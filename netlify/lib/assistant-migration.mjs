/* ══ Tagesbriefing v3 — Kern lesen und migrieren ════════════════════════════
 *
 * Der reale Bestand liegt als JSON-String in appStore/app-data_json. Dieses
 * Modul nimmt den GEPARSTEN Bestand entgegen und liefert einen neuen,
 * migrierten Bestand zurueck — ohne Netz, ohne Uhr, ohne Zufall.
 *
 * Regeln:
 *   · Ein fehlender, unlesbarer oder strukturell kaputter Kern ist ein
 *     FEHLER. Es gibt keinen leeren Ersatzbestand, nichts wird "repariert",
 *     indem es geleert oder als erledigt gedeutet wird (F-25).
 *   · Die Migration ist versioniert und EINMALIG je Objekt: ein Objekt mit
 *     operationalStateSource wird nie wieder aus seinen Altfeldern
 *     abgeleitet — danach ist operationalState fuehrend.
 *   · Zweimal angewendet ergibt exakt dasselbe Ergebnis, auch mit anderem now.
 *   · Fremde Felder und _deleteLog bleiben unveraendert.
 *   · Unbekannte und MEHRDEUTIGE Altstatus werden als Migrationskonflikt
 *     sichtbar gefuehrt, nicht geraten.
 * ═════════════════════════════════════════════════════════════════════════ */
import {
  SCHEMA_VERSION, STATE_MODEL_VERSION, MAPPER, QUELLEN, RUN_PHASES, AUTOMATION_KARTEN, PFLICHT_STORES,
  leereAutomation, rollenAbleiten,
} from "./assistant-schema.mjs";
import { isoAus, istLokalDatum } from "./assistant-zeit.mjs";

export class CoreDocumentError extends Error {
  constructor(code, message) { super(message || code); this.code = code; this.status = 503; this.coreDocument = true; }
}

function istKarte(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    && [Object.prototype, null].includes(Object.getPrototypeOf(v));
}

/* Nimmt das Ergebnis von readAppDataDocument (oder den rohen Text) und
 * liefert den geparsten Bestand — oder wirft. */
export function parseCoreDocument(stored) {
  if (stored == null) throw new CoreDocumentError("CORE_MISSING", "Kernbestand fehlt (kein Dokument).");
  let text = null;
  if (typeof stored === "string") text = stored;
  else if (typeof stored === "object") {
    if (stored.exists === false) throw new CoreDocumentError("CORE_MISSING", "Kernbestand fehlt (exists=false).");
    if (typeof stored.data === "string") text = stored.data;
    else if (stored.parsed && typeof stored.parsed === "object") return pruefeBestand(stored.parsed);
  }
  if (typeof text !== "string" || !text.trim()) throw new CoreDocumentError("CORE_MISSING", "Kernbestand fehlt (leerer Text).");
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) {
    throw new CoreDocumentError("CORE_UNPARSEABLE", "Kernbestand ist kein gueltiges JSON: " + e.message);
  }
  return pruefeBestand(parsed);
}

/* Grundform: ein Objekt mit entities als Objekt. Jede Sammlung, die es gibt,
 * muss ein Objekt sein; ein Array oder Primitiv an dieser Stelle ist ein
 * korrupter Bestand, keine leere Sammlung. */
export function pruefeBestand(parsed) {
  if (!istKarte(parsed)) throw new CoreDocumentError("CORE_SHAPE", "Kernbestand ist kein Objekt.");
  if (!istKarte(parsed.entities)) throw new CoreDocumentError("CORE_NO_ENTITIES", "Kernbestand ohne entities-Objekt — das ist kein Quantus-Bestand.");
  for (const q of Object.values(QUELLEN)) {
    if (parsed.entities[q.store] !== undefined && !istKarte(parsed.entities[q.store])) throw new CoreDocumentError("CORE_STORE_CORRUPT", `entities.${q.store} ist keine Karte.`);
  }
  for (const k of ["notes", "projects", "chatgptNotes"]) {
    if (parsed.entities[k] !== undefined && !istKarte(parsed.entities[k])) throw new CoreDocumentError("CORE_STORE_CORRUPT", `entities.${k} ist keine Karte.`);
  }
  if (parsed.automation !== undefined && !istKarte(parsed.automation)) throw new CoreDocumentError("CORE_AUTOMATION_CORRUPT", "automation ist kein Objekt.");
  if (parsed.dailyBriefing !== undefined && !istKarte(parsed.dailyBriefing)) throw new CoreDocumentError("CORE_DAILYBRIEFING_CORRUPT", "dailyBriefing ist kein Objekt.");
  if (parsed.dailyBriefing && parsed.dailyBriefing.assistantRuns !== undefined && !istKarte(parsed.dailyBriefing.assistantRuns)) throw new CoreDocumentError("CORE_RUNS_CORRUPT", "dailyBriefing.assistantRuns ist keine Karte.");
  return parsed;
}

export function klon(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/* Hat der Bestand schon v3-Spuren? Dann ist er entweder ein vollstaendiger,
 * gueltiger v3-Kern (wiederholte Migration erlaubt: nur neue, noch nicht
 * gemappte Objekte) — oder er ist PARTIELL/KAPUTT, und dann ist die Migration
 * fail-closed. Es wird nie ein Ledger, eine Outbox, eine Revision, eine Lease
 * oder ein Marker "geheilt": das wuerde Replay-/Versandnachweise und die
 * monotone Revision zuruecksetzen. */
export function v3Spuren(data) {
  const spuren = [];
  if (data.automation !== undefined) spuren.push("automation");
  if (istKarte(data.dailyBriefing) && data.dailyBriefing.assistantRuns !== undefined) spuren.push("dailyBriefing.assistantRuns");
  for (const q of Object.values(QUELLEN)) {
    const store = data.entities[q.store];
    if (!istKarte(store)) continue;
    for (const [id, e] of Object.entries(store)) {
      if (istKarte(e) && (e.operationalStateSource !== undefined || e.operationalState !== undefined || e.operationalStateVersion !== undefined || e.operationalRoles !== undefined)) { spuren.push(`entities.${q.store}.${id}`); break; }
    }
  }
  return spuren;
}

function ergaenzeAutomation(data, bericht) {
  if (data.automation === undefined) { data.automation = leereAutomation(); bericht.created.push("automation"); }
}

function ergaenzeRuns(data, bericht) {
  if (data.dailyBriefing === undefined) { data.dailyBriefing = {}; bericht.created.push("dailyBriefing"); }
  if (data.dailyBriefing.assistantRuns === undefined) {
    data.dailyBriefing.assistantRuns = {};
    bericht.created.push("dailyBriefing.assistantRuns");
  }
}

/* Einmalige Ableitung je Objekt. Ein Objekt MIT operationalStateSource wird
 * nicht angefasst — egal, was seine Altfelder inzwischen sagen. */
function mappeZustaende(data, nowIso, bericht) {
  for (const [sourceType, q] of Object.entries(QUELLEN)) {
    const store = data.entities[q.store];
    if (!istKarte(store)) continue;
    for (const [id, e] of Object.entries(store)) {
      if (!istKarte(e)) { bericht.conflicts.push({ kind: "corrupt_entity", sourceType, sourceId: id }); continue; }
      if (istKarte(e.operationalStateSource)) continue;   // bereits migriert: fuehrend, nie erneut ableiten
      const m = MAPPER[sourceType](e);
      e.operationalState = m.operationalState;
      e.operationalStateVersion = 1;
      e.operationalStateSource = { model: STATE_MODEL_VERSION, legacyField: m.legacyField, legacyValue: m.legacyValue, mappedAt: nowIso, note: m.note || null };
      e.operationalRoles = rollenAbleiten(sourceType, e);
      if (m.unmapped) {
        e.operationalStateUnmapped = m.reason;
        bericht.conflicts.push({ kind: m.reason, sourceType, sourceId: id, legacyField: m.legacyField, legacyValue: m.legacyValue });
      }
      bericht.mapped.push({ sourceType, sourceId: id, operationalState: m.operationalState });
    }
  }
}

/* Die Migration. Gibt IMMER einen neuen Bestand zurueck (tiefe Kopie); die
 * Eingabe wird nicht veraendert. changed=false heisst: byteidentisch.
 *
 *   · ohne v3-Spuren: erstmalige Legacy-Migration — Pflichtsammlungen und
 *     Kern werden angelegt, Altstatus einmal gemappt, alles Fremde bleibt
 *   · mit v3-Spuren: der Kern muss VOLLSTAENDIG gueltig sein (Struktur-
 *     pruefung), sonst CORE_PARTIAL_V3 (503); dann werden nur Objekte
 *     ohne operationalStateSource (neu vom Client angelegt) gemappt */
export function migrateCore(input, { now } = {}) {
  if (typeof now !== "number" || !Number.isFinite(now)) throw new TypeError("migrateCore: now (ms) fehlt");
  const bestand = pruefeBestand(input);
  const data = klon(bestand);
  const bericht = { created: [], mapped: [], conflicts: [], mode: null };
  const nowIso = isoAus(now);

  const spuren = v3Spuren(data);
  if (spuren.length) {
    const f = pruefeKernStruktur(data);
    if (f.length) throw new CoreDocumentError("CORE_PARTIAL_V3", "v3-Spuren (" + spuren.join(", ") + ") in einem unvollstaendigen oder kaputten Kern — keine erneute Erstmigration: " + f.map((x) => x.code + "@" + x.path).join("; "));
    bericht.mode = "repeat";
  } else {
    bericht.mode = "initial";
    for (const k of PFLICHT_STORES) {
      if (data.entities[k] === undefined) { data.entities[k] = {}; bericht.created.push("entities." + k); }
    }
    ergaenzeAutomation(data, bericht);
    ergaenzeRuns(data, bericht);
  }
  mappeZustaende(data, nowIso, bericht);

  const a = data.automation;
  const bisher = istKarte(a.migration) ? a.migration : null;
  const nochOffen = (bisher ? bisher.conflicts || [] : []).filter((c) => {
    if (c.kind === "corrupt_entity") return !istKarte(data.entities?.[QUELLEN[c.sourceType]?.store]?.[c.sourceId]);
    const e = data.entities?.[QUELLEN[c.sourceType]?.store]?.[c.sourceId];
    return e && typeof e.operationalStateUnmapped === "string";
  });
  const vorhanden = new Set(nochOffen.map((c) => c.kind + ":" + c.sourceType + ":" + c.sourceId));
  const neu = bericht.conflicts.filter((c) => !vorhanden.has(c.kind + ":" + c.sourceType + ":" + c.sourceId));
  const migration = bisher
    ? { ...bisher, conflicts: [...nochOffen, ...neu] }
    : { schemaVersion: SCHEMA_VERSION, stateModel: STATE_MODEL_VERSION, migratedAt: nowIso, conflicts: bericht.conflicts };
  if (!bisher || JSON.stringify(migration) !== JSON.stringify(bisher)) a.migration = migration;

  const changed = JSON.stringify(data) !== JSON.stringify(bestand);
  return { data, changed, report: { ...bericht, unknownStates: bericht.conflicts.filter((c) => c.kind === "unknown"), ambiguousStates: bericht.conflicts.filter((c) => c.kind === "ambiguous") } };
}

/* Strukturpruefung des migrierten Kerns — NICHT werfend, vollstaendig.
 * Liefert jede Verletzung als { code, path }. Die Ampel meldet sie rot, die
 * Mutation (requireCore) lehnt sie ab. Kein Number(x)||0, kein Ueberspringen. */
export function pruefeKernStruktur(data) {
  const f = [];
  const add = (code, path) => f.push({ code, path });
  if (!istKarte(data)) return [{ code: "CORE_SHAPE", path: "" }];
  if (!istKarte(data.entities)) return [{ code: "CORE_NO_ENTITIES", path: "entities" }];
  for (const k of PFLICHT_STORES) {
    if (!istKarte(data.entities[k])) { add("CORE_STORE_MISSING", "entities." + k); continue; }
    if (QUELLEN[Object.keys(QUELLEN).find((t) => QUELLEN[t].store === k)] || k === "chatgptNotes" || k === "projects") {
      for (const [id, e] of Object.entries(data.entities[k])) if (!istKarte(e)) add("CORE_STORE_CORRUPT", `entities.${k}.${id}`);
    }
  }
  if (data.entities.notes !== undefined && !istKarte(data.entities.notes)) add("CORE_STORE_CORRUPT", "entities.notes");
  const a = data.automation;
  if (!istKarte(a)) { add("CORE_NOT_MIGRATED", "automation"); return f; }
  if (a.schemaVersion !== SCHEMA_VERSION) add("CORE_NOT_MIGRATED", "automation.schemaVersion");
  if (!(Number.isSafeInteger(a.dataRevision) && a.dataRevision >= 0)) add("CORE_REVISION_CORRUPT", "automation.dataRevision");
  for (const k of AUTOMATION_KARTEN) if (!istKarte(a[k])) add("CORE_AUTOMATION_CORRUPT", "automation." + k);
  if (a.activeLease !== null && a.activeLease !== undefined && !istKarte(a.activeLease)) add("CORE_AUTOMATION_CORRUPT", "automation.activeLease");
  if (!istKarte(a.migration)) add("CORE_NOT_MIGRATED", "automation.migration");
  if (!istKarte(data.dailyBriefing) || !istKarte(data.dailyBriefing.assistantRuns)) add("CORE_NOT_MIGRATED", "dailyBriefing.assistantRuns");
  else {
    for (const [date, run] of Object.entries(data.dailyBriefing.assistantRuns)) {
      if (!istKarte(run) || run.date !== date || !istLokalDatum(date) || !RUN_PHASES.includes(run.phase)
          || !Array.isArray(run.itemRefs) || !istKarte(run.slotReceipts) || !istKarte(run.sourceChecks) || !Array.isArray(run.corrections)
          || !(Number.isSafeInteger(run.revision) && run.revision >= 0)) add("CORE_RUN_CORRUPT", "dailyBriefing.assistantRuns." + date);
    }
  }
  return f;
}

/* Der migrierte Kern in einem Bestand — vollstaendig geprueft, oder ein
 * Fehler. Nichts wird geleert oder ergaenzt. */
export function requireCore(data) {
  const d = pruefeBestand(data);
  const f = pruefeKernStruktur(d);
  if (f.length) throw new CoreDocumentError(f[0].code, f.map((x) => x.code + "@" + x.path).join("; "));
  return d;
}
