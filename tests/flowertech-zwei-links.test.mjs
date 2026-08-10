/*
 * FlowerTech — die ZWEI Links und die zwei Phasen.
 * ---------------------------------------------------------------------------
 * Der Ablauf wurde vorher vermischt: ein einziger „Kundenlink" trug Fragebogen
 * UND Vorschau, und ein Vision-Room-Beitrag legte ohne Antwort der Kundschaft
 * ein Projekt an. Dieser Test hält die Korrektur fest — nicht als Anzeige,
 * sondern als Verhalten:
 *
 *   PHASE 1 · Fragebogen-Link (fragebogen.html?e=…)
 *     · fragt alle Pflichtangaben ab, Vision Room inbegriffen
 *     · zeigt NIE Vorschau, Angebot, Vertrag oder AGB
 *     · erzeugt beim Absenden genau EIN Projekt und genau EINE Aufgabe
 *
 *   PHASE 2 · Kundenportal-Link (kunde.html?t=…)
 *     · existiert erst nach Vorschau, Leistung, Offerte, Vertrag, AGB
 *       UND einer ausdrücklichen Veröffentlichung
 *
 * Geprüft wird der Kern (reine Logik). Die Laufzeitseite — dass beim Absenden
 * wirklich genau ein Projekt entsteht und vorher kein Portal — steht in
 * flowertech-kundenanfrage.test.mjs und flowertech-topnav-runtime.test.mjs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CORE = (await import(path.join(root, "public/flowertech-workflow-core.js"))).default;

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

const NOW = "2026-08-09T10:00:00.000Z";
const TOKEN = "t".repeat(32);

/* ══ 1. Die Begriffe sind eindeutig ════════════════════════════════════════ */
{
  ok(CORE.LINK_LABELS.intake === "Fragebogen-Link", "der Link der Phase 1 heisst nicht „Fragebogen-Link“");
  ok(CORE.LINK_LABELS.intakeAlt === "Briefing-Link", "die zweite erlaubte Bezeichnung fehlt");
  ok(CORE.LINK_LABELS.portal === "Kundenportal-Link", "der Link der Phase 2 heisst nicht „Kundenportal-Link“");
  ok(CORE.LINK_LABELS.intakeHint === "Kundendaten & Vision Room – noch keine Vorschau",
    "der eindeutige Hilfetext der Phase 1 stimmt nicht");
  ok(CORE.LINK_LABELS.portalUnpublished === "Kundenportal – noch nicht veröffentlicht",
    "der interne Zustand der Phase 2 ist nicht benannt");

  // Die beiden Links sind verschiedene Seiten mit verschiedenen Tokenkreisen.
  const fragebogen = CORE.intakeFormUrl(TOKEN);
  const portal = CORE.clientPortalUrl(TOKEN);
  ok(fragebogen === "https://flowertech.ch/fragebogen.html?e=" + TOKEN,
    `der Fragebogen-Link stimmt nicht: ${fragebogen}`);
  ok(portal === "https://flowertech.ch/kunde.html?t=" + TOKEN, `der Portal-Link stimmt nicht: ${portal}`);
  ok(fragebogen !== portal, "beide Phasen zeigen auf dieselbe Seite");
}

/* ══ 2. Der Fragebogen fragt, was gebraucht wird ═══════════════════════════ */
{
  const deckung = CORE.intakeCoverage(CORE.DEFAULT_INTAKE_QUESTIONS);
  ok(deckung.complete, `der Standardfragebogen ist unvollständig: ${deckung.missing.join(", ")}`);

  const qs = CORE.normalizeIntakeQuestions(CORE.DEFAULT_INTAKE_QUESTIONS);
  const rollen = qs.map((q) => q.role);
  ["projectTitle", "contactName", "contactEmail", "contactPhone", "address",
   "currentUrl", "currentProvider", "currentPrice", "need", "budget", "deadline",
  ].forEach((rolle) => {
    ok(rollen.includes(rolle), `dem Fragebogen fehlt die Rolle ${rolle}`);
  });
  ["iststand", "pages", "features", "design", "content", "fragen"].forEach((key) => {
    ok(qs.some((q) => q.key === key), `dem Fragebogen fehlt die Frage ${key}`);
  });

  // Ein abgespeckter Fragebogen wird als unvollständig erkannt — die Warnung
  // ist datengetrieben, nicht ein Kommentar in der Oberfläche.
  const wenig = CORE.intakeCoverage([{ key: "a", label: "Ihr Name", type: "text", role: "contactName" }]);
  ok(!wenig.complete, "ein Fragebogen mit einer Frage gilt als vollständig");
  ok(wenig.missing.includes("Adresse") && wenig.missing.includes("Vision Room"),
    `die fehlenden Themen werden nicht benannt: ${wenig.missing.join(", ")}`);
}

/* ══ 3. Der Vision Room ist Teil desselben Briefings ═══════════════════════ */
{
  const qs = CORE.normalizeIntakeQuestions(CORE.DEFAULT_INTAKE_QUESTIONS);
  const vision = qs.filter((q) => q.vision);
  ok(vision.length === 2, `der Vision Room besteht aus ${vision.length} Fragen statt zwei`);
  ok(vision.some((q) => q.vision === "idea"), "die Vision-Idee fehlt");
  ok(vision.some((q) => q.vision === "features"), "die Vision-Funktionen fehlen");
  ok(vision.every((q) => qs.includes(q)), "die Vision-Fragen stehen ausserhalb des Fragebogens");

  // Die Antworten aus dem Vision Room sind ganz normale Antworten.
  const { answers } = CORE.normalizeIntakeAnswers(qs, {
    [CORE.VISION_QUESTION_KEYS.idea]: "Gäste reservieren direkt einen Tisch",
    [CORE.VISION_QUESTION_KEYS.features]: "Tischreservation\nSpeisekarte digital",
  }, { now: NOW });
  const v = CORE.visionFromAnswers(answers);
  ok(v.present, "die Vision-Antworten werden nicht erkannt");
  ok(v.idea.includes("Tisch"), "die Idee geht verloren");
  ok(v.features.length === 2, `es kommen ${v.features.length} Funktionen an statt zwei`);
}

/* ══ 4. Ein Absenden = ein Projekt, eine Aufgabe ═══════════════════════════ */
{
  const intake = { id: "int_1", title: "Ihre Angaben für FlowerTech" };
  const qs = CORE.normalizeIntakeQuestions(CORE.DEFAULT_INTAKE_QUESTIONS);
  const werte = {};
  qs.forEach((q) => {
    werte[q.key] = q.type === "date" ? "2026-10-01"
      : q.type === "email" ? "anna@beiz.ch"
      : q.type === "select" ? (q.options || [""])[0]
      : "Antwort " + q.key;
  });
  Object.assign(werte, {
    projekt: "Beiz AG", name: "Anna Muster", phone: "079 000 00 00",
    adresse: "Bahnhofstrasse 1, 8000 Zürich",
    "website-url": "https://alt.beiz.ch", anbieter: "Webagentur Muster",
    "bisheriger-preis": "1800", budget: "4200",
    need: "Mehr Reservationen ohne Telefon",
    design: "Warm, Holz, viel Bild",
    [CORE.VISION_QUESTION_KEYS.idea]: "Gäste reservieren direkt einen Tisch",
    [CORE.VISION_QUESTION_KEYS.features]: "Tischreservation\nSpeisekarte digital",
  });

  const { answers } = CORE.normalizeIntakeAnswers(qs, werte, { now: NOW });
  const pruefung = CORE.intakeAnswersUsable(qs, answers);
  ok(pruefung.usable, `die vollständige Antwort gilt als unbrauchbar: ${pruefung.missing.join(", ")}`);

  const project = CORE.projectFromIntake({ intake, answers, now: NOW });
  ok(project.title === "Beiz AG", `der Projektname stimmt nicht: ${project.title}`);
  ok(project.client.email === "anna@beiz.ch", "der Kontakt fehlt intern am Projekt");
  ok(project.client.street.includes("Bahnhofstrasse"), "die Adresse fehlt intern am Projekt");
  ok(project.ftCurrentUrl === "https://alt.beiz.ch", "die bisherige Website fehlt");
  ok(project.ftCurrentProvider === "Webagentur Muster", "der bisherige Anbieter fehlt");
  ok(project.currentProviderPrice === 1800, "der bisher bezahlte Preis fehlt");
  ok(project.budget === 4200, "der Budgetrahmen fehlt");
  ok(project.dueDate === "2026-10-01", "der Wunschtermin fehlt");
  ok(project.ftVision && project.ftVision.features.includes("Tischreservation"),
    "der Vision Room hängt nicht am selben Projekt");

  // GENAU eine Aufgabe, und sie heisst nach dem Vorgang.
  const doc = CORE.buildIntakeDocument({ intake, answers, now: NOW });
  const task = CORE.buildIntakeTask({ project, document: doc, projectId: "prj_1", now: NOW });
  ok(!Array.isArray(task), "aus einem Fragebogen entsteht eine Liste von Aufgaben");
  ok(/^Offertenanfrage/.test(task.title), `die Aufgabe heisst nicht „Offertenanfrage“: ${task.title}`);
  ok(task.projectId === "prj_1", "die Aufgabe hängt nicht am Projekt");
  ok(task.category === "flowertech" && task.status === "todo", "es ist keine normale Quantus-Aufgabe");

  /* ── Der Prompt ist vollständig ──────────────────────────────────────── */
  const prompt = CORE.buildProjectPrompt({ project, document: doc, now: NOW });
  [
    "https://alt.beiz.ch",            // Ist-Website
    "Webagentur Muster",              // bisheriger Anbieter
    "CHF 1800.00",                    // bisher bezahlter Preis
    "CHF 4200.00",                    // Budgetrahmen
    "2026-10-01",                     // Termin
    "Mehr Reservationen",             // Ziel
    "Warm, Holz",                     // Stil
    "Tischreservation",               // Vision Room
    "Vision Room",                    // eigener Abschnitt
  ].forEach((teil) => ok(prompt.includes(teil), `im Prompt fehlt: ${teil}`));

  // Kontaktdaten bleiben intern, solange ich sie nicht ausdrücklich freigebe.
  ok(!prompt.includes("anna@beiz.ch"), "die E-Mail steht ungefragt im Code-Prompt");
  ok(!prompt.includes("Bahnhofstrasse"), "die Adresse steht ungefragt im Code-Prompt");
  ok(!prompt.includes("079 000 00 00"), "die Telefonnummer steht ungefragt im Code-Prompt");
  ok(prompt.includes("(intern hinterlegt)"), "die Kontaktfelder werden nicht als intern ausgewiesen");

  // Mit ausdrücklicher Wahl gehen sie mit — und nur dann.
  const mitKontakt = CORE.buildProjectPrompt({ project, document: doc, now: NOW, includeContact: true });
  ok(mitKontakt.includes("anna@beiz.ch"), "die ausdrückliche Wahl bringt die Kontaktdaten nicht mit");
  ok(mitKontakt.includes("Bahnhofstrasse"), "die Adresse fehlt trotz ausdrücklicher Wahl");
  ok(/nicht auf der Website veröffentlichen/.test(mitKontakt),
    "die Kontaktdaten sind im Prompt nicht als intern gekennzeichnet");
}

/* ══ 5. Beide Antwortformen laufen zusammen ═══════════════════════════════ */
// Der Fragebogen sendet eine LISTE, n8n eine ZUORDNUNG. Vorher kam die Liste
// serverseitig als „unvollständig" zurück — eine korrekt ausgefüllte
// Einreichung wurde abgewiesen und es entstand nie ein Projekt.
{
  const qs = CORE.normalizeIntakeQuestions([
    { key: "name", label: "Ihr Name", type: "text", role: "contactName", required: true },
    { key: "email", label: "E-Mail", type: "email", role: "contactEmail", required: true },
  ]);
  const liste = CORE.normalizeIntakeAnswers(qs, {
    answers: [{ key: "name", answer: "Anna" }, { key: "email", answer: "anna@beiz.ch" }],
  }, { now: NOW });
  ok(CORE.intakeAnswersUsable(qs, liste.answers).usable,
    "die Antwortliste des Fragebogens gilt als unvollständig");
  ok(CORE.answerByRole(liste.answers, "contactName") === "Anna", "die Liste kommt nicht an");

  const map = CORE.normalizeIntakeAnswers(qs, { name: "Anna", email: "anna@beiz.ch" }, { now: NOW });
  ok(CORE.intakeAnswersUsable(qs, map.answers).usable, "die Zuordnungsform gilt als unvollständig");

  // Was nicht gefragt wurde, kommt weiterhin nicht durch.
  const fremd = CORE.normalizeIntakeAnswers(qs, {
    answers: [{ key: "name", answer: "Anna" }, { key: "email", answer: "anna@beiz.ch" },
              { key: "geheim", answer: "untergeschoben" }],
  }, { now: NOW });
  ok(!JSON.stringify(fremd.answers).includes("untergeschoben"),
    "eine nicht gestellte Frage wird beantwortet");
}

/* ══ 6. Phase 2: das Portal ist eine Entscheidung ══════════════════════════ */
{
  const leer = CORE.portalReleaseState({});
  ok(!leer.ready, "ein leeres Kundenportal gilt als vollständig");
  ok(!leer.published, "ein leeres Kundenportal gilt als veröffentlicht");
  ok(leer.label === CORE.LINK_LABELS.portalUnpublished,
    "vor der Freigabe trägt der Zugang die falsche Beschriftung");
  ok(leer.missing.length === 5, `es werden ${leer.missing.length} von 5 fehlenden Punkten benannt`);

  // Jede einzelne Lücke blockiert — es gibt keine „fast fertige" Freigabe.
  const alle = { hasPreview: true, hasService: true, hasOffer: true, hasContract: true, hasTerms: true };
  ["hasPreview", "hasService", "hasOffer", "hasContract", "hasTerms"].forEach((key) => {
    const ohne = CORE.portalReleaseState(Object.assign({}, alle, { [key]: false, released: true }));
    ok(!ohne.ready && !ohne.published, `ohne ${key} liesse sich das Kundenportal veröffentlichen`);
  });

  // Vollständig, aber nicht freigegeben: weiterhin kein Kundenportal-Link.
  const bereit = CORE.portalReleaseState(Object.assign({}, alle));
  ok(bereit.ready, "die Vollständigkeit wird nicht erkannt");
  ok(!bereit.published, "vollständig gilt bereits als veröffentlicht");
  ok(bereit.label === CORE.LINK_LABELS.portalUnpublished,
    "ein vorbereiteter Zugang wird bereits als Kundenportal-Link ausgegeben");
  ok(/vorbereitet/.test(bereit.reason), `der Zustand wird nicht erklärt: ${bereit.reason}`);

  const offen = CORE.portalReleaseState(Object.assign({}, alle, { released: true, releasedAt: NOW }));
  ok(offen.published && offen.label === CORE.LINK_LABELS.portal,
    "nach der Freigabe fehlt der Kundenportal-Link");
  ok(offen.releasedAt === NOW, "der Zeitpunkt der Freigabe fehlt");
}

/* ══ 7. Der Snapshot weist seine Freigabe aus ══════════════════════════════ */
{
  const basis = {
    project: { title: "Beiz-Website", pipelineStage: "build", client: { email: "anna@beiz.ch" } },
    previewHtml: "<h1>Entwurf</h1>", now: NOW,
  };
  const ohne = CORE.buildClientSnapshot(Object.assign({}, basis, {
    release: CORE.portalReleaseState({}),
  }));
  ok(ohne.published === false, "ein unfreigegebener Snapshot weist sich als veröffentlicht aus");

  const mit = CORE.buildClientSnapshot(Object.assign({}, basis, {
    release: CORE.portalReleaseState({
      hasPreview: true, hasService: true, hasOffer: true, hasContract: true, hasTerms: true,
      released: true, releasedAt: NOW,
    }),
  }));
  ok(mit.published === true, "ein freigegebener Snapshot weist sich nicht als veröffentlicht aus");
  ok(mit.releasedAt === NOW, "der Freigabezeitpunkt fehlt im Snapshot");

  // Und weiterhin: nichts Internes im Snapshot.
  const roh = JSON.stringify(mit);
  ok(!roh.includes("anna@beiz.ch"), "die Mailadresse der Kundschaft wandert in den Snapshot");
  CORE.CLIENT_SNAPSHOT_FORBIDDEN_KEYS.forEach((key) => {
    ok(!Object.prototype.hasOwnProperty.call(mit, key), `der Snapshot trägt das verbotene Feld ${key}`);
  });
}

/* ══ 8. AGB-Zustimmung ist versioniert ═════════════════════════════════════ */
{
  const terms = { title: "AGB", version: "2" };
  const ohne = CORE.termsState({ terms, consent: null });
  ok(!ohne.accepted && !ohne.outdated, "ohne Zustimmung gilt bereits etwas als zugestimmt");
  ok(ohne.version === "2", "die Fassung wird nicht ausgewiesen");

  const passend = CORE.termsState({ terms, consent: { version: "2", acceptedAt: NOW } });
  ok(passend.accepted, "eine Zustimmung zur aktuellen Fassung zählt nicht");
  ok(passend.acceptedAt === NOW, "der Zeitpunkt der Zustimmung fehlt");
  ok(!passend.outdated, "eine gültige Zustimmung gilt als veraltet");

  // Der Kern der Versionierung: eine geänderte Fassung braucht eine NEUE
  // Zustimmung — die alte gilt sichtbar als veraltet, nicht stillschweigend
  // weiter.
  const geaendert = CORE.termsState({ terms: { title: "AGB", version: "3" },
    consent: { version: "2", acceptedAt: NOW } });
  ok(!geaendert.accepted, "die Zustimmung zur alten Fassung gilt für die neue weiter");
  ok(geaendert.outdated, "die veraltete Zustimmung wird nicht als solche erkannt");
  ok(geaendert.acceptedAt === "", "eine veraltete Zustimmung trägt weiterhin einen Zeitpunkt");

  // Im Snapshot steht derselbe Zustand — die Kundenseite erfindet nichts.
  const snapshot = CORE.buildClientSnapshot({
    project: { title: "X" },
    terms: { title: "AGB", version: "3", body: "Text der Fassung 3" },
    consent: { version: "2", acceptedAt: NOW },
    now: NOW,
  });
  ok(snapshot.terms.version === "3", "im Portal steht die falsche Fassung");
  ok(snapshot.terms.accepted === false, "im Portal gilt die alte Zustimmung weiter");
  ok(snapshot.terms.outdated === true, "im Portal fehlt der Hinweis auf die geänderte Fassung");
}

/* ══ 9. Der öffentliche Vision Room erzeugt eine Anfrage ═══════════════════ */
{
  const anfrage = CORE.inquiryFromVision({
    idea: "Eine App für die Vereinskasse", features: ["Login", "Beitragsliste"],
    email: "Verein@Muster.CH", type: "Web-App",
  }, { now: NOW, id: "ftq_1" });

  ok(CORE.inquiryFromVisionIsUsable(anfrage), "eine brauchbare Vision-Anfrage wird abgewiesen");
  ok(anfrage.email === "verein@muster.ch", "die E-Mail wird nicht normalisiert");
  ok(anfrage.message.includes("Vereinskasse"), "die Idee fehlt in der Anfrage");
  ok(anfrage.message.includes("Beitragsliste"), "die Funktionen fehlen in der Anfrage");
  ok(anfrage.service === "Web-App", "die Art fehlt");
  ok(anfrage.status === "new", "die Anfrage startet nicht als neu");

  // Es ist eine Anfrage, KEIN Projekt: kein Vorgang, keine Phase, keine Route.
  ok(!anfrage.projectId, "die Anfrage trägt bereits ein Projekt");
  ok(!anfrage.pipelineStage && !anfrage.ftRoute, "die Anfrage ist bereits ein Vorgang");
  ok(CORE.inquiryIsOpen(anfrage), "die frische Anfrage gilt nicht als offen");

  // Ohne Rückkanal keine Anfrage — sie wäre nicht beantwortbar.
  ok(!CORE.inquiryFromVisionIsUsable(CORE.inquiryFromVision({ idea: "Etwas" }, { now: NOW })),
    "eine Anfrage ohne Rückkanal wird angenommen");
  ok(!CORE.inquiryFromVisionIsUsable(CORE.inquiryFromVision({ email: "a@b.ch" }, { now: NOW })),
    "eine leere Anfrage wird angenommen");

  // Der nächste Schritt heisst Fragebogen-Link — nicht „Projekt anlegen".
  const schritte = CORE.nextProcessSteps({ inquiries: [anfrage] });
  const schritt = schritte.find((s) => s.key === "inquiry");
  ok(schritt, "eine offene Anfrage taucht nicht in den nächsten Schritten auf");
  ok(schritt.label === "Fragebogen-Link schicken", `der Schritt heisst: ${schritt.label}`);
  ok(/Vision Room – noch keine Vorschau/.test(schritt.hint),
    `der Schritt erklärt den Link nicht eindeutig: ${schritt.hint}`);
}

/* ══ 10. Die Seiten halten die Trennung ein ════════════════════════════════ */
// Zweites Repo, aber derselbe Vertrag — deshalb hier mitgeprüft, sofern der
// Klon vorhanden ist.
{
  const kandidaten = ["/workspace/flowertech", path.join(path.dirname(root), "flowertech")];
  const ft = kandidaten.find((dir) => fs.existsSync(path.join(dir, "fragebogen.html")));
  if (ft) {
    const fragebogen = fs.readFileSync(path.join(ft, "fragebogen.html"), "utf8");
    const kunde = fs.readFileSync(path.join(ft, "kunde.html"), "utf8");

    // Phase 1 zeigt NICHTS aus Phase 2.
    ok(/kind: "intake"|kind: 'intake'/.test(fragebogen), "der Fragebogen sendet die falsche Art");
    ok(!/clientPortals/.test(fragebogen), "der Fragebogen liest den Kundenportal-Snapshot");
    [/Vorschau/, /Änderungswunsch/, /Offerte/, /Vertrag/, /\bAGB\b/].forEach((re) => {
      ok(!re.test(fragebogen), `der Fragebogen zeigt Inhalte der Phase 2: ${re}`);
    });

    // Der Vision Room steht IM Fragebogen und wird mit ihm abgeschickt.
    ok(/id="visionRoom"/.test(fragebogen), "der Vision Room fehlt im Fragebogen");
    ok(/q\.vision === "idea"/.test(fragebogen) && /q\.vision === "features"/.test(fragebogen),
      "der Vision Room ist nicht an die Fragen des Fragebogens gebunden");
    const sendungen = (fragebogen.match(/fetch\(/g) || []).length;
    ok(sendungen === 2, `der Fragebogen sendet an ${sendungen} Stellen statt zweimal (laden + senden)`);

    // Phase 2 zeigt nichts ohne Freigabe.
    ok(/data\.published === false/.test(kunde),
      "die Kundenseite zeigt einen nicht freigegebenen Vorgang");
    ok(/clientPortals/.test(kunde), "die Kundenseite liest den Snapshot nicht");
    ok(!/intakeForms/.test(kunde), "die Kundenseite liest den Fragebogen");
  }
}

/* ══ 9. Auch eine Offerte OHNE Projekt kennt nur diese zwei Links ══════════
   Der Fragebogen-Link steht ihr offen — der Kundenportal-Link nicht. Die
   ausführliche Absicherung des Ablaufs steht in
   tests/flowertech-offerte-ohne-projekt.test.mjs. */
{
  const frei = { id: "of_1", projectId: null };
  const zustaende = [
    CORE.offerBriefingLinkState({ offer: frei, intake: null }),
    CORE.offerBriefingLinkState({ offer: frei, intake: { inviteToken: TOKEN } }),
    CORE.offerBriefingLinkState({ offer: frei, intake: { inviteToken: TOKEN, projectId: "prj_1" } }),
    CORE.offerBriefingLinkState({ offer: { id: "of_2", projectId: "prj_1" }, intake: null }),
  ];
  zustaende.forEach((state) => {
    ok(state.hint === CORE.LINK_LABELS.intakeHint, `dem Zustand ${state.mode} fehlt der Hilfetext der Phase 1`);
    ok(!String(state.url || "").includes("kunde.html"),
      `der Zustand ${state.mode} bietet die Kundenseite als Fragebogen an`);
    ok(!/Kundenportal-Link/.test(state.explain),
      `der Zustand ${state.mode} verspricht den Link der Phase 2`);
  });
  ok(zustaende[0].label === CORE.LINK_LABELS.intakeCreate && zustaende[0].url === "",
    "ohne Fragebogen wird trotzdem ein Link angeboten");
  ok(zustaende[1].url === CORE.intakeFormUrl(TOKEN),
    "der Link der Offerte ohne Projekt ist nicht der Fragebogen-Link");
}

console.log(`flowertech zwei links: ok (${checks} Pruefungen)`);
