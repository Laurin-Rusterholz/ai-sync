/*
 * DailyBriefing-Umbau nach Konzept v3 S13/S16/S18 §11.3: ganz oben nur
 * Arbeitsdeckung, Betriebszustand, letzte bestätigte Prüfung, nächster Lauf
 * und zwingende Handlungen; darunter fällige Ausnahmen und echte
 * persönliche Freigaben mit vorbereitetem Ergebnis; alles Weitere bleibt
 * kompakt/eingeklappt. Keine erfundene grüne Prüfung — fehlt eine
 * Bestätigung, muss das ausdrücklich "offen"/"noch nicht geprüft" heissen.
 * Verweise auf Aufgaben/Entscheidungen zeigen auf die echten Originalobjekte
 * (data-action="open-entity"), es gibt keinen zweiten Aufgabenbestand, und
 * nichts davon darf Habits (dailyBriefing.routines) anfassen.
 *
 * Diese Tests extrahieren die ECHTEN Funktionen aus public/index.html.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

function sliceFn(startMarker, startFrom = 0) {
  const start = index.indexOf(startMarker, startFrom);
  assert.ok(start > 0, `Marker nicht gefunden: ${startMarker}`);
  const end = index.indexOf("\n}\n", start) + 3;
  assert.ok(end > start + 3, `Ende nicht bestimmbar fuer: ${startMarker}`);
  return { text: index.slice(start, end), end };
}

// ── 0) Echte Verdrahtung in viewDailyBriefing(): Reihenfolge und Einklappung ──
{
  const vdbStart = index.indexOf("function viewDailyBriefing() {");
  assert.ok(vdbStart > 0, "viewDailyBriefing() wurde nicht gefunden");
  const vdbEnd = index.indexOf("\nwindow.viewDailyBriefing = viewDailyBriefing;", vdbStart);
  assert.ok(vdbEnd > vdbStart, "Ende von viewDailyBriefing() nicht bestimmbar");
  const vdbSrc = index.slice(vdbStart, vdbEnd);

  const posKontrolle = vdbSrc.indexOf('id="dbV3Kontrolle"');
  const posAusnahmen = vdbSrc.indexOf('id="dbV3Ausnahmen"');
  const posStatus = vdbSrc.indexOf('id="dbV3Status"');
  const posSchluss = vdbSrc.indexOf('id="dbV3Schlusspruefung"');
  const posSecondary = vdbSrc.indexOf('id="dbSecondarySections"');
  const posTagesziele = vdbSrc.indexOf("<!-- Tagesziele -->");
  const posVergangeneTage = vdbSrc.indexOf("<!-- Vergangene Tage -->");

  test("Kontrollbereich steht ganz oben, vor allem anderen v3-Material (S18 §11.3)", () => {
    assert.ok([posKontrolle, posAusnahmen, posStatus, posSchluss, posSecondary].every((p) => p > 0), "eine der neuen Sektionen fehlt in viewDailyBriefing()");
    assert.ok(posKontrolle < posAusnahmen && posAusnahmen < posStatus && posStatus < posSchluss && posSchluss < posSecondary,
      "Reihenfolge muss Kontrollbereich -> Ausnahmen/Freigaben -> Automatisches Tagesbriefing -> Schlussprüfung -> Weitere Bereiche sein");
  });

  test("die 'Weitere Bereiche' sind wirklich eingeklappt (<details>) und liegen NACH dem Kontrollbereich", () => {
    assert.ok(posSecondary < posTagesziele, "dbSecondarySections muss VOR der Tagesziele-Sektion oeffnen");
    assert.ok(posTagesziele < posVergangeneTage, "Tagesziele muss vor Vergangene Tage liegen");
    const detailsTag = vdbSrc.slice(posSecondary - 10, posSecondary + 20);
    assert.match(detailsTag, /<details/, "dbSecondarySections muss ein <details>-Element sein, kein einfaches <div>");
  });

  test("keine der sekundaeren Sektionen (Tagesziele etc.) steht VOR dem Kontrollbereich", () => {
    assert.ok(posTagesziele > posKontrolle, "Tagesziele darf nicht vor dem Kontrollbereich erscheinen");
  });

  test("kein Habit-Write im neuen v3-Bereich: das Segment vor 'Weitere Bereiche' fasst dailyBriefing.routines nicht an", () => {
    const vorSecondary = vdbSrc.slice(0, posSecondary);
    assert.ok(!/routines/.test(vorSecondary), "der neue Kontroll-/Ausnahmen-/Schlusspruefungs-Bereich darf Habits (dailyBriefing.routines) nicht anfassen");
    assert.ok(!/toggleHabitToday|toggleHabitSubUnit|incHabitToday/.test(vorSecondary), "keine Habit-Toggle-Funktionen im neuen Bereich");
  });
}

// ── Extraktion der echten Hilfsfunktionen ──────────────────────────────────
const escSrc = index.slice(index.indexOf("\nfunction esc(s){"), index.indexOf("}\n", index.indexOf("\nfunction esc(s){")) + 1);
const todayStart = index.indexOf("const todayYmd = () => {");
const todaySrc = index.slice(todayStart, index.indexOf("};\n", todayStart) + 2);
const addDaysStart = index.indexOf("const addDaysYmd = (ymd, days) => {");
const addDaysSrc = index.slice(addDaysStart, index.indexOf("};\n", addDaysStart) + 2);

const blockStart = index.indexOf("const V3_AMPEL_LABEL = {");
assert.ok(blockStart > 0, "V3_AMPEL_LABEL wurde nicht gefunden");
const schluss = sliceFn("function renderV3Schlusspruefung(runV3, selectedDate) {", blockStart);
const blockSrc = index.slice(blockStart, schluss.end);

function loadModule() {
  const fn = new Function("APP", "window",
    escSrc + "\n" + todaySrc + "\n" + addDaysSrc + "\n" + blockSrc + "\n"
    + "return { renderV3ControlPanel, renderV3FaelligeAusnahmen, renderV3Freigaben, renderV3Schlusspruefung, v3NextSlotInfo, v3AmpelText, dbDecideDecision: window.dbDecideDecision };"
  );
  return fn;
}

function appWith(data, storage) {
  return { state: { data, storage: storage || {} } };
}

// ── 1) renderV3ControlPanel: leere Daten, keine erfundene gruene Pruefung ──
test("renderV3ControlPanel: ohne jeden Lauf -> 'noch nicht geprüft'/'noch nicht bestätigt', keine gruene Pruefung, kein Absturz", () => {
  const win = {};
  const mod = loadModule()(appWith({ entities: {} }), win);
  // Bewusst ein Datum, das nie "heute" ist (unabhaengig vom echten Systemdatum),
  // sonst wuerde die "E-Mail-Auswertung heute noch nicht durchgefuehrt"-Regel
  // faelschlich mitgezaehlt und den Leerzustand-Test verfaelschen.
  const html = mod.renderV3ControlPanel("2020-01-01", undefined, []);
  assert.match(html, /noch nicht geprüft/);
  assert.match(html, /Noch nicht bestätigt/);
  assert.doesNotMatch(html, /🟢/, "ohne echte Bewertung darf niemals ein gruenes Symbol erscheinen");
  assert.match(html, /Keine zwingenden Handlungen/);
});

test("renderV3ControlPanel: mit echter finalEvaluation werden Arbeitsdeckung/Betriebszustand korrekt getrennt gezeigt (S13)", () => {
  const win = {};
  const runV3 = { finalEvaluation: { coverage: "green", operations: "yellow" }, finalAt: "2026-09-21T23:10:00.000Z", closureRevision: 7 };
  const mod = loadModule()(appWith({ entities: {} }), win);
  const html = mod.renderV3ControlPanel("2026-09-21", runV3, []);
  assert.match(html, /🟢 in Ordnung/, "Arbeitsdeckung (coverage) muss gruen erscheinen");
  assert.match(html, /🟡 zu prüfen/, "Betriebszustand (operations) muss GETRENNT von coverage gelb erscheinen, nicht gruen");
  assert.match(html, /Revision 7/);
});

test("renderV3ControlPanel: ueberfaellige Aufgabe erscheint als zwingende Handlung MIT Verweis auf das echte Originalobjekt", () => {
  const win = {};
  const overdueTasks = [{ id: "t_real_1", title: "Vertrag pruefen" }];
  const mod = loadModule()(appWith({ entities: {} }), win);
  const html = mod.renderV3ControlPanel("2026-09-21", undefined, overdueTasks);
  assert.match(html, /data-action="open-entity" data-kind="task" data-id="t_real_1"/, "muss auf die echte Aufgabe verlinken, kein zweiter Aufgabenbestand");
  assert.match(html, /Vertrag pruefen/);
});

test("renderV3ControlPanel: ueberfaellige Entscheidung erscheint als zwingende Handlung mit Verweis auf entities.decisions", () => {
  const win = {};
  const data = { entities: { decisions: { d1: { id: "d1", title: "Angebot annehmen?", status: "open", deadline: "2020-01-01" } } } };
  const mod = loadModule()(appWith(data), win);
  const html = mod.renderV3ControlPanel("2026-09-21", undefined, []);
  assert.match(html, /data-action="open-entity" data-kind="decision" data-id="d1"/);
});

test("renderV3ControlPanel: fehlende Mail-Pruefung heute wird als zwingende Handlung markiert, blockiert aber nichts (Rueckgabe bleibt ein normaler HTML-String)", () => {
  const win = {};
  const heute = new Date().toISOString().slice(0, 10);
  const mod = loadModule()(appWith({ entities: {} }), win);
  const html = mod.renderV3ControlPanel(heute, { sourceChecks: {} }, []);
  assert.match(html, /E-Mail-Auswertung heute noch nicht durchgeführt/);
  assert.equal(typeof html, "string");
});

// ── 2) renderV3FaelligeAusnahmen: S13 fehlende Pflichtquelle bleibt offen/rot ──
test("renderV3FaelligeAusnahmen: ohne Ausnahmen ein ehrlicher Leerzustand", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const html = mod.renderV3FaelligeAusnahmen(undefined, "2026-09-21");
  assert.match(html, /Keine fälligen Ausnahmen/);
});

test("renderV3FaelligeAusnahmen: eine nicht-'ok' Quellenpruefung wird sichtbar, nicht stillschweigend uebersprungen", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const html = mod.renderV3FaelligeAusnahmen({ sourceChecks: { gmail: { outcome: "auth_error" } } }, "2026-09-21");
  assert.match(html, /gmail/);
  assert.match(html, /Anmeldefehler/);
});

test("renderV3FaelligeAusnahmen: bald faellige (aber nicht ueberfaellige) Entscheidung erscheint hier, nicht bei den zwingenden Handlungen", () => {
  const heute = new Date().toISOString().slice(0, 10);
  const data = { entities: { decisions: { d1: { id: "d1", title: "Reise buchen", status: "open", deadline: heute } } } };
  const mod = loadModule()(appWith(data), {});
  const html = mod.renderV3FaelligeAusnahmen(undefined, heute);
  assert.match(html, /Reise buchen/);
});

// ── 3) renderV3Freigaben: Originalobjekte, kein zweiter Bestand ────────────
test("renderV3Freigaben: ohne vorbereitete Entscheidung ein ehrlicher Leerzustand", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  assert.match(mod.renderV3Freigaben(), /Keine vorbereiteten Freigaben/);
});

test("renderV3Freigaben: offene Entscheidung MIT Beschreibung erscheint mit Ja/Nein, die das Originalobjekt aendern", () => {
  const data = { entities: { decisions: { d1: { id: "d1", title: "Budget erhoehen?", description: "Antrag liegt vor.", status: "open", votes: [] } } } };
  const mod = loadModule()(appWith(data), {});
  const html = mod.renderV3Freigaben();
  assert.match(html, /Budget erhoehen\?/);
  assert.match(html, /window\.dbDecideDecision\('d1','yes'\)/);
  assert.match(html, /window\.dbDecideDecision\('d1','no'\)/);
  assert.match(html, /data-action="open-entity" data-kind="decision" data-id="d1"/);
});

test("renderV3Freigaben: eine Entscheidung OHNE Beschreibung gilt nicht als 'vorbereitet' und erscheint nicht", () => {
  const data = { entities: { decisions: { d1: { id: "d1", title: "Ohne Inhalt", status: "open" } } } };
  const mod = loadModule()(appWith(data), {});
  assert.doesNotMatch(mod.renderV3Freigaben(), /Ohne Inhalt/);
});

test("dbDecideDecision schreibt DIREKT ins Originalobjekt (entities.decisions), kein zweiter Bestand, kein Habit-Write", () => {
  const dc = { id: "d1", title: "x", votes: [] };
  const data = { entities: { decisions: { d1: dc } } };
  let saved = false, rendered = false;
  const win = {};
  const getEntity = (kind, id) => (kind === "decision" ? data.entities.decisions[id] : null);
  const scheduleSave = () => { saved = true; };
  const render = () => { rendered = true; };
  const nowIso = () => "2026-09-21T10:00:00.000Z";
  const fn = new Function("APP", "window", "getEntity", "scheduleSave", "render", "nowIso",
    escSrc + "\n" + todaySrc + "\n" + addDaysSrc + "\n" + blockSrc + "\nreturn window.dbDecideDecision;");
  const decide = fn(appWith(data), win, getEntity, scheduleSave, render, nowIso);
  decide("d1", "yes");
  assert.equal(dc.votes.length, 1, "das ECHTE Objekt aus entities.decisions muss veraendert werden");
  assert.equal(dc.votes[0].vote, "yes");
  assert.ok(saved && rendered, "scheduleSave() und render() muessen aufgerufen werden");
  assert.equal(data.dailyBriefing, undefined, "dbDecideDecision darf niemals dailyBriefing.routines (Habits) beruehren");
});

// ── 4) renderV3Schlusspruefung: nie eine erfundene abgeschlossene Pruefung ──
test("renderV3Schlusspruefung: ohne Lauf ein ehrlicher Hinweis, keine Pruefung behauptet", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const html = mod.renderV3Schlusspruefung(undefined, "2026-09-21");
  assert.match(html, /noch kein Lauf vor/);
});

test("renderV3Schlusspruefung: Lauf vorhanden, aber NICHT final -> ausdruecklich 'noch keine abgeschlossene Schlussprüfung', nie ein Haekchen", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const runV3 = { phase: "created", slotReceipts: { briefing04: null, process09: null, continue14: null, close23: null } };
  const html = mod.renderV3Schlusspruefung(runV3, "2026-09-21");
  assert.match(html, /noch keine abgeschlossene Schlussprüfung/);
  assert.doesNotMatch(html, /phase.*final/i);
});

test("renderV3Schlusspruefung: echte Slot-Quittungen werden pro Slot korrekt bestaetigt/offen gezeigt", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const runV3 = {
    phase: "created",
    slotReceipts: {
      briefing04: { receiptId: "r1", at: "2026-09-21T04:05:00.000Z" },
      process09: null, continue14: null, close23: null,
    },
  };
  const html = mod.renderV3Schlusspruefung(runV3, "2026-09-21");
  const belegteZeile = html.match(/04:00 Start[\s\S]*?<\/div>/)[0];
  assert.match(belegteZeile, /✅ bestätigt/);
  const offeneZeile = html.match(/09:00 Bearbeitung[\s\S]*?<\/div>/)[0];
  assert.match(offeneZeile, /🔴 offen/);
});

test("renderV3Schlusspruefung: echter Abschluss (phase=final) zeigt die echte Notiz, unveraendert und aufklappbar (S16-Muster)", () => {
  const data = { entities: { chatgptNotes: { note1: { id: "note1", instruction: "Abschlusstext heute." } } } };
  const mod = loadModule()(appWith(data), {});
  const runV3 = { phase: "final", finalNoteId: "note1", finalAt: "2026-09-21T23:30:00.000Z", closureRevision: 3, slotReceipts: {} };
  const html = mod.renderV3Schlusspruefung(runV3, "2026-09-21");
  assert.match(html, /<details/, "die Abschlussnotiz muss als aufklappbarer Pruefpfad erscheinen (S16)");
  assert.match(html, /Abschlusstext heute\./);
});

// ── 5) v3NextSlotInfo: reine, deterministische Uhrzeitberechnung ──────────
test("v3NextSlotInfo: kurz nach 04:00 Europe/Zurich ist der naechste Lauf 09:00 heute", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  // 04:30 Europe/Zurich im September (Sommerzeit, UTC+2) = 02:30 UTC.
  const t = Date.parse("2026-09-21T02:30:00.000Z");
  const info = mod.v3NextSlotInfo(t);
  assert.equal(info.stunde, 9);
  assert.equal(info.morgen, false);
});

test("v3NextSlotInfo: nach 23:00 rollt der naechste Lauf auf 04:00 morgen", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const t = Date.parse("2026-09-21T21:30:00.000Z"); // 23:30 Europe/Zurich (Sommerzeit, UTC+2).
  const info = mod.v3NextSlotInfo(t);
  assert.equal(info.stunde, 4);
  assert.equal(info.morgen, true);
});

console.log("quantus-v3-daily-briefing-controlpanel: alle Pruefungen bestanden");
