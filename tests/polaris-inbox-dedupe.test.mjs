/*
 * Die zweite London-Notiz.
 *
 * Das Tablet bearbeitet eine bestehende Notiz, schreibt sie kanonisch per
 * ref.transaction() und spiegelt dieselbe Operation danach nach
 * polaris/inbox/<typ>/<entitaets-id> (quantus-tablet-version public/app.js,
 * mirrorOperation; die Id steht im Schluessel UND in record.id).
 *
 * plInboxApply loeste den Eintrag bis dahin AUSSCHLIESSLICH ueber
 * settings.polaris.inboxMap auf — einen geraetelokalen Index, der nur
 * Eintraege enthaelt, die DIESES Geraet selbst schon einmal angelegt hat. Ein
 * Rechner mit frischem Profil fand nichts, existing blieb null, und
 * plInboxDecide machte aus op:"update" ein "create": createEntity legte eine
 * Kopie mit frischer uuid an, der Titel doppelt, source blieb
 * "quantus-tablet". Der anschliessende Voll-Push dieses Rechners ueberschrieb
 * ausserdem meta.lastSavedBy des Tablets.
 *
 * Der Test laesst die ECHTEN Funktionen gegen Attrappen laufen.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

// Von plInboxDecide bis zum Ende von plInboxApply — decide, scrub, claim und
// apply liegen dort zusammen.
function cutInbox() {
  const start = index.indexOf("  function plInboxDecide(existing, entry){");
  const marke = index.indexOf('console.error("Polaris-Inbox: Merge fehlgeschlagen"', start);
  const end = index.indexOf("\n  }", index.indexOf("}", marke)) + 4;
  ok(start > 0 && end > start, "der Inbox-Block wurde in index.html nicht gefunden");
  return index.slice(start, end);
}
const INBOX_SRC = cutInbox();

const DEPS = [
  "window", "console", "Date",
  "POLARIS_BLOCKED_TYPES", "POLARIS_INBOX_CONTROL", "POLARIS_SENSITIVE_RE",
  "POLARIS_TYPE_MAP", "POLARIS_CANON_TYPES", "plSettings", "plParseTs", "plTypeLabel",
  "plScheduleSave", "plInboxActivity", "plDbSet", "plDbRef",
];

// Eine Firebase-Attrappe fuer ref.transaction auf dem claim-Kindknoten.
function makeClaimStore() {
  const knoten = {};            // pfad -> { by, at }
  const log = { transactions: 0, sets: [] };
  return {
    knoten, log,
    plDbRef: (pfad) => ({
      transaction(updateFn, cb) {
        log.transactions++;
        const aktuell = knoten[pfad] || null;
        const neu = updateFn(aktuell);
        if (neu === undefined) { setTimeout(() => cb(null, false, null), 0); return; }
        knoten[pfad] = neu;
        setTimeout(() => cb(null, true, null), 0);
      },
    }),
    plDbSet: async (pfad, wert) => { log.sets.push(pfad); knoten[pfad] = wert; },
  };
}

// Wie das echte uuid(): global eindeutig, NICHT pro Harness. Sonst vergaeben
// zwei Attrappen zufaellig dieselbe Id und der Wiederanlauf-Test (C) waere
// gegenstandslos.
let _uuidZaehler = 0;
function harness({ notes = {}, inboxMap = {}, deviceId = "dev_frisch_profil", claim = null, daten = null } = {}) {
  const c = claim || makeClaimStore();
  const log = { createEntity: [], updateEntity: [], activity: [], saves: 0 };
  const settings = { inboxMap };
  const win = {
    APP: { state: { data: daten || { entities: { notes } } } },
    getEntityMap: (kind) => (kind === "note" ? notes : null),
    getOrCreateDeviceId: () => deviceId,
    createEntity: (kind, data, forcedId) => {
      const id = (typeof forcedId === "string" && forcedId) ? forcedId : ("uuid-" + (++_uuidZaehler));
      log.createEntity.push({ kind, id, data });
      notes[id] = Object.assign({ id, createdAt: "neu", updatedAt: "neu" }, data);
      return id;
    },
    updateEntity: (kind, id, data) => { log.updateEntity.push({ kind, id, data }); Object.assign(notes[id], data); },
    nowIso: () => "2026-08-23T20:26:57.950Z",
    render: () => {},
  };
  const api = new Function(...DEPS, INBOX_SRC +
    "\nreturn { plInboxDecide, plInboxApply, plInboxClaim, inFlight: _plInboxInFlight, owner: plInboxOwner };")(
    win, { log() {}, warn() {}, error: (...a) => { if (process.env.PL_DEBUG) console.error("  [inbox]", ...a); } }, Date,
    new Set(["password", "vault"]),
    JSON.parse(JSON.stringify(["op","ts","updatedAt","createdAt","processedAt","processedBy","id","inboxId","claim"])),
    /password|passwort|secret|token/i,
    { note: { kind: "note" } }, new Set(["note"]), () => settings,
    (v) => (v == null ? 0 : (typeof v === "number" ? v : Date.parse(v) || 0)),
    () => "Notiz",
    () => { log.saves++; }, (...a) => log.activity.push(a),
    c.plDbSet, c.plDbRef,
  );
  return { api, log, notes, settings, claimStore: c, win };
}

const LONDON = "mo7ob010bvrg76mk0";
const TITEL_ALT = "London [Q-S4-MOBILE-20260823-1608]";
const TITEL_NEU = "London [Q-S4-MOBILE-20260823-1608] [Q-S4-TABLET-20260823-2227]";
// So spiegelt das Tablet: Schluessel = Entitaets-Id, record.id ebenso.
const spiegel = (id, titel, ts) => ({
  id, title: titel, op: "update", ts: Date.parse(ts), updatedAt: ts, source: "quantus-tablet",
});

// ── 1. Leerer inboxMap + bestehende Id → update/skip, NIE create ──────────
{
  const notes = { [LONDON]: { id: LONDON, title: TITEL_ALT, updatedAt: "2026-08-23T20:14:00.000Z" } };
  const h = harness({ notes, inboxMap: {} });
  await h.api.plInboxApply("note", LONDON, spiegel(LONDON, TITEL_NEU, "2026-08-23T20:26:57.950Z"));

  ok(h.log.createEntity.length === 0,
    `es wurde eine Kopie angelegt (${h.log.createEntity.length}) — genau der Produktionsfehler`);
  ok(Object.keys(h.notes).length === 1,
    `aus einer Notiz wurden ${Object.keys(h.notes).length}`);
  ok(h.log.updateEntity.length === 1, "die bestehende Notiz wurde nicht aktualisiert");
  ok(h.log.updateEntity[0].id === LONDON, `aktualisiert wurde "${h.log.updateEntity[0].id}" statt ${LONDON}`);
  ok(h.notes[LONDON].title === TITEL_NEU, "der neue Titel kam nicht an");
  ok(h.settings.inboxMap["note/" + LONDON] === LONDON,
    "die Zuordnung wurde nicht in den geraetelokalen Index uebernommen");
  ok(!Object.prototype.hasOwnProperty.call(h.log.updateEntity[0].data, "claim"),
    "das Steuerfeld claim ist in die Entitaet gewandert");
}

// ── 1b. Aelterer Spiegelsatz auf bekannter Id → skip, kein create ─────────
{
  const notes = { [LONDON]: { id: LONDON, title: TITEL_NEU, updatedAt: "2026-08-23T20:26:59.977Z" } };
  const h = harness({ notes, inboxMap: {} });
  await h.api.plInboxApply("note", LONDON, spiegel(LONDON, TITEL_ALT, "2026-08-23T20:26:57.950Z"));
  ok(h.log.createEntity.length === 0, "ein aelterer Spiegelsatz erzeugte eine Kopie");
  ok(h.log.updateEntity.length === 0, "ein aelterer Spiegelsatz ueberschrieb den neueren Stand");
  ok(h.notes[LONDON].title === TITEL_NEU, "der neuere Titel wurde zurueckgesetzt");
}

// ── 2. Unbekannte Id → weiterhin create (produktiver n8n-Fall) ───────────
{
  const notes = { [LONDON]: { id: LONDON, title: TITEL_ALT, updatedAt: "2026-08-23T20:14:00.000Z" } };
  const h = harness({ notes, inboxMap: {} });
  await h.api.plInboxApply("note", "n8n-neu-1", { id: "n8n-neu-1", title: "Von n8n", op: "update", ts: 1, updatedAt: "2026-08-23T21:00:00.000Z" });
  ok(h.log.createEntity.length === 1, "eine unbekannte Id erzeugt keine neue Notiz mehr — Rueckschritt fuer n8n");
  ok(Object.keys(h.notes).length === 2, "die neue Notiz fehlt");
  ok(h.settings.inboxMap["note/n8n-neu-1"] === h.log.createEntity[0].id, "die neue Zuordnung wurde nicht gebunden");
}

// ── 3. Zwei Geraete, beide leerer inboxMap → genau EINE Entitaet ─────────
{
  const c = makeClaimStore();
  const notes = { [LONDON]: { id: LONDON, title: TITEL_ALT, updatedAt: "2026-08-23T20:14:00.000Z" } };
  const a = harness({ notes, inboxMap: {}, deviceId: "dev_aaa", claim: c });
  const b = harness({ notes, inboxMap: {}, deviceId: "dev_bbb", claim: c });
  const eintrag = spiegel(LONDON, TITEL_NEU, "2026-08-23T20:26:57.950Z");
  await Promise.all([
    a.api.plInboxApply("note", LONDON, eintrag),
    b.api.plInboxApply("note", LONDON, eintrag),
  ]);
  ok(Object.keys(notes).length === 1, `zwei Geraete erzeugten ${Object.keys(notes).length} Notizen`);
  ok(a.log.createEntity.length + b.log.createEntity.length === 0, "ein Geraet legte eine Kopie an");
  const anwendungen = a.log.updateEntity.length + b.log.updateEntity.length;
  ok(anwendungen === 1, `die Operation wurde ${anwendungen}-mal angewendet statt genau einmal`);
  ok(c.log.transactions >= 2, "der Anspruch lief nicht als Transaktion");
  const claimKnoten = c.knoten["polaris/inbox/note/" + LONDON + "/claim"];
  ok(claimKnoten && /^dev_(aaa|bbb)#/.test(String(claimKnoten.by)),
    `der Anspruch traegt keine Instanz-Kennung: ${claimKnoten && claimKnoten.by}`);
}

// ── 4. Idempotenz: create, update und delete mehrfach ────────────────────
{
  const notes = { [LONDON]: { id: LONDON, title: TITEL_ALT, updatedAt: "2026-08-23T20:14:00.000Z" } };
  const h = harness({ notes, inboxMap: {} });
  const e = spiegel(LONDON, TITEL_NEU, "2026-08-23T20:26:57.950Z");
  await h.api.plInboxApply("note", LONDON, e);
  await h.api.plInboxApply("note", LONDON, e);              // derselbe Eintrag erneut
  ok(Object.keys(h.notes).length === 1, "die Wiederholung erzeugte eine Kopie");
  ok(h.log.updateEntity.length === 1, `die Wiederholung wendete erneut an (${h.log.updateEntity.length}x)`);

  // Verarbeiteter Eintrag (processedAt gesetzt) → immer skip
  const h2 = harness({ notes: { [LONDON]: { id: LONDON, title: TITEL_ALT } }, inboxMap: {} });
  await h2.api.plInboxApply("note", LONDON, Object.assign({}, e, { processedAt: 1 }));
  ok(h2.log.updateEntity.length === 0 && h2.log.createEntity.length === 0,
    "ein bereits verarbeiteter Eintrag wurde erneut angewendet");

  // delete auf bekannter Id → Soft-Delete, zweimal ist idempotent
  const notes3 = { [LONDON]: { id: LONDON, title: TITEL_NEU, updatedAt: "2026-08-23T20:00:00.000Z" } };
  const h3 = harness({ notes: notes3, inboxMap: {} });
  const del = { id: LONDON, op: "delete", ts: 9, updatedAt: "2026-08-23T21:00:00.000Z" };
  await h3.api.plInboxApply("note", LONDON, del);
  ok(notes3[LONDON].status === "deleted", "delete auf bekannter Id wirkte nicht");
  const vorher = h3.log.updateEntity.length;
  await h3.api.plInboxApply("note", LONDON, del);
  ok(h3.log.updateEntity.length === vorher, "das zweite delete war nicht idempotent");
  ok(Object.keys(notes3).length === 1, "delete erzeugte eine Kopie");
}

// ── 5. Der Anspruch schuetzt, verliert aber nichts ───────────────────────
{
  const src = INBOX_SRC;
  ok(/function plInboxClaim/.test(src), "plInboxClaim fehlt");
  ok(/PL_INBOX_CLAIM_MS/.test(src), "der Anspruch hat keine Frist");
  const claimFn = src.slice(src.indexOf("async function plInboxClaim"), src.indexOf("async function plInboxApply"));
  ok(!/processedAt/.test(claimFn), "der Anspruch setzt processedAt — eine Operation ginge beim Absturz verloren");
  const applyFn = src.slice(src.indexOf("async function plInboxApply"));
  const anspruchPos = applyFn.indexOf("plInboxClaim(");
  const processedPos = applyFn.indexOf('"/processedAt"');
  ok(anspruchPos > 0 && processedPos > anspruchPos,
    "processedAt wird vor der Anwendung geschrieben");
  ok(/_plInboxInFlight/.test(applyFn), "der Riegel gegen den eigenen Listener fehlt");

  // Abgelaufene Frist: ein anderes Geraet darf uebernehmen (Wiederanlauf).
  const c = makeClaimStore();
  c.knoten["polaris/inbox/note/" + LONDON + "/claim"] = { by: "dev_abgestuerzt", at: Date.now() - 120000 };
  const notes = { [LONDON]: { id: LONDON, title: TITEL_ALT, updatedAt: "2026-08-23T20:14:00.000Z" } };
  const h = harness({ notes, inboxMap: {}, deviceId: "dev_nachfolger", claim: c });
  await h.api.plInboxApply("note", LONDON, spiegel(LONDON, TITEL_NEU, "2026-08-23T20:26:57.950Z"));
  ok(h.log.updateEntity.length === 1, "nach abgelaufener Frist wurde die Operation nicht nachgeholt");
  ok(/^dev_nachfolger#/.test(String(c.knoten["polaris/inbox/note/" + LONDON + "/claim"].by)),
    "der abgelaufene Anspruch wurde nicht uebernommen");
  ok(c.log.sets.some((p) => p.endsWith("/processedAt")), "processedAt wurde nach dem Erfolg nicht gesetzt");
  ok(c.log.sets.some((p) => p.endsWith("/processedBy")), "processedBy wurde nicht gesetzt");
}

// ── 6. Quelltextregeln ───────────────────────────────────────────────────
{
  ok(/"claim"\]/.test(index) && /POLARIS_INBOX_CONTROL = \[[^\]]*"claim"/.test(index),
    "claim fehlt in POLARIS_INBOX_CONTROL und koennte in eine Entitaet wandern");
  ok(/if \(!existing\)\{[\s\S]{0,400}?const kandidat = String\(\(entry && entry\.id\) \|\| inboxId \|\| ""\);/.test(INBOX_SRC),
    "die Id-Aufloesung fehlt");
  ok(/if \(!existing\) return "create";/.test(INBOX_SRC),
    "der create-Zweig fuer unbekannte Ids wurde entfernt");
}

// ── 7. E2E: Spiegelsatz des Tablets auf einem frischen Rechner ──────────
// Nachstellung des Produktionsvorgangs. Die Tablet-Seite selbst (eine Notiz,
// meta.lastSavedBy = "tablet-app", keine neue Wurzel) prueft die Suite des
// Tablet-Repos; hier zaehlt, was der Rechner daraus macht.
{
  const notes = { [LONDON]: { id: LONDON, title: TITEL_ALT, updatedAt: "2026-08-23T20:14:00.000Z" } };
  const daten = {
    entities: { notes },
    meta: { updatedAt: "2026-08-23T20:26:59.977Z", lastSavedBy: "tablet-app" },
    _importedBelege: ["B1"], _nextBelegNr: 7, journal: { documents: [] }, timers: {},
  };
  const wurzelnVorher = Object.keys(daten).sort().join(",");
  const h = harness({ notes, inboxMap: {}, daten });
  await h.api.plInboxApply("note", LONDON, spiegel(LONDON, TITEL_NEU, "2026-08-23T20:26:57.950Z"));

  const idsDanach = Object.keys(notes);
  ok(idsDanach.length === 1, `aus einer Notiz wurden ${idsDanach.length} — das Produktionssymptom`);
  ok(idsDanach[0] === LONDON, `die Id wechselte auf "${idsDanach[0]}"`);
  ok(h.log.createEntity.length === 0, "der Rechner legte eine Kopie an");
  ok(!idsDanach.some((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id)),
    "es entstand eine Notiz mit frischer uuid");
  ok(notes[LONDON].source === "quantus-tablet", "die Herkunft ging verloren");
  ok(Object.keys(daten).sort().join(",") === wurzelnVorher,
    "der Inbox-Pfad hat eine Wurzel hinzugefuegt oder entfernt");
  ok(daten.meta.lastSavedBy === "tablet-app",
    "der Inbox-Pfad hat meta.lastSavedBy ueberschrieben");
  ok(daten._nextBelegNr === 7 && daten._importedBelege.length === 1, "Fachwurzeln wurden veraendert");
}

/* ══════════════════════════════════════════════════════════════════════════
 * Die drei Blocker aus der Remote-Gegenpruefung
 * ══════════════════════════════════════════════════════════════════════════ */

// ── A. Wirft die Anwendung, wird der Riegel trotzdem frei ────────────────
// Vorher lagen rawType und mapKey INNERHALB des try; im catch waren sie
// lexikalisch unsichtbar, das Aufraeumen warf einen ReferenceError, der
// verschluckt wurde — der Schluessel blieb dauerhaft gesperrt.
{
  const notes = { [LONDON]: { id: LONDON, title: TITEL_ALT, updatedAt: "2026-08-23T20:14:00.000Z" } };
  const h = harness({ notes, inboxMap: {} });
  let werfen = true;
  const echt = h.api;                       // updateEntity aus dem Fenster ersetzen
  const eintrag = spiegel(LONDON, TITEL_NEU, "2026-08-23T20:26:57.950Z");
  h.win.updateEntity = () => { if (werfen) throw new Error("Anwendung fehlgeschlagen"); h.log.updateEntity.push({ id: LONDON }); notes[LONDON].title = TITEL_NEU; };

  await echt.plInboxApply("note", LONDON, eintrag);
  ok(echt.inFlight.size === 0,
    `nach einem Fehler bleiben ${echt.inFlight.size} Eintraege im Riegel — der Tab kann sie nie wiederholen`);
  ok(notes[LONDON].title === TITEL_ALT, "trotz Wurf wurde angewendet");

  werfen = false;                            // Wiederholung muss jetzt greifen
  await echt.plInboxApply("note", LONDON, eintrag);
  ok(notes[LONDON].title === TITEL_NEU, "die Wiederholung nach einem Fehler wirkt nicht");
  ok(echt.inFlight.size === 0, "der Riegel bleibt nach dem erfolgreichen Lauf belegt");
}

// ── A2. Auch ein fehlgeschlagener Anspruch belegt den Riegel nicht ───────
{
  const c = makeClaimStore();
  c.knoten["polaris/inbox/note/" + LONDON + "/claim"] = { by: "fremd#xyz", at: Date.now() };
  const notes = { [LONDON]: { id: LONDON, title: TITEL_ALT, updatedAt: "2026-08-23T20:14:00.000Z" } };
  const h = harness({ notes, inboxMap: {}, claim: c });
  await h.api.plInboxApply("note", LONDON, spiegel(LONDON, TITEL_NEU, "2026-08-23T20:26:57.950Z"));
  ok(h.log.updateEntity.length === 0, "der fremde Anspruch wurde uebergangen");
  ok(h.api.inFlight.size === 0, "ein abgelehnter Anspruch laesst den Riegel belegt");
}

// ── B. Zwei Tabs DESSELBEN Geraets → genau eine Anwendung ───────────────
// getOrCreateDeviceId ist pro Browserprofil stabil. Ohne eigene Kennung je
// Listener-Instanz haetten beide Tabs denselben Anspruch erneuern duerfen.
{
  const c = makeClaimStore();
  const notes = { [LONDON]: { id: LONDON, title: TITEL_ALT, updatedAt: "2026-08-23T20:14:00.000Z" } };
  const tabA = harness({ notes, inboxMap: {}, deviceId: "dev_gleiches_geraet", claim: c });
  const tabB = harness({ notes, inboxMap: {}, deviceId: "dev_gleiches_geraet", claim: c });
  ok(tabA.api.owner() !== tabB.api.owner(),
    "beide Tabs desselben Geraets teilen dieselbe Anspruchskennung");
  ok(tabA.api.owner().startsWith("dev_gleiches_geraet#"), "die Kennung nennt das Geraet nicht");

  const eintrag = spiegel(LONDON, TITEL_NEU, "2026-08-23T20:26:57.950Z");
  await Promise.all([
    tabA.api.plInboxApply("note", LONDON, eintrag),
    tabB.api.plInboxApply("note", LONDON, eintrag),
  ]);
  const anwendungen = tabA.log.updateEntity.length + tabB.log.updateEntity.length;
  ok(anwendungen === 1, `zwei Tabs desselben Geraets wendeten ${anwendungen}-mal an`);
  ok(tabA.log.createEntity.length + tabB.log.createEntity.length === 0, "ein Tab legte eine Kopie an");
  ok(Object.keys(notes).length === 1, `es entstanden ${Object.keys(notes).length} Notizen`);
}

// ── C. Wiederanlauf bei UNBEKANNTER Id ist idempotent ───────────────────
// Geraet A erzeugt und stuerzt VOR processedAt ab. Nach Ablauf der Frist
// uebernimmt Geraet B mit leerem inboxMap. Weil die Erzeugung deterministisch
// aus der Eintrags-Id erfolgt, entsteht keine zweite Entitaet.
{
  const NEU = "n8n-unbekannt-1";
  const eintrag = { id: NEU, title: "Von n8n", op: "update", ts: 1, updatedAt: "2026-08-23T21:00:00.000Z" };

  // A: erzeugt, dann Absturz vor processedAt (plDbSet wirft)
  const cA = makeClaimStore();
  const setEcht = cA.plDbSet;
  cA.plDbSet = async (pfad, wert) => {
    if (pfad.endsWith("/processedAt")) throw new Error("Absturz vor processedAt");
    return setEcht(pfad, wert);
  };
  const notesA = {};
  const a = harness({ notes: notesA, inboxMap: {}, deviceId: "dev_A", claim: cA });
  await a.api.plInboxApply("note", NEU, eintrag);
  const idA = Object.keys(notesA)[0];
  ok(Object.keys(notesA).length === 1, "Geraet A hat nichts erzeugt");
  ok(idA === NEU, `Geraet A erzeugte "${idA}" statt der Eintrags-Id — nicht deterministisch`);
  ok(!cA.log.sets.some((p) => p.endsWith("/processedAt")), "processedAt wurde trotz Absturz gesetzt");

  // B: eigener Tab, eigener leerer Index, eigener lokaler Stand (A hat nie gepusht).
  // Die Frist ist abgelaufen.
  cA.knoten["polaris/inbox/note/" + NEU + "/claim"].at = Date.now() - 120000;
  const notesB = {};
  const b = harness({ notes: notesB, inboxMap: {}, deviceId: "dev_B", claim: cA });
  await b.api.plInboxApply("note", NEU, eintrag);
  const idB = Object.keys(notesB)[0];
  ok(Object.keys(notesB).length === 1, "Geraet B hat nichts erzeugt");
  ok(idB === idA,
    `B erzeugte "${idB}" statt "${idA}" — nach dem Merge entstuenden zwei Entitaeten`);

  // Und wenn B den Stand von A bereits gemergt hat: kein zweiter Datensatz.
  const notesC = { [NEU]: Object.assign({}, notesA[NEU]) };
  const cc = harness({ notes: notesC, inboxMap: {}, deviceId: "dev_C", claim: cA });
  cA.knoten["polaris/inbox/note/" + NEU + "/claim"].at = Date.now() - 120000;
  await cc.api.plInboxApply("note", NEU, eintrag);
  ok(Object.keys(notesC).length === 1,
    `nach dem Merge erzeugte der Wiederanlauf ${Object.keys(notesC).length} Entitaeten`);
  ok(cc.log.createEntity.length === 0, "der Wiederanlauf legte eine Kopie an");
}

// ── C2. Quelltextregeln zu den drei Blockern ────────────────────────────
{
  const apply = INBOX_SRC.slice(INBOX_SRC.indexOf("async function plInboxApply"));
  ok(/const rawType = String\(type \|\| ""\);\s*\n\s*const mapKey/.test(INBOX_SRC),
    "rawType/mapKey liegen wieder innerhalb des try");
  ok(/\} finally \{[\s\S]{0,200}?if \(belegt\) _plInboxInFlight\.delete\(mapKey\);/.test(apply),
    "der Riegel wird nicht in einem finally freigegeben");
  ok(/function plInboxOwner\(\)/.test(INBOX_SRC), "die Kennung je Listener-Instanz fehlt");
  ok(/const dev = plInboxOwner\(\);/.test(INBOX_SRC), "der Anspruch nutzt die Instanz-Kennung nicht");
  ok(/const festeId = String\(\(entry && entry\.id\) \|\| inboxId \|\| ""\)/.test(apply),
    "die Erzeugung ist nicht deterministisch");
  ok(/window\.createEntity\(store\.kind, data, festeId\)/.test(apply),
    "createEntity bekommt die feste Id nicht");
  // processedBy behaelt die stabile Geraete-Id
  ok(/getOrCreateDeviceId\(\) : "web";\s*\n\s*await plDbSet\(.*processedBy/.test(apply) ||
     /const dev = \(typeof window\.getOrCreateDeviceId/.test(apply),
    "processedBy nutzt nicht mehr die stabile Geraete-Id");
}

console.log(`polaris inbox dedupe: ok (${checks} Pruefungen)`);
