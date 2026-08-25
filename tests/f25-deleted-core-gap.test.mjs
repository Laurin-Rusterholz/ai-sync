/*
 * F-25 v6 — ein fehlender Serverstand ist ein Konflikt, kein Freibrief.
 *
 * Befund: writeAppDataText prueft die Client-Vorbedingung nur, wenn ueberhaupt
 * ein Stand da ist:
 *     if (ifMatch && currentData != null && currentLogicalEtag !== ifMatch)
 * Fehlt der Knoten (geloescht, noch nicht angelegt, nicht auspackbar), faellt
 * der Vergleich AUS. Der Client sagt "schreibe nur, wenn der Stand noch A ist",
 * der Server findet gar keinen Stand — und schreibt trotzdem. Damit
 * rekonstruiert er das ganze Dokument aus der Client-Nutzlast: alles, was die
 * Loeschung gerade entfernt hatte, ist wieder da.
 *
 * Der innere Server-ETag-CAS (firebaseDbSet mit current.serverEtag) rettet das
 * NICHT — er sichert nur das Wettrennen zwischen Lesen und Schreiben ab und
 * sagt nichts darueber, ob der Stand der ist, den der Client gelesen hat.
 *
 * Der Test fuehrt das ECHTE writeAppDataText aus netlify/lib/firebase-admin.mjs
 * gegen einen gemockten Transport aus und zaehlt die Schreibvorgaenge.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jsonEtag, firebaseNodeKey } from "../netlify/lib/firebase-admin.mjs";
// Seit F-25 M2 prueft writeAppDataText zuerst die Schluesselpolitik.
import { classifyBlobKey } from "../netlify/lib/blob-key-policy.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(root, "netlify/lib/firebase-admin.mjs"), "utf8");
let checks = 0;
const luecken = [];
const ok = (bedingung, text) => { checks++; if (!bedingung) luecken.push(text); };

// Die ECHTE Funktion herausschneiden; nur der Transport wird ersetzt.
function ladeWriteAppDataText() {
  const a = src.indexOf("export async function writeAppDataText(");
  assert.ok(a > 0, "writeAppDataText wurde nicht gefunden");
  const koerper = src.slice(a, src.indexOf("\n}\n", a) + 3).replace("export async function", "async function");
  const unwrapA = src.indexOf("function unwrapData(value) {");
  const unwrap = src.slice(unwrapA, src.indexOf("\n}\n", unwrapA) + 3);
  return { koerper, unwrap };
}
const { koerper, unwrap } = ladeWriteAppDataText();

function bauen({ current = null, serverEtag = "srv-1", setzenOk = true } = {}) {
  const log = { gets: 0, sets: [] };
  const fn = new Function(
    "firebaseDbGetWithEtag", "firebaseDbSet", "appStorePath", "jsonEtag", "classifyBlobKey", "JSON", "Date", "Error",
    unwrap + "\n" + koerper + "\nreturn writeAppDataText;")(
    async () => { log.gets++; return { exists: current !== null, value: current, serverEtag }; },
    async (p, v) => { log.sets.push({ path: p, value: v }); return { ok: setzenOk }; },
    (k) => "appStore/" + firebaseNodeKey(k), jsonEtag, classifyBlobKey, JSON, Date, Error);
  return { fn, log };
}

const STAND_A = JSON.stringify({ entities: { notes: {} }, meta: { updatedAt: "2026-08-25T10:00:00.000Z" } });
const ETAG_A = jsonEtag(STAND_A);
const huelle = (text) => ({ data: text, etag: jsonEtag(text) });
const NEU = JSON.stringify({ entities: { notes: { wieder: { id: "wieder" } } }, meta: { updatedAt: "2026-08-25T11:00:00.000Z" } });

// ── 1. DER FALL: A gelesen, current fehlt, If-Match A ───────────────────
{
  const b = bauen({ current: null });
  const res = await b.fn("app-data.json", NEU, { ifMatch: ETAG_A });
  ok(res.ok === false && res.conflict === true,
    `A gelesen, Knoten weg, If-Match A: es wurde geschrieben statt zu konfliktieren (ok=${res.ok})`);
  ok(res.reason === "no_current", `der Grund lautet "${res.reason}" statt no_current`);
  ok(b.log.sets.length === 0,
    `es gingen ${b.log.sets.length} Firebase-PUTs hinaus — verlangt sind NULL; ` +
    "jeder davon rekonstruiert das geloeschte Dokument aus der Client-Nutzlast");
}

// ── 2. Auch ein nicht auspackbarer Stand zaehlt als "kein Stand" ────────
for (const [wert, was] of [
  [{}, "leere Huelle"],
  [{ data: 42 }, "data ist keine Zeichenkette"],
  [{ etag: "x" }, "Huelle ohne data"],
]) {
  const b = bauen({ current: wert });
  const res = await b.fn("app-data.json", NEU, { ifMatch: ETAG_A });
  ok(res.ok === false && res.conflict === true && res.reason === "no_current",
    `${was}: es wurde geschrieben statt zu konfliktieren`);
  ok(b.log.sets.length === 0, `${was}: es ging ein Firebase-PUT hinaus`);
}

// ── 3. Fremder Stand: weiterhin Konflikt, mit eigenem Grund ─────────────
{
  const fremd = JSON.stringify({ entities: {}, meta: { updatedAt: "2026-08-25T10:30:00.000Z" } });
  const b = bauen({ current: huelle(fremd) });
  const res = await b.fn("app-data.json", NEU, { ifMatch: ETAG_A });
  ok(res.ok === false && res.conflict === true && res.reason === "etag_mismatch",
    `fremder Stand: "${res.reason}" statt etag_mismatch`);
  ok(b.log.sets.length === 0, "fremder Stand: es ging ein Firebase-PUT hinaus");
}

// ── 4. Passender Stand: schreibt, und erst DANN der Server-ETag-CAS ─────
{
  const b = bauen({ current: huelle(STAND_A), serverEtag: "srv-42" });
  const res = await b.fn("app-data.json", NEU, { ifMatch: ETAG_A });
  ok(res.ok === true && res.conflict === false, `passender Stand: wurde abgelehnt (${res.reason})`);
  ok(b.log.sets.length === 1, `passender Stand: ${b.log.sets.length} Schreibvorgaenge statt einem`);
  ok(b.log.sets[0].value.data === NEU, "es wurde nicht die neue Nutzlast geschrieben");
  ok(res.etag === jsonEtag(NEU), "der zurueckgegebene ETag passt nicht zur Nutzlast");
}

// ── 5. Ohne Vorbedingung: unveraendert (Nebenschluessel-Semantik) ───────
{
  const b = bauen({ current: null });
  const res = await b.fn("recalllab-mobile.json", NEU, {});
  ok(res.ok === true, "ohne If-Match wird ein Nebenschluessel nicht mehr geschrieben");
  ok(b.log.sets.length === 1, "ohne If-Match fand kein Schreibvorgang statt");
}

// ── 6. Bewusste Erstanlage nur ueber If-None-Match: * ───────────────────
{
  const b = bauen({ current: null });
  const res = await b.fn("app-data.json", NEU, { ifNoneMatch: "*" });
  ok(res.ok === true, `Erstanlage mit If-None-Match:* wurde abgelehnt (${res.reason})`);
  ok(b.log.sets.length === 1, "Erstanlage schrieb nicht");

  const b2 = bauen({ current: huelle(STAND_A) });
  const res2 = await b2.fn("app-data.json", NEU, { ifNoneMatch: "*" });
  ok(res2.ok === false && res2.reason === "already_exists",
    `Erstanlage auf einen vorhandenen Stand: "${res2.reason}" statt already_exists`);
  ok(b2.log.sets.length === 0, "Erstanlage ueberschrieb einen vorhandenen Stand");
}

// ── 7. Quelltextregeln ─────────────────────────────────────────────────
{
  const w = src.slice(src.indexOf("export async function writeAppDataText("),
    src.indexOf("\n}\n", src.indexOf("export async function writeAppDataText(")))
    .replace(/^\s*\/\/.*$/gm, "");
  ok(!/ifMatch && currentData != null && currentLogicalEtag !== ifMatch/.test(w),
    "der Vergleich haengt weiterhin an currentData != null — ein fehlender Stand umgeht die Vorbedingung");
  ok(/no_current/.test(w) && /etag_mismatch/.test(w), "die Konfliktgruende fehlen");
  ok(w.indexOf("no_current") < w.indexOf("firebaseDbSet"),
    "der logische Vergleich steht NACH dem Schreibvorgang");
  ok(/ifNoneMatch === "\*"/.test(w), "es gibt keinen expliziten Weg fuer eine Erstanlage");
  // mutateAppData ist ein eigener, serverseitig frischer Pfad und bleibt unberuehrt
  const m = src.slice(src.indexOf("export async function mutateAppData("));
  ok(/const current = await firebaseDbGetWithEtag\(path\);/.test(m) && /ifMatch: current\.serverEtag/.test(m),
    "mutateAppData liest nicht mehr serverseitig frisch — date-invite und flowertech haengen daran");
  ok(!/writeAppDataText/.test(m), "mutateAppData laeuft jetzt ueber writeAppDataText — anderer Vertrag");
}

if (luecken.length) {
  console.error("F-25 DELETED CORE GAP — " + luecken.length + " von " + checks + " Pruefungen:");
  luecken.forEach((l) => console.error("   - " + l));
  process.exit(1);
}
console.log(`f25 deleted core gap: ok (${checks} Pruefungen)`);
