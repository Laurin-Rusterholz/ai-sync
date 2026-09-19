/* ══ Tagesbriefing v3 — Kern lesen und migrieren ════════════════════════════
 *
 * Der reale Bestand liegt als JSON-String in appStore/app-data_json (siehe
 * firebase-admin.readAppDataDocument). Dieses Modul nimmt den GEPARSTEN
 * Bestand entgegen und liefert einen neuen, migrierten Bestand zurueck —
 * ohne Netz, ohne Uhr, ohne Zufall. Der Aufrufer (spaeter: der CAS-Schreib-
 * pfad) gibt "now" herein und schreibt das Ergebnis zurueck.
 *
 * Regeln:
 *   · Ein fehlender oder unlesbarer Kern ist ein FEHLER. Es gibt keinen
 *     leeren Ersatzbestand, in den man dann hineinschreiben koennte — genau
 *     so entstanden frueher Datenverluste (F-25).
 *   · Die Migration ist idempotent: zweimal angewendet ergibt exakt dasselbe
 *     Ergebnis, auch mit anderem "now".
 *   · Fremde Felder, _deleteLog und alles, was der Kern nicht kennt, bleiben
 *     unveraendert.
 *   · Unbekannte Altstatus werden SICHTBAR markiert (Bericht + Feld an der
 *     Entitaet), nicht stumm nach done gedeutet.
 * ═════════════════════════════════════════════════════════════════════════ */
import {
  SCHEMA_VERSION, MAPPER, QUELLEN, leereAutomation,
} from "./assistant-schema.mjs";
import { isoAus } from "./assistant-zeit.mjs";

export class CoreDocumentError extends Error {
  constructor(code, message) { super(message || code); this.code = code; this.coreDocument = true; }
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

function pruefeBestand(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CoreDocumentError("CORE_SHAPE", "Kernbestand ist kein Objekt.");
  if (!parsed.entities || typeof parsed.entities !== "object") throw new CoreDocumentError("CORE_NO_ENTITIES", "Kernbestand ohne entities — das ist kein Quantus-Bestand.");
  return parsed;
}

export function klon(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function istKarte(v) { return v && typeof v === "object" && !Array.isArray(v); }

/* Wiederverwendung: was schon da ist, bleibt; nur fehlende Bereiche werden
 * angelegt. Ein vorhandener Bereich mit falschem Typ wird NICHT ueberschrieben,
 * sondern im Bericht gemeldet — sonst ginge etwas verloren. */
function ergaenzeAutomation(data, bericht) {
  const vorlage = leereAutomation();
  if (!istKarte(data.automation)) {
    if (data.automation !== undefined) bericht.conflicts.push({ path: "automation", found: typeof data.automation });
    else { data.automation = vorlage; bericht.created.push("automation"); return; }
    if (!istKarte(data.automation)) return;
  }
  const a = data.automation;
  for (const [k, v] of Object.entries(vorlage)) {
    if (a[k] === undefined) { a[k] = v; bericht.created.push("automation." + k); continue; }
    if (istKarte(v) && !istKarte(a[k])) bericht.conflicts.push({ path: "automation." + k, found: typeof a[k] });
  }
  if (typeof a.schemaVersion !== "number" || a.schemaVersion < SCHEMA_VERSION) {
    a.schemaVersion = SCHEMA_VERSION;
    bericht.created.push("automation.schemaVersion=" + SCHEMA_VERSION);
  }
}

function ergaenzeRuns(data, bericht) {
  if (!istKarte(data.dailyBriefing)) {
    if (data.dailyBriefing !== undefined) { bericht.conflicts.push({ path: "dailyBriefing", found: typeof data.dailyBriefing }); return; }
    data.dailyBriefing = {};
    bericht.created.push("dailyBriefing");
  }
  if (data.dailyBriefing.assistantRuns === undefined) {
    data.dailyBriefing.assistantRuns = {};
    bericht.created.push("dailyBriefing.assistantRuns");
  } else if (!istKarte(data.dailyBriefing.assistantRuns)) {
    bericht.conflicts.push({ path: "dailyBriefing.assistantRuns", found: typeof data.dailyBriefing.assistantRuns });
  }
}

/* operationalState je Entitaet ableiten. Geschrieben wird nur, wenn das
 * Feld fehlt oder der Altstatus sich seit dem letzten Mapping veraendert
 * hat (der Client hat weitergearbeitet). Ein bereits gemapptes Objekt mit
 * unveraendertem Altstatus wird nicht angefasst — deshalb ist die zweite
 * Migration ein No-op. */
function mappeZustaende(data, nowIso, bericht) {
  for (const [sourceType, q] of Object.entries(QUELLEN)) {
    const store = data.entities[q.store];
    if (!istKarte(store)) continue;
    for (const [id, e] of Object.entries(store)) {
      if (!istKarte(e)) continue;
      const m = MAPPER[sourceType](e);
      const src = istKarte(e.operationalStateSource) ? e.operationalStateSource : null;
      const unveraendert = src && src.legacyField === m.legacyField && src.legacyValue === m.legacyValue
        && (m.unmapped ? e.operationalState === null && e.operationalStateUnmapped === true : typeof e.operationalState === "string");
      if (unveraendert) continue;
      e.operationalState = m.operationalState;
      e.operationalStateSource = { legacyField: m.legacyField, legacyValue: m.legacyValue, mappedAt: nowIso, note: m.note || null };
      if (m.unmapped) {
        e.operationalStateUnmapped = true;
        bericht.unknownStates.push({ sourceType, sourceId: id, legacyField: m.legacyField, legacyValue: m.legacyValue });
      } else if (e.operationalStateUnmapped) {
        delete e.operationalStateUnmapped;
      }
      bericht.mapped.push({ sourceType, sourceId: id, operationalState: m.operationalState });
    }
  }
}

/* Die Migration. Gibt IMMER einen neuen Bestand zurueck (tiefe Kopie); die
 * Eingabe wird nicht veraendert. changed=false heisst: byteidentisch. */
export function migrateCore(input, { now } = {}) {
  if (typeof now !== "number" || !Number.isFinite(now)) throw new TypeError("migrateCore: now (ms) fehlt");
  const bestand = pruefeBestand(input);
  const data = klon(bestand);
  const bericht = { created: [], mapped: [], unknownStates: [], conflicts: [] };
  const nowIso = isoAus(now);

  ergaenzeAutomation(data, bericht);
  ergaenzeRuns(data, bericht);
  mappeZustaende(data, nowIso, bericht);

  const a = istKarte(data.automation) ? data.automation : null;
  if (a) {
    // Der Bericht wird nur beim ERSTEN Lauf angelegt bzw. wenn neue
    // unbekannte Zustaende hinzukommen — ein wiederholter Lauf ohne Befund
    // veraendert nichts (kein neues migratedAt).
    const bisher = istKarte(a.migration) ? a.migration : null;
    const unknownNeu = bericht.unknownStates;
    if (!bisher) {
      a.migration = { schemaVersion: SCHEMA_VERSION, migratedAt: nowIso, unknownStates: unknownNeu, conflicts: bericht.conflicts };
    } else {
      // Unbekannte, die inzwischen einen bekannten Status haben, verschwinden;
      // neue kommen dazu. Ohne Unterschied bleibt das Objekt byteidentisch.
      const vorhanden = new Set((bisher.unknownStates || []).map((u) => u.sourceType + ":" + u.sourceId));
      const zusaetzlich = unknownNeu.filter((u) => !vorhanden.has(u.sourceType + ":" + u.sourceId));
      const nochUnbekannt = (bisher.unknownStates || []).filter((u) => {
        const e = data.entities?.[QUELLEN[u.sourceType]?.store]?.[u.sourceId];
        return e && e.operationalStateUnmapped === true;
      });
      const neu = { ...bisher, unknownStates: [...nochUnbekannt, ...zusaetzlich], conflicts: bericht.conflicts.length ? bericht.conflicts : (bisher.conflicts || []) };
      if (JSON.stringify(neu) !== JSON.stringify(bisher)) a.migration = neu;
    }
  }

  const changed = JSON.stringify(data) !== JSON.stringify(bestand);
  return { data, changed, report: bericht };
}

/* Der Kern in einem Bestand — oder ein Fehler. Kein Fallback auf {}. */
export function requireCore(data) {
  const d = pruefeBestand(data);
  if (!istKarte(d.automation) || d.automation.schemaVersion !== SCHEMA_VERSION) throw new CoreDocumentError("CORE_NOT_MIGRATED", "automation fehlt oder hat eine andere schemaVersion — erst migrateCore ausfuehren.");
  if (!istKarte(d.dailyBriefing) || !istKarte(d.dailyBriefing.assistantRuns)) throw new CoreDocumentError("CORE_NOT_MIGRATED", "dailyBriefing.assistantRuns fehlt — erst migrateCore ausfuehren.");
  return d;
}
