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
  // APP zusaetzlich zu window: plResolveStore greift im Direktmap-Zweig auf das
  // globale APP zu, nicht auf window.APP. Im Browser ist das dieselbe Bindung,
  // in der Attrappe waere es sonst ein verschluckter ReferenceError.
  "window", "APP", "console", "Date",
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
function harness({ notes = {}, inboxMap = {}, deviceId = "dev_frisch_profil", claim = null, daten = null, canon = ["note"] } = {}) {
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
      // wie das echte createEntity seit dem Prototyp-Fix: defineProperty,
      // damit auch die Id "__proto__" eine EIGENE Eigenschaft wird
      Object.defineProperty(notes, id, { value: Object.assign({ id, createdAt: "neu", updatedAt: "neu" }, data),
        writable: true, enumerable: true, configurable: true });
      return id;
    },
    updateEntity: (kind, id, data) => { log.updateEntity.push({ kind, id, data });
      const ziel = Object.prototype.hasOwnProperty.call(notes, id) ? notes[id] : null;
      if (ziel) Object.assign(ziel, data); },
    nowIso: () => "2026-08-23T20:26:57.950Z",
    render: () => {},
  };
  const api = new Function(...DEPS, INBOX_SRC +
    "\nreturn { plInboxDecide, plInboxApply, plInboxClaim, inFlight: _plInboxInFlight, owner: plInboxOwner };")(
    win, win.APP, { log() {}, warn() {}, error: (...a) => { if (process.env.PL_DEBUG) console.error("  [inbox]", ...a); } }, Date,
    new Set(["password", "vault"]),
    JSON.parse(JSON.stringify(["op","ts","updatedAt","createdAt","processedAt","processedBy","id","inboxId","claim"])),
    /password|passwort|secret|token/i,
    { note: { kind: "note" } }, new Set(canon), () => settings,
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

// ── P. Prototyp-Schluessel als Entitaets-Id ─────────────────────────────
// polaris/inbox ist derzeit ohne Anmeldung beschreibbar (F-02), und RTDB
// erlaubt "__proto__" als Kindschluessel. Zwei getrennte Loecher:
//   SCHREIBEN  map["__proto__"] = entity legt keine Entitaet an, sondern
//              tauscht den Prototyp der Map. hasOwnProperty false, Object.keys
//              leer — der Datensatz existiert nicht.
//   LESEN      map["toString"] liefert die geerbte Funktion, also truthy. Der
//              Aufrufer haelt sie fuer eine bestehende Entitaet und der
//              Update-Pfad legt danach ein Object.assign auf
//              Object.prototype.toString — ab da sieht JEDES Objekt der App
//              die fremden Felder.
const PROTO_IDS = ["__proto__", "constructor", "toString"];
const protoUnberuehrt = () => PROTO_IDS.every((k) =>
  !Object.prototype.hasOwnProperty.call(Object.prototype[k] || {}, "title"));

for (const BOES of PROTO_IDS) {
  const eintrag = (titel, ts) => ({
    id: BOES, title: titel, op: "update", ts: Date.parse(ts), updatedAt: ts, source: "quantus-tablet",
  });

  // P1 — frisches Geraet, leerer Index: erzeugen, aber prototypsicher
  const notes = {};
  const h = harness({ notes, inboxMap: {} });
  const protoVorher = Object.getPrototypeOf(notes);
  await h.api.plInboxApply("note", BOES, eintrag("Erst", "2026-08-23T20:00:00.000Z"));

  ok(Object.getPrototypeOf(h.notes) === protoVorher,
    `Id "${BOES}": der Prototyp der Entitaetskarte wurde ausgetauscht`);
  ok(Object.prototype.hasOwnProperty.call(h.notes, BOES),
    `Id "${BOES}": es entstand keine EIGENE Eigenschaft (hasOwnProperty false)`);
  ok(Object.keys(h.notes).includes(BOES),
    `Id "${BOES}": Object.keys enthaelt die Id nicht — der Datensatz waere unsichtbar`);
  ok(Object.keys(h.notes).length === 1,
    `Id "${BOES}": ${Object.keys(h.notes).length} eigene Entitaeten statt genau einer`);
  ok(h.notes[BOES] && h.notes[BOES].title === "Erst",
    `Id "${BOES}": die Entitaet traegt den Titel nicht`);
  ok(h.log.createEntity.length === 1 && h.log.updateEntity.length === 0,
    `Id "${BOES}": ein geerbtes Object.prototype-Mitglied wurde als bestehende Entitaet gelesen ` +
    `(create=${h.log.createEntity.length}, update=${h.log.updateEntity.length})`);
  ok(protoUnberuehrt(),
    `Id "${BOES}": Object.prototype wurde beschrieben — Pollution ueber den Update-Pfad`);

  // P2 — zweiter Verbraucher, eigener leerer Index, gemeinsamer Datenstand:
  //      idempotent, also aktualisieren statt eine zweite Entitaet anlegen
  const claim2 = makeClaimStore();
  const h2 = harness({ notes: h.notes, inboxMap: {}, deviceId: "dev_zweit", claim: claim2 });
  await h2.api.plInboxApply("note", BOES, eintrag("Zweit", "2026-08-23T21:00:00.000Z"));

  ok(h2.log.createEntity.length === 0,
    `Id "${BOES}": der zweite Verbraucher legte eine Kopie an`);
  ok(Object.keys(h2.notes).length === 1,
    `Id "${BOES}": nach dem Wiederanlauf ${Object.keys(h2.notes).length} Entitaeten`);
  ok(h2.notes[BOES].title === "Zweit",
    `Id "${BOES}": der neuere Stand kam nicht an`);
  ok(Object.getPrototypeOf(h2.notes) === protoVorher && protoUnberuehrt(),
    `Id "${BOES}": der Wiederanlauf veraenderte einen Prototyp`);

  // P3 — geerbter Name NIE als bestehende Entitaet, auch nicht ueber den Index
  const h3 = harness({ notes: {}, inboxMap: { ["note/" + BOES]: BOES } });
  await h3.api.plInboxApply("note", BOES, eintrag("Dritt", "2026-08-23T22:00:00.000Z"));
  ok(h3.log.updateEntity.length === 0,
    `Id "${BOES}": ein Index-Eintrag auf eine NICHT vorhandene Entitaet fuehrte zu einem Update ` +
    `auf ein geerbtes Mitglied`);
  ok(Object.keys(h3.notes).length === 1 && protoUnberuehrt(),
    `Id "${BOES}": ueber den Index entstand kein sauberer eigener Datensatz`);
}

// P4 — die normale Tablet-Id verhaelt sich unveraendert
{
  const notes = { [LONDON]: { id: LONDON, title: TITEL_ALT, updatedAt: "2026-08-23T20:14:00.000Z" } };
  const h = harness({ notes, inboxMap: {} });
  await h.api.plInboxApply("note", LONDON, spiegel(LONDON, TITEL_NEU, "2026-08-23T20:26:57.950Z"));
  ok(h.log.createEntity.length === 0 && h.log.updateEntity.length === 1,
    "die normale Tablet-Id wird nicht mehr exakt aktualisiert");
  ok(h.log.updateEntity[0].id === LONDON && h.notes[LONDON].title === TITEL_NEU,
    "die bestehende Notiz wurde nicht getroffen");
  ok(Object.keys(h.notes).length === 1, "aus einer Notiz wurden mehrere");
}

// P5 — "__proto__" als FELDname der Nutzlast wird nicht uebernommen.
// Object.assign(ziel, data) benutzt [[Set]] und wuerde damit den Prototyp des
// Ziels tauschen statt ein Feld zu setzen.
{
  const notes = {};
  const h = harness({ notes, inboxMap: {} });
  const nutzlast = JSON.parse('{"id":"feld-1","title":"Harmlos","op":"update","ts":1,' +
    '"updatedAt":"2026-08-23T20:00:00.000Z","__proto__":{"polluted":true}}');
  await h.api.plInboxApply("note", "feld-1", nutzlast);
  const e = h.notes["feld-1"];
  ok(e && Object.getPrototypeOf(e) === Object.prototype,
    "der Prototyp der erzeugten Entitaet wurde ueber ein Nutzlast-Feld getauscht");
  ok(({}).polluted === undefined, "Object.prototype traegt jetzt ein Feld aus der Nutzlast");
  ok(!Object.prototype.hasOwnProperty.call(e, "__proto__"),
    "das Feld __proto__ wurde in die Entitaet uebernommen");
}

// P5b — DIREKTMAP-Zweig (store.viaApi === false). Dort schreibt und liest
// plInboxApply ohne Umweg ueber createEntity/updateEntity; genau in diesem
// Zweig stand vorher Object.assign(store.map["toString"], data) — ein
// Object.assign auf Object.prototype.toString, sichtbar fuer die ganze App.
{
  const DIREKT = "idee";   // kanonisch, aber ohne kind → e["polaris_idee"]
  for (const BOES of PROTO_IDS) {
    const daten = { entities: {} };
    const h = harness({ daten, inboxMap: {}, canon: ["note", DIREKT] });
    const eintrag = (t, ts) => ({ id: BOES, title: t, op: "update", ts: Date.parse(ts), updatedAt: ts });

    await h.api.plInboxApply(DIREKT, BOES, eintrag("Erst", "2026-08-23T20:00:00.000Z"));
    const map = daten.entities["polaris_" + DIREKT];
    ok(map && Object.prototype.hasOwnProperty.call(map, BOES),
      `Direktmap, Id "${BOES}": keine eigene Eigenschaft angelegt`);
    ok(Object.keys(map).length === 1 && map[BOES].title === "Erst",
      `Direktmap, Id "${BOES}": ${map ? Object.keys(map).length : 0} Eintraege statt genau einem`);
    ok(Object.getPrototypeOf(map) === Object.prototype,
      `Direktmap, Id "${BOES}": der Prototyp der Karte wurde getauscht`);
    ok(protoUnberuehrt() && Object.keys(Object.prototype).length === 0,
      `Direktmap, Id "${BOES}": Object.prototype wurde beschrieben`);

    // zweiter Durchlauf auf demselben Stand: aktualisieren, nicht verdoppeln
    const h2 = harness({ daten, inboxMap: {}, deviceId: "dev_zweit", claim: makeClaimStore(), canon: ["note", DIREKT] });
    await h2.api.plInboxApply(DIREKT, BOES, eintrag("Zweit", "2026-08-23T21:00:00.000Z"));
    ok(Object.keys(map).length === 1 && map[BOES].title === "Zweit",
      `Direktmap, Id "${BOES}": der Wiederanlauf war nicht idempotent`);
    ok(protoUnberuehrt(), `Direktmap, Id "${BOES}": der Wiederanlauf beschrieb Object.prototype`);
  }
}

// P6 — Quelltextregeln: kein roher Map-Zugriff mehr auf diesem Pfad
{
  const apply = INBOX_SRC.slice(INBOX_SRC.indexOf("async function plInboxApply"));
  ok(/Object\.prototype\.hasOwnProperty\.call\(map, id\)/.test(INBOX_SRC),
    "plOwn prueft nicht auf eine eigene Eigenschaft");
  ok(/Object\.defineProperty\(map, id, \{ value: wert, writable: true, enumerable: true, configurable: true \}\)/.test(INBOX_SRC),
    "plSetOwn schreibt nicht prototypsicher");
  ok(!/store\.map\[(appId|kandidat|newId|k)\]/.test(apply),
    "es gibt wieder einen rohen store.map[...]-Zugriff im Apply-Pfad");
  ok(/plOwn\(store\.map, appId\)/.test(apply) && /plOwn\(store\.map, kandidat\)/.test(apply),
    "Index-Treffer und Kandidat laufen nicht ueber plOwn");
  ok(/plSetOwn\(store\.map, newId,/.test(apply),
    "die Direkterzeugung schreibt nicht ueber plSetOwn");
  ok(/let appId = plOwnStr\(s\.inboxMap, mapKey\);/.test(apply),
    "der Index wird nicht als eigene Eigenschaft gelesen");
  ok(/if \(k === "__proto__"\) return;/.test(INBOX_SRC),
    "plInboxScrub laesst __proto__ als Feldnamen durch");
}

// ── Q. Kern-CRUD: dieselbe Semantik fuer get/update/delete ───────────────
// createEntity, getEntity und deleteEntity liegen im Kernblock, nicht im
// Inbox-Ausschnitt. Sie werden hier einzeln herausgeschnitten und gegen
// Attrappen ausgefuehrt — es sind die ECHTEN Funktionen.
{
  const schnipsel = (name) => {
    const a = index.indexOf("\nfunction " + name + "(");
    ok(a > 0, `die Funktion ${name} wurde in index.html nicht gefunden`);
    const b = index.indexOf("\n}", a) + 2;
    return index.slice(a, b);
  };
  const KERN = ["ownEntity", "setOwnEntity", "getEntity", "createEntity", "updateEntity", "deleteEntity"]
    .map(schnipsel).join("\n");

  const bauen = () => {
    const notes = {};
    const APP = { state: { data: { entities: { notes }, meta: {}, pinnedItems: [] }, undoStack: [] } };
    let zaehler = 0;
    const api = new Function("APP", "getEntityMap", "uuid", "nowIso", "logActivity", "logDeletion",
      "scheduleSave", "deepClone", "updateUndoButton", "cleanupLinks",
      KERN + "\nreturn { getEntity, createEntity, updateEntity, deleteEntity };")(
      APP, (k) => (k === "note" ? notes : null), () => "uuid-" + (++zaehler), () => "jetzt",
      () => {}, () => {}, () => {}, (o) => JSON.parse(JSON.stringify(o)), () => {}, () => {});
    return { api, notes, APP };
  };

  for (const BOES of PROTO_IDS) {
    const { api, notes } = bauen();
    const protoVorher = Object.getPrototypeOf(notes);

    // getEntity darf ein geerbtes Mitglied nicht als Entitaet melden
    // Ein Wurf ist genauso ein Fehlschlag wie ein falscher Rueckgabewert: auf dem
    // Vorgaengerstand liest updateEntity die geerbte Funktion und wirft dann in
    // deepClone (JSON.stringify einer Funktion ist undefined). Deshalb einfangen
    // statt den Lauf abbrechen zu lassen.
    const ruf = (f) => { try { return f(); } catch (e) { return e.constructor.name + ": " + e.message; } };
    ok(ruf(() => api.getEntity("note", BOES)) === null,
      `getEntity("${BOES}") meldete ein geerbtes Object.prototype-Mitglied als Entitaet`);
    ok(ruf(() => api.updateEntity("note", BOES, { title: "VERGIFTET" })) === false,
      `updateEntity("${BOES}") lehnte ein nicht vorhandenes Ziel nicht sauber ab`);
    ok(ruf(() => api.deleteEntity("note", BOES)) === false,
      `deleteEntity("${BOES}") lehnte ein geerbtes Mitglied nicht sauber ab`);
    ok(!Object.prototype.hasOwnProperty.call(Object.prototype[BOES] || {}, "title"),
      `Object.prototype.${BOES} wurde beschrieben`);

    // createEntity legt eine eigene, aufzaehlbare Eigenschaft an
    const id = api.createEntity("note", { title: "Echt" }, BOES);
    ok(id === BOES, `createEntity gab "${id}" statt "${BOES}" zurueck`);
    ok(Object.prototype.hasOwnProperty.call(notes, BOES) && Object.keys(notes).includes(BOES),
      `createEntity("${BOES}") legte keine eigene, aufzaehlbare Eigenschaft an`);
    ok(Object.getPrototypeOf(notes) === protoVorher, `createEntity("${BOES}") tauschte den Prototyp`);
    ok(Object.keys(notes).length === 1, `nach createEntity ${Object.keys(notes).length} Eintraege`);

    // Speichern und Neuladen erhaelt sie
    const rt = JSON.parse(JSON.stringify(notes));
    ok(Object.prototype.hasOwnProperty.call(rt, BOES) && Object.keys(rt).includes(BOES),
      `nach JSON-Runde ist "${BOES}" keine eigene Eigenschaft mehr`);
    ok(Object.getPrototypeOf(rt) === Object.prototype,
      `die JSON-Runde tauschte den Prototyp bei "${BOES}"`);
    ok(rt[BOES] && rt[BOES].title === "Echt", `nach der JSON-Runde fehlt der Inhalt von "${BOES}"`);

    // und ab jetzt greifen get/update/delete darauf
    ok(api.getEntity("note", BOES) === notes[BOES], `getEntity findet die eigene Entitaet "${BOES}" nicht`);
    ok(api.updateEntity("note", BOES, { title: "Neu" }) === true && notes[BOES].title === "Neu",
      `updateEntity trifft die eigene Entitaet "${BOES}" nicht`);
    ok(api.deleteEntity("note", BOES) === true && !Object.prototype.hasOwnProperty.call(notes, BOES),
      `deleteEntity entfernt die eigene Entitaet "${BOES}" nicht`);
    ok(Object.getPrototypeOf(notes) === protoVorher, `deleteEntity("${BOES}") tauschte den Prototyp`);
  }

  // normale Ids unveraendert
  {
    const { api, notes } = bauen();
    const id = api.createEntity("note", { title: "Normal" });
    ok(id === "uuid-1" && notes[id].title === "Normal", "eine normale Id verhaelt sich nicht mehr wie bisher");
    ok(api.getEntity("note", id) === notes[id], "getEntity findet eine normale Entitaet nicht");
    ok(api.updateEntity("note", id, { title: "N2" }) === true && notes[id].title === "N2",
      "updateEntity trifft eine normale Entitaet nicht");
    const feste = api.createEntity("note", { title: "Fest" }, "tablet-id-1");
    ok(feste === "tablet-id-1" && notes["tablet-id-1"].title === "Fest",
      "die feste Id aus F-23 C funktioniert nicht mehr");
    ok(api.deleteEntity("note", id) === true && !(id in notes), "deleteEntity entfernt eine normale Entitaet nicht");
    ok(api.getEntity("note", "gibtsnicht") === null, "getEntity meldet eine unbekannte Id als Treffer");
  }
}

// Abschluss: Object.prototype traegt nach allen Laeufen keine fremden Felder
ok(Object.keys(Object.prototype).length === 0,
  `Object.prototype hat aufzaehlbare Eigenschaften: ${Object.keys(Object.prototype).join(", ")}`);

console.log(`polaris inbox dedupe: ok (${checks} Pruefungen)`);
