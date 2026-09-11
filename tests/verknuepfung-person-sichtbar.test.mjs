/*
 * Verknüpfte Personen an Aufgabe und Projekt.
 *
 * PRODUKTIONSBEFUND (Person Pius prs_mtw0v2fhdpj7, 11.09.):
 *   Die Personenseite zeigt drei SPAR-Aufgaben. Auf den Aufgaben selbst
 *   (b63eec31…, 2f0dc251…, Bankstatus) steht unter „Verknüpfungen" kein Pius.
 *   ➕ Verknüpfen → Pius wählen schliesst den Auswähler, danach erscheint
 *   nichts — weder sofort noch nach Speichern und Neuladen.
 *
 * BEFUND AUS DEM CODE, im Browser isoliert nachgemessen:
 *   Der Auswähler speichert RICHTIG. linkEntities() schreibt beide Seiten:
 *   task.linkedPersons = [personId] UND person.linkedTasks = [taskId]; beides
 *   übersteht das Neuladen. Gerendert wurde es nur nicht: die Verknüpfungs-
 *   karte von Aufgabe und Projekt zeichnet ihre Chips von Hand und kennt dabei
 *   eine feste Handvoll Sorten (Aufgabe, Projekt, Notiz, Organisation,
 *   Strategie, Ziel, Termin, Meeting, Idee). Der Auswähler bietet dagegen JEDE
 *   verknüpfbare Sorte aus der Registry an — rund vierzig. Person, Mail,
 *   Protokoll, Entscheidung … verschwanden deshalb lautlos.
 *
 *   Folge war nicht nur Unsichtbarkeit: ohne Chip gab es auch keinen ✕, die
 *   Verknüpfung liess sich über die Oberfläche nicht mehr lösen.
 *
 * Der universelle Renderer renderLinkedEntitiesSection() macht es seit jeher
 * richtig, wird von Aufgabe und Projekt aber nicht benutzt. Statt beide
 * Ansichten umzubauen (und ihre Besonderheiten wie die Beschreibungsvorschau
 * zu verlieren), trägt weitereVerknuepfungenHtml() genau die fehlenden Sorten
 * nach. Die Gegenseite bleibt unangetastet.
 *
 * Geprüft wird gegen die ECHTEN Funktionen aus public/index.html.
 * Kein Browser, kein Netz, keine Datei wird geschrieben.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

let checks = 0;
const luecken = [];
const ok = (bedingung, text) => { checks++; if (!bedingung) luecken.push(text); };

function schneide(start, ende) {
  const a = index.indexOf(start);
  if (a < 0) return null;
  const b = index.indexOf(ende, a);
  return b < 0 ? null : index.slice(a, b);
}

// ═══ 1. Der Auswähler speichert beide Seiten ══════════════════════════════
const linkQuelle = schneide("function linkEntities(srcKind, srcId, tgtKind, tgtId)", "function canHaveField(");
ok(!!linkQuelle, "linkEntities() nicht gefunden");

const welt = {
  APP: { state: { data: { entities: {
    tasks:   { t1: { id: "t1", title: "SPAR Testaufgabe" } },
    persons: { p1: { id: "p1", name: "Testperson" } },
    protocols: { pr1: { id: "pr1", title: "Testprotokoll" } },
  }, meta: {} } } },
  console: { log() {}, error() {}, warn() {} },
};
welt.getEntity = (kind, id) => {
  const store = { task: "tasks", person: "persons", protocol: "protocols" }[kind];
  return store ? welt.APP.state.data.entities[store][id] || null : null;
};
welt.nowIso = () => "2026-09-11T09:00:00.000Z";
welt.logActivity = () => {};
welt.scheduleSave = () => {};

if (linkQuelle) {
  const linkEntities = new Function(
    "APP", "getEntity", "nowIso", "logActivity", "scheduleSave", "console",
    linkQuelle + "\nreturn linkEntities;"
  )(welt.APP, welt.getEntity, welt.nowIso, welt.logActivity, welt.scheduleSave, welt.console);

  const erfolg = linkEntities("task", "t1", "person", "p1");
  const e = welt.APP.state.data.entities;
  ok(erfolg === true, "linkEntities meldet keinen Erfolg");
  ok(Array.isArray(e.tasks.t1.linkedPersons) && e.tasks.t1.linkedPersons.includes("p1"),
    "die Aufgabe traegt die Person nicht — dann waere es doch ein Speicherfehler");
  ok(Array.isArray(e.persons.p1.linkedTasks) && e.persons.p1.linkedTasks.includes("t1"),
    "die Person traegt die Aufgabe nicht — die Gegenseite ginge verloren");
  // Zweimal dasselbe darf nicht doppelt eintragen
  linkEntities("task", "t1", "person", "p1");
  ok(e.tasks.t1.linkedPersons.length === 1, "eine zweite gleiche Verknuepfung wird doppelt eingetragen");
  linkEntities("task", "t1", "protocol", "pr1");
  ok(e.tasks.t1.linkedProtocols && e.tasks.t1.linkedProtocols.includes("pr1"),
    "auch ein Protokoll wird gespeichert (dieselbe Sorte Verknuepfung)");
}

// ═══ 2. Die Nachzeichnung ═════════════════════════════════════════════════
const htmlQuelle = schneide("function weitereVerknuepfungenHtml(kind, id, schonGezeigt)",
  "window.weitereVerknuepfungenHtml");
ok(!!htmlQuelle, "weitereVerknuepfungenHtml() nicht gefunden");

if (htmlQuelle) {
  const registry = [
    { kind: "task",     store: "tasks",     label: "Aufgabe",  icon: "✅", nameField: "title" },
    { kind: "person",   store: "persons",   label: "Person",   icon: "👤", nameField: "name"  },
    { kind: "protocol", store: "protocols", label: "Protokoll",icon: "📋", nameField: "title" },
    { kind: "tag",      store: "tags",      label: "Tag",      icon: "🏷️", nameField: "name", linkable: false },
  ];
  const esc = (x) => String(x == null ? "" : x).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const entities = {
    tasks:   { t1: { id: "t1", title: "SPAR Testaufgabe",
                     linkedPersons: ["p1", "pWeg"], linkedProtocols: ["pr1"], linkedTasks: ["t2"] } },
    persons: { p1: { id: "p1", name: "Testperson Pius-Attrappe" } },
    protocols: { pr1: { id: "pr1", title: "Testprotokoll" } },
    tags:    {},
  };
  const getEntity = (kind, id) => {
    const info = registry.find((r) => r.kind === kind);
    return info ? entities[info.store][id] || null : null;
  };
  const fn = new Function(
    "getEntity", "entityKindRegistry", "linkFieldForKindName", "entityDisplayLabel", "esc",
    htmlQuelle + "\nreturn weitereVerknuepfungenHtml;"
  )(
    getEntity,
    () => registry,
    (kind) => `linked${String(kind).charAt(0).toUpperCase() + String(kind).slice(1)}s`,
    (kind, ent) => { const i = registry.find((r) => r.kind === kind); return String((i && ent[i.nameField]) || ent.title || ent.name || ""); },
    esc
  );

  const html = fn("task", "t1", ["linkedTasks"]);
  ok(html.includes("Testperson Pius-Attrappe"), "die Person fehlt in der Nachzeichnung");
  ok(/data-action="open-slide" data-kind="person" data-id="p1"/.test(html),
    "der Personen-Chip ist nicht anklickbar");
  ok(/data-action="unlink-entity"[^>]*data-tgt-kind="person"[^>]*data-tgt-id="p1"/.test(html),
    "ohne ✕ liesse sich die Verknuepfung ueber die Oberflaeche nicht mehr loesen");
  ok(html.includes("Testprotokoll"), "das Protokoll fehlt — es trifft dieselbe Luecke");
  ok(!html.includes("pWeg"), "ein geloeschtes Ziel wird trotzdem gezeichnet");
  ok(!/data-tgt-kind="task"/.test(html),
    "eine bereits von Hand gezeichnete Sorte wird doppelt ausgegeben");
  ok(fn("task", "unbekannt", []) === "", "eine fehlende Aufgabe liefert kein HTML");
  ok(fn("task", "t1", ["linkedTasks", "linkedPersons", "linkedProtocols"]) === "",
    "sind alle Sorten schon gezeichnet, kommt nichts dazu");

  // Nicht verknuepfbare Sorten bleiben aussen vor
  entities.tags.tg1 = { id: "tg1", name: "Tag" };
  entities.tasks.t1.linkedTags = ["tg1"];
  ok(!fn("task", "t1", ["linkedTasks"]).includes("tg1"),
    "eine als nicht verknuepfbar markierte Sorte wird trotzdem gezeichnet");
}

// ═══ 3. Aufgaben- und Projektansicht benutzen die Nachzeichnung ═══════════
const taskQuelle = schneide("function viewTaskDetail(id)", "function viewTaskCreate");
ok(!!taskQuelle, "viewTaskDetail() nicht gefunden");
if (taskQuelle) {
  ok(/weitereTaskLinks = weitereVerknuepfungenHtml\("task", id, \[/.test(taskQuelle),
    "die Aufgabenansicht zeichnet die fehlenden Sorten nicht nach");
  ok(/\$\{linkedIdeas\}\$\{weitereTaskLinks\}/.test(taskQuelle),
    "die Nachzeichnung steht nicht in der Verknuepfungskarte");
  ok(/&& !weitereTaskLinks \?/.test(taskQuelle),
    "„Keine Verknuepfungen.“ erscheint weiterhin, obwohl Chips da sind");
  // Die neun handgezeichneten Sorten muessen ausgenommen sein, sonst doppelt.
  for (const feld of ["linkedTasks", "linkedProjects", "linkedNotes", "linkedOrganizations",
                      "linkedStrategies", "linkedGoals", "linkedCalendarEvents",
                      "linkedMeetings", "linkedIdeas"]) {
    const block = /weitereVerknuepfungenHtml\("task", id, \[([\s\S]*?)\]\)/.exec(taskQuelle);
    ok(!!block && block[1].includes(`"${feld}"`), `${feld} fehlt in der Ausnahmeliste — Chips waeren doppelt`);
  }
}
const projQuelle = schneide("const weitereProjektLinks = weitereVerknuepfungenHtml", "const tagsHtml");
ok(!!projQuelle, "die Projektansicht zeichnet die fehlenden Sorten nicht nach");
if (projQuelle) {
  ok(/allProjectLinks = [^;]*weitereProjektLinks/.test(projQuelle),
    "die Nachzeichnung landet nicht in der Verknuepfungsliste des Projekts");
}

// ═══ 4. Die Gegenseite bleibt, wie sie war ════════════════════════════════
const unlinkQuelle = schneide("const srcField = `linked${tgtKind.charAt(0).toUpperCase()", "// ====");
ok(index.includes("function renderLinkedEntitiesSection(kind, id)"),
  "der universelle Renderer wurde entfernt — andere Ansichten haengen daran");
ok(/window\.weitereVerknuepfungenHtml = weitereVerknuepfungenHtml/.test(index),
  "die Nachzeichnung ist nicht global erreichbar");

if (luecken.length) {
  console.error(`verknuepfung person sichtbar: ${luecken.length} von ${checks} Pruefungen offen`);
  for (const l of luecken) console.error("  - " + l);
  process.exit(1);
}
console.log(`verknuepfung person sichtbar: ${checks} Pruefungen bestanden`);
