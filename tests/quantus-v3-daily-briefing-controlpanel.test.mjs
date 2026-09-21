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
}

// ── Extraktion der echten Hilfsfunktionen ──────────────────────────────────
const escSrc = index.slice(index.indexOf("\nfunction esc(s){"), index.indexOf("}\n", index.indexOf("\nfunction esc(s){")) + 1);
const todayStart = index.indexOf("const todayYmd = () => {");
const todaySrc = index.slice(todayStart, index.indexOf("};\n", todayStart) + 2);
const addDaysStart = index.indexOf("const addDaysYmd = (ymd, days) => {");
const addDaysSrc = index.slice(addDaysStart, index.indexOf("};\n", addDaysStart) + 2);

const blockStart = index.indexOf("const V3_AMPEL_LABEL = {");
assert.ok(blockStart > 0, "V3_AMPEL_LABEL wurde nicht gefunden");
const schluss = sliceFn("function renderV3Schlusspruefung(runV3, selectedDate, dayLogNotes) {", blockStart);
const blockSrc = index.slice(blockStart, schluss.end);

function loadModule(extraFns = {}) {
  const namen = Object.keys(extraFns);
  const fn = new Function("APP", "window", ...namen,
    escSrc + "\n" + todaySrc + "\n" + addDaysSrc + "\n" + blockSrc + "\n"
    + "return { renderV3ControlPanel, renderV3FaelligeAusnahmen, renderV3Freigaben, renderV3Schlusspruefung, renderV3Ueberblick, v3NextSlotInfo, v3AmpelText, v3AktuelleBewertung, v3SpeicherStatusText };"
  );
  return (app, win) => fn(app, win, ...namen.map((n) => extraFns[n]));
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
    meta: { updatedAt: "2026-09-21T08:00:00.000Z" },
  };
  const mod = loadModule()(appWith(data), {});
  const html = mod.renderV3Ueberblick({
    allProjects: [{ id: "p1" }, { id: "p2" }],
    overdueTasks: [{ id: "t1" }],
    upcomingTasks: [{ id: "t2" }, { id: "t3" }],
    calEvents: [{ id: "c1" }],
    allMeetings: [],
  });
  assert.match(html, /2 aktiv\/in Planung/, "Projektzahl muss aus den echten, bereits berechneten Bestaenden kommen");
  assert.match(html, /2 offen \(Leads 1, Aufgaben 1\)/, "nur der wirklich offene Lead/die wirklich offene Aufgabe zaehlen");
  assert.match(html, /1 überfällig, 2 anstehend/);
  assert.match(html, /1 heute, 0 diese Woche/, "mit meta.updatedAt (Bestand geladen) duerfen echte Kalenderzahlen erscheinen");
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
  const mod = loadModule()(appWith(data), {});
  const html = mod.renderV3Ueberblick({ allProjects: [], overdueTasks: [], upcomingTasks: [], calEvents: [], allMeetings: [] });
  assert.match(html, /5 offen \(Leads 5, Aufgaben 0\)/, "5 gelesene, aber offene Leads (inkl. 'wartet') duerfen nicht verschwiegen werden");
  assert.doesNotMatch(html, /KI-Pendente[\s\S]*?0 offen/, "die alte Unread-Logik (faelschlich 0) darf nicht wieder auftreten");
});

test("Befund 4: ohne echtes Kalender-Signal (kein meta.updatedAt) steht ehrlich 'nicht geprüft', keine erfundene Null", () => {
  const mod = loadModule()(appWith({ entities: {} }), {}); // kein meta.updatedAt
  const html = mod.renderV3Ueberblick({ allProjects: [], overdueTasks: [], upcomingTasks: [], calEvents: [], allMeetings: [] });
  assert.match(html, /Termine[\s\S]*?nicht geprüft/);
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

console.log("quantus-v3-daily-briefing-controlpanel: alle Pruefungen bestanden");
