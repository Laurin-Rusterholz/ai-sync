/*
 * F-25 v3 — Waechter ueber ALLE kanonischen Schreibwege.
 *
 * Leitsatz: kein Schreibvorgang auf app-data ohne unmittelbar vorherigen Merge
 * gegen den aktuellen Serverstand.
 *
 * Der Gegenbeweis f25-stale-push-gap zeigt die drei Mechanik-Luecken
 * (Transaktion, 412, Schatten). Diese Datei bewacht die CALLSITES und die
 * Klasse als ganze: sie laesst canonicalWrite gegen Attrappen laufen, prueft
 * die migrierten Aufrufer und stellt statisch sicher, dass keine neue
 * Direktschreibung auf den Kernschluessel entsteht.
 *
 * Faellt etwas durch, meldet der Lauf "F-25 CALLSITE GAP" mit der Liste.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const luecken = [];
const ok = (bedingung, text) => { checks++; if (!bedingung) luecken.push(text); };

function funktion(name, praefix = "function ") {
  const a = index.indexOf("\n" + praefix + name + "(");
  assert.ok(a > 0, `${name} wurde in public/index.html nicht gefunden`);
  return index.slice(a, index.indexOf("\n}\n", a) + 3);
}
const funktionAsync = (name) => funktion(name, "async function ");
const ohneKommentare = (src) => src.replace(/^\s*\/\/.*$/gm, "");

const JETZT = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const stand = (notizen, extra) => ({
  entities: { notes: notizen || {} },
  meta: { updatedAt: iso(JETZT), lastSavedBy: "dev-A" }, ...extra,
});

// ── canonicalWrite mit echten Abhaengigkeiten ───────────────────────────
function trichter({ fern = null, leseFehler = false, putErgebnisse = [{ ok: true }] } = {}) {
  const log = { lesen: 0, puts: [] };
  const APP = { state: { settings: { storage: { blobKey: "app-data.json" } }, storage: {} } };
  let i = 0;
  const fn = new Function(
    "APP", "remoteGetByKey", "remotePutByKey", "normalizeData", "mergeData",
    "primaryCloudProvider", "getOrCreateDeviceId", "console", "Date",
    "const CANONICAL_WRITE_MAX_ATTEMPTS = " +
      (index.match(/const CANONICAL_WRITE_MAX_ATTEMPTS = (\d+)/) || [, "2"])[1] + ";\n" +
      funktionAsync("canonicalWrite") + "\nreturn canonicalWrite;")(
    APP,
    async () => { log.lesen++; return leseFehler ? { ok: false } : { ok: true, data: fern }; },
    async (k, d, o) => { log.puts.push({ key: k, data: d, options: o }); return putErgebnisse[Math.min(i++, putErgebnisse.length - 1)]; },
    (d) => d,
    // echtes mergeData waere hier Beiwerk: geprueft wird der ABLAUF. Dass der
    // Merge die Grabsteine vereint, steht in delete-tombstone und stale-push-gap.
    (lokal, fernStand) => ({ ...fernStand, ...lokal, gemergt: true }),
    () => "rtdb", () => "dev-A",
    { log() {}, warn() {}, error() {}, info() {} }, Date);
  return { fn, log, APP };
}

// ── 1. Der Trichter liest IMMER, merged IMMER, schreibt bedingt ─────────
{
  const t = trichter({ fern: stand({ n1: { id: "n1" } }) });
  const res = await t.fn(stand({}));
  ok(t.log.lesen === 1, `es wurde ${t.log.lesen}-mal gelesen statt genau einmal`);
  ok(t.log.puts.length === 1, `es wurde ${t.log.puts.length}-mal geschrieben statt genau einmal`);
  ok(t.log.puts[0].data.gemergt === true, "der Schreibvorgang trug keinen gemergten Stand");
  ok(t.log.puts[0].options._viaCanonicalWrite === true, "der Trichter-Token fehlt");
  ok(!("force" in t.log.puts[0].options), "der Trichter reicht force weiter");
  ok(typeof t.log.puts[0].options.mergeFn === "function", "der CAS-Weg bekommt kein mergeFn");
  ok(res.mergedRemote === true, "das Ergebnis meldet den Merge nicht");
}

// ── 2. mutateFn setzt auf dem GELESENEN Serverstand auf ─────────────────
{
  const fern = stand({ vomServer: { id: "vomServer" } });
  const t = trichter({ fern });
  let gesehen = null;
  await t.fn((f) => { gesehen = f; return stand({}); });
  ok(gesehen === fern, "mutateFn bekam nicht den gelesenen Serverstand");
}

// ── 3. requireRemoteRead: kein Lesevorgang -> KEIN Schreibvorgang ───────
{
  const t = trichter({ leseFehler: true });
  const res = await t.fn(stand({}), { requireRemoteRead: true });
  ok(res.ok === false && res.reason === "remote_read_failed",
    `ohne lesbaren Serverstand kam "${res.reason}" statt remote_read_failed`);
  ok(t.log.puts.length === 0,
    "ohne lesbaren Serverstand wurde trotzdem geschrieben — genau der F-08-Fall");
}

// ── 4. Konflikt: bestehende Grenze, danach sichtbarer Fehler, nie Force ─
{
  const t = trichter({ fern: stand({}), putErgebnisse: [{ ok: false, status: 412 }] });
  const res = await t.fn(stand({}));
  ok(t.log.puts.length === 2, `${t.log.puts.length} Schreibversuche statt der Grenze von zwei`);
  ok(res.ok === false && res.reason === "canonical_write_conflict",
    `nach der Grenze kam "${res.reason}" statt eines sichtbaren Konfliktfehlers`);
  ok(t.log.puts.every((pv) => !pv.options.force),
    "eine Wiederholung lief mit force — es darf keinen Force-Rueckfall geben");
}

// ── 5. Echter Fehler wird nicht wiederholt, sondern gemeldet ───────────
{
  const t = trichter({ fern: stand({}), putErgebnisse: [{ ok: false, status: 500 }] });
  const res = await t.fn(stand({}));
  ok(t.log.puts.length === 1, "ein 500er wurde wiederholt statt gemeldet");
  ok(res.ok === false, "ein 500er wurde als Erfolg gemeldet");
}

// ── 6. Waechter: Low-Level auf den Kernschluessel wird umgeleitet ───────
{
  const guard = new Function("isCoreDataKey", "console",
    funktion("coreWriteGuard") + "\nreturn coreWriteGuard;")(
    (k) => k === "app-data.json", { warn() {}, error() {} });
  ok(guard("netlifyBlobPut", "app-data.json", {}) !== null,
    "ein Low-Level-Schreibvorgang auf den Kernschluessel laeuft am Trichter vorbei");
  ok(guard("netlifyBlobPut", "app-data.json", { _viaCanonicalWrite: true }) === null,
    "der Trichter selbst wird von seinem eigenen Waechter blockiert");
  ok(guard("netlifyBlobPut", "recalllab-mobile.json", {}) === null,
    "ein Nebenschluessel wird faelschlich abgefangen — recalllab & Co. bleiben unberuehrt");

  for (const f of ["netlifyBlobPut", "firebaseJsonPut", "rtdbJsonPut", "remotePutByKey"]) {
    ok(/const _g = coreWriteGuard\('/.test(funktionAsync(f)) && /if \(_g\) return canonicalWrite\(/.test(funktionAsync(f)),
      `${f} traegt den Trichter-Waechter nicht`);
  }
}

// ── 7. Statischer Repo-Waechter ────────────────────────────────────────
// Die Klasse wird geschlossen, nicht nur die heute bekannten Stellen.
{
  const zeilen = index.split("\n");
  const putAufruf = /\b(netlifyBlobPut|firebaseJsonPut|rtdbJsonPut|remotePutByKey)\s*\(/;
  const kernBezug = /blobKey|['"]app-data\.json['"]/;
  // Erlaubt sind ausschliesslich: die Definitionen selbst, die Anbieterschleife
  // in remotePutByKey und der Schatten — alle innerhalb der Trichter-Schicht.
  const erlaubt = [
    /^\s*(async )?function (netlifyBlobPut|firebaseJsonPut|rtdbJsonPut|remotePutByKey)\(/,
    /provider === 'rtdb' \? await rtdbJsonPut/,
    /: provider === 'firebase' \? await firebaseJsonPut/,
    /: await netlifyBlobPut\(key, data, options\)/,
    /return netlifyBlobPut\(key, options\.mergeFn\(data, aktuell\.data\)/,
    /const putFn = firebaseJsonPut;/,
  ];
  const verstoesse = [];
  zeilen.forEach((z, i) => {
    if (!putAufruf.test(z)) return;
    if (erlaubt.some((r) => r.test(z))) return;
    if (!kernBezug.test(z)) return;             // Nebenschluessel duerfen
    verstoesse.push(`${i + 1}: ${z.trim().slice(0, 100)}`);
  });
  ok(verstoesse.length === 0,
    `Direktschreibung auf den Kernschluessel ausserhalb des Trichters:\n     ${verstoesse.join("\n     ")}`);

  // force:true darf app-data nirgends mehr treffen — auch nicht ueber remotePut.
  const forceVerstoesse = [];
  zeilen.forEach((z, i) => {
    const code = z.replace(/^\s*\/\/.*$/, "");
    if (!/force:\s*true/.test(code)) return;
    if (!(putAufruf.test(code) || /\bremotePut\s*\(/.test(code) || /canonicalWrite\s*\(/.test(code))) return;
    if (/readinghub|recalllab|_diagnose|attachment-text|textKey/i.test(code)) return;
    forceVerstoesse.push(`${i + 1}: ${code.trim().slice(0, 100)}`);
  });
  ok(forceVerstoesse.length === 0,
    `force: true auf einem app-data-Schreibweg:\n     ${forceVerstoesse.join("\n     ")}`);
}

// ── 8. Die migrierten Aufrufer ─────────────────────────────────────────
{
  // manualTransferPush
  const mtp = ohneKommentare(index.slice(index.indexOf("async function manualTransferPush"),
    index.indexOf("async function manualTransferPull")));
  ok(mtp.length > 500, "manualTransferPush wurde nicht gefunden");
  ok(/await canonicalWrite\(payload\)/.test(mtp), "manualTransferPush laeuft nicht ueber den Trichter");
  ok(!/for \(const k in _remoteEtags\) delete _remoteEtags\[k\]/.test(mtp),
    "manualTransferPush loescht weiterhin alle ETags — damit kann der Server keinen fremden Stand mehr schuetzen");
  ok(!/netlifyBlobPut\(APP\.state\.settings\.storage\.blobKey/.test(mtp) &&
     !/firebaseJsonPut\(APP\.state\.settings\.storage\.blobKey/.test(mtp),
    "manualTransferPush schreibt weiterhin direkt pro Anbieter");
  ok(/toast\('info', 'Zusammengefuehrt'/.test(mtp),
    "manualTransferPush sagt nicht, WAS zusammengefuehrt wurde (F-21)");

  // _headerPush und doSave
  const hp = ohneKommentare(index.slice(index.indexOf("window._headerPush = async function()"),
    index.indexOf("window._headerPush = async function()") + 2000));
  ok(/await remotePut\(payload\)/.test(hp) && !/remotePut\(payload, \{ force/.test(hp),
    "_headerPush erzwingt weiterhin");
  const ds = ohneKommentare(index.slice(index.indexOf("async function doSave("),
    index.indexOf("async function doSave(") + 6000));
  ok(!/remotePut\([^)]*force/.test(ds), "doSave erzwingt weiterhin");

  // jbSendToMobile
  const jb = ohneKommentare(index.slice(index.indexOf("window.jbSendToMobile = async function()"),
    index.indexOf("window.jbCloseEditor = function()")));
  ok(jb.length > 500, "jbSendToMobile wurde nicht gefunden");
  ok(/window\.canonicalWrite\(/.test(jb) && /requireRemoteRead: true/.test(jb),
    "jbSendToMobile laeuft nicht mit requireRemoteRead ueber den Trichter");
  ok(!/fetch\(/.test(jb), "jbSendToMobile schreibt weiterhin roh per fetch am Abgleich vorbei");
  ok(!/remotePutByKey\(/.test(jb), "jbSendToMobile hat weiterhin einen Rueckfall auf remotePutByKey");
  ok(!/buildLocalAppSnapshot|buildRemoteAppPayload/.test(jb),
    "jbSendToMobile schickt bei einem Fehler weiterhin den lokalen Vollstand");
  ok(/remote_read_failed/.test(jb),
    "ein nicht lesbarer Serverstand wird dem Nutzer nicht als Grund genannt");
}

// ── 9. 412 ohne frischen ETag: abbrechen statt unbedingt zu schreiben ───
{
  const src = ohneKommentare(funktionAsync("netlifyBlobPut"));
  ok(/etag_conflict_no_etag/.test(src),
    "nach einem 412 ohne frischen ETag laeuft die Wiederholung weiterhin OHNE If-Match");
  ok(/etag_conflict_read_failed/.test(src),
    "ein nicht lesbarer Serverstand nach 412 fuehrt weiterhin zu einem Schreibvorgang");
  ok(!/retrying without If-Match/.test(src), "der Force-Zweig ohne If-Match steht noch im Quelltext");
}

if (luecken.length) {
  console.error("F-25 CALLSITE GAP — " + luecken.length + " von " + checks + " Pruefungen:");
  luecken.forEach((l) => console.error("   - " + l));
  process.exit(1);
}
console.log(`f25 callsite gaps: ok (${checks} Pruefungen)`);
