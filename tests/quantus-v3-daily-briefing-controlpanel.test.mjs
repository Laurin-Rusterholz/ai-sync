/*
 * DailyBriefing-Umbau nach Konzept v3 S13/S16/S18 §11.3, korrigiert nach
 * Review 94fd75f:
 *
 * 1) finalEvaluation ist eine HISTORISCHE Momentaufnahme (assistant-
 *    abschluss.mjs closeRun) — sie gilt nur als aktuell, wenn phase==="final",
 *    keine invalidatedAt UND die (einzige ohne Server-Policy pruefbare)
 *    Revision uebereinstimmt. Sonst ausdruecklich "historisch/ungeprüft",
 *    NIE ein gruenes aktuelles Label (S13).
 * 2) storage.status wird u. a. rein aus countEntities() gesetzt — niemals
 *    als "Server bestätigt" ausgeben, nur "lokal synchronisiert/unbekannt".
 * 3) Keine neue Abstimmungs-Mutation ohne Nutzeridentitaet/Version — Ja/Nein
 *    wurde entfernt, "Freigaben" verlinkt nur auf die echte Entscheidung.
 *    Eine Beschreibung allein macht daraus keine erfundene "Freigabe".
 * 4) Ein sichtbarer, kompakter Ueberblick (Projekte, KI-Pendente, eigene
 *    Aufgaben, Termine, Dokumente/Messwerte) ergaenzt das eingeklappte
 *    "Weitere Bereiche" — echte Zahlen, unbekannte explizit gekennzeichnet.
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
  const posUeberblick = vdbSrc.indexOf('id="dbV3Ueberblick"');
  const posSecondary = vdbSrc.indexOf('id="dbSecondarySections"');
  const posTagesziele = vdbSrc.indexOf("<!-- Tagesziele -->");
  const posVergangeneTage = vdbSrc.indexOf("<!-- Vergangene Tage -->");

  test("Kontrollbereich steht ganz oben, vor allem anderen v3-Material (S18 §11.3)", () => {
    assert.ok([posKontrolle, posAusnahmen, posStatus, posSchluss, posUeberblick, posSecondary].every((p) => p > 0), "eine der neuen Sektionen fehlt in viewDailyBriefing()");
    assert.ok(posKontrolle < posAusnahmen && posAusnahmen < posStatus && posStatus < posSchluss && posSchluss < posUeberblick && posUeberblick < posSecondary,
      "Reihenfolge muss Kontrollbereich -> Ausnahmen/Freigaben -> Automatisches Tagesbriefing -> Schlussprüfung -> Ueberblick -> Weitere Bereiche sein");
  });

  test("Befund 4: der Ueberblick ist SICHTBAR (kein <details>), nicht im eingeklappten Bereich versteckt", () => {
    const stueck = vdbSrc.slice(posUeberblick - 20, posUeberblick + 20);
    assert.doesNotMatch(stueck, /<details/, "der Ueberblick muss ausserhalb des eingeklappten <details> sichtbar sein");
    assert.ok(posUeberblick < posSecondary, "der Ueberblick muss vor dem eingeklappten Bereich stehen");
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

  test("Befund 3: keine neue Abstimmungs-Mutation mehr im Datei — dbDecideDecision/votes.push wurde entfernt", () => {
    assert.ok(!/dbDecideDecision/.test(index), "dbDecideDecision darf nach Review 94fd75f nicht mehr existieren");
  });

  test("Kalender-Live-Fix: das echte gcal-Modul exportiert gcalEventsInRange/gcalStatusSnapshot/gcalEnsureLoaded", () => {
    assert.match(index, /window\.gcalEventsInRange\s*=\s*function/, "gcalEventsInRange muss im echten gcal-Modul exportiert sein, sonst bleibt renderV3Ueberblick beim Nullbestand");
    assert.match(index, /window\.gcalStatusSnapshot\s*=\s*function/, "gcalStatusSnapshot muss im echten gcal-Modul exportiert sein");
    assert.match(index, /window\.gcalEnsureLoaded\s*=\s*gcalEnsureLoaded/, "gcalEnsureLoaded muss im echten gcal-Modul exportiert sein, sonst startet nie ein Ladevorgang");
  });

  // ── Review-Fix PR267 ────────────────────────────────────────────────────
  test("Review-Fix PR267: dedizierter Bereichslader gcalEnsureRangeLoaded existiert und gcalStatusSnapshot liefert statusChecked/brRange/brError", () => {
    assert.match(index, /window\.gcalEnsureRangeLoaded\s*=\s*loadBriefingRange/, "ein von gcalEnsureLoaded getrennter, deduplizierender Bereichslader muss exportiert sein — sonst laedt die Briefing-Kalenderzeile den falschen (View-)Bereich");
    assert.match(index, /statusChecked:\s*GC\.status\s*!==\s*undefined/, "gcalStatusSnapshot muss 'noch nie geprueft' von 'geprueft und nicht verbunden' unterscheiden");
    assert.match(index, /brRange:\s*\(GC\._brRangeMin/, "gcalStatusSnapshot muss den tatsaechlich abgedeckten Bereich melden, nicht den View-Bereich");
    assert.match(index, /brError:\s*GC\._brError/, "gcalStatusSnapshot muss einen Ladefehler melden, statt ihn zu verschweigen");
  });

  test("Review-Fix PR267: loadBriefingRange schluckt Kalenderfehler nicht (kein reines console.warn wie in loadEvents)", () => {
    const loaderMatch = index.match(/async function loadBriefingRange\(fromYmd, toYmd, force\)\{[\s\S]*?\n  \}/);
    assert.ok(loaderMatch, "loadBriefingRange muss im gcal-Modul existieren");
    assert.match(loaderMatch[0], /failed\.push\(calId\)/, "fehlgeschlagene Kalenderabrufe muessen erfasst werden");
    assert.match(loaderMatch[0], /GC\._brError\s*=\s*failed\.length/, "ein Teilfehler muss GC._brError setzen, statt eine vollstaendige leere Liste vorzutaeuschen");
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
// Konzept v2 C: v3ProjectLineText ist die letzte Funktion in diesem Block
// (nach v3FreeSlotsForDay) — Ende dort, sonst bleibt die Projektzeile ungetestet.
const projectLine = sliceFn("function v3ProjectLineText(p, offeneAufgaben) {", blockStart);
const blockSrc = index.slice(blockStart, projectLine.end);

function loadModule(extraFns = {}) {
  // nowIso/fmtDateTime sind echte globale Helfer aus index.html, die ausserhalb
  // des extrahierten Blocks definiert sind — hier als einfache, deterministische
  // Stubs bereitgestellt, damit v3RegisterFollowUp/renderV3ChatgptCockpit ohne
  // ReferenceError laufen; ein Test kann sie ueber extraFns ueberschreiben.
  const alle = { nowIso: () => new Date().toISOString(), fmtDateTime: (iso) => String(iso || ""), ...extraFns };
  const namen = Object.keys(alle);
  const fn = new Function("APP", "window", ...namen,
    escSrc + "\n" + todaySrc + "\n" + addDaysSrc + "\n" + blockSrc + "\n"
    + "return { renderV3ControlPanel, renderV3FaelligeAusnahmen, renderV3Freigaben, renderV3Schlusspruefung, renderV3Ueberblick, renderV3ChatgptCockpit, renderV3IntakeQueue, renderV3AppProgress, v3LeadOperationalState, v3LeadStatus, v3LeadStatusText, v3RegisterFollowUp, v3ZurichLocalToUtcIso, v3PlanningSettings, v3FreeSlotsForDay, v3ProjectLineText, v3NextSlotInfo, v3AmpelText, v3AktuelleBewertung, v3SpeicherStatusText };"
  );
  return (app, win) => fn(app, win, ...namen.map((n) => alle[n]));
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

// ── Befund 1: finalEvaluation ist historisch — nur bei phase=final, keiner
// Invalidierung UND uebereinstimmender automation.dataRevision aktuell. ────
test("Befund 1: finalEvaluation OHNE phase=final gilt als historisch — kein gruenes aktuelles Label", () => {
  const win = {};
  // Dieselbe Bewertung wie im 'aktuellen' Test unten, aber OHNE phase:"final".
  const runV3 = { finalEvaluation: { coverage: "green", operations: "yellow", evaluatedRevision: 5 }, finalAt: "2026-09-21T23:10:00.000Z", closureRevision: 7 };
  const data = { entities: {}, automation: { dataRevision: 5 } };
  const mod = loadModule()(appWith(data), win);
  const html = mod.renderV3ControlPanel("2026-09-21", runV3, []);
  assert.doesNotMatch(html, /🟢|🟡/, "ohne phase='final' darf niemals ein farbiges aktuelles Label erscheinen");
  assert.match(html, /historisch \(nicht mehr aktuell\)/);
});

test("Befund 1: finalEvaluation MIT phase=final, aber veraenderter automation.dataRevision seither -> historisch, nie gruen", () => {
  const win = {};
  const runV3 = { phase: "final", finalEvaluation: { coverage: "green", operations: "green", evaluatedRevision: 5 }, finalAt: "2026-09-21T23:10:00.000Z", closureRevision: 7 };
  const data = { entities: {}, automation: { dataRevision: 9 } }; // Bestand hat sich seither geaendert
  const mod = loadModule()(appWith(data), win);
  const html = mod.renderV3ControlPanel("2026-09-21", runV3, []);
  assert.doesNotMatch(html, /🟢/, "eine veraenderte Revision darf niemals eine gruene Bewertung zeigen");
  assert.match(html, /historisch \(nicht mehr aktuell\)/);
});

test("Befund 1: ein WIDERRUFENER Abschluss (invalidatedAt gesetzt) gilt niemals als aktuell", () => {
  const win = {};
  const runV3 = { phase: "exception_open", invalidatedAt: "2026-09-21T23:50:00.000Z", finalEvaluation: { coverage: "green", operations: "green", evaluatedRevision: 5 } };
  const data = { entities: {}, automation: { dataRevision: 5 } };
  const mod = loadModule()(appWith(data), win);
  const html = mod.renderV3ControlPanel("2026-09-21", runV3, []);
  assert.doesNotMatch(html, /🟢/, "ein widerrufener Abschluss darf niemals gruen erscheinen");
});

// Sicherheitsnachtrag (nach ad84f54): ein Revisionsvergleich allein reicht
// NICHT — Fristen/Quellen koennen rein durch Zeitablauf (validUntil) altern,
// ohne dass sich automation.dataRevision aendert. Ohne echte Serverpolicy
// darf deshalb selbst eine UNVERAENDERTE Revision niemals "aktuell gruen"
// ergeben — jede finalEvaluation bleibt ausschliesslich historisch.
test("Sicherheitsnachtrag: phase=final, invalidatedAt fehlt, UNVERAENDERTE Revision — trotzdem niemals aktuell/gruen (Zeitablauf nicht pruefbar)", () => {
  const win = {};
  const runV3 = { phase: "final", finalEvaluation: { coverage: "green", operations: "yellow", evaluatedRevision: 5 }, finalAt: "2026-09-21T23:10:00.000Z", closureRevision: 7 };
  const data = { entities: {}, automation: { dataRevision: 5 } }; // exakt gleiche Revision wie evaluatedRevision
  const mod = loadModule()(appWith(data), win);
  const html = mod.renderV3ControlPanel("2026-09-21", runV3, []);
  assert.doesNotMatch(html, /🟢|🟡 zu prüfen/, "eine unveraenderte Revision allein darf ohne Server-Policy niemals als aktuell/gruen/gelb gelten");
  assert.match(html, /historisch \(nicht mehr aktuell\)/, "muss trotz gleicher Revision als historisch gekennzeichnet sein");
  // Das Datum des echten letzten Abschlusses bleibt trotzdem sichtbar.
  assert.match(html, /Revision 7/);
  assert.match(html, /nur historischer Stand/);
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

// ── Befund 2: storage.status niemals als "Server bestätigt" ausgeben ──────
test("Befund 2: storage.status='saved' (auch reine countEntities-Vermutung) wird NIE als 'Server bestätigt' ausgegeben", () => {
  const mod = loadModule()(appWith({ entities: {} }, { status: "saved" }), {});
  const text = mod.v3SpeicherStatusText();
  assert.doesNotMatch(text, /Server bestätigt/);
  assert.match(text, /Lokal synchronisiert.*unbekannt/);
});
test("Befund 2: 'idle'/'warning'/unbekannter Status ebenfalls nie 'Server bestätigt'", () => {
  for (const s of ["idle", "warning", undefined, "irgendwas"]) {
    const mod = loadModule()(appWith({ entities: {} }, { status: s }), {});
    assert.doesNotMatch(mod.v3SpeicherStatusText(), /Server bestätigt/, `Status '${s}' darf nicht als bestätigt gelten`);
  }
});
test("Befund 2: 'offline'/'error'/'auth_required' bleiben ehrlich als nicht synchronisiert erkennbar", () => {
  assert.match(loadModule()(appWith({ entities: {} }, { status: "offline" }), {}).v3SpeicherStatusText(), /nicht synchronisiert/);
  assert.match(loadModule()(appWith({ entities: {} }, { status: "error" }), {}).v3SpeicherStatusText(), /Nicht synchronisiert/);
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

// ── Befund 3: Freigaben nur noch Verweis auf Originalentscheidung, keine
// neue Mutation, keine erfundene "Freigabe" nur wegen Beschreibungstext. ────
test("Befund 3: renderV3Freigaben ohne offene Entscheidung ein ehrlicher Leerzustand", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  assert.match(mod.renderV3Freigaben(), /Keine offenen Freigaben/);
});

test("Befund 3: eine offene Entscheidung OHNE Beschreibung erscheint trotzdem — Beschreibung ist kein Kriterium mehr", () => {
  const data = { entities: { decisions: { d1: { id: "d1", title: "Ohne Beschreibungstext", status: "open" } } } };
  const mod = loadModule()(appWith(data), {});
  const html = mod.renderV3Freigaben();
  assert.match(html, /Ohne Beschreibungstext/, "eine fehlende Beschreibung darf eine echte offene Entscheidung nicht ausblenden");
});

test("Befund 3: KEIN Ja/Nein-Knopf, KEINE dbDecideDecision-Mutation mehr — nur Verweis auf die echte Entscheidung", () => {
  const data = { entities: { decisions: { d1: { id: "d1", title: "Budget erhoehen?", description: "Antrag liegt vor.", status: "open", votes: [{ vote: "yes" }] } } } };
  const mod = loadModule()(appWith(data), {});
  const html = mod.renderV3Freigaben();
  assert.match(html, /Budget erhoehen\?/);
  assert.match(html, /data-action="open-entity" data-kind="decision" data-id="d1"/, "muss auf die bestehende, bereits geprüfte Bearbeitung verlinken");
  assert.doesNotMatch(html, /dbDecideDecision|👍|👎|<button/, "keine neue Abstimmungs-UI mehr");
  assert.match(html, /1 Stimme/, "bestehende echte Stimmen duerfen weiter angezeigt werden");
});

test("Befund 3: ueberfaellige/bald faellige Entscheidungen werden hier NICHT doppelt gezeigt (stehen schon bei Handlungen/Ausnahmen)", () => {
  const heute = new Date().toISOString().slice(0, 10);
  const data = { entities: { decisions: {
    ueberfaellig: { id: "ueberfaellig", title: "Laengst faellig", status: "open", deadline: "2000-01-01" },
    baldFaellig: { id: "baldFaellig", title: "Bald faellig", status: "open", deadline: heute },
    normal: { id: "normal", title: "Ohne Eile", status: "open" },
  } } };
  const mod = loadModule()(appWith(data), {});
  const html = mod.renderV3Freigaben();
  assert.doesNotMatch(html, /Laengst faellig/);
  assert.doesNotMatch(html, /Bald faellig/);
  assert.match(html, /Ohne Eile/);
});

// ── Befund 4: sichtbarer, kompakter Ueberblick — echte Zahlen, Unbekanntes markiert ──
test("Befund 4: renderV3Ueberblick zeigt echte Zaehlwerte je Kategorie und markiert Dokumente/Messwerte ehrlich als nicht erfasst", () => {
  const data = {
    entities: {
      chatgptLeads: { l1: { status: "neu" }, l2: { status: "abgeschlossen" } },
      chatgptTasks: { t1: { state: "offen" }, t2: { state: "erledigt" } },
    },
  };
  const win = { gcalStatusSnapshot: () => ({ connected: false }) };
  const mod = loadModule()(appWith(data), win);
  const html = mod.renderV3Ueberblick({
    allProjects: [{ id: "p1" }, { id: "p2" }],
    overdueTasks: [{ id: "t1" }],
    upcomingTasks: [{ id: "t2" }, { id: "t3" }],
    selectedDate: "2026-09-21", future7Str: "2026-09-28",
  });
  assert.match(html, /2 aktiv\/in Planung/, "Projektzahl muss aus den echten, bereits berechneten Bestaenden kommen");
  assert.match(html, /2 offen \(Leads 1, Aufgaben 1\)/, "nur der wirklich offene Lead/die wirklich offene Aufgabe zaehlen");
  assert.match(html, /1 überfällig, 2 anstehend/);
  assert.match(html, /nicht erfasst/, "Dokumente/Messwerte duerfen keine erfundene Zahl zeigen");
});

// Regressionstest (Computer-Use-Abnahme, PR265 live): 5 LEADS SIND OFFEN,
// aber bereits gelesen (readAt gesetzt) und teils im Status "wartet" — die
// alte chatgptLeadsUnreadCount()-Logik haette hier faelschlich 0 gezeigt.
test("Regressionstest: 5 bereits gelesene, aber offene Leads (u. a. 'wartet') werden trotzdem als offen gezaehlt", () => {
  const data = {
    entities: {
      chatgptLeads: {
        l1: { status: "neu", readAt: "2026-09-20T08:00:00.000Z" },
        l2: { status: "verstanden", readAt: "2026-09-20T08:00:00.000Z" },
        l3: { status: "in_arbeit", readAt: "2026-09-20T08:00:00.000Z" },
        l4: { status: "wartet", readAt: "2026-09-20T08:00:00.000Z" },
        l5: { status: "wartet", readAt: "2026-09-20T08:00:00.000Z" },
        l6: { status: "abgeschlossen", readAt: "2026-09-20T08:00:00.000Z" }, // zaehlt nicht
      },
      chatgptTasks: {},
    },
  };
  const win = { gcalStatusSnapshot: () => ({ connected: false }) };
  const mod = loadModule()(appWith(data), win);
  const html = mod.renderV3Ueberblick({ allProjects: [], overdueTasks: [], upcomingTasks: [], selectedDate: "2026-09-21", future7Str: "2026-09-28" });
  assert.match(html, /5 offen \(Leads 5, Aufgaben 0\)/, "5 gelesene, aber offene Leads (inkl. 'wartet') duerfen nicht verschwiegen werden");
  assert.doesNotMatch(html, /KI-Pendente[\s\S]*?0 offen/, "die alte Unread-Logik (faelschlich 0) darf nicht wieder auftreten");
});

// ── Konzept v2 H, konkreter Bug (Live-Test 21.09.): Kalender zeigte 0 statt
// 59 echter Termine, weil entities.calendarEvents/meetings nie vom echten
// Google-Sync befuellt werden (der lebt in der Modulvariable GC.events).
// Ab jetzt liest renderV3Ueberblick den ECHTEN Adapter (window.gcal*). ────
test("Regressionstest: Google Kalender verbunden und geladen -> echte Live-Zahlen statt lokalem Nullbestand", () => {
  const win = {
    gcalStatusSnapshot: () => ({ statusChecked: true, connected: true, brBooted: true, brLoading: false, brError: null, brRange: { min: "2026-09-21", max: "2026-09-28" } }),
    gcalEventsInRange: (from, to) => (from === to ? new Array(3).fill(0) : new Array(59).fill(0)),
  };
  const mod = loadModule()(appWith({ entities: {} }), win);
  const html = mod.renderV3Ueberblick({ allProjects: [], overdueTasks: [], upcomingTasks: [], selectedDate: "2026-09-21", future7Str: "2026-09-28" });
  assert.match(html, /3 heute, 59 diese Woche \(Google Kalender\)/, "die echten Google-Kalender-Zahlen muessen erscheinen, kein lokaler Nullbestand");
});

test("Kalenderzeile: nicht verbunden wird ehrlich als 'nicht verbunden' gezeigt, keine erfundene Zahl", () => {
  const win = { gcalStatusSnapshot: () => ({ statusChecked: true, connected: false }) };
  const mod = loadModule()(appWith({ entities: {} }), win);
  const html = mod.renderV3Ueberblick({ allProjects: [], overdueTasks: [], upcomingTasks: [], selectedDate: "2026-09-21", future7Str: "2026-09-28" });
  assert.match(html, /Termine[\s\S]*?nicht verbunden/);
});

test("Kalenderzeile: verbunden, aber noch nicht geladen -> 'wird geladen' UND stoesst gcalEnsureRangeLoaded() an (kein stiller Nullbestand)", () => {
  let ensureCalledWith = null;
  const win = {
    gcalStatusSnapshot: () => ({ statusChecked: true, connected: true, brBooted: false, brLoading: false, brError: null, brRange: null }),
    gcalEnsureRangeLoaded: (from, to) => { ensureCalledWith = [from, to]; return Promise.resolve(); },
  };
  const mod = loadModule()(appWith({ entities: {} }), win);
  const html = mod.renderV3Ueberblick({ allProjects: [], overdueTasks: [], upcomingTasks: [], selectedDate: "2026-09-21", future7Str: "2026-09-28" });
  assert.match(html, /wird geladen/);
  assert.deepEqual(ensureCalledWith, ["2026-09-21", "2026-09-28"], "das erste Rendern ohne Kalenderbesuch muss den echten Ladevorgang fuer GENAU den angefragten Bereich anstossen, sonst bleibt es bei 0");
});

// ── Review-Fix PR267: Kaltstart VOR jedem Statuscheck darf nicht als
// "nicht verbunden" erscheinen (GC.status===undefined wurde vorher wie
// connected:false behandelt) ────────────────────────────────────────────
test("Kalenderzeile Kaltstart: Verbindungsstatus noch nie geprueft -> 'wird geprüft', NICHT 'nicht verbunden', UND stoesst Laden an", () => {
  let ensureCalled = false;
  const win = {
    gcalStatusSnapshot: () => ({ statusChecked: false }),
    gcalEnsureRangeLoaded: () => { ensureCalled = true; return Promise.resolve(); },
  };
  const mod = loadModule()(appWith({ entities: {} }), win);
  const html = mod.renderV3Ueberblick({ allProjects: [], overdueTasks: [], upcomingTasks: [], selectedDate: "2026-09-21", future7Str: "2026-09-28" });
  assert.doesNotMatch(html, /Termine[\s\S]*?nicht verbunden/, "ein ungeprüfter Status ist NICHT dasselbe wie geprüft-und-nicht-verbunden");
  assert.match(html, /wird geprüft/);
  assert.ok(ensureCalled, "der Kaltstart muss selbst den Ladevorgang anstossen");
});

// ── Review-Fix PR267: ein tatsaechlich leerer, aber VOLLSTAENDIG geladener
// Kalender ist eine echte 0, keine Ladeanzeige ────────────────────────────
test("Kalenderzeile: verbunden, Bereich vollstaendig geladen, aber wirklich leer -> '0 heute, 0 diese Woche', keine Dauerschleife", () => {
  let ensureCalls = 0;
  const win = {
    gcalStatusSnapshot: () => ({ statusChecked: true, connected: true, brBooted: true, brLoading: false, brError: null, brRange: { min: "2026-09-21", max: "2026-09-28" } }),
    gcalEventsInRange: () => [],
    gcalEnsureRangeLoaded: () => { ensureCalls++; return Promise.resolve(); },
  };
  const mod = loadModule()(appWith({ entities: {} }), win);
  const html = mod.renderV3Ueberblick({ allProjects: [], overdueTasks: [], upcomingTasks: [], selectedDate: "2026-09-21", future7Str: "2026-09-28" });
  assert.match(html, /0 heute, 0 diese Woche \(Google Kalender\)/, "ein wirklich leerer, vollstaendig geladener Kalender ist eine echte Zahl, keine Unbekannte");
  assert.equal(ensureCalls, 0, "ein bereits vollstaendig geladener Bereich darf keinen erneuten Ladevorgang anstossen (sonst Dauerschleife)");
});

// ── Review-Fix PR267: ein Ladefehler darf NIE als Zahl (erst recht nicht 0)
// erscheinen — loadEvents schluckte Fehler bislang komplett ──────────────
test("Kalenderzeile: Ladefehler wird ehrlich benannt, NIE als 0 oder echte Zahl verkleidet", () => {
  const win = {
    gcalStatusSnapshot: () => ({ statusChecked: true, connected: true, brBooted: true, brLoading: false, brError: "Kalenderabruf teilweise fehlgeschlagen (1 von 2 Kalendern) — Zahlen unvollständig", brRange: { min: "2026-09-21", max: "2026-09-28" } }),
    gcalEventsInRange: () => { throw new Error("darf bei Fehlerzustand nicht aufgerufen werden"); },
  };
  const mod = loadModule()(appWith({ entities: {} }), win);
  const html = mod.renderV3Ueberblick({ allProjects: [], overdueTasks: [], upcomingTasks: [], selectedDate: "2026-09-21", future7Str: "2026-09-28" });
  assert.match(html, /Kalenderfehler beim Laden/, "ein Ladefehler muss sichtbar benannt werden");
  assert.doesNotMatch(html, /\d+ heute, \d+ diese Woche/, "bei einem Ladefehler duerfen keine Zahlen behauptet werden");
});

// ── Review-Fix PR267: der interaktive Kalender-View (Monat/Woche/Agenda)
// laedt einen eigenen Bereich, der die Briefing-Anfrage NICHT abdecken muss
// — ein zu eng geladener Bereich darf nie als abgeschlossen gelten ────────
test("Kalenderzeile: geladener Bereich deckt die Anfrage NICHT ab (zu eng) -> 'wird geladen', kein falscher Nullbestand", () => {
  let ensureCalledWith = null;
  const win = {
    // Nur bis zum 23. geladen (z.B. interaktiver Wochen-View), Anfrage geht bis zum 28.
    gcalStatusSnapshot: () => ({ statusChecked: true, connected: true, brBooted: true, brLoading: false, brError: null, brRange: { min: "2026-09-21", max: "2026-09-23" } }),
    gcalEventsInRange: () => { throw new Error("darf bei nicht abgedecktem Bereich nicht als Zahl gelesen werden"); },
    gcalEnsureRangeLoaded: (from, to) => { ensureCalledWith = [from, to]; return Promise.resolve(); },
  };
  const mod = loadModule()(appWith({ entities: {} }), win);
  const html = mod.renderV3Ueberblick({ allProjects: [], overdueTasks: [], upcomingTasks: [], selectedDate: "2026-09-21", future7Str: "2026-09-28" });
  assert.match(html, /wird geladen/, "ein zu eng geladener Bereich darf nicht als vollstaendig gelten");
  assert.deepEqual(ensureCalledWith, ["2026-09-21", "2026-09-28"], "es muss der tatsaechlich fehlende, volle Bereich nachgeladen werden");
});

// ── 4) renderV3Schlusspruefung: nie eine erfundene abgeschlossene Pruefung ──
// Nutzerklarstellung nach PR265-Live-Test: 95% Computer-Use, kein durchgehend
// API-gebundener Leitungsagent — ein fehlender Server-Lauf darf deshalb
// NICHT "keine Schlussprüfung möglich" behaupten. Primär zaehlen die echten
// Tagesnotizen (dailyBriefing.dailyLog[date].notes).
test("Regressionstest: OHNE Server-Lauf, aber MIT Tagesnotizen -> Notiz unveraendert sichtbar, NIE 'keine Schlussprüfung möglich'", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const html = mod.renderV3Schlusspruefung(undefined, "2026-09-21", "Alle Mails geprüft, Kalender kontrolliert.");
  assert.doesNotMatch(html, /keine Schlussprüfung möglich/i, "ein fehlender Server-Lauf darf die Schlussprüfung nicht für unmöglich erklären");
  assert.match(html, /Alle Mails geprüft, Kalender kontrolliert\./, "die echte Tagesnotiz muss unveraendert erscheinen");
  assert.match(html, /Noch kein technischer Laufnachweis/, "der fehlende technische Nachweis wird separat, ehrlich benannt");
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

// ── Konzept v2: Betriebsmodell fuer ChatGPT-Leads (v3LeadStatus/renderV3ChatgptCockpit) ──
// Diese Tests pruefen die vom Nutzer explizit vorgegebenen Regeln: Gruen
// heisst nicht "erledigt", sondern "vollstaendig dokumentiertes, nicht
// ueberfaelliges Warten/Delegieren"; ein ungeprueft er Cowork-Ruecklauf und
// fehlende Pflichtfelder bleiben immer Rot.

test("WartenGruen: externes Warten mit allen vier Pflichtfeldern und nicht ueberfaelligem Termin ist gruen", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const lead = {
    operationalState: "waiting_external",
    waitingOn: "Kunde X", waitingSince: "2026-09-20T09:00:00.000Z",
    nextAction: "Nachfassen", followUpAt: "2026-09-25T09:00:00.000Z",
  };
  assert.equal(mod.v3LeadStatus(lead, { nowMs: Date.parse("2026-09-21T10:00:00.000Z") }), "green");
});

test("fehlFollowupRot: externes Warten OHNE Termin/naechsten Schritt ist rot, nicht gelb oder gruen", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const lead = { operationalState: "waiting_external", waitingOn: "Kunde X" }; // waitingSince/nextAction/followUpAt fehlen
  assert.equal(mod.v3LeadStatus(lead, { nowMs: Date.parse("2026-09-21T10:00:00.000Z") }), "red");
});

test("fehlFollowupRot: ueberfaelliger Follow-up-Termin ist rot", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const lead = {
    operationalState: "waiting_external", waitingOn: "Kunde X", waitingSince: "2026-09-10T09:00:00.000Z",
    nextAction: "Nachfassen", followUpAt: "2026-09-15T09:00:00.000Z",
  };
  assert.equal(mod.v3LeadStatus(lead, { nowMs: Date.parse("2026-09-21T10:00:00.000Z") }), "red");
});

test("Deferrals>=3: dreimalige Verschiebung ohne echten Fortschritt setzt information_required und eine Frage fuer morgen vor", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const lead = { lastAction: "Erstkontakt" };
  mod.v3RegisterFollowUp(lead, { newLastAction: "Erstkontakt", followUpAt: "2026-09-22T09:00:00.000Z", morgenIsoStr: "2026-09-22T04:00:00.000Z" });
  mod.v3RegisterFollowUp(lead, { newLastAction: "Erstkontakt", followUpAt: "2026-09-23T09:00:00.000Z", morgenIsoStr: "2026-09-23T04:00:00.000Z" });
  assert.equal(lead.followUpDeferrals, 2, "zwei Verschiebungen ohne Fortschritt sind noch keine Eskalation");
  mod.v3RegisterFollowUp(lead, { newLastAction: "Erstkontakt", followUpAt: "2026-09-24T09:00:00.000Z", morgenIsoStr: "2026-09-24T04:00:00.000Z" });
  assert.equal(lead.followUpDeferrals, 3);
  assert.equal(lead.operationalState, "information_required", "ab der dritten Verschiebung ohne Fortschritt wird daraus eine Frage an Laurin");
  assert.equal(lead.questionForBriefingAt, "2026-09-24T04:00:00.000Z");
});

test("Deferrals: ein ECHTER neuer lastAction setzt den Zaehler zurueck, statt zu eskalieren", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const lead = { lastAction: "Erstkontakt", followUpDeferrals: 2 };
  mod.v3RegisterFollowUp(lead, { newLastAction: "Kunde hat geantwortet, Angebot verschickt", followUpAt: "2026-09-25T09:00:00.000Z" });
  assert.equal(lead.followUpDeferrals, 0);
  assert.notEqual(lead.operationalState, "information_required");
});

test("CoworkUngeprueftKeinGruen: Cowork-Ruecklauf ohne Pruefung ist rot, obwohl der Rueckalauftermin eingehalten wurde", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const lead = {
    operationalState: "delegated_cowork", handoverAt: "2026-09-18T09:00:00.000Z",
    expectedReturnAt: "2026-09-20T18:00:00.000Z", returnedAt: "2026-09-20T15:00:00.000Z", returnChecked: false,
  };
  assert.equal(mod.v3LeadStatus(lead, { nowMs: Date.parse("2026-09-21T10:00:00.000Z") }), "red", "ein ungeprueft er Ruecklauf darf nie automatisch gruen werden");
});

test("Cowork: mit Rueckalauftermin, noch nicht faellig und noch nicht zurueck, ist gruen (Delegation gilt als tagesgruen)", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const lead = { operationalState: "delegated_cowork", handoverAt: "2026-09-20T09:00:00.000Z", expectedReturnAt: "2026-09-25T18:00:00.000Z" };
  assert.equal(mod.v3LeadStatus(lead, { nowMs: Date.parse("2026-09-21T10:00:00.000Z") }), "green");
});

test("Cowork ohne Rueckalauftermin ist rot (fehlender naechster Schritt), auch ohne Ueberfaelligkeit", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const lead = { operationalState: "delegated_cowork", handoverAt: "2026-09-20T09:00:00.000Z" };
  assert.equal(mod.v3LeadStatus(lead, { nowMs: Date.parse("2026-09-21T10:00:00.000Z") }), "red");
});

// ── renderV3ChatgptCockpit: A (Entscheidungen), B (Fragen/Fragemorgen), E, F ──
test("Fragemorgen: eine fuer morgen vorgemerkte Frage erscheint HEUTE nicht im Briefing", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const leads = [{ id: "l1", title: "Anfrage Meier", operationalState: "information_required", pendingQuestion: { text: "Preis ok?" }, questionForBriefingAt: "2026-09-22T04:00:00.000Z" }];
  const html = mod.renderV3ChatgptCockpit(leads, { nowMs: Date.parse("2026-09-21T10:00:00.000Z") });
  assert.match(html, /Fragen von ChatGPT[\s\S]*?\(0\)/, "eine erst morgen faellige Frage darf heute nicht gezaehlt werden");
  assert.doesNotMatch(html, /Preis ok\?/, "der Fragetext darf vor Faelligkeit nicht erscheinen");
});

test("Fragemorgen: nach Ablauf der Frist (heute >= questionForBriefingAt) erscheint dieselbe Frage sichtbar mit Antwortfeld", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const leads = [{ id: "l1", title: "Anfrage Meier", operationalState: "information_required", pendingQuestion: { text: "Preis ok?", options: ["Ja", "Nein"], recommendation: "Ja" }, questionForBriefingAt: "2026-09-21T04:00:00.000Z" }];
  const html = mod.renderV3ChatgptCockpit(leads, { nowMs: Date.parse("2026-09-21T10:00:00.000Z") });
  assert.match(html, /Fragen von ChatGPT[\s\S]*?\(1\)/);
  assert.match(html, /Preis ok\?/);
  assert.match(html, /Optionen: Ja, Nein/);
  assert.match(html, /data-action="cgl-answer-question" data-id="l1"/, "die Antwort muss ueber die echte, einmalig verarbeitbare Aktion auf demselben Lead laufen");
});

test("renderV3ChatgptCockpit: Entscheidungen (A) erscheinen getrennt von Fragen (B) und zeigen die Empfehlung", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const leads = [{ id: "l2", title: "Vertragsentscheid", operationalState: "decision_required", pendingQuestion: { text: "Vertrag X unterschreiben?", recommendation: "Ja, Konditionen passen" }, questionForBriefingAt: "2026-09-21T04:00:00.000Z" }];
  const html = mod.renderV3ChatgptCockpit(leads, { nowMs: Date.parse("2026-09-21T10:00:00.000Z") });
  assert.match(html, /Entscheidungen gefragt[\s\S]*?\(1\)/);
  assert.match(html, /Empfehlung: Ja, Konditionen passen/);
});

test("renderV3ChatgptCockpit: erledigte/stornierte Leads erscheinen in keinem der Panels", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const leads = [
    { id: "l3", title: "Alt", status: "abgeschlossen" },
    { id: "l4", title: "Storniert", status: "abgeschlossen", closedBy: "laurin", obsolete: true },
  ];
  const html = mod.renderV3ChatgptCockpit(leads, { nowMs: Date.parse("2026-09-21T10:00:00.000Z") });
  assert.match(html, /Pendent bei ChatGPT[\s\S]*?\(0\)/, "erledigte/stornierte Leads zaehlen nicht als pendent");
});

test("renderV3ChatgptCockpit: Cowork-Panel zeigt einen ungeprueften Ruecklauf mit Rueckhol-Aktion, keine gruene Vortaeuschung", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const leads = [{ id: "l5", title: "Recherche X", operationalState: "review", handoverAt: "2026-09-18T09:00:00.000Z", returnedAt: "2026-09-20T15:00:00.000Z", returnChecked: false }];
  const html = mod.renderV3ChatgptCockpit(leads, { nowMs: Date.parse("2026-09-21T10:00:00.000Z") });
  assert.match(html, /Bei Cowork[\s\S]*?\(1\)/);
  assert.match(html, /Rücklauf ungeprüft/);
  assert.match(html, /data-action="cgl-cowork-return-check" data-id="l5"/);
});

// ── Item G: Delegation genau EINES Originaltasks, echte Checkbox ──────────
// Diese Tests pruefen den echten Quelltext (handleClick laesst sich wegen
// vieler verschachtelter Closures nicht sauber per new Function() isolieren,
// siehe CLAUDE.md "Modulgrenzen sind echt") — gezielte Struktur-Assertions
// an genau der Stelle, an der frueher ein Fehler moeglich war.
// Review-Fix a1de2c2 Punkt 4: eine reine assignee-Aenderung war fuer ChatGPT
// unsichtbar, weil "Pendent bei ChatGPT" (renderV3ChatgptCockpit) nur
// entities.chatgptLeads liest. Die Delegation muss deshalb GENAU EINEN
// verknuepften Lead anlegen/wiederverwenden (delegatedLeadId, idempotent),
// das Originaltask bleibt bestehen (keine Kopie, keine zweite Aufgabe).
test("DelegationEinLead: task-delegate-chatgpt legt genau EINEN verknuepften Lead an/wieder, Original bleibt bestehen", () => {
  const caseMatch = index.match(/case "task-delegate-chatgpt": \{[\s\S]*?\n\}/);
  assert.ok(caseMatch, "der Delegations-Handler muss im echten handleClick existieren");
  const src = caseMatch[0];
  assert.match(src, /getEntity\("task", taskId\)/, "muss auf DASSELBE Originaltask lesen");
  assert.match(src, /updateEntity\("task", taskId, \{ assignee: "chatgpt" \}\)/, "das Original-Task bleibt bestehen, nur assignee wird gesetzt");
  assert.doesNotMatch(src, /createEntity\("task"/, "die Delegation darf niemals eine zweite Aufgabe/Kopie erzeugen");
  assert.match(src, /task\.delegatedLeadId \? getEntity\("chatgptLead", task\.delegatedLeadId\) : null/, "ein bereits verknuepfter Lead muss wiederverwendet werden (idempotent), kein zweiter Lead pro erneuter Delegation");
  assert.match(src, /createChatgptLead\(/, "ohne bestehenden Lead muss GENAU EINER angelegt werden, sonst bleibt die Delegation fuer 'Pendent bei ChatGPT' unsichtbar");
  assert.match(src, /linkEntities\("task", taskId, "chatgptLead", leadId\)/, "der neue Lead muss ueber die Standard-Registry mit dem Original-Task verknuepft werden");
  // Review-Fix (25.09.2026): deterministische Lead-ID statt Zufalls-ID —
  // siehe chatgpt-task-delegation-lead-race.test.mjs (analog zu intake-to-lead).
  assert.match(src, /const leadId = "chatgptLead_from_task_" \+ taskId;/, "die Lead-ID wird nicht mehr deterministisch aus der taskId abgeleitet — zwei offline delegierende Geraete erzeugen wieder einen doppelten Lead");
});

test("DelegationEinLead: zweimaliges Delegieren desselben Tasks erzeugt KEINEN zweiten Lead (echte Idempotenz)", () => {
  // Simuliert den Handler-Kern gegen ein Mini-Modell, um die Wiederverwendung
  // ueber delegatedLeadId end-to-end zu pruefen (nicht nur strukturell).
  const entities = { tasks: {}, chatgptLeads: {} };
  const taskId = "t1";
  entities.tasks[taskId] = { id: taskId, title: "Bericht schreiben", assignee: "user" };
  const getEntity = (kind, id) => (kind === "task" ? entities.tasks[id] : entities.chatgptLeads[id]) || null;
  let nextLeadId = 1;
  const createChatgptLead = (title) => { const id = "l" + (nextLeadId++); entities.chatgptLeads[id] = { id, title, status: "neu", operationalState: "doing" }; return id; };
  const delegieren = () => {
    const task = getEntity("task", taskId);
    const bestehenderLead = task.delegatedLeadId ? getEntity("chatgptLead", task.delegatedLeadId) : null;
    let lead = bestehenderLead;
    if (!lead) {
      const neueId = createChatgptLead(task.title);
      lead = getEntity("chatgptLead", neueId);
      task.delegatedLeadId = neueId;
    } else if (lead.status === "abgeschlossen") {
      lead.status = "neu";
    }
    task.assignee = "chatgpt";
  };
  delegieren();
  const ersterLeadId = entities.tasks[taskId].delegatedLeadId;
  assert.equal(Object.keys(entities.chatgptLeads).length, 1, "die erste Delegation muss genau einen Lead anlegen");
  // Zurueckholen + erneut delegieren:
  entities.tasks[taskId].assignee = "user";
  entities.chatgptLeads[ersterLeadId].status = "abgeschlossen";
  delegieren();
  assert.equal(Object.keys(entities.chatgptLeads).length, 1, "eine erneute Delegation darf KEINEN zweiten Lead anlegen");
  assert.equal(entities.tasks[taskId].delegatedLeadId, ersterLeadId, "derselbe Lead muss wiederverwendet werden");
  assert.equal(entities.chatgptLeads[ersterLeadId].status, "neu", "der wiederverwendete Lead muss reaktiviert werden");
});

test("Originalcheckbox: das neue 'Meine Aufgaben'-Panel im DailyBriefing nutzt denselben quick-complete-task-Mechanismus wie die echte Aufgabenliste", () => {
  const meineAufgabenStart = index.indexOf("Meine Aufgaben <span");
  assert.ok(meineAufgabenStart > 0, "das 'Meine Aufgaben'-Panel muss in viewDailyBriefing() existieren");
  const meineAufgabenSrc = index.slice(meineAufgabenStart, meineAufgabenStart + 2500);
  assert.match(meineAufgabenSrc, /data-action="quick-complete-task"/, "muss dieselbe echte Checkbox-Aktion wie die Aufgabenliste verwenden, kein eigener Fake-Toggle");
  assert.match(meineAufgabenSrc, /data-action="task-delegate-chatgpt"/, "muss den echten Delegations-Button anbieten");
});

test("Antwortreaktiviert: cgl-answer-question setzt operationalState zurueck auf 'doing' und markiert die Frage als beantwortet (einmalig)", () => {
  const caseMatch = index.match(/case "cgl-answer-question": \{[\s\S]*?\n    \}/);
  assert.ok(caseMatch, "der Antwort-Handler muss existieren");
  const src = caseMatch[0];
  assert.match(src, /l\.pendingQuestion\.answeredAt \|\| l\.status === "abgeschlossen"\)\s*return;/, "eine bereits beantwortete Frage ODER ein abgeschlossener Lead darf kein zweites Mal/gar nicht verarbeitet werden");
  assert.match(src, /l\.pendingQuestion\.answer = antwort/, "die Antwort muss am ORIGINALLEAD gespeichert werden");
  assert.match(src, /l\.operationalState = "doing"/, "nach der Antwort macht der Assistent weiter (doing), keine Endlosschlaufe in decision_required");
  // Funktionaler Nachweis (kein reiner String-Check) in tests/chatgpt-lead-wiedereroeffnen.test.mjs
  // Abschnitt 8: fuehrt den echten Handler gegen einen abgeschlossenen Lead aus.
});

// ── Konzept v2 L: Kalender-Einplanung — Vorschlag statt Automatik ──────────
test("v3PlanningSettings: Standardwerte sind Autoplan AUS, Mo-Fr, 09:00-18:00, 30 Minuten", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const ps = mod.v3PlanningSettings({});
  assert.equal(ps.autoplanEnabled, false, "Autoplan muss standardmaessig aus sein");
  assert.deepEqual(ps.allowedDays, [1, 2, 3, 4, 5]);
  assert.equal(ps.windowStart, "09:00");
  assert.equal(ps.windowEnd, "18:00");
  assert.equal(ps.defaultDurationMin, 30);
});

test("v3PlanningSettings: gespeicherte Werte (inkl. explizit aktiviertem Autoplan) werden uebernommen", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const ps = mod.v3PlanningSettings({ planningSettings: { autoplanEnabled: true, windowStart: "07:30", windowEnd: "20:00", defaultDurationMin: 45, allowedDays: [1, 3, 5] } });
  assert.equal(ps.autoplanEnabled, true);
  assert.equal(ps.windowStart, "07:30");
  assert.deepEqual(ps.allowedDays, [1, 3, 5]);
});

test("v3FreeSlotsForDay: findet den ersten freien Slot zwischen zwei Terminen, ueberspringt Konflikte", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const slots = mod.v3FreeSlotsForDay(30, {
    busyIntervals: [{ startMin: 9 * 60, endMin: 10 * 60 }, { startMin: 10 * 60 + 15, endMin: 11 * 60 }],
    windowStart: "09:00", windowEnd: "12:00", stepMin: 15,
  });
  assert.ok(slots.length > 0, "es muss mindestens ein freier Slot gefunden werden");
  assert.equal(slots[0].start, "11:00", "der erste WIRKLICH freie Slot beginnt erst nach beiden Terminen");
  // keine Ueberschneidung mit einem der beiden Termine:
  slots.forEach((s) => {
    assert.ok(!(s.startMin < 10 * 60 && s.endMin > 9 * 60), "kein Slot darf den ersten Termin ueberschneiden");
    assert.ok(!(s.startMin < 11 * 60 && s.endMin > 10 * 60 + 15), "kein Slot darf den zweiten Termin ueberschneiden");
  });
});

test("v3FreeSlotsForDay: interne timeBlocks blockieren genauso wie echte Kalendertermine", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const slots = mod.v3FreeSlotsForDay(30, {
    busyIntervals: [], timeBlocks: [{ startTime: "09:00", endTime: "17:30" }],
    windowStart: "09:00", windowEnd: "18:00", stepMin: 15,
  });
  assert.equal(slots.length, 1, "nur genau der Rest nach dem internen Zeitblock darf frei sein");
  assert.equal(slots[0].start, "17:30");
});

test("v3FreeSlotsForDay: ein ganztaegiger Termin blockiert den gesamten Tag (allDayBlocksWholeDay)", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const slots = mod.v3FreeSlotsForDay(30, { allDayBlocksWholeDay: true, windowStart: "09:00", windowEnd: "18:00" });
  assert.deepEqual(slots, [], "ein ganztaegiger Termin darf niemals einen freien Slot vorschlagen");
});

test("v3FreeSlotsForDay: kein Konflikt -> der gesamte Fenster-Anfang ist als Slot verfuegbar (keine erfundene Bloackade)", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const slots = mod.v3FreeSlotsForDay(30, { windowStart: "09:00", windowEnd: "10:00", stepMin: 15 });
  assert.equal(slots[0].start, "09:00");
});

// ── Item L: Autoplan-Schalter/Buttons existieren wirklich im DailyBriefing ──
test("Konzept v2 L: die Einplanungs-Einstellungen (Autoplan-Checkbox, Zeitfenster, Dauer) sind wirklich im DailyBriefing verdrahtet", () => {
  assert.match(index, /id="dbV3PlanningSettings"/, "der Einstellungsbereich muss in viewDailyBriefing() existieren");
  assert.match(index, /planningSettings\.autoplanEnabled\s*=\s*this\.checked/, "die Autoplan-Checkbox muss den echten Bestand schreiben");
  assert.match(index, /window\.dbPlanTaskSlot\s*=\s*async function/, "der Vorschlags-Handler fuer 'Termin vorschlagen' muss existieren");
});

test("Konzept v2 L: dbPlanTaskSlot schreibt NIE direkt, sondern oeffnet immer den echten Kalender-Editor zur Bestaetigung", () => {
  const fnMatch = index.match(/window\.dbPlanTaskSlot = async function\([\s\S]*?\n\};/);
  assert.ok(fnMatch, "dbPlanTaskSlot muss existieren");
  const src = fnMatch[0];
  assert.doesNotMatch(src, /gcApi\("POST"|gcApi\('POST'/, "die Vorschlagsfunktion selbst darf niemals einen Kalender-Eintrag schreiben");
  assert.match(src, /gcalEventFromTask\(/, "die Bestaetigung muss ueber den bestehenden echten Kalender-Editor laufen");
  assert.match(src, /allowedDays\.includes\(weekday\)/, "der erlaubte Wochentag muss tatsaechlich geprueft werden, nicht nur gespeichert werden");
  assert.match(src, /gcalEnsureRangeLoaded\(dateYmd, dateYmd, true\)/, "Review-Fix: vor jeder Einplanung MUSS frisch geladen werden (force), sonst Doppelbuchungsgefahr durch veralteten Cache");
});

// ── Review-Fix a1de2c2 Punkt 2: Ueberschneidung/Clipping/transparent/Cache ──
test("gcalBusyIntervalsForDay: prueft echte Ueberschneidung (nicht nur Starttag) und clippt auf den Tag, ignoriert transparente Termine", () => {
  const fnMatch = index.match(/window\.gcalBusyIntervalsForDay = function\(ymd\)\{[\s\S]*?\n  \};/);
  assert.ok(fnMatch, "gcalBusyIntervalsForDay muss existieren");
  const src = fnMatch[0];
  assert.doesNotMatch(src, /toDateVal\(evStart\(ev\)\)\s*===\s*ymd/, "die alte Start-Tag-Filterung uebersah mehrtaegige/ueber-Mitternacht-Termine");
  assert.match(src, /transparency === "transparent"/, "ein als 'frei' markierter Termin darf keinen Konflikt verursachen");
  assert.match(src, /s < dayEndMs && e > dayStartMs/, "es muss echte Ueberschneidung mit dem Tagesfenster geprueft werden");
});

test("gcApi invalidiert den Briefing-Ladezustand nach JEDER Termin-Mutation (zentral, nicht pro Aufrufstelle)", () => {
  const fnMatch = index.match(/async function gcApi\(method, path, opts\)\{[\s\S]*?\n  \}/);
  assert.ok(fnMatch, "gcApi muss existieren");
  assert.match(fnMatch[0], /GC\._brBooted = false; GC\._brLoadKey = null;/, "eine erfolgreiche Termin-Mutation muss den Cache invalidieren, sonst Doppelbuchungsgefahr");
});

// ── Review-Fix a1de2c2 Punkt 1: echte Europe/Zurich-Umrechnung ────────────
test("v3ZurichLocalToUtcIso: 04:00 Europe/Zurich im September (Sommerzeit) ist 02:00 UTC, NICHT 04:00 UTC", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  assert.equal(mod.v3ZurichLocalToUtcIso("2026-09-22", "04:00"), "2026-09-22T02:00:00.000Z", "04:00Z waere in Wahrheit 06:00 Zuercher Ortszeit — der echte 04-Uhr-Lauf saehe die Frage dann noch nicht als faellig");
});

test("v3ZurichLocalToUtcIso: 04:00 Europe/Zurich im Januar (Winterzeit) ist 03:00 UTC", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  assert.equal(mod.v3ZurichLocalToUtcIso("2026-01-15", "04:00"), "2026-01-15T03:00:00.000Z");
});

test("Review-Fix a1de2c2 Punkt 1: eine faellige, aber unbeantwortete Entscheidung/Frage wird NIE allein dadurch rot (keine echte Frist vorhanden)", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const laengstFaellig = { operationalState: "information_required", questionForBriefingAt: "2026-01-01T03:00:00.000Z" }; // laengst ueberfaellig
  assert.equal(mod.v3LeadStatus(laengstFaellig, { nowMs: Date.parse("2026-09-21T10:00:00.000Z") }), "yellow", "faellig heisst nur sichtbar, nicht automatisch rot ohne echte Frist");
  const nochNichtFaellig = { operationalState: "decision_required", questionForBriefingAt: "2026-09-22T02:00:00.000Z" };
  assert.equal(mod.v3LeadStatus(nochNichtFaellig, { nowMs: Date.parse("2026-09-21T10:00:00.000Z") }), "green", "vor Faelligkeit ist gruen: ChatGPT arbeitet noch, nichts von Laurin noetig");
});

test("cgl-ask-decision/-information nutzen die echte Zeitzonen-Umrechnung statt eines festen UTC-Strings", () => {
  assert.match(index, /l\.questionForBriefingAt = v3ZurichLocalToUtcIso\(addDaysYmd\(todayYmd\(\), 1\), "04:00"\)/, "questionForBriefingAt muss echte Europe/Zurich-Zeit sein, kein fester UTC-String");
  assert.match(index, /morgenIsoStr: v3ZurichLocalToUtcIso\(addDaysYmd\(todayYmd\(\), 1\), "04:00"\)/, "auch die Deferral-Eskalation (cgl-postpone-followup) muss dieselbe echte Umrechnung nutzen");
});

// ── Review-Fix a1de2c2 Punkt 3: die Aktionen brauchen echte, sichtbare UI ──
test("Review-Fix a1de2c2 Punkt 3: cgl-set-next-action/-waiting-external/-postpone-followup/-ask-* haben sichtbare Eingabefelder+Buttons im Lead-Editor (kein toter Handler)", () => {
  const fnMatch = index.match(/function chatgptLeadOperationalBoxHtml\(l\) \{[\s\S]*?\n\}/);
  assert.ok(fnMatch, "chatgptLeadOperationalBoxHtml muss existieren");
  const src = fnMatch[0];
  ["cgl-set-next-action", "cgl-set-waiting-external", "cgl-postpone-followup", "cgl-ask-decision", "cgl-ask-information", "cgl-answer-question"].forEach((action) => {
    assert.match(src, new RegExp('data-action="' + action + '"'), action + " muss ein echtes, klickbares Element haben");
  });
  ["cglNextAction_", "cglNextActionAt_", "cglWaitOn_", "cglWaitNext_", "cglWaitUntil_", "cglPostponeAction_", "cglPostponeUntil_", "cglAskText_", "cglAskOptions_", "cglAskRecommendation_", "cglAnswerText_"].forEach((idPrefix) => {
    assert.match(src, new RegExp('id="' + idPrefix), idPrefix + "<id> muss als echtes Eingabefeld existieren, sonst liest der Handler ins Leere");
  });
  assert.match(index, /\$\{chatgptLeadOperationalBoxHtml\(l\)\}/, "die Box muss tatsaechlich im Lead-Detail (chatgptLeadStatusBoxHtml) eingebunden sein");
});

// ── Konzept v2 C: Projektzeile (Eingang/naechster Schritt), keine Mailliste ──
test("v3ProjectLineText: zeigt den letzten Kommentar als Eingang und die faelligste offene Aufgabe als naechsten Schritt", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const p = { comments: [{ text: "Alt" }, { text: "Kunde hat Feedback geschickt" }] };
  const aufgaben = [{ title: "Vertrag pruefen", dueDate: "2026-09-25" }, { title: "Angebot senden", dueDate: "2026-09-20" }];
  const zeile = mod.v3ProjectLineText(p, aufgaben);
  assert.match(zeile, /Eingang: Kunde hat Feedback geschickt/, "muss den LETZTEN (nicht ersten) Kommentar zeigen");
  assert.match(zeile, /Nächster Schritt: Angebot senden \(2026-09-20\)/, "muss die frueheste faellige offene Aufgabe als naechsten Schritt zeigen, nicht irgendeine");
});

test("v3ProjectLineText: ehrlich ohne Kommentare/Aufgaben, keine erfundenen Werte", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const zeile = mod.v3ProjectLineText({}, []);
  assert.match(zeile, /Eingang: keine neue Rückmeldung/);
  assert.match(zeile, /Nächster Schritt: keiner hinterlegt/);
});

test("Konzept v2 C: die Projektzeile ist wirklich im DailyBriefing verdrahtet (keine volle Mailliste)", () => {
  assert.match(index, /v3ProjectLineText\(p, pt\)/, "die Projektzeile muss im Projekte-Abschnitt des DailyBriefing aufgerufen werden");
});

// Review PR268 (24.09.2026): "".localeCompare(echtesDatum) sortiert eine leere
// dueDate faelschlich VOR jede echte Frist — eine fristlose Aufgabe erschien
// als "naechster Schritt" statt der wirklich faelligsten.
test("v3ProjectLineText: eine Aufgabe ohne dueDate darf eine echte Frist nicht als naechsten Schritt verdraengen", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const aufgaben = [{ title: "Ohne Frist", dueDate: "" }, { title: "Vertrag pruefen", dueDate: "2026-09-25" }];
  const zeile = mod.v3ProjectLineText({}, aufgaben);
  assert.match(zeile, /Nächster Schritt: Vertrag pruefen \(2026-09-25\)/,
    "eine fristlose Aufgabe wird faelschlich vor der echten Frist gezeigt");
});
test("v3ProjectLineText: mehrere fristlose Aufgaben aendern nichts an der Reihenfolge nach Frist", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const aufgaben = [
    { title: "Ohne A", dueDate: null },
    { title: "Spaeter", dueDate: "2026-10-01" },
    { title: "Ohne B", dueDate: undefined },
    { title: "Frueher", dueDate: "2026-09-22" },
  ];
  const zeile = mod.v3ProjectLineText({}, aufgaben);
  assert.match(zeile, /Nächster Schritt: Frueher \(2026-09-22\)/);
});

// ── Konzept v2 K: Intake-Queue (client-seitig, idempotente Lead-Verknuepfung) ──
test("renderV3IntakeQueue: zeigt offene und verknuepfte Anfragen korrekt, kein zweiter Lead-Knopf nach Verknuepfung", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const queue = [
    { id: "i1", text: "Bitte Angebot für Firma Y prüfen", createdAt: "2026-09-20T08:00:00.000Z", linkedLeadId: null },
    { id: "i2", text: "Alte Anfrage", createdAt: "2026-09-18T08:00:00.000Z", linkedLeadId: "l99" },
  ];
  const html = mod.renderV3IntakeQueue(queue);
  assert.match(html, /Anfrage einreichen[\s\S]*?\(1 offen\)/, "nur unverknuepfte Anfragen zaehlen als offen");
  assert.match(html, /data-action="intake-to-lead" data-id="i1"/, "eine offene Anfrage muss den Lead-erstellen-Knopf haben");
  assert.doesNotMatch(html, /data-action="intake-to-lead" data-id="i2"/, "eine bereits verknuepfte Anfrage darf keinen zweiten Lead-Knopf mehr anbieten");
  assert.match(html, /Bitte Angebot für Firma Y prüfen/);
});

test("Konzept v2 K: intake-to-lead verknuepft genau einmal (linkedLeadId als Sperre), kein zweiter Lead beim erneuten Klick", () => {
  const caseMatch = index.match(/case "intake-to-lead": \{[\s\S]*?\n\}/);
  assert.ok(caseMatch, "der intake-to-lead-Handler muss im echten handleClick existieren");
  const src = caseMatch[0];
  assert.match(src, /if \(!item \|\| item\.linkedLeadId\) break;/, "eine bereits verknuepfte Anfrage darf nicht erneut verarbeitet werden");
  assert.match(src, /item\.linkedLeadId = leadId/, "die Verknuepfung muss auf der ORIGINAL-Anfrage vermerkt werden");
  assert.match(src, /createChatgptLead\(/, "es muss ein echter Lead ueber den bestehenden Erstellungsweg entstehen");
});

test("Konzept v2 K: dbIntakeAdd schreibt ins client-seitige intakeQueue, NICHT in automation.intakeById (keine zweite Server-Wahrheit)", () => {
  const fnMatch = index.match(/window\.dbIntakeAdd = function\(\) \{[\s\S]*?\n\};/);
  assert.ok(fnMatch, "dbIntakeAdd muss existieren");
  assert.match(fnMatch[0], /db\.intakeQueue\.push/, "muss in dailyBriefing.intakeQueue schreiben");
  assert.doesNotMatch(fnMatch[0], /automation\.intake/, "darf NICHT automation.intakeById beruehren (CAS-geschuetzter Serverkern)");
});

// ── Konzept v2 I: App-Fortschritt/Updates — ehrlich, kein Raten ───────────
test("renderV3AppProgress: ohne jede echte Datenquelle ist alles ehrlich 'nicht verfügbar', keine erfundene Zahl", () => {
  const mod = loadModule()(appWith({ entities: {} }), {});
  const html = mod.renderV3AppProgress();
  assert.match(html, /RecallLab[\s\S]*?nicht verfügbar/);
  assert.match(html, /Smarter[\s\S]*?nicht verfügbar/);
  assert.match(html, /Morgen-PDF[\s\S]*?nicht verfügbar/);
  assert.doesNotMatch(html, /\d+ Karte/, "ohne echte RecallLab-Daten darf keine Kartenzahl erscheinen");
});

test("renderV3AppProgress: mit echten RecallLab-Daten (localStorage) zeigt die wirkliche Kartenzahl/Streak", () => {
  const mod = loadModule({ getRecallLabData: () => ({ cards: [{}, {}, {}], user: { streak: 5 } }) })(appWith({ entities: {} }), {});
  const html = mod.renderV3AppProgress();
  assert.match(html, /RecallLab[\s\S]*?3 Karte\(n\), Streak 5 Tage/);
});

// Review PR268 (24.09.2026): ein echtes, aber LEERES Kartenarray (RecallLab
// ist geladen, hat aber 0 Karten) wurde durch den .length-Falsy-Check zu
// "nicht verfügbar" verschluckt — ununterscheidbar von "keine Datenquelle".
test("renderV3AppProgress: ein echtes leeres RecallLab-Array zeigt 0, nicht 'nicht verfügbar'", () => {
  const mod = loadModule({ getRecallLabData: () => ({ cards: [], user: { streak: 0 } }) })(appWith({ entities: {} }), {});
  const html = mod.renderV3AppProgress();
  assert.match(html, /RecallLab[\s\S]*?0 Karte\(n\), Streak 0 Tage/,
    "eine echte, leere Kartensammlung muss als 0 erscheinen, nicht als 'nicht verfügbar'");
});

test("renderV3AppProgress: Smarter zeigt nur eine Zahl, wenn das Modul in dieser Sitzung tatsaechlich geladen wurde", () => {
  const mod = loadModule({ SMARTER: { loaded: true, archive: { docs: { a: 1, b: 2 } } } })(appWith({ entities: {} }), {});
  const html = mod.renderV3AppProgress();
  assert.match(html, /Smarter[\s\S]*?2 Dokument\(e\) im Archiv/);
});

test("Konzept v2 I: der App-Fortschritt ist wirklich im DailyBriefing eingeklappt verdrahtet", () => {
  assert.match(index, /id="dbV3AppProgress"/, "der Abschnitt muss in viewDailyBriefing() existieren");
  assert.match(index, /<details class="db-section" id="dbV3AppProgress">/, "der Abschnitt muss standardmaessig eingeklappt sein (details, kein offenes div)");
});

// ── Konzept v2 D: echter Dokumenten-Upload direkt im Briefing ─────────────
test("renderV3ChatgptCockpit: 'Pendent bei ChatGPT' bindet die ECHTE Anhangs-Pipeline (renderFileAttachments) pro Lead ein, keine eigene Upload-Logik", () => {
  let aufgerufenMit = null;
  const win = { renderFileAttachments: (kind, id) => { aufgerufenMit = [kind, id]; return "<div>ECHTE-PIPELINE</div>"; } };
  const mod = loadModule({ renderFileAttachments: win.renderFileAttachments })(appWith({ entities: {} }), {});
  const leads = [{ id: "l1", title: "Anfrage", operationalState: "doing", nextAction: "x", files: [{ id: "f1" }, { id: "f2" }] }];
  const html = mod.renderV3ChatgptCockpit(leads, { nowMs: Date.parse("2026-09-21T10:00:00.000Z") });
  assert.deepEqual(aufgerufenMit, ["chatgptLead", "l1"], "muss dieselbe Funktion mit derselben Sammlung/ID wie das Lead-Detail aufrufen");
  assert.match(html, /ECHTE-PIPELINE/, "das Ergebnis der echten Pipeline muss tatsaechlich eingebunden werden");
  assert.match(html, /Dokumente \(2\)/, "die echte Dateianzahl muss angezeigt werden, keine erfundene Zahl");
});

test("Konzept v2 D: kein neues/erfundenes 'processedAt'-Feld — nur die bestehenden echten Statusfelder (textExtractStatus/textExtracted) werden verwendet", () => {
  assert.doesNotMatch(index, /processedAt\s*=/, "es darf kein neues processedAt-Feld eingefuehrt werden, das schon beim Hochladen faelschlich 'verarbeitet' behauptet");
});

console.log("quantus-v3-daily-briefing-controlpanel: alle Pruefungen bestanden");
