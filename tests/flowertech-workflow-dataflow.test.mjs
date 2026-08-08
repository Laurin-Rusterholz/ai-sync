/*
 * FlowerTech: Aufgaben- und Workflow-Datenfluss.
 *
 * Der Kundenprozess erzeugt aus Kundeneingaben Projektfelder und Aufgaben. Die
 * entscheidende Zusage dabei: FlowerTech legt KEINE eigene Aufgabenart an. Was
 * entsteht, sind ganz normale Quantus-Aufgaben — deshalb tauchen sie ohne
 * Zutun in der zentralen Aufgaben-App auf. Genau das prueft dieser Test, indem
 * er die Funktionen des geteilten Kerns AUSFUEHRT und ihre Rueckgaben ansieht.
 *
 * Abgedeckt: Phasenfolge, Briefing -> Projektfelder, Briefing -> Aufgaben,
 * Aenderungswunsch -> Aufgabe, Statusfuehrung durch die Aufgabe,
 * Kostenuebersicht, Vertrag/AGB/Datenschutz als Entwurf mit Pruefhinweis,
 * Datensparsamkeit des Claude-Prompts, Mailzuordnung und Idempotenz.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const W = (await import(path.join(root, "public/flowertech-workflow-core.js"))).default;

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };

const NOW = "2026-08-06T10:00:00.000Z";

// de-CH setzt als Tausendertrenner je nach ICU-Version ' (U+0027) oder
// \u2019 (U+2019). Beides ist korrekt — Tests duerfen daran nicht haengen.
const normNum = (v) => String(v).replace(/[\u2018\u2019\u0027\u02BC\u00A0\u202F]/g, "'");
const containsNum = (haystack, needle) => normNum(haystack).includes(normNum(needle));


// ── 1. Der Kundenprozess laeuft vorwaerts und rueckwaerts ──────────────────
{
  eq(W.WORKFLOW_STAGES.map((s) => s.key),
    ["lead", "intake", "proposal", "build", "revision", "approval"],
    "die Phasenfolge des Kundenprozesses stimmt nicht");

  let stage = "lead";
  const walked = [stage];
  for (let i = 0; i < 5; i++) { stage = W.nextStage(stage); walked.push(stage); }
  eq(walked, ["lead", "intake", "proposal", "build", "revision", "approval"],
    "der Durchlauf durch den Prozess stimmt nicht");
  eq(W.nextStage("approval"), "approval", "die letzte Phase laeuft ueber");
  eq(W.previousStage("lead"), "lead", "die erste Phase laeuft unter");
  eq(W.previousStage("proposal"), "intake", "der Rueckweg stimmt nicht");

  // Altbestand bleibt lesbar — bestehende Projekte verlieren ihre Phase nicht.
  eq(W.stageLabel("discovery"), "Bestandesaufnahme", "die alte Phase discovery ist unlesbar geworden");
  eq(W.stageLabel("won"), "Gewonnen", "die alte Phase won ist unlesbar geworden");
  eq(W.stageLabel("lost"), "Verloren", "die alte Phase lost ist unlesbar geworden");
  eq(W.stageIndex("kaputt"), 0, "ein unbekannter Phasenschluessel fuehrt nicht auf Lead zurueck");
}

// ── 2. Bedarfsformular: Rohdaten werden sauber normalisiert ────────────────
const RAW = {
  contactName: "  Anna   Muster ",
  contactEmail: "  ANNA@Muster.CH ",
  contactPhone: "079 111 22 33",
  company: "Gärtnerei Muster",
  deliveryType: "website",
  goal: "Wir wollen mehr Anfragen über die Website erhalten.",
  audience: "Privatkundschaft in der Region",
  features: "Kontaktformular\nTerminbuchung\n\nBildergalerie",
  pages: "Startseite, Über uns, Kontakt",
  contentStatus: "Logo vorhanden, Texte fehlen",
  currentSystem: "Alte WordPress-Seite bei einem Bekannten",
  currentProviderPrice: "CHF 1'200",
  budget: "4500.50",
  deadline: "2026-11-01",
  priorities: "Auffindbarkeit\nEinfache Pflege",
  notes: "Bitte auf Deutsch",
};

const briefing = W.normalizeBriefing(RAW, { now: NOW });
{
  eq(briefing.contactName, "Anna Muster", "Mehrfach-Leerzeichen werden nicht zusammengezogen");
  eq(briefing.contactEmail, "anna@muster.ch", "die E-Mail wird nicht normalisiert");
  eq(briefing.features, ["Kontaktformular", "Terminbuchung", "Bildergalerie"],
    "Funktionen werden nicht als Liste erkannt (Leerzeilen muessen wegfallen)");
  eq(briefing.pages, ["Startseite", "Über uns", "Kontakt"], "Seiten werden nicht als Liste erkannt");
  eq(briefing.budget, 4500.5, "das Budget wird nicht als Zahl gelesen");
  eq(briefing.currentProviderPrice, 1200, "der bisherige Anbieterpreis wird nicht gelesen");
  eq(briefing.deadline, "2026-11-01", "der Wunschtermin geht verloren");
  eq(briefing.priorities, ["Auffindbarkeit", "Einfache Pflege"], "die Prioritaeten gehen verloren");
  ok(W.briefingIsUsable(briefing), "ein vollstaendiges Briefing gilt als unbrauchbar");

  // Unbrauchbares wird als solches erkannt, statt halbe Projekte anzulegen.
  ok(!W.briefingIsUsable(W.normalizeBriefing({ goal: "zu kurz" }, { now: NOW })),
    "ein Briefing ohne E-Mail gilt als brauchbar");
  ok(!W.briefingIsUsable(W.normalizeBriefing({ contactEmail: "a@b.ch", goal: "kurz" }, { now: NOW })),
    "ein Briefing ohne Zielbeschreibung gilt als brauchbar");
  // Ein ungueltiges Datum darf nicht durchrutschen.
  eq(W.normalizeBriefing({ deadline: "irgendwann" }, { now: NOW }).deadline, "",
    "ein ungueltiges Datum wird uebernommen");
  eq(W.normalizeBriefing({ budget: "keine Ahnung" }, { now: NOW }).budget, null,
    "ein unlesbares Budget wird nicht auf null gesetzt");
}

// ── 3. Briefing -> Projektfelder, ohne Gepflegtes zu ueberschreiben ────────
{
  const leeresProjekt = {};
  const patch = W.projectFieldsFromBriefing(briefing, leeresProjekt);
  eq(patch.deliveryType, "website", "der Projekttyp wird nicht uebernommen");
  eq(patch.budget, 4500.5, "das Budget wird nicht uebernommen");
  eq(patch.currentProviderPrice, 1200, "der bisherige Anbieterpreis wird nicht uebernommen");
  eq(patch.dueDate, "2026-11-01", "der Termin wird nicht uebernommen");
  eq(patch.client.email, "anna@muster.ch", "die Kundendaten werden nicht uebernommen");
  eq(patch.client.company, "Gärtnerei Muster", "die Firma wird nicht uebernommen");

  // Gepflegte Werte bleiben stehen — ein zweites Formular darf nichts zerstoeren.
  const gepflegt = {
    deliveryType: "program",
    budget: 9000,
    dueDate: "2026-12-24",
    client: { email: "chef@muster.ch", name: "Bereits Erfasst" },
  };
  const patch2 = W.projectFieldsFromBriefing(briefing, gepflegt);
  eq(patch2.deliveryType, undefined, "ein gepflegter Projekttyp wird ueberschrieben");
  eq(patch2.budget, undefined, "ein gepflegtes Budget wird ueberschrieben");
  eq(patch2.dueDate, undefined, "ein gepflegter Termin wird ueberschrieben");
  eq(patch2.client.email, "chef@muster.ch", "eine gepflegte E-Mail wird ueberschrieben");
  eq(patch2.client.company, "Gärtnerei Muster", "eine noch leere Firma wird nicht ergaenzt");
}

// ── 4. Briefing -> ganz normale Quantus-Aufgaben ───────────────────────────
{
  const tasks = W.buildBriefingTasks(briefing, "prj_1", { now: NOW });
  ok(tasks.length >= 8, `zu wenige Aufgaben aus dem Briefing: ${tasks.length}`);

  // Jede Aufgabe traegt die Felder einer normalen Quantus-Aufgabe.
  for (const task of tasks) {
    ok(typeof task.title === "string" && task.title.length > 0, "eine Aufgabe hat keinen Titel");
    eq(task.status, "todo", `Aufgabe "${task.title}" startet nicht auf todo`);
    eq(task.projectId, "prj_1", `Aufgabe "${task.title}" haengt nicht am Projekt`);
    ok([1, 2, 3].includes(task.priority), `Aufgabe "${task.title}" hat keine gueltige Prioritaet`);
    ok(Array.isArray(task.tags) && task.tags.includes("flowertech"),
      `Aufgabe "${task.title}" ist nicht als FlowerTech-Aufgabe markiert`);
    ok(task.createdAt && task.updatedAt, `Aufgabe "${task.title}" hat keine Zeitstempel`);
    // Die entscheidende Zusage: keine eigene Aufgabenart.
    ok(!("kind" in task) && !("type" in task) && !("taskType" in task),
      `Aufgabe "${task.title}" fuehrt eine eigene Aufgabenart ein`);
  }

  // Jede gewuenschte Funktion und jede Seite wird zu einer Aufgabe.
  for (const feature of briefing.features) {
    ok(tasks.some((t) => t.title === "Funktion: " + feature), `keine Aufgabe fuer Funktion: ${feature}`);
  }
  for (const page of briefing.pages) {
    ok(tasks.some((t) => t.title === "Seite: " + page), `keine Aufgabe fuer Seite: ${page}`);
  }
  ok(tasks.some((t) => /Inhalte beschaffen/.test(t.title)), "die Inhaltsbeschaffung fehlt");
  const offer = tasks.find((t) => /Offerte/.test(t.title));
  ok(!!offer, "die Aufgabe zur Offerte fehlt");
  eq(offer.dueDate, "2026-11-01", "die Offerte erbt den Wunschtermin nicht");

  // Stabile Schluessel: ein zweites Absenden erzeugt keine Dubletten.
  const wieder = W.buildBriefingTasks(briefing, "prj_1", { now: "2026-08-07T10:00:00.000Z" });
  eq(wieder.map((t) => t.key), tasks.map((t) => t.key),
    "die Aufgabenschluessel sind nicht stabil — ein zweites Formular erzeugt Dubletten");
  eq(new Set(tasks.map((t) => t.key)).size, tasks.length, "zwei Aufgaben teilen sich einen Schluessel");

  // Bei einem Programm heissen die Bereiche anders als Seiten.
  const programm = W.normalizeBriefing({ ...RAW, deliveryType: "program" }, { now: NOW });
  const programmTasks = W.buildBriefingTasks(programm, "prj_2", { now: NOW });
  ok(programmTasks.some((t) => t.title === "Bereich: Startseite"),
    "bei einem Programm entstehen weiterhin Aufgaben fuer Seiten statt fuer Bereiche");
}

// ── 5. Aenderungswunsch -> Aufgabe, Status folgt der Aufgabe ───────────────
{
  const cr = W.normalizeChangeRequest({
    title: "  Startseite: anderes Bild  ",
    detail: "Das Titelbild passt nicht zur Jahreszeit.",
    area: "Startseite",
    priority: 1,
    requestedBy: "Anna Muster",
  }, { now: NOW });
  ok(W.changeRequestIsUsable(cr), "ein vollstaendiger Aenderungswunsch gilt als unbrauchbar");
  eq(cr.status, "new", "ein neuer Wunsch startet nicht auf 'neu'");
  eq(cr.origin, "client", "die Herkunft steht nicht standardmaessig auf Kunde");
  ok(!W.changeRequestIsUsable(W.normalizeChangeRequest({ title: "ab" }, { now: NOW })),
    "ein Wunsch ohne brauchbaren Titel gilt als verwertbar");

  const task = W.buildChangeRequestTask({ ...cr, id: "cr_1" }, "prj_1", { now: NOW });
  eq(task.status, "todo", "die Aufgabe startet nicht auf todo");
  eq(task.projectId, "prj_1", "die Aufgabe haengt nicht am Projekt");
  eq(task.priority, 1, "die Prioritaet des Wunsches geht verloren");
  eq(task.sourceChangeRequestId, "cr_1", "die Aufgabe verweist nicht auf den Wunsch");
  ok(task.title.startsWith("Änderung: "), "die Aufgabe ist nicht als Änderung erkennbar");
  ok(task.description.includes("Startseite"), "der Bereich fehlt in der Aufgabe");
  ok(task.description.includes("Anna Muster"), "die anfragende Person fehlt in der Aufgabe");
  ok(!("kind" in task) && !("type" in task), "der Aenderungswunsch fuehrt eine eigene Aufgabenart ein");

  // Die zentrale Aufgaben-App bleibt fuehrend: der Wunsch folgt der Aufgabe.
  eq(W.changeStatusFromTask({ status: "done" }, "accepted"), "done",
    "eine erledigte Aufgabe schliesst den Wunsch nicht");
  eq(W.changeStatusFromTask({ status: "in_progress" }, "accepted"), "in_progress",
    "eine laufende Aufgabe setzt den Wunsch nicht auf 'in Arbeit'");
  eq(W.changeStatusFromTask({ status: "todo" }, "new"), "accepted",
    "eine angelegte Aufgabe hebt den Wunsch nicht aus 'neu'");
  // Wird eine erledigte Aufgabe wieder geoeffnet, faellt der Wunsch zurueck.
  eq(W.changeStatusFromTask({ status: "todo" }, "done"), "accepted",
    "eine wieder geoeffnete Aufgabe laesst den Wunsch auf 'erledigt' stehen");
  eq(W.changeStatusFromTask(null, "in_progress"), "in_progress",
    "ohne Aufgabe darf sich der Status nicht veraendern");
}

// ── 6. Kostenuebersicht ────────────────────────────────────────────────────
{
  const totals = (d) => d.total;
  const costs = W.costOverview({
    offers: [
      { status: "accepted", total: 4500 },
      { status: "sent", total: 800 },
      { status: "declined", total: 9999 },
    ],
    invoices: [
      { status: "paid", total: 2000 },
      { status: "sent", total: 2500 },
      { status: "cancelled", total: 700 },
    ],
    totals,
  });
  eq(costs.offered, 5300, "abgelehnte Offerten werden mitgezaehlt");
  eq(costs.accepted, 4500, "die angenommene Offerte wird falsch summiert");
  eq(costs.invoiced, 4500, "stornierte Rechnungen werden mitgezaehlt");
  eq(costs.paid, 2000, "die bezahlte Summe stimmt nicht");
  eq(costs.open, 2500, "der offene Betrag stimmt nicht");

  const leer = W.costOverview({});
  eq(leer, { offered: 0, accepted: 0, invoiced: 0, paid: 0, open: 0 },
    "ohne Belege liefert die Uebersicht keine Nullen");
}

// ── 7. Vertrag, AGB, Datenschutz: Entwuerfe mit sichtbarem Pruefhinweis ────
{
  const context = {
    project: { title: "Website Gärtnerei", deliveryType: "website", budget: 4500,
      client: { company: "Gärtnerei Muster", name: "Anna Muster", address: "Dorfstrasse 1" } },
    company: { name: "FlowerTech", address: "Bahnhofstrasse 1", venue: "Zürich" },
    briefing,
    milestones: [{ title: "Entwurf", date: "2026-09-01" }],
  };

  const contract = W.buildContractDraft(context);
  eq(contract.status, "draft", "der Vertrag startet nicht als Entwurf");
  ok(/rechtlich prüfen/i.test(contract.legalNotice), "dem Vertrag fehlt der Rechtsprüf-Hinweis");
  ok(/rechtlich prüfen/i.test(contract.intro), "dem Vertrag fehlt der Hinweis vor dem Text");
  ok(contract.title.includes("Website Gärtnerei"), "der Vertragstitel uebernimmt den Projektnamen nicht");
  ok(contract.sections.length >= 12, `zu wenige Vertragsklauseln: ${contract.sections.length}`);
  for (const key of ["parteien", "leistung", "mitwirkung", "termine", "verguetung", "aenderungen",
    "abnahme", "rechte", "vertraulichkeit", "haftung", "schluss", "signatur"]) {
    ok(contract.sections.some((s) => s.key === key), `Vertragsklausel fehlt: ${key}`);
  }
  // Jede Klausel ist ein eigener, editierbarer Block.
  for (const section of contract.sections) {
    ok(section.title && section.body, `Klausel ${section.key} ist leer`);
    eq(section.enabled, true, `Klausel ${section.key} ist standardmaessig aus`);
    ok(Array.isArray(section.variables), `Klausel ${section.key} kennt ihre Variablen nicht`);
  }

  // Variablen werden zur Laufzeit ersetzt, offene bleiben sichtbar stehen.
  const verguetung = contract.sections.find((s) => s.key === "verguetung");
  ok(containsNum(verguetung.body, "4'500.00"),
    `der Preis wird nicht eingesetzt (erhalten: ${verguetung.body.slice(0, 80)})`);
  ok(/nur bei vergleichbarem Umfang|denselben Umfang/i.test(verguetung.body),
    "die faire Konkurrenzpreis-Formulierung fehlt");
  const schluss = contract.sections.find((s) => s.key === "schluss");
  ok(schluss.body.includes("Schweizer Recht"), "das anwendbare Recht fehlt");
  ok(schluss.body.includes("Zürich"), "der Gerichtsstand wird nicht eingesetzt");

  const offen = W.renderTemplate("Preis {{preis_chf}} an {{unbekannt}}", { preis_chf: "100" });
  eq(offen, "Preis 100 an {{unbekannt}}", "eine offene Variable verschwindet, statt sichtbar zu bleiben");

  const text = W.contractToText(contract, W.contractVariables(context));
  ok(text.includes("⚠"), "der Prüfhinweis fehlt im ausgegebenen Vertragstext");
  ok(text.includes("1. Parteien und Projekt"), "die Klauseln fehlen im ausgegebenen Text");

  // Abgewaehlte Bloecke erscheinen nicht im Text.
  const ohneSignatur = { ...contract, sections: contract.sections.map((s) =>
    s.key === "signatur" ? { ...s, enabled: false } : s) };
  ok(!W.contractToText(ohneSignatur, {}).includes("Unterschriften"),
    "ein abgewaehlter Block erscheint trotzdem im Text");

  for (const kind of ["agb", "privacy"]) {
    const doc = W.buildLegalDraft(kind, context);
    eq(doc.status, "draft", `${kind} startet nicht als Entwurf`);
    ok(/rechtlich prüfen|vor Veröffentlichung/i.test(doc.intro + " " + doc.legalNotice),
      `${kind} traegt keinen Pruefhinweis`);
    ok(doc.sections.length > 0 && doc.sections.every((s) => s.body),
      `${kind} hat leere Abschnitte`);
  }
  eq(W.buildLegalDraft("gibtesnicht", context).kind, "agb",
    "eine unbekannte Vorlagenart faellt nicht sauber zurueck");

  // Leistungsbeschreibung folgt dem Projekttyp.
  const website = W.buildServiceDescription(context.project, briefing, context);
  ok(website.blocks[0].body.includes("Website"), "die Website-Leistungsbeschreibung passt nicht zum Typ");
  ok(website.blocks.some((b) => b.key === "warum-flowertech"), "die Positionierungskarte fehlt");
  const programm = W.buildServiceDescription({ ...context.project, deliveryType: "program" }, briefing, context);
  ok(programm.blocks[0].body.includes("Programm"), "die Programm-Leistungsbeschreibung passt nicht zum Typ");
}

// ── 8. Claude-Prompt: datensparsam per Voreinstellung ──────────────────────
{
  const context = {
    project: { title: "Website Gärtnerei", deliveryType: "website", budget: 4500,
      currentProviderPrice: 1200, client: { company: "Gärtnerei Muster", email: "anna@muster.ch" } },
    briefing,
    changeRequests: [
      { title: "Bild tauschen", status: "new", detail: "Titelbild" },
      { title: "Schon erledigt", status: "done" },
      { title: "Abgelehnt", status: "rejected" },
    ],
    notes: [{ text: "Kunde zahlt erfahrungsgemäss spät" }],
  };

  // Voreinstellung: Kundendaten, Preise und interne Notizen sind AUS.
  const standard = {};
  W.PROMPT_DATA_OPTIONS.forEach((o) => { standard[o.key] = o.default; });
  for (const key of ["client", "prices", "internal"]) {
    eq(standard[key], false, `${key} ist standardmaessig eingeschaltet`);
  }

  const prompt = W.buildClaudePrompt(context, standard);
  ok(prompt.includes("Website Gärtnerei"), "der Projektname fehlt im Prompt");
  ok(prompt.includes("mehr Anfragen"), "das Ziel fehlt im Prompt");
  ok(prompt.includes("Kontaktformular"), "die Funktionen fehlen im Prompt");
  ok(prompt.includes("Bild tauschen"), "der offene Aenderungswunsch fehlt im Prompt");
  // Erledigte und abgelehnte Wuensche sind nicht mehr offen.
  ok(!prompt.includes("Schon erledigt"), "ein erledigter Wunsch landet im Prompt");
  ok(!prompt.includes("Abgelehnt"), "ein abgelehnter Wunsch landet im Prompt");
  // Und das Wesentliche: nichts Vertrauliches ohne ausdrueckliche Auswahl.
  ok(!prompt.includes("anna@muster.ch"), "die Kunden-E-Mail landet ungefragt im Prompt");
  ok(!prompt.includes("Gärtnerei Muster"), "der Kundenname landet ungefragt im Prompt");
  ok(!prompt.includes("4500"), "das Budget landet ungefragt im Prompt");
  ok(!prompt.includes("1200"), "der bisherige Anbieterpreis landet ungefragt im Prompt");
  ok(!prompt.includes("zahlt erfahrungsgemäss spät"), "eine interne Notiz landet ungefragt im Prompt");

  // Ausdruecklich eingeschaltet, erscheinen die Daten.
  const voll = W.buildClaudePrompt(context, { ...standard, client: true, prices: true, internal: true });
  ok(voll.includes("anna@muster.ch"), "eingeschaltete Kundendaten fehlen");
  ok(voll.includes("4500"), "eingeschaltete Preise fehlen");
  ok(voll.includes("zahlt erfahrungsgemäss spät"), "eingeschaltete interne Notizen fehlen");
}

// ── 9. Mailzuordnung: nur ueber ausdruecklichen Projektkontext ─────────────
{
  const projekt = { id: "prj_1", client: { email: "anna@muster.ch" }, mailContacts: ["buchhaltung@muster.ch"] };
  eq(W.projectMailAddresses(projekt), ["anna@muster.ch", "buchhaltung@muster.ch"],
    "die hinterlegten Projektadressen stimmen nicht");

  ok(W.mailBelongsToProject({ from: ["Anna <anna@muster.ch>"], to: [] }, projekt),
    "eine Mail der hinterlegten Adresse wird nicht zugeordnet");
  ok(W.mailBelongsToProject({ from: [], to: ["buchhaltung@muster.ch"] }, projekt),
    "eine Mail an die zweite Projektadresse wird nicht zugeordnet");
  ok(W.mailBelongsToProject({ from: ["fremd@example.com"], linkedEntity: { kind: "project", id: "prj_1" } }, projekt),
    "eine ausdruecklich verknuepfte Mail wird nicht zugeordnet");

  // Keine allgemeine Postfachueberwachung.
  ok(!W.mailBelongsToProject({ from: ["fremd@example.com"], to: ["ich@example.com"] }, projekt),
    "eine fremde Mail wird dem Projekt zugeordnet");
  ok(!W.mailBelongsToProject({ from: ["anna@muster.ch"] }, { id: "prj_2", client: {} }),
    "ein Projekt ohne hinterlegte Adresse zieht trotzdem Mails an sich");
  ok(!W.mailBelongsToProject(null, projekt), "eine fehlende Mail wird zugeordnet");
}

// ── 10. Idempotenz: derselbe Eingang wirkt nur einmal ──────────────────────
{
  const payload = { token: "t".repeat(24), kind: "briefing", contactEmail: "a@b.ch", goal: "Ziel" };
  const key = W.idempotencyKey(payload);
  eq(W.idempotencyKey({ ...payload }), key, "derselbe Eingang erzeugt zwei verschiedene Schluessel");
  ok(W.idempotencyKey({ ...payload, goal: "Anderes Ziel" }) !== key,
    "ein anderer Eingang erzeugt denselben Schluessel");
  ok(W.idempotencyKey({ ...payload, token: "u".repeat(24) }) !== key,
    "ein anderes Projekt erzeugt denselben Schluessel");

  const gesehen = new Set([key]);
  ok(W.isDuplicate(key, gesehen), "ein bekannter Schluessel gilt als neu");
  ok(!W.isDuplicate("neu", gesehen), "ein neuer Schluessel gilt als Dublette");
  ok(!W.isDuplicate("", gesehen), "ein leerer Schluessel gilt als Dublette");
}

// ── 11. Freigabe-Links ─────────────────────────────────────────────────────
{
  const token = "a".repeat(28);
  ok(W.isShareToken(token), "ein gueltiger Token wird abgelehnt");
  ok(!W.isShareToken("zu-kurz"), "ein zu kurzer Token wird akzeptiert");
  ok(!W.isShareToken("hat leerzeichen im token aaaaaaa"), "ein Token mit Leerzeichen wird akzeptiert");
  eq(W.formUrl("https://x.test/", token), "https://x.test/flowertech-formular.html?t=" + token,
    "der Formularlink stimmt nicht");
  eq(W.portalUrl("https://x.test", token), "https://x.test/flowertech-kunde.html?t=" + token,
    "der Kundenlink stimmt nicht");
  eq(W.formUrl("https://x.test", "kaputt"), "", "ein ungueltiger Token erzeugt trotzdem einen Link");
}

// ── 12. Der Prozess als Daten: was jetzt ansteht ───────────────────────────
{
  const inquiries = [
    { id: "i1", name: "Anna", company: "Muster AG", email: "a@muster.ch", status: "new" },
    { id: "i2", name: "Beat", email: "b@x.ch", status: "new", projectId: "prj_x" }, // schon Projekt
    { id: "i3", name: "Cara", email: "c@x.ch", status: "lost" },                    // abgesagt
  ];
  eq(inquiries.filter(W.inquiryIsOpen).map((i) => i.id), ["i1"],
    "offene Anfragen werden falsch bestimmt");

  const steps = W.nextProcessSteps({
    inquiries,
    projects: [
      { id: "p1", title: "Ohne Bedarf", pipelineStage: "lead" },
      // Ausdruecklich auf dem Offertweg — ohne Route waere es ein Direktprojekt.
      { id: "p2", title: "Bedarf da, kein Angebot", pipelineStage: "intake", ftRoute: "offer_first" },
      { id: "p3", title: "Wartet auf Freigabe", pipelineStage: "approval" },
      { id: "p4", title: "Archiviert", pipelineStage: "lead", status: "archived" },
    ],
    briefings: { p2: { goal: "Ziel" } },
    offers: [],
    changeRequests: [
      { projectId: "p3", status: "new", title: "A" },
      { projectId: "p3", status: "done", title: "B" },
    ],
  });
  const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));

  // Der Schritt, um den es geht: eine Anfrage wird zum Projekt.
  ok(!!byKey.inquiry, "der Schritt 'Anfrage → Projekt' fehlt");
  eq(byKey.inquiry.count, 1, "es wird die falsche Zahl offener Anfragen gemeldet");
  eq(byKey.inquiry.items[0].title, "Muster AG", "die Anfrage wird falsch beschriftet");

  eq(byKey.briefing.items.map((i) => i.id), ["p1"], "der Bedarfsschritt trifft die falschen Projekte");
  eq(byKey.offer.items.map((i) => i.id), ["p2"], "der Angebotsschritt trifft die falschen Projekte");
  // p1 hat keine Route und keine Offerte → gilt als Direktprojekt (Altbestand).
  ok(!byKey.offer.items.some((i) => i.id === "p1"),
    "ein routenloses Projekt landet faelschlich im Angebotsschritt");
  eq(byKey.changes.count, 1, "erledigte Änderungswünsche zählen mit");
  eq(byKey.approval.items.map((i) => i.id), ["p3"], "der Freigabeschritt trifft die falschen Projekte");
  ok(!steps.some((s) => s.items.some((i) => i.id === "p4")),
    "ein archiviertes Projekt taucht im Prozess auf");

  // Nichts offen → keine Schritte, damit die Uebersicht ruhig bleibt.
  eq(W.nextProcessSteps({}), [], "ohne Daten werden trotzdem Schritte gemeldet");

  // Ein Projekt mit Angebot faellt aus dem Angebotsschritt.
  const mitAngebot = W.nextProcessSteps({
    projects: [{ id: "p2", title: "x", pipelineStage: "intake", ftRoute: "offer_first" }],
    briefings: { p2: { goal: "Ziel" } },
    offers: [{ projectId: "p2", status: "sent" }],
  });
  ok(!mitAngebot.some((s) => s.key === "offer"), "ein Projekt mit Angebot steht weiter im Angebotsschritt");
  // Eine abgelehnte Offerte zaehlt nicht als Angebot.
  const abgelehnt = W.nextProcessSteps({
    projects: [{ id: "p2", title: "x", pipelineStage: "intake", ftRoute: "offer_first" }],
    briefings: { p2: { goal: "Ziel" } },
    offers: [{ projectId: "p2", status: "declined" }],
  });
  // Neue Regel: Ablehnung SCHLIESST den Angebotsvorgang. Er taucht nicht wieder
  // als "Angebot erstellen" auf — sonst entstuende ein zweiter Anlauf von selbst.
  ok(!abgelehnt.some((s) => String(s.key).startsWith("offer")),
    "ein abgelehnter Angebotsvorgang wird wieder zur offenen Aufgabe");
}

// ── 13. Anfrage → Projekt ──────────────────────────────────────────────────
{
  const inquiry = {
    id: "inq_1", name: "Anna Muster", company: "Gärtnerei Muster",
    email: "anna@muster.ch", phone: "079 111 22 33", service: "Website",
    message: "Wir hätten gerne eine neue Website mit Kontaktformular.",
  };
  const { project, briefing: draft } = W.projectFromInquiry(inquiry, { now: NOW });

  eq(project.title, "Gärtnerei Muster", "der Projektname kommt nicht aus der Anfrage");
  eq(project.projectType, "flowertech", "das Projekt ist kein FlowerTech-Projekt");
  eq(project.pipelineStage, "intake",
    "der Prozess startet nicht bei der Bestandesaufnahme — der Lead ist ja bereits da");
  eq(project.deliveryType, "website", "der Typ wird nicht aus dem Interesse abgeleitet");
  eq(project.sourceInquiryId, "inq_1", "das Projekt verweist nicht auf die Anfrage");
  eq(project.client.email, "anna@muster.ch", "die Kundendaten werden nicht uebernommen");
  ok(project.description.includes("Kontaktformular"), "die Nachricht fehlt in der Beschreibung");

  // Die Nachricht wird zum ersten Ziel — der Kunde hat es schon formuliert.
  ok(!!draft, "aus der Nachricht entsteht kein Bedarfsentwurf");
  eq(draft.contactEmail, "anna@muster.ch", "der Bedarfsentwurf uebernimmt die E-Mail nicht");
  ok(draft.goal.includes("Kontaktformular"), "die Nachricht wird nicht als Ziel uebernommen");
  eq(draft.source, "anfrage", "die Herkunft des Bedarfs ist nicht vermerkt");

  // Aus dem Entwurf entstehen sofort ganz normale Aufgaben.
  const tasks = W.buildBriefingTasks(draft, "prj_neu", { now: NOW });
  ok(tasks.length > 0, "aus dem uebernommenen Bedarf entstehen keine Aufgaben");
  ok(tasks.every((t) => t.projectId === "prj_neu" && t.status === "todo"),
    "die Aufgaben haengen nicht am neuen Projekt");

  // Ein Programm wird als solches erkannt.
  eq(W.projectFromInquiry({ service: "Software für die Zeiterfassung" }, { now: NOW }).project.deliveryType,
    "program", "ein Programm-Interesse wird als Website eingestuft");

  // Zu kurze Nachricht → kein Bedarfsentwurf, statt einen leeren anzulegen.
  eq(W.projectFromInquiry({ name: "X", message: "Hallo" }, { now: NOW }).briefing, null,
    "aus einer zu kurzen Nachricht entsteht ein leerer Bedarfsentwurf");
  eq(W.projectFromInquiry({}, { now: NOW }).project.title, "FlowerTech-Projekt",
    "eine Anfrage ohne Namen erzeugt ein Projekt ohne Titel");
}

// ── 15. Die Weggabelung: Offerte zuerst / Direktprojekt ────────────────────
{
  eq(W.ROUTES.map((r) => r.key), ["offer_first", "direct"], "es gibt nicht genau zwei Wege");
  ok(W.ROUTES.every((r) => r.label && r.hint && r.stages.length), "ein Weg ist unvollstaendig");
  ok(W.ROUTES.find((r) => r.key === "direct").skips.includes("proposal"),
    "das Direktprojekt ueberspringt den Angebotsschritt nicht sichtbar");

  // Persistierte Entscheidung gewinnt.
  eq(W.routeOf({ id: "p", ftRoute: "direct" }, []), "direct", "die gespeicherte Route wird ignoriert");
  ok(W.routeIsExplicit({ ftRoute: "offer_first" }), "eine gesetzte Route gilt als unentschieden");

  // Rueckwaertskompatibilitaet: Altbestand wird NICHT migriert, sondern beim
  // Lesen abgeleitet — wer eine Offerte hat, lief ueber "Offerte zuerst".
  ok(!W.routeIsExplicit({ id: "alt" }), "ein Altprojekt gilt faelschlich als entschieden");
  eq(W.routeOf({ id: "alt" }, [{ projectId: "alt", status: "sent" }]), "offer_first",
    "ein Altprojekt mit Offerte wird nicht als Offertweg gelesen");
  eq(W.routeOf({ id: "alt" }, []), "direct", "ein Altprojekt ohne Offerte wird nicht als Direktprojekt gelesen");
  eq(W.routeOf({ id: "x", ftRoute: "quatsch" }, []), "direct", "eine unbekannte Route wird uebernommen");

  // Angebotsstand aus den vorhandenen Offerten — kein eigener Zaehler.
  const p = { id: "p1" };
  eq(W.offerDecisionState(p, []), "none", "ohne Offerte falscher Stand");
  eq(W.offerDecisionState(p, [{ projectId: "p1", status: "draft" }]), "draft", "Entwurf falsch erkannt");
  eq(W.offerDecisionState(p, [{ projectId: "p1", status: "sent" }]), "sent", "Versand falsch erkannt");
  eq(W.offerDecisionState(p, [{ projectId: "p1", status: "declined" }, { projectId: "p1", status: "accepted" }]),
    "accepted", "eine angenommene Offerte wird von einer abgelehnten verdeckt");
  eq(W.offerDecisionState(p, [{ projectId: "p1", status: "declined" }]), "declined", "Ablehnung falsch erkannt");
  eq(W.offerDecisionState(p, [{ projectId: "andere", status: "accepted" }]), "none",
    "die Offerte eines fremden Projekts wird mitgezaehlt");
}

// ── 16. Prozessschritte folgen dem gewaehlten Weg ──────────────────────────
{
  const base = { briefings: { a: { goal: "x" }, b: { goal: "x" } } };
  const keys = (opts) => W.nextProcessSteps(Object.assign({}, base, opts)).map((s) => s.key);

  // Offertweg: erstellen → senden → Entscheidung.
  const a = { id: "a", title: "A", pipelineStage: "intake", ftRoute: "offer_first" };
  ok(keys({ projects: [a], offers: [] }).includes("offer"), "der Offertweg verlangt keine Offerte");
  ok(keys({ projects: [a], offers: [{ projectId: "a", status: "draft" }] }).includes("offer_send"),
    "eine Offerte im Entwurf fuehrt nicht zu 'Offerte senden'");
  ok(keys({ projects: [a], offers: [{ projectId: "a", status: "sent" }] }).includes("offer_decision"),
    "eine versendete Offerte fuehrt nicht zur Entscheidung");
  // Angenommen: kein Angebotsschritt mehr.
  const nachAnnahme = keys({ projects: [{ ...a, pipelineStage: "build" }], offers: [{ projectId: "a", status: "accepted" }] });
  ok(!nachAnnahme.some((k) => k.startsWith("offer")), "nach der Annahme steht der Angebotsschritt weiter offen");

  // Direktprojekt: NIE ein Angebotsschritt, dafuer die Umsetzung.
  const b = { id: "b", title: "B", pipelineStage: "intake", ftRoute: "direct" };
  const direkt = keys({ projects: [b], offers: [] });
  ok(!direkt.some((k) => k.startsWith("offer")), "das Direktprojekt bekommt einen Angebotsschritt");
  ok(direkt.includes("direct_build"), "das Direktprojekt bekommt keinen Umsetzungsschritt");
  const item = W.nextProcessSteps(Object.assign({}, base, { projects: [b] }))
    .find((s) => s.key === "direct_build").items[0];
  ok(/übersprungen/.test(item.sub), "der übersprungene Angebotsschritt ist nicht sichtbar");

  // Anfrage ohne Wahl setzt KEINE Route — die UI muss fragen.
  eq(W.projectFromInquiry({ name: "X" }, { now: NOW }).project.ftRoute, null,
    "eine Anfrage waehlt still einen Weg");
  eq(W.projectFromInquiry({ name: "X" }, { now: NOW, route: "direct" }).project.ftRoute, "direct",
    "die gewaehlte Route wird nicht uebernommen");
  eq(W.projectFromInquiry({ name: "X" }, { now: NOW, route: "quatsch" }).project.ftRoute, null,
    "eine erfundene Route wird uebernommen");
}

// ── 17. Beilage zur Offerte: Vision Room oder echte Beispiel-URL ───────────
{
  eq(W.OFFER_ATTACHMENTS.map((a) => a.key), ["vision", "example"], "die Beilagen stimmen nicht");

  // Ohne Wahl ist nichts versandfertig.
  const leer = W.offerAttachmentState({});
  ok(!leer.ready && /Wähle/.test(leer.reason), "ohne Beilage fehlt die Aufforderung");

  // Vision braucht einen echten Token.
  ok(W.offerAttachmentState({ kind: "vision", visionToken: "v".repeat(28) }).ready,
    "eine Beilage mit gueltigem Vision-Token gilt als unfertig");
  const ohneToken = W.offerAttachmentState({ kind: "vision" });
  ok(!ohneToken.ready && /Vision-Room-Link/.test(ohneToken.reason), "der fehlende Vision-Link wird nicht benannt");

  // Beispiel braucht eine echte URL — erfundene Links gibt es nicht.
  ok(W.offerAttachmentState({ kind: "example", exampleUrl: "https://muster.ch/vorschau" }).ready,
    "eine gueltige Beispiel-URL gilt als unfertig");
  for (const bad of ["", "muster.ch", "javascript:alert(1)", "ftp://x.ch", "https://", "http://localhost"]) {
    const st = W.offerAttachmentState({ kind: "example", exampleUrl: bad });
    ok(!st.ready, `unbrauchbare Beispiel-URL wird akzeptiert: ${bad}`);
    ok(/echte Beispiel-URL|Vision Room/.test(st.reason), `keine Aufforderung bei: ${bad}`);
  }
  ok(W.isHttpUrl("http://muster.ch"), "http wird abgelehnt");
  ok(!W.isHttpUrl("data:text/html,<h1>x"), "eine data-URL gilt als Beispiel-URL");
}

// ── 18. Vision Room → Direktprojekt ────────────────────────────────────────
{
  const raw = {
    type: "Web-Programm",
    idea: "Buchhaltung für kleine Vereine",
    features: ["Belege erfassen", "Jahresabschluss", "Mitgliederliste"],
    email: "  KASSIER@Verein.CH ",
  };
  const vision = W.normalizeVisionSubmission(raw, { now: NOW });
  eq(vision.deliveryType, "program", "Web-Programm wird nicht als Programm gelesen");
  eq(vision.contactEmail, "kassier@verein.ch", "die E-Mail wird nicht normalisiert");
  eq(vision.features.length, 3, "die Funktionen gehen verloren");
  eq(vision.source, "vision-room", "die Herkunft ist nicht vermerkt");
  ok(W.visionIsUsable(vision), "eine vollstaendige Vision gilt als unbrauchbar");
  eq(W.normalizeVisionSubmission({ type: "Web-App" }, { now: NOW }).deliveryType, "program",
    "Web-App wird nicht als Programm gelesen");
  eq(W.normalizeVisionSubmission({ type: "Erfunden" }, { now: NOW }).type, "Website",
    "eine erfundene Art wird uebernommen");

  // Unbrauchbares wird abgewiesen, statt halbe Projekte anzulegen.
  ok(!W.visionIsUsable(W.normalizeVisionSubmission({ idea: "x", email: "a@b.ch", features: ["f"] }, { now: NOW })),
    "eine zu kurze Idee gilt als brauchbar");
  ok(!W.visionIsUsable(W.normalizeVisionSubmission({ idea: "Gute Idee", features: ["f"] }, { now: NOW })),
    "eine Vision ohne E-Mail gilt als brauchbar");
  ok(!W.visionIsUsable(W.normalizeVisionSubmission({ idea: "Gute Idee", email: "a@b.ch" }, { now: NOW })),
    "eine Vision ohne Funktionen gilt als brauchbar");

  // Das Direktprojekt entsteht vollstaendig — ohne Nacharbeit.
  const { project, briefing: draft } = W.projectFromVision(vision, { now: NOW });
  eq(project.ftRoute, "direct", "der Vision Room startet kein Direktprojekt");
  eq(project.ftRouteSource, "vision-room", "die Herkunft der Route fehlt");
  eq(project.pipelineStage, "intake", "die Bestandesaufnahme durch den Vision Room wird nicht anerkannt");
  eq(project.deliveryType, "program", "der Typ aus dem Vision Room geht verloren");
  eq(project.client.email, "kassier@verein.ch", "die Kontaktdaten gehen verloren");
  ok(project.title.includes("Buchhaltung"), "die Idee wird nicht zum Titel");
  ok(project.description.includes("Jahresabschluss"), "die Funktionen fehlen in der Beschreibung");
  ok(project.tags.includes("visionroom"), "das Projekt ist nicht als Vision-Room-Projekt erkennbar");

  // Aus den Funktionen entstehen sofort normale Quantus-Aufgaben.
  eq(draft.features, vision.features, "der Bedarf uebernimmt die Funktionen nicht");
  const tasks = W.buildBriefingTasks(draft, "prj_v", { now: NOW });
  for (const f of vision.features) {
    ok(tasks.some((t) => t.title === "Funktion: " + f), `keine Aufgabe fuer Vision-Funktion: ${f}`);
  }
  ok(tasks.every((t) => !("kind" in t) && !("type" in t)), "der Vision Room fuehrt eine eigene Aufgabenart ein");

  // Idempotenz: derselbe Eingang, derselbe Schluessel.
  const k1 = W.idempotencyKey({ token: "", kind: "vision", contactEmail: vision.contactEmail, title: vision.idea });
  const k2 = W.idempotencyKey({ token: "", kind: "vision", contactEmail: vision.contactEmail, title: vision.idea });
  eq(k1, k2, "derselbe Vision-Eingang erzeugt zwei Schluessel");
  ok(W.idempotencyKey({ token: "", kind: "vision", contactEmail: vision.contactEmail, title: "Andere Idee" }) !== k1,
    "eine andere Idee erzeugt denselben Schluessel");
}

// ── 19. Kundenseite: Snapshot ist eine Positivliste ────────────────────────
{
  // Ein Projekt mit allem, was NICHT hinaus darf.
  const project = {
    id: "prj_geheim", title: "Website Muster", pipelineStage: "build",
    deliveryType: "website", budget: 4500,
    previewUrl: "https://vorschau.muster.ch", adminUrl: "https://admin.muster.ch",
    client: { name: "Anna Muster", email: "anna@muster.ch", phone: "079 111 22 33" },
    ftContactLog: [{ text: "Kunde zahlt spät", at: NOW }],
    ftOfferAttachment: { kind: "vision", visionToken: "v".repeat(28) },
    ftVision: { idea: "geheim" },
    sourceInquiryId: "inq_1", sourceVisionId: "sub_1", ftRouteSource: "manuell",
    mailThreadIds: ["thread_1"],
  };
  const snap = W.buildClientSnapshot({
    project,
    company: { name: "FlowerTech", email: "hallo@flowertech.ch" },
    content: [{ title: "Angebot", body: "Text", enabled: true }],
    milestones: [{ title: "Entwurf", date: "2026-09-01", done: true, id: "ms_1" }],
    changes: [{ title: "Bild tauschen", status: "new", detail: "x", createdAt: NOW, id: "cr_1", taskId: "t_1" }],
    versions: [{ label: "Entwurf 1", at: NOW, approved: false, id: "v_1" }],
    costs: { accepted: 4500, invoiced: 2000, paid: 2000, open: 0 },
    now: NOW,
  });

  // Nichts Internes im gesamten Snapshot — rekursiv geprueft.
  const flat = JSON.stringify(snap);
  for (const key of W.CLIENT_SNAPSHOT_FORBIDDEN_KEYS) {
    ok(!new RegExp('"' + key + '"').test(flat), `verbotener Schluessel im Snapshot: ${key}`);
  }
  for (const secret of ["prj_geheim", "anna@muster.ch", "079 111 22 33", "Kunde zahlt spät",
    "inq_1", "sub_1", "thread_1", "v".repeat(28), "ms_1", "cr_1", "v_1", "t_1"]) {
    ok(!flat.includes(secret), `interne Angabe im Snapshot: ${secret}`);
  }

  // Was drin sein MUSS.
  eq(snap.title, "Website Muster", "der Projektname fehlt");
  eq(snap.stageLabel, "Umsetzung", "die Phase fehlt");
  eq(snap.stageSteps.length, 6, "der Phasenfortschritt ist unvollstaendig");
  ok(snap.stageSteps[3].current, "die aktuelle Phase ist nicht markiert");
  ok(snap.stageSteps[0].done && !snap.stageSteps[4].done, "der Fortschritt stimmt nicht");
  eq(snap.costs.agreed, 4500, "die vereinbarten Kosten fehlen");
  eq(snap.costs.paid, 2000, "der bezahlte Betrag fehlt");
  eq(snap.content.length, 1, "die Leistungsbeschreibung fehlt");
  eq(snap.milestones[0].title, "Entwurf", "die Termine fehlen");
  eq(snap.changes[0].statusLabel, "Neu", "der Änderungsstatus fehlt");
  eq(snap.versions[0].approved, false, "der Freigabestatus fehlt");
  eq(snap.previewUrl, "https://vorschau.muster.ch/", "die Vorschau-URL fehlt");
  eq(snap.adminUrl, "https://admin.muster.ch/", "der Admin-Link fehlt");
  eq(snap.closed, false, "ein laufender Vorgang gilt als geschlossen");
  eq(W.buildClientSnapshot({ project: { ftOutcome: "lost" } }).closed, true,
    "ein verlorener Vorgang wird nicht als geschlossen markiert");
}

// ── 20. URL-Pruefung: nur echte HTTPS-Adressen ─────────────────────────────
{
  for (const bad of ["", "muster.ch", "http://muster.ch", "javascript:alert(1)",
    "data:text/html,<h1>x", "ftp://muster.ch", "https://", "//muster.ch"]) {
    eq(W.clientSafeUrl(bad), "", `unsichere URL wird durchgelassen: ${bad}`);
    const snap = W.buildClientSnapshot({ project: { previewUrl: bad, adminUrl: bad } });
    eq(snap.previewUrl, "", `unsichere Vorschau-URL landet im Snapshot: ${bad}`);
    eq(snap.adminUrl, "", `unsicherer Admin-Link landet im Snapshot: ${bad}`);
  }
  ok(W.clientSafeUrl("https://muster.ch/pfad?a=1").startsWith("https://muster.ch/"),
    "eine gueltige HTTPS-Adresse wird verworfen");
}

// ── 21. Der Kundenlink zeigt auf flowertech.ch ─────────────────────────────
{
  const token = "t".repeat(28);
  eq(W.clientPortalUrl(token), "https://flowertech.ch/kunde.html?t=" + token,
    "der Kundenlink zeigt nicht auf flowertech.ch/kunde.html");
  ok(!W.clientPortalUrl(token).includes("management-xo2-pro"),
    "der neue Kundenlink zeigt weiterhin auf die Quantus-Domain");
  eq(W.clientPortalUrl("zu-kurz"), "", "ein ungueltiger Token erzeugt trotzdem einen Link");
  // Der alte Link bleibt fuer Bestandsprojekte erreichbar — keine Migration.
  ok(W.portalUrl("https://management-xo2-pro.netlify.app", token).includes("flowertech-kunde.html"),
    "der alte Kundenlink funktioniert nicht mehr");
}

// ── 22. Phasenfortschritt ──────────────────────────────────────────────────
{
  const p0 = W.clientStageProgress("lead");
  eq(p0.index, 0, "Lead steht nicht am Anfang");
  ok(p0.steps[0].current && !p0.steps[0].done, "die erste Phase ist falsch markiert");
  const p5 = W.clientStageProgress("approval");
  eq(p5.index, 5, "die Freigabe steht nicht am Ende");
  eq(p5.steps.filter((s) => s.done).length, 5, "der Fortschritt bis zur Freigabe stimmt nicht");
  // Altbestand bleibt darstellbar.
  eq(W.clientStageProgress("discovery").label, "Bestandesaufnahme", "alte Phasen brechen den Fortschritt");
}

console.log(`flowertech workflow dataflow: ok (${checks} Pruefungen)`);
