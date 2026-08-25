/*
 * Der Rechner hat den Haupt-Datensatz bedingungslos ueberschrieben.
 *
 * rtdbJsonPut() las den Serverstand, entschied ausserhalb der Datenbank, ob
 * gemergt wird, und rief danach ref.set(). Zwischen Lesen und Schreiben lag
 * ein ungeschuetztes Fenster, und schlug der Lesevorgang fehl, wurde ohne
 * jede Bedingung ersetzt — kein If-Match, kein Vergleich, kein 412. Von den
 * drei Clients war der Rechner damit der einzige ohne Absicherung: das Tablet
 * benutzt ref.transaction() (quantus-tablet-version public/app.js), das Handy
 * schickt If-Match.
 *
 * Der Test laesst die ECHTE Funktion gegen eine Firebase-Attrappe laufen, die
 * sich wie ref.transaction() verhaelt — inklusive erneutem Aufruf, wenn sich
 * der Knoten zwischendurch aendert.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

const MARKER = "Q-S4-MOBILE-20260823-1608";

function cut(header) {
  const start = index.indexOf(header);
  ok(start > 0, `${header} wurde in index.html nicht gefunden`);
  const cands = ["\nfunction ", "\nasync function ", "\nwindow.", "\nconst ", "\nlet ", "\nvar "]
    .map((m) => index.indexOf(m, start + header.length)).filter((n) => n > 0);
  return index.slice(start, Math.min(...cands));
}

const DEPS = [
  "APP", "console", "shouldTryCloudProvider", "coreAuthReady", "rememberCoreAuthRequired",
  "RTDB_NODE", "RTDB_DB_URL", "rtdbNodeKey", "rtdbDbRef", "fetchWithTimeout",
  "getDataTimestamp", "getOrCreateDeviceId", "rememberCloudSuccess", "rememberCloudFailure",
  "rtdbJsonGet", "rememberCoreAuthRequired", "isAuthDeniedError",
  // Seit F-25 v3 traegt jede Low-Level-Schreibfunktion den Trichter-Waechter.
  // Hier wird der Weg INNERHALB des Trichters geprueft, also gibt der Waechter
  // null zurueck; canonicalWrite darf gar nicht erst gerufen werden.
  "coreWriteGuard", "canonicalWrite",
];
const OHNE_TRICHTER = [() => null, async () => { throw new Error("canonicalWrite darf hier nicht greifen"); }];
// Die echte Fehlereinstufung mitlaufen lassen: ein permission_denied aus der
// Transaktion muss als Anmeldefehler herauskommen, nicht als Netzfehler.
const isAuthDeniedError = new Function("e", cut("function isAuthDeniedError(e) {") + "\nreturn isAuthDeniedError(e);");

// Firebase-Attrappe: ruft die Aenderungsfunktion mit `serverValues` der Reihe
// nach auf (ein Eintrag = ein Durchlauf) und meldet dann committed.
function makeRef({ serverValues = [null], committed = true, error = null } = {}) {
  const log = { setCalls: 0, txnCalls: 0, written: null, applyLocally: undefined };
  return {
    log,
    ref: {
      set: async () => { log.setCalls++; },
      transaction(updateFn, cb, applyLocally) {
        log.applyLocally = applyLocally;
        let out = null;
        for (const v of serverValues) { log.txnCalls++; out = updateFn(v); }
        log.written = out;
        // Der echte SDK reicht im dritten Argument den COMMITTETEN Stand zurueck.
        // Vorher gab die Attrappe null — damit lief die CAS-Beweispflicht aus
        // F-25 v4 ins Leere, und der Test haette einen Erfolg ohne Beweis
        // durchgewinkt. Bei abgebrochener Transaktion gibt es keinen Stand.
        const snapshot = (!error && committed && out !== undefined)
          ? { val: () => out, exists: () => !!out }
          : null;
        setTimeout(() => cb(error, error ? false : committed, snapshot), 0);
      },
    },
  };
}

function build(refBundle, { blobKey = "app-data.json", device = "dev_desktop_1" } = {}) {
  const APP = { state: { settings: { storage: { blobKey } }, storage: {} } };
  const fails = [];
  const factory = new Function(...DEPS,
    cut("async function rtdbJsonPut(key, data, options = {}) {") + "\nreturn rtdbJsonPut;");
  const fn = factory(
    APP, { log() {}, warn() {} }, () => true,
    async () => ({ user: { uid: "u1" } }), () => {},
    "appStore", "https://rtdb.example",
    (k) => String(k).replace(/[.#$[\]/]/g, "_"),
    () => refBundle.ref,
    async () => { throw new Error("REST darf fuer den Hauptdatensatz nicht laufen"); },
    (d) => new Date(d?.meta?.updatedAt || 0).getTime() || 0,
    () => device, () => {}, (p, i) => { fails.push(i); },
    async () => ({ ok: false, provider: "rtdb" }),
    () => { APP.state.storage.status = "auth_required"; }, isAuthDeniedError,
    ...OHNE_TRICHTER,
  );
  return { fn, APP, fails };
}

// mergeData-Ersatz: vereinigt verlustfrei, damit der Test die Weitergabe prueft
// und nicht mergeData selbst (dafuer gibt es sync-merge.test.mjs).
const mergeFn = (local, remote) => ({ ...remote, ...local, entities: { ...(remote.entities || {}), ...(local.entities || {}) } });

const wrapOf = (payload, savedBy) => ({
  data: JSON.stringify(payload), updatedAt: payload?.meta?.updatedAt, savedAt: 1, savedBy,
});

// ── 1. Fremder Serverstand wird gemergt, der Marker ueberlebt ─────────────
{
  const remote = {
    entities: { notes: { mo7ob: { id: "mo7ob", title: MARKER } } },
    journal: { documents: [{ id: "j1" }] },
    meta: { updatedAt: "2026-08-23T14:08:59.753Z", lastSavedBy: "mobile-app" },
  };
  const local = {
    entities: { tasks: { t1: { id: "t1" } } },
    meta: { updatedAt: "2026-08-23T13:00:00.000Z", lastSavedBy: "dev_desktop_1" },
  };
  const b = makeRef({ serverValues: [wrapOf(remote, "mobile-app")] });
  const { fn, APP } = build(b);
  const res = await fn("app-data.json", local, { mergeFn });

  ok(res.ok === true, "die Transaktion meldet keinen Erfolg");
  ok(res.merged === true, "ein fremder Serverstand wurde NICHT gemergt");
  ok(b.log.setCalls === 0, "der Hauptdatensatz wurde mit ref.set() ueberschrieben statt in einer Transaktion geschrieben");
  ok(b.log.applyLocally === false, "die Transaktion schreibt den Zwischenstand lokal (applyLocally muss false sein)");

  const written = JSON.parse(b.log.written.data);
  ok(written.entities.notes.mo7ob.title === MARKER,
    "der Marker des Handys hat den Schreibvorgang des Rechners nicht ueberlebt");
  ok(written.entities.tasks.t1, "die eigene Aenderung ging beim Merge verloren");
  ok(written.journal.documents[0].id === "j1",
    "ein Bereich der Gegenseite ohne lokales Gegenstueck ging verloren");
  ok(b.log.written.savedBy === "dev_desktop_1", "der Wrapper traegt nicht die eigene Geraete-Id");
  ok(typeof b.log.written.data === "string", "der Wrapper legt data nicht als Zeichenkette ab");
  ok(b.log.written.savedAt > 0, "savedAt fehlt im Wrapper");
  ok(APP.state.storage.lastRemoteSeenAt > 0, "lastRemoteSeenAt wurde nicht nachgefuehrt");
  ok(APP.state.storage.lastRemoteProvider === "rtdb", "lastRemoteProvider wurde nicht gesetzt");
}

// ── 2. Neuerer Serverstand desselben Geraets wird ebenfalls gemergt ───────
{
  const remote = { entities: {}, nurRemote: true, meta: { updatedAt: "2026-08-23T15:00:00.000Z", lastSavedBy: "dev_desktop_1" } };
  const local = { entities: {}, meta: { updatedAt: "2026-08-23T14:00:00.000Z", lastSavedBy: "dev_desktop_1" } };
  const b = makeRef({ serverValues: [wrapOf(remote, "dev_desktop_1")] });
  const { fn } = build(b);
  const res = await fn("app-data.json", local, { mergeFn });
  ok(res.merged === true, "ein neuerer Serverstand desselben Geraets wurde nicht gemergt");
  ok(JSON.parse(b.log.written.data).nurRemote === true, "der neuere Serverstand ging verloren");
}

// ── 3. Eigener, aelterer Serverstand: JETZT ebenfalls Merge ───────────────
// Bis F-25 Commit 4 stand hier das Gegenteil: bei eigener Geraete-Id und
// aelterem Serverstand wurde der Merge als "unnoetig" uebersprungen. Genau
// dieses Loch nutzte der veraltete zweite Tab desselben Rechners — er hat den
// SPAETEREN Zeitstempel und dieselbe lastSavedBy, also griff kein Torwaechter,
// und sein Voll-Stand ersetzte den Serverstand samt der Grabsteine darin.
// lastSavedBy trennt Geraete, nicht Tabs. Der Merge laeuft deshalb immer; dass
// der eigene neuere Stand gewinnt, entscheidet mergeData per LWW — nicht ein
// vorgeschalteter Torwaechter.
{
  const remote = { entities: {}, meta: { updatedAt: "2026-08-23T12:00:00.000Z", lastSavedBy: "dev_desktop_1" } };
  const local = { entities: {}, neu: true, meta: { updatedAt: "2026-08-23T14:00:00.000Z", lastSavedBy: "dev_desktop_1" } };
  const b = makeRef({ serverValues: [wrapOf(remote, "dev_desktop_1")] });
  const { fn } = build(b);
  const res = await fn("app-data.json", local, { mergeFn });
  ok(res.ok === true && res.merged === true,
    "ein eigener, aelterer Serverstand wird nicht gemergt — der veraltete Tab kann wieder ersetzen");
  ok(JSON.parse(b.log.written.data).neu === true, "der eigene neuere Stand wurde nicht geschrieben");
  ok(res.casProof && res.casProof.kind === "rtdb-transaction",
    "der Erfolg traegt keinen CAS-Beweis aus dem Schnappschuss");
  ok(res.committedByTransaction === true,
    "das Ergebnis ist nicht als Stand der kanonischen Merge-Transaktion gekennzeichnet");
}

// ── 4. Leerer Knoten: schreiben, nicht scheitern ──────────────────────────
{
  const local = { entities: {}, meta: { updatedAt: "2026-08-23T14:00:00.000Z", lastSavedBy: "dev_desktop_1" } };
  const b = makeRef({ serverValues: [null] });
  const { fn } = build(b);
  const res = await fn("app-data.json", local, { mergeFn });
  ok(res.ok === true && res.merged === false, "auf einem leeren Knoten schlaegt der Schreibvorgang fehl");
  ok(b.log.written && b.log.written.data, "auf einem leeren Knoten wurde nichts geschrieben");
}

// ── 5. Erneuter Aufruf: der zuletzt gesehene Serverstand gewinnt ──────────
{
  const spaet = {
    entities: { notes: { mo7ob: { id: "mo7ob", title: MARKER } } },
    meta: { updatedAt: "2026-08-23T14:08:59.753Z", lastSavedBy: "mobile-app" },
  };
  const local = { entities: {}, meta: { updatedAt: "2026-08-23T13:00:00.000Z", lastSavedBy: "dev_desktop_1" } };
  // Firebase ruft die Funktion erst mit null und dann mit dem echten Stand auf.
  const b = makeRef({ serverValues: [null, wrapOf(spaet, "mobile-app")] });
  const { fn } = build(b);
  const res = await fn("app-data.json", local, { mergeFn });
  ok(b.log.txnCalls === 2, "die Aenderungsfunktion wurde nicht erneut aufgerufen");
  ok(res.merged === true, "beim zweiten Durchlauf wurde der Serverstand nicht gemergt");
  ok(JSON.parse(b.log.written.data).entities.notes.mo7ob.title === MARKER,
    "der beim zweiten Durchlauf gesehene Marker ging verloren");
}

// ── 6. Abbruch und Fehler der Transaktion sind sichtbar ───────────────────
{
  const local = { entities: {}, meta: { updatedAt: "2026-08-23T14:00:00.000Z" } };
  const b1 = makeRef({ serverValues: [null], committed: false });
  const r1 = await build(b1).fn("app-data.json", local, { mergeFn });
  ok(r1.ok === false, "eine abgebrochene Transaktion meldet Erfolg");
  ok(r1.reason === "transaction_aborted", "der Abbruchgrund fehlt");

  // Netzfehler aus der Transaktion: bleibt ein Netzfehler mit Backoff.
  const b2 = makeRef({ serverValues: [null], error: new Error("Failed to fetch") });
  const h2 = build(b2);
  const r2 = await h2.fn("app-data.json", local, { mergeFn });
  ok(r2.ok === false, "eine fehlgeschlagene Transaktion meldet Erfolg");
  ok(String(r2.error?.message || "").includes("Failed to fetch"), "der Fehler der Transaktion wird nicht durchgereicht");
  ok(!r2.authRequired, "ein Netzfehler aus der Transaktion gilt faelschlich als Anmeldefehler");
  ok(h2.fails.length > 0, "der Fehler wurde nicht in der Provider-Gesundheit vermerkt");

  // permission_denied aus der Transaktion: sichtbarer Anmeldefehler, KEIN Backoff.
  const denied = Object.assign(new Error("permission_denied at /appStore/app-data_json"), { code: "PERMISSION_DENIED" });
  const b3 = makeRef({ serverValues: [null], error: denied });
  const h3 = build(b3);
  const r3 = await h3.fn("app-data.json", local, { mergeFn });
  ok(r3.ok === false && r3.authRequired === true,
    "permission_denied aus der Transaktion wird nicht als Anmeldefehler gemeldet");
  ok(r3.reason === "permission_denied", `der Grund lautet "${r3.reason}" statt permission_denied`);
  ok(h3.fails.length === 0, "permission_denied aus der Transaktion setzt einen generischen Backoff");
  ok(h3.APP.state.storage.status === "auth_required", "permission_denied aus der Transaktion bleibt unsichtbar");
}

// ── 7. Ohne SDK kein blindes REST-Ueberschreiben des Hauptdatensatzes ─────
{
  const local = { entities: {}, meta: { updatedAt: "2026-08-23T14:00:00.000Z" } };
  const factory = new Function(...DEPS,
    cut("async function rtdbJsonPut(key, data, options = {}) {") + "\nreturn rtdbJsonPut;");
  let restCalls = 0;
  const APP = { state: { settings: { storage: { blobKey: "app-data.json" } }, storage: {} } };
  const fn = factory(
    APP, { log() {}, warn() {} }, () => true, async () => ({ user: { uid: "u1" } }), () => {},
    "appStore", "https://rtdb.example", (k) => k, () => null,
    async () => { restCalls++; return { ok: true }; },
    () => 1, () => "dev_desktop_1", () => {}, () => {}, async () => ({ ok: false }),
    undefined, undefined, ...OHNE_TRICHTER,
  );
  const res = await fn("app-data.json", local, {});
  ok(res.ok === false && res.reason === "no_sdk_no_transaction",
    "ohne SDK wird der Hauptdatensatz weiterhin ueber REST bedingungslos ueberschrieben");
  ok(restCalls === 0, "ohne SDK lief trotzdem ein REST-Schreibvorgang auf den Hauptdatensatz");
}

// ── 8. Nebenschluessel behalten den bisherigen Weg ────────────────────────
{
  const local = { meta: { updatedAt: "2026-08-23T14:00:00.000Z" } };
  const b = makeRef({ serverValues: [null] });
  const { fn } = build(b);
  const res = await fn("recalllab-mobile.json", local, {});
  ok(res.ok === true, "ein Nebenschluessel laesst sich nicht mehr schreiben");
  ok(b.log.setCalls === 1, "ein Nebenschluessel laeuft jetzt faelschlich ueber die Transaktion");
  ok(b.log.txnCalls === 0, "fuer einen Nebenschluessel wurde eine Transaktion gestartet");
}

// ── 9. Der 30-s-Wecker und mergeData bleiben unberuehrt ───────────────────
{
  ok(/setInterval\(async \(\) => \{[\s\S]{0,900}?syncFreshness\('background_poll'\)[\s\S]{0,200}?\}, 30000\);/.test(index),
    "der 30-Sekunden-Wecker wurde veraendert");
  ok(index.indexOf("function mergeData(local, remote) {") > 0, "mergeData fehlt");
  ok(/mergeFn: mergeData/.test(index), "remotePut reicht mergeData nicht mehr als Merge-Funktion durch");
}

console.log(`sync rtdb transaction: ok (${checks} Pruefungen)`);
