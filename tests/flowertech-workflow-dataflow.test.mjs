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
  ok(verguetung.body.includes("4'500.00"), "der Preis wird nicht eingesetzt");
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

console.log(`flowertech workflow dataflow: ok (${checks} Pruefungen)`);
