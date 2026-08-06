/*
 * Career Model: Themenideen je Beruf.
 *
 * Ein Modul beginnt nicht am Schreibtisch, sondern im Arbeitsalltag: "das
 * muesste ich mal koennen". Bisher gab es fuer diesen Moment keinen Ort — man
 * musste sofort die ganze Vorbereitung anstossen oder das Thema ging verloren.
 * Themenideen schliessen die Luecke: sie haengen am BERUFSFELD, nicht an einem
 * Modul, und lassen sich spaeter mit einem Klick in den Claude-Prompt heben.
 *
 * Zwei Entscheidungen, die hier festgehalten werden:
 *
 *  • Zugeordnet wird ueber den normalisierten Berufsnamen (areaKey), nicht ueber
 *    eine areaId. Bereiche entstehen erst beim Import — Ideen muessen aber schon
 *    davor sammelbar sein, sonst braucht man ein Modul, um ein Modul zu planen.
 *
 *  • Beim Uebernehmen in den Prompt wird der Modultitel ERSETZT, die Notizen
 *    aber ERGAENZT. Was man vorher an Vorgaben eingetippt hat, darf nicht
 *    verschwinden; zweimal dieselbe Idee zu uebernehmen darf den Prompt
 *    umgekehrt nicht aufblaehen.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => fs.readFileSync(path.join(here, "..", file), "utf8");
const core = ["01", "02", "03"].map((part) => read(`public/quantus-bundles/career-core.${part}.txt`)).join("");
const app = ["01", "02", "03", "04", "05"].map((part) => read(`public/quantus-bundles/career-app.${part}.txt`)).join("");

const sandbox = { globalThis: undefined };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(core, sandbox, { filename: "career-core.bundle.js" });
const Core = sandbox.CareerModelCore;
assert.ok(Core, "CareerModelCore fehlt");

// ── 1. Ideen haengen am Beruf, nicht an einem Bereich ─────────────────────
{
  const state = Core.emptyState();
  const a = Core.buildIdea({ areaName: "Versicherungen", title: "Haftpflichtrecht", notes: "Fokus KMU-Policen" }, "2026-08-06T10:00:00.000Z");
  const b = Core.buildIdea({ areaName: "  versicherungen ", title: "Sachversicherung" }, "2026-08-07T10:00:00.000Z");
  const c = Core.buildIdea({ areaName: "Immobilien", title: "Mietrecht" }, "2026-08-07T11:00:00.000Z");

  assert.equal(a.areaKey, b.areaKey, "Schreibweise und Leerzeichen duerfen kein zweites Berufsfeld erzeugen");
  assert.notEqual(a.areaKey, c.areaKey);
  assert.equal(a.status, "open");
  assert.equal(a.usedAt, null);

  // Es braucht KEINEN importierten Bereich, damit Ideen funktionieren.
  assert.equal(Object.keys(state.areas).length, 0);
  [a, b, c].forEach((idea) => { state.ideas[idea.id] = idea; });

  const versicherungen = Core.ideasForArea(state, "VERSICHERUNGEN");
  assert.equal(versicherungen.length, 2, "die Suche nach dem Beruf ist unabhaengig von der Schreibweise");
  assert.equal(versicherungen[0].title, "Sachversicherung", "die neueste offene Idee steht oben");
  assert.equal(Core.ideasForArea(state, "Immobilien").length, 1);
  assert.equal(Core.ideasForArea(state, "Gibtsnicht").length, 0);

  // Erledigte Ideen rutschen ans Ende, verschwinden aber nicht.
  state.ideas[b.id] = Object.assign({}, b, { status: "used" });
  const sortiert = Core.ideasForArea(state, "Versicherungen");
  assert.equal(sortiert.length, 2);
  assert.equal(sortiert[0].title, "Haftpflichtrecht");
  assert.equal(sortiert[1].status, "used");

  // Uebersicht ueber alle Berufsfelder mit Ideen.
  const areas = Core.ideaAreas(state);
  assert.equal(areas.length, 2);
  const vers = areas.find((entry) => entry.areaKey === a.areaKey);
  assert.equal(vers.total, 2);
  assert.equal(vers.open, 1, "eine der beiden Ideen ist erledigt");
}

// ── 2. Dieselbe Idee zweimal anlegen erzeugt kein Duplikat ────────────────
{
  const first = Core.buildIdea({ areaName: "Versicherungen", title: "Haftpflichtrecht" }, "2026-08-06T10:00:00.000Z");
  const again = Core.buildIdea({ areaName: "Versicherungen", title: "Haftpflichtrecht", notes: "andere Notiz" }, "2026-08-09T10:00:00.000Z");
  assert.equal(first.id, again.id, "gleiches Thema im gleichen Berufsfeld ist dieselbe Idee");
  const anderes = Core.buildIdea({ areaName: "Immobilien", title: "Haftpflichtrecht" }, "2026-08-06T10:00:00.000Z");
  assert.notEqual(first.id, anderes.id, "gleiches Thema in anderem Berufsfeld ist eine eigene Idee");
}

// ── 3. Uebernahme in den Prompt ───────────────────────────────────────────
{
  const idea = Core.buildIdea({ areaName: "Versicherungen", title: "Haftpflichtrecht", notes: "Fokus KMU-Policen" }, "2026-08-06T10:00:00.000Z");
  const start = { areaName: "Irgendwas", moduleTitle: "Altes Modul", level: "Praxis", dailyMinutes: 30, notes: "Bestehende Vorgabe" };

  const after = Core.applyIdeaToPrompt(start, idea);
  assert.equal(after.areaName, "Versicherungen");
  assert.equal(after.moduleTitle, "Haftpflichtrecht", "der Modultitel wird ersetzt");
  assert.equal(after.level, "Praxis", "unbeteiligte Felder bleiben unangetastet");
  assert.equal(after.dailyMinutes, 30);
  assert.equal(after.notes, "Bestehende Vorgabe\n\nFokus KMU-Policen", "die Notiz wird ergaenzt, nicht ueberschrieben");
  assert.equal(start.notes, "Bestehende Vorgabe", "der urspruengliche Prompt wird nicht veraendert");

  // Zweimal dieselbe Idee darf den Prompt nicht aufblaehen.
  const twice = Core.applyIdeaToPrompt(after, idea);
  assert.equal(twice.notes, after.notes);

  // Eine Idee ohne Notiz laesst die Vorgaben, wie sie sind.
  const ohneNotiz = Core.buildIdea({ areaName: "Versicherungen", title: "Sachversicherung" }, "2026-08-06T10:00:00.000Z");
  const dritte = Core.applyIdeaToPrompt(after, ohneNotiz);
  assert.equal(dritte.moduleTitle, "Sachversicherung");
  assert.equal(dritte.notes, after.notes, "ohne Notiz bleiben die Vorgaben unveraendert");

  // Leerer Ausgangszustand darf nicht mit "undefined" im Text enden.
  const leer = Core.applyIdeaToPrompt({}, idea);
  assert.equal(leer.notes, "Fokus KMU-Policen");
}

// ── 4. Zustand bleibt abwaertskompatibel ──────────────────────────────────
{
  const alt = Core.normalizeState({ areas: {}, modules: {}, progress: {}, reflections: {} });
  assert.ok(alt.ideas && typeof alt.ideas === "object", "ideas fehlt im normalisierten Zustand");
  assert.equal(Object.keys(alt.ideas).length, 0);
  assert.equal(Core.ideasForArea(alt, "Versicherungen").length, 0);
  assert.equal(Core.ideaAreas(alt).length, 0);
}

// ── 5. Oberflaeche: sammeln, uebernehmen, abhaken ─────────────────────────
assert.match(app, /function ideasSection\(\)/, "der Ideen-Abschnitt fehlt");
assert.match(app, /function ideaRow\(idea\)/, "die Ideen-Zeile fehlt");
assert.match(app, /content \+= ideasSection\(\);/, "der Ideen-Abschnitt haengt nicht im Reiter „Vorbereiten\"");
for (const fn of ["addIdea", "deleteIdea", "toggleIdea", "adoptIdea", "markIdeaUsed"]) {
  assert.ok(app.includes(`function ${fn}(`), `${fn}() fehlt`);
}
for (const action of ["idea-add", "idea-adopt", "idea-toggle", "idea-delete", "idea-area"]) {
  assert.ok(app.includes(`action === "${action}"`), `Aktion ${action} wird nicht behandelt`);
  assert.ok(app.includes(`data-cm-action="${action}"`), `Aktion ${action} hat keinen Knopf`);
}
// Die Uebernahme geht ueber die reine Kernfunktion, nicht ueber eine zweite
// Zuweisungslogik in der Oberflaeche.
assert.match(app, /state\.prompt = Core\.applyIdeaToPrompt\(state\.prompt, idea\);/,
  "die Oberflaeche baut die Prompt-Uebernahme selbst statt den Kern zu nutzen");
// Ideen sind auch beim Berufsfeld in der Bereichsansicht sichtbar.
assert.match(app, /cm-area-ideas/, "die Bereichsansicht zeigt die Themenideen des Berufsfelds nicht");
// Wird aus einer Idee ein Modul, gilt sie als erledigt.
assert.match(app, /markIdeaUsed\(prep\.areaName, prep\.moduleTitle\)/, "die Vorbereitung schliesst die Idee nicht ab");
assert.match(app, /markIdeaUsed\(areaName, moduleTitle\)/, "der Import schliesst die Idee nicht ab");

// ── 6. CSS ────────────────────────────────────────────────────────────────
const css = read("public/career-model.css");
for (const cls of ["cm-idea", "cm-idea-list", "cm-idea-check", "cm-idea-areas", "cm-area-ideas"]) {
  assert.ok(css.includes("." + cls), `CSS-Klasse ${cls} fehlt`);
}

console.log("career model ideas: ok");
