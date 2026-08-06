/*
 * Career Model: Lernplan, Wiederholung, Fortschritt, Suche und Modulvorbereitung.
 *
 * Das Career Model konnte bisher nur importieren, taeglich einen Lerntag
 * abarbeiten und abends reflektieren. Was die BM-Vorbereitung ausmacht — ein
 * Zieldatum mit daraus gerechnetem Pensum, verteilte Wiederholung, eine
 * Fortschrittsauswertung und Volltextsuche — fehlte komplett. Ergaenzt wurde
 * genau das, aber ohne n8n: alles rechnet die App selbst aus dem bereits
 * importierten Stoff.
 *
 * Dazu die Modulvorbereitung. Ein Modul entsteht nicht aus dem Nichts (Quellen
 * sammeln, Prompt geben, Datei pruefen, importieren) — das ist Arbeit, und
 * Arbeit ist in Quantus eine Aufgabe. Die Vorbereitung legt deshalb eine ECHTE
 * Quantus-Aufgabe an, ueber die Polaris-Inbox, die die Hauptapp ohnehin in
 * createEntity("task", …) uebersetzt. Damit steht sie unter „Aufgaben" und ist
 * dieselbe Einheit wie jede andere Aufgabe — keine Kopie, keine eigene Art.
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

// ── Testzustand: ein Modul mit zwei Lerntagen, davon einer abgeschlossen ───
function makeState() {
  const state = Core.emptyState();
  state.areas.a1 = { id: "a1", name: "Versicherungen", moduleIds: ["m1"] };
  state.modules.m1 = {
    id: "m1", areaId: "a1", title: "Haftpflichtrecht", status: "active",
    dayOrder: ["d1", "d2"],
    days: {
      d1: {
        id: "d1", day: 1, title: "Grundlagen", estimatedMinutes: 30,
        objectives: ["Verschulden erklaeren"],
        sections: [{ type: "paragraph", title: "Einstieg", text: "Der Kausalzusammenhang." }],
        reviewQuestions: [{ question: "Was ist Kausalitaet?", answer: "Ursache und Wirkung" }],
        takeaways: ["Ohne Schaden keine Haftung"],
        exercise: { prompt: "Fall loesen", solution: "Musterloesung" }
      },
      d2: {
        id: "d2", day: 2, title: "Vertiefung", estimatedMinutes: 30,
        reviewQuestions: [{ question: "Was ist Widerrechtlichkeit?", answer: "Normverstoss" }],
        takeaways: []
      }
    }
  };
  state.progress.m1 = { completedDays: { d1: { completedAt: "2026-08-06T09:00:00.000Z", actualMinutes: 32 } } };
  return state;
}

// ── 1. Lernplan: Pensum wird gerechnet, nicht geliefert ───────────────────
{
  const state = makeState();
  const ohneZiel = Core.studyPlan(state, "m1", "2026-08-06");
  assert.equal(ohneZiel.targetDate, null, "ohne Zieldatum darf kein Ziel erscheinen");
  assert.equal(ohneZiel.daysLeft, null, "ohne Zieldatum gibt es keine Restfrist");
  assert.equal(ohneZiel.remaining, 1, "ein Lerntag ist noch offen");

  state.plans.m1 = { targetDate: "2026-08-10", startedAt: "2026-08-04" };
  const plan = Core.studyPlan(state, "m1", "2026-08-06");
  assert.equal(plan.daysLeft, 4);
  assert.equal(plan.perDay, 1, "ein offener Lerntag auf vier Tage ist ein Tag pro Tag");
  assert.equal(plan.expected, 1, "nach der Haelfte der Zeit ist ein von zwei Tagen erwartet");
  assert.equal(plan.delta, 0);
  assert.equal(plan.status, "ok");

  // Zieldatum verstrichen, aber noch offen → ueberfaellig.
  const spaet = Core.studyPlan(state, "m1", "2026-08-12");
  assert.equal(spaet.status, "overdue", "nach dem Zieldatum mit offenen Tagen ist der Plan ueberfaellig");
}

// ── 2. Wiederholung: Karten nur aus gelerntem Stoff ───────────────────────
{
  const state = makeState();
  const cards = Core.reviewCards(state);
  assert.equal(cards.length, 2, "nur der abgeschlossene Tag liefert Karten (1 Frage + 1 Merksatz)");
  assert.ok(cards.every((card) => card.dayId === "d1"), "ein nicht gelernter Tag darf keine Karte liefern");
  assert.equal(Core.reviewCards(state, { onlyCompleted: false }).length, 3);

  // Alles ist zu Beginn faellig, weil noch nie gesehen.
  assert.equal(Core.dueCards(state, { todayKey: "2026-08-06" }).length, 2);

  // Leitner: richtig schiebt weiter, falsch setzt auf Fach 1 zurueck.
  const first = Core.applyReviewResult(null, true, "2026-08-06");
  assert.equal(first.box, 2);
  assert.equal(first.dueDate, "2026-08-08", "Fach 2 ist nach zwei Tagen wieder faellig");
  assert.equal(first.correct, 1);
  const second = Core.applyReviewResult(first, true, "2026-08-08");
  assert.equal(second.box, 3);
  assert.equal(second.dueDate, "2026-08-12", "Fach 3 ist nach vier Tagen wieder faellig");
  const failed = Core.applyReviewResult(second, false, "2026-08-12");
  assert.equal(failed.box, 1, "ein Fehler setzt immer auf Fach 1 zurueck");
  assert.equal(failed.wrong, 1);
  assert.equal(failed.seen, 3, "die Zaehler laufen weiter");

  // Eine noch nicht faellige Karte taucht nicht in der Faelligkeitsliste auf.
  state.review[cards[0].id] = { box: 3, dueDate: "2026-08-20" };
  const due = Core.dueCards(state, { todayKey: "2026-08-06" });
  assert.equal(due.length, 1);
  assert.equal(due[0].id, cards[1].id);

  const stats = Core.reviewStats(state);
  assert.equal(stats.total, 2);
  assert.equal(stats.due, 1);
  assert.equal(stats.started, 1);
}

// ── 3. Fortschritt ────────────────────────────────────────────────────────
{
  const state = makeState();
  const stats = Core.progressStats(state);
  assert.equal(stats.modules, 1);
  assert.equal(stats.totalDays, 2);
  assert.equal(stats.doneDays, 1);
  assert.equal(stats.percent, 50);
  assert.equal(stats.minutes, 32, "die tatsaechliche Lernzeit wird summiert");
  assert.equal(stats.activeDays, 1);
}

// ── 4. Suche ueber alles Importierte ──────────────────────────────────────
{
  const state = makeState();
  assert.equal(Core.searchContent(state, "x").length, 0, "ein Zeichen sucht nicht");
  const hits = Core.searchContent(state, "kausal");
  assert.ok(hits.length >= 2, "Lerninhalt und Kontrollfrage muessen gefunden werden");
  assert.ok(hits.some((hit) => hit.kind === "Kontrollfrage"));
  assert.ok(hits.every((hit) => hit.moduleId === "m1" && hit.dayId));
  // Die Suche geht auch ueber noch nicht gelernte Tage.
  assert.ok(Core.searchContent(state, "widerrecht").some((hit) => hit.dayId === "d2"));
  assert.equal(Core.searchContent(state, "musterloesung")[0].kind, "Praxisuebung");
}

// ── 5. Modulvorbereitung ──────────────────────────────────────────────────
{
  const prep = Core.buildPreparation({
    areaName: "Versicherungen", moduleTitle: "Sachversicherung",
    dailyMinutes: 30, notes: "Fokus KMU", targetDate: "2026-09-01"
  }, "2026-08-06T10:00:00.000Z");
  assert.equal(prep.status, "open");
  assert.equal(prep.targetDate, "2026-09-01");
  assert.equal(prep.taskRef, null, "die Aufgabe wird erst beim Anlegen verknuepft");
  assert.ok(prep.steps.length >= 3, "die Vorbereitung braucht nachvollziehbare Schritte");
  // Gleiche Eingabe → gleiche Id, damit eine Vorbereitung nicht doppelt entsteht.
  const again = Core.buildPreparation({ areaName: "Versicherungen", moduleTitle: "Sachversicherung" }, "2026-08-07T10:00:00.000Z");
  assert.equal(again.id, prep.id);

  const text = Core.preparationTaskDescription(prep);
  assert.match(text, /Bereich: Versicherungen/);
  assert.match(text, /Modul: Sachversicherung/);
  assert.match(text, /Zieldatum: 2026-09-01/);
  assert.match(text, /Fokus KMU/);
  assert.match(text, /1\. /, "die Schritte werden nummeriert aufgefuehrt");
}

// ── 6. Zustand bleibt abwaertskompatibel ──────────────────────────────────
{
  // Ein alter Datenstand ohne die neuen Zweige darf nicht kippen.
  // Objekte aus dem vm-Kontext haben ein anderes Object.prototype — deshalb
  // ueber die Schluessel pruefen statt per deepEqual.
  const alt = Core.normalizeState({ areas: {}, modules: {}, progress: {}, reflections: {} });
  for (const branch of ["preparations", "plans", "review"]) {
    assert.ok(alt[branch] && typeof alt[branch] === "object", `${branch} fehlt im normalisierten Zustand`);
    assert.equal(Object.keys(alt[branch]).length, 0);
  }
  assert.equal(Core.progressStats(alt).percent, 0);
  assert.equal(Core.dueCards(alt).length, 0);
}

// ── 7. Die App legt eine ECHTE Quantus-Aufgabe an ─────────────────────────
// Der Weg dorthin ist die Polaris-Inbox: Quantus liest polaris/inbox/<typ>/<id>
// und uebersetzt sie ueber sein eigenes createEntity() in eine Entitaet.
assert.match(app, /state\.db\.ref\("polaris\/inbox\/task\/" \+ inboxId\)\.set\(/,
  "die Vorbereitung schreibt keine Aufgabe in die Polaris-Inbox");
assert.match(app, /source: "career-model"/, "die Aufgabe weist ihre Herkunft nicht aus");
assert.match(app, /function preparationTaskPayload\(prep, done\)/, "preparationTaskPayload() fehlt");
assert.match(app, /status: done \? "done" : "todo"/, "die Aufgabe nutzt nicht den normalen Aufgabenstatus");
// Erst die Aufgabe, dann der Eintrag — sonst behauptet eine Vorbereitung, es
// gaebe eine Aufgabe, die nie entstanden ist.
assert.match(app, /pushQuantusTask\(inboxId, preparationTaskPayload\(prep, false\), "create"\)\.then\(/,
  "die Vorbereitung wird gespeichert, bevor die Aufgabe sicher angelegt ist");
// Import schliesst die passende Vorbereitung samt Aufgabe.
assert.match(app, /function closeMatchingPreparation\(moduleTitle\)/, "closeMatchingPreparation() fehlt");
assert.match(app, /closeMatchingPreparation\(moduleTitle\);/, "der Import schliesst die Vorbereitung nicht ab");

// ── 8. Die neuen Ansichten sind erreichbar ────────────────────────────────
for (const [key, label] of [["plan", "Lernplan"], ["review", "Wiederholen"], ["progress", "Fortschritt"],
                            ["search", "Suche"], ["prepare", "Vorbereiten"]]) {
  assert.ok(app.includes(`key: "${key}"`), `Reiter ${label} fehlt in der Navigation`);
  assert.ok(app.includes(`state.tab === "${key}"`), `Reiter ${label} wird nicht gerendert`);
}
for (const fn of ["planView", "reviewView", "progressView", "searchView", "prepareView"]) {
  assert.ok(app.includes(`function ${fn}()`), `${fn}() fehlt`);
}
// Kein n8n im Career Model — das war die ausdrueckliche Vorgabe. Geprueft wird
// die tatsaechliche Abhaengigkeit (Webhook-Host, Webhook-Konstante), nicht das
// blosse Wort: ein Kommentar darf erklaeren, warum hier nichts von aussen kommt.
for (const [name, source] of [["App", app], ["Kern", core]]) {
  assert.doesNotMatch(source, /n8n\.[a-z0-9.-]+\//i, `der Career-${name} spricht einen n8n-Host an`);
  assert.doesNotMatch(source, /webhook/i, `der Career-${name} ruft einen Webhook auf`);
}

// ── 9. CSS fuer die neuen Bausteine ───────────────────────────────────────
const css = read("public/career-model.css");
for (const cls of ["cm-plan-grid", "cm-review-front", "cm-review-back", "cm-progress-row", "cm-search-hit", "cm-prep-steps"]) {
  assert.ok(css.includes("." + cls), `CSS-Klasse ${cls} fehlt`);
}

console.log("career model learning: ok");
