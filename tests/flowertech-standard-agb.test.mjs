#!/usr/bin/env node
/**
 * Die zentrale FlowerTech-Standard-AGB.
 *
 * Worum es geht: Es darf GENAU EINE Fassung geben. Sie steht im Code, nicht
 * in den Projektdaten, und sie erscheint Zeichen für Zeichen gleich
 *
 *   • auf jedem Kundenlink (tiles.terms),
 *   • im Kundenportal (buildClientSnapshot.terms),
 *   • in jedem erzeugten Projekt-Prompt (geschützter Abschnitt).
 *
 * Dazu die zweite Hälfte des Auftrags: die unverbindliche TEST-Leistungs-
 * kachel. Sie ist die ausdrückliche Ausnahme und darf den Offertenweg nicht
 * anfassen — kein Betrag, kein Versand, keine Rechnung, und nur nach
 * ausdrücklicher, widerrufbarer Freigabe.
 *
 * Aufruf:  node tests/flowertech-standard-agb.test.mjs
 */
import assert from "node:assert/strict";
import * as C from "../public/flowertech-workflow-core.js";

let geprueft = 0;
const pruefe = (name, fn) => { fn(); geprueft += 1; void name; };

/* ── Die Fassung selbst ─────────────────────────────────────────────────── */

pruefe("Fassung, Titel und Prüfhinweis stehen und sind als Entwurf erkennbar", () => {
  const t = C.standardTerms();
  assert.equal(t.version, "0.1-test");
  assert.equal(t.title, "FlowerTech Standard-AGB");
  assert.equal(t.editable, false);
  // Der Hinweis muss die drei Dinge sagen, auf die es ankommt: Test, Version,
  // rechtliche Freigabe steht aus.
  assert.match(t.notice, /Test-\/Entwurfsversion 0\.1/);
  assert.match(t.notice, /rechtlich freigeben/);
  assert.ok(t.sections.length >= 15, "zu wenige Abschnitte: " + t.sections.length);
});

pruefe("Schweizer Schreibweise: kein ß, aber echte Umlaute", () => {
  const text = C.standardTermsText();
  assert.ok(!/ß/.test(text), "Der Text enthält ß");
  assert.ok(/[äöüÄÖÜ]/.test(text), "Der Text hat keine echten Umlaute");
  // Keine ae/oe/ue-Krücken — das wäre nicht „gut lesbar".
  assert.ok(!/\b(fuer|ueber|moeglich|gueltig|Geschaeftsbedingungen)\b/.test(text),
    "Der Text benutzt ae/oe/ue statt Umlauten");
});

pruefe("Es wird keine rechtliche Verbindlichkeit zugesichert", () => {
  const text = C.standardTermsText().toLowerCase();
  assert.ok(text.includes("keine rechtsberatung"));
  assert.ok(text.includes("keine rechtliche verbindlichkeit"));
  // Kein Versprechen, das eine ungeprüfte Fassung nicht halten kann.
  assert.ok(!/rechtlich gepr(ü|ue)ft und freigegeben/.test(text));
});

pruefe("Die Fassung ist eingefroren — nichts kann sie überschreiben", () => {
  const t = C.standardTerms();
  assert.ok(Object.isFrozen(t) && Object.isFrozen(t.sections) && Object.isFrozen(t.sections[0]));
  const vorher = t.sections[0].body;
  try { t.sections[0].body = "gekapert"; } catch (e) { /* strict mode wirft — auch recht */ }
  try { t.version = "9"; } catch (e) { /* dito */ }
  assert.equal(t.sections[0].body, vorher);
  assert.equal(C.standardTerms().version, "0.1-test");
});

pruefe("Kein Platzhalter — kein Projekt kann Text einschleusen", () => {
  assert.ok(!/\{\{/.test(C.standardTermsText()), "Die AGB enthalten eine Variable");
});

/* ── Überall dieselbe Fassung ───────────────────────────────────────────── */

const PROJEKT_A = {
  id: "p-a", title: "Projekt A", previewUrl: "https://a.example.ch/",
  client: { company: "A AG", name: "Anna A", email: "anna@a.example.ch" },
};
const PROJEKT_B = {
  id: "p-b", title: "Projekt B", previewUrl: "https://b.example.ch/",
  client: { company: "B GmbH", name: "Bea B", email: "bea@b.example.ch" },
};
const INTAKE = (token) => ({ inviteToken: token, title: "Bogen", questions: [{ key: "q", label: "Frage" }] });
const TOKEN_A = "a".repeat(32);
const TOKEN_B = "b".repeat(32);

pruefe("Zwei verschiedene Projekte liefern denselben AGB-Wortlaut", () => {
  const a = C.customerAreaSnapshot({ intake: INTAKE(TOKEN_A), project: PROJEKT_A });
  const b = C.customerAreaSnapshot({ intake: INTAKE(TOKEN_B), project: PROJEKT_B });
  assert.ok(a.tiles.terms, "Projekt A hat keine AGB-Kachel");
  assert.ok(b.tiles.terms, "Projekt B hat keine AGB-Kachel");
  assert.deepEqual(a.tiles.terms, b.tiles.terms);
  assert.equal(a.tiles.terms.version, "0.1-test");
  assert.equal(a.tiles.terms.editable, false);
});

pruefe("Auch ohne Projekt trägt jede gültige Einladung die AGB", () => {
  const ohne = C.customerAreaSnapshot({ intake: INTAKE(TOKEN_A), project: null });
  assert.ok(ohne.tiles.terms);
  assert.equal(ohne.tiles.terms.version, "0.1-test");
});

pruefe("Kundenlink, Kundenportal und Prompt tragen denselben Wortlaut", () => {
  const kachel = C.standardTermsTile();
  const ausKachel = kachel.sections.map((s) => s.title + "\n" + s.body).join("\n\n");
  const portal = C.buildClientSnapshot({ project: PROJEKT_A, terms: {}, consent: null });
  const prompt = C.buildClaudePrompt({ project: PROJEKT_A }, {}, { mode: "implement" });

  C.standardTerms().sections.forEach((sec) => {
    assert.ok(ausKachel.includes(sec.body), "Kachel: Abschnitt fehlt — " + sec.title);
    assert.ok(portal.terms.body.includes(sec.body), "Portal: Abschnitt fehlt — " + sec.title);
    assert.ok(prompt.includes(sec.body), "Prompt: Abschnitt fehlt — " + sec.title);
  });
  assert.equal(portal.terms.version, kachel.version);
  assert.equal(portal.terms.editable, false);
  assert.ok(prompt.includes("Fassung " + kachel.version));
});

pruefe("Der Prompt-Abschnitt ist als geschützt und zentral markiert", () => {
  const prompt = C.buildClaudePrompt({ project: PROJEKT_A }, {}, { mode: "demo" });
  assert.ok(prompt.includes(C.STANDARD_TERMS_PROMPT_HEADING));
  assert.match(prompt, /nicht projektweise ändern/i);
  assert.match(prompt, /Fingerabdruck [0-9a-f]{16}/);
});

pruefe("Die AGB stehen in JEDEM Prompt-Modus und bei jedem Datenschalter", () => {
  const modi = C.PROMPT_MODES.map((m) => m.key);
  assert.ok(modi.length >= 2);
  const schalter = [{}, { client: true, briefing: true, tech: true, changes: true, prices: true, internal: true }];
  modi.forEach((mode) => {
    schalter.forEach((include) => {
      const p = C.buildClaudePrompt({ project: PROJEKT_A, briefing: {}, changeRequests: [], notes: [] },
        include, { mode });
      assert.ok(p.includes(C.STANDARD_TERMS_PROMPT_HEADING), "AGB fehlen im Modus " + mode);
      assert.ok(p.includes("19. Schlussbestimmungen"), "AGB unvollständig im Modus " + mode);
    });
  });
});

/* ── Nicht überschreibbar ───────────────────────────────────────────────── */

pruefe("Kundeneingaben und Projektdaten können die AGB nicht überschreiben", () => {
  // Ein Projekt, das mit aller Kraft versucht, eigene AGB unterzuschieben.
  const boese = Object.assign({}, PROJEKT_A, {
    terms: { title: "Gekaperte AGB", version: "999", body: "Alles erlaubt." },
    tiles: { terms: { label: "Gefälscht", sections: [{ title: "X", body: "Y" }] } },
  });
  const snap = C.customerAreaSnapshot({
    intake: Object.assign(INTAKE(TOKEN_A), { terms: { body: "Auch gefälscht" } }),
    project: boese,
  });
  assert.equal(snap.tiles.terms.version, "0.1-test");
  assert.equal(snap.tiles.terms.label, "FlowerTech Standard-AGB");
  assert.ok(!JSON.stringify(snap.tiles.terms).includes("Gekapert"));
  assert.ok(!JSON.stringify(snap.tiles.terms).includes("Alles erlaubt"));

  // Dasselbe fürs Portal: `terms` wird nur noch für die Zustimmung gelesen.
  const portal = C.buildClientSnapshot({
    project: PROJEKT_A,
    terms: { title: "Gekapert", version: "999", body: "Alles erlaubt." },
    consent: null,
  });
  assert.equal(portal.terms.version, "0.1-test");
  assert.equal(portal.terms.title, "FlowerTech Standard-AGB");
  assert.ok(!portal.terms.body.includes("Alles erlaubt"));
});

pruefe("buildLegalDraft liefert für AGB die zentrale, nicht bearbeitbare Fassung", () => {
  const doc = C.buildLegalDraft("agb", { project: PROJEKT_A });
  assert.equal(doc.editable, false);
  assert.equal(doc.version, "0.1-test");
  assert.equal(doc.scope, "standard");
  assert.equal(doc.sections.length, C.standardTerms().sections.length);
  doc.sections.forEach((s) => assert.equal(s.editable, false));
  // Datenschutz bleibt ein bearbeitbarer Entwurf — der Auftrag betraf die AGB.
  const privacy = C.buildLegalDraft("privacy", { project: PROJEKT_A });
  assert.notEqual(privacy.editable, false);
});

pruefe("Die Zustimmung hängt an der zentralen Fassung, nicht an einer Projektfassung", () => {
  const alt = C.termsState({ terms: { version: "1-2020-01-01" }, consent: { acceptedAt: "2026-01-01T00:00:00Z", version: "1-2020-01-01" } });
  assert.equal(alt.version, "0.1-test");
  assert.equal(alt.accepted, false, "Eine Zustimmung zu einer Projektfassung darf nicht zählen");
  assert.equal(alt.outdated, true);
  const neu = C.termsState({ terms: {}, consent: { acceptedAt: "2026-08-10T00:00:00Z", version: "0.1-test" } });
  assert.equal(neu.accepted, true);
});

/* ── Keine Kundendatenlecks ─────────────────────────────────────────────── */

pruefe("Der Kundenlink verrät weder Projekt-ID noch Kontakt, Notizen oder Token", () => {
  const projekt = Object.assign({}, PROJEKT_A, {
    adminUrl: "https://admin.example.ch/",
    ftCustomerPreview: { released: true, releasedAt: "2026-08-10T00:00:00Z" },
    ftCustomerAdmin: { released: true, releasedAt: "2026-08-10T00:00:00Z" },
    ftContactLog: [{ text: "interne Notiz: Kunde zahlt spät" }],
    notesInternal: "geheime Notiz",
    portalToken: "p".repeat(32),
    budgetInternal: 12345,
  });
  const snap = C.customerAreaSnapshot({
    intake: INTAKE(TOKEN_A), project: projekt,
    prompt: { text: "irgendein Prompt" },
  });
  const roh = JSON.stringify(snap);
  [
    "p-a", "anna@a.example.ch", "Anna A", "A AG",
    "interne Notiz", "geheime Notiz", "12345",
    TOKEN_A, "p".repeat(32), "irgendein Prompt",
  ].forEach((verboten) => {
    assert.ok(!roh.includes(verboten), "Der Kundenlink verrät: " + verboten);
  });
  // Und die verbotenen Schlüssel, die der Kern schon länger führt.
  C.CLIENT_SNAPSHOT_FORBIDDEN_KEYS.forEach((key) => {
    assert.ok(!Object.prototype.hasOwnProperty.call(snap, key), "Verbotener Schlüssel: " + key);
  });
});

pruefe("Die AGB-Kachel selbst trägt keinen Projektbezug", () => {
  const kachel = C.standardTermsTile();
  const roh = JSON.stringify(kachel);
  ["projectId", "token", "client", "email", "@"].forEach((verboten) => {
    assert.ok(!roh.includes(verboten), "Die AGB-Kachel enthält: " + verboten);
  });
});

/* ── Die TEST-Leistungskachel ───────────────────────────────────────────── */

const TEST_TILE = {
  title: "Website-Neukonzept Beispiel*CH",
  summary: "Unverbindlicher Vorschlag zum Anschauen.",
  currentUrl: "https://bestehend.example.ch/index.php",
  previewUrl: "https://vorschau.example.ch/",
};

pruefe("Ohne ausdrückliche Freigabe gibt es die Kachel nicht", () => {
  assert.equal(C.customerTestServiceTile({ project: {} }), null);
  assert.equal(C.customerTestServiceTile({ project: { ftTestServiceTile: TEST_TILE } }), null);
  assert.equal(C.customerTestServiceTile({
    project: { ftTestServiceTile: Object.assign({}, TEST_TILE, { released: false }) },
  }), null);
  // „truthy" genügt nicht — es muss genau true sein.
  ["ja", 1, "true", {}].forEach((wert) => {
    assert.equal(C.customerTestServiceTile({
      project: { ftTestServiceTile: Object.assign({}, TEST_TILE, { released: wert }) },
    }), null, "released=" + JSON.stringify(wert) + " hat die Kachel gezeigt");
  });
});

pruefe("Freigegeben zeigt sie Titel und Kostenstand — und ist als TEST markiert", () => {
  const tile = C.customerTestServiceTile({
    project: { ftTestServiceTile: Object.assign({}, TEST_TILE, { released: true, releasedAt: "2026-08-10T09:00:00Z" }) },
  });
  assert.ok(tile);
  assert.equal(tile.test, true);
  assert.equal(tile.binding, false);
  assert.match(tile.label, /TEST/);
  assert.equal(tile.title, TEST_TILE.title);
  assert.equal(tile.costStatus, "Kosten noch offen — keine verbindliche Preisangabe");
  assert.match(tile.notice, /keine Offerte/i);
  assert.match(tile.notice, /keine Rechnung/i);
});

pruefe("Sie zeigt NIE einen Betrag — auch keine Null", () => {
  const tile = C.customerTestServiceTile({
    project: {
      ftTestServiceTile: Object.assign({}, TEST_TILE, {
        released: true,
        // Selbst wenn jemand Beträge hineinschreibt: sie dürfen nicht hinaus.
        amount: 0, total: 0, currency: "CHF", price: "0.00", status: "sent", sentAt: "2026-08-10T00:00:00Z",
      }),
    },
  });
  C.TEST_SERVICE_FORBIDDEN_KEYS.forEach((key) => {
    assert.ok(!Object.prototype.hasOwnProperty.call(tile, key),
      "Die Test-Kachel trägt das verbotene Feld " + key);
  });
  const roh = JSON.stringify(tile);
  assert.ok(!/CHF/.test(roh), "Die Test-Kachel nennt eine Währung");
  assert.ok(!/0\.00/.test(roh), "Die Test-Kachel zeigt 0.00");
  // Der Kostenstand ist ein Satz, keine Zahl.
  assert.equal(typeof tile.costStatus, "string");
});

pruefe("Sie akzeptiert nur HTTPS-Adressen", () => {
  const tile = C.customerTestServiceTile({
    project: {
      ftTestServiceTile: {
        released: true, title: "T",
        currentUrl: "http://unsicher.example.ch/", previewUrl: "javascript:alert(1)",
      },
    },
  });
  assert.equal(tile.currentUrl, "");
  assert.equal(tile.previewUrl, "");
});

pruefe("Der Widerruf lässt sie sofort verschwinden", () => {
  const projekt = { id: "p", ftTestServiceTile: Object.assign({}, TEST_TILE, { released: true }) };
  let snap = C.customerAreaSnapshot({ intake: INTAKE(TOKEN_A), project: projekt });
  assert.ok(snap.tiles.testService);
  projekt.ftTestServiceTile = Object.assign({}, projekt.ftTestServiceTile, { released: false, releasedAt: "" });
  snap = C.customerAreaSnapshot({ intake: INTAKE(TOKEN_A), project: projekt });
  assert.equal(snap.tiles.testService, null);
});

/* ── Der normale Offertenweg bleibt unangetastet ────────────────────────── */

pruefe("Ein Offerten-ENTWURF bleibt unsichtbar — auch neben einer Test-Kachel", () => {
  const entwurf = { id: "o1", status: "draft", title: "Entwurf", number: "A-1" };
  const snap = C.customerAreaSnapshot({
    intake: INTAKE(TOKEN_A),
    project: { id: "p", ftTestServiceTile: Object.assign({}, TEST_TILE, { released: true }) },
    offers: [entwurf], offerAmount: 4200,
  });
  assert.equal(snap.tiles.offer, null, "Ein Entwurf ist sichtbar geworden");
  assert.ok(snap.tiles.testService, "Die Test-Kachel fehlt");
});

pruefe("Eine WIRKLICH versendete Offerte erscheint weiterhin mit Betrag", () => {
  const versendet = { id: "o2", status: "sent", sentAt: "2026-08-01T10:00:00Z", number: "A-2", title: "Offerte" };
  const snap = C.customerAreaSnapshot({
    intake: INTAKE(TOKEN_A), project: { id: "p" },
    offers: [versendet], offerAmount: 4200,
  });
  assert.ok(snap.tiles.offer);
  assert.equal(snap.tiles.offer.amount, 4200);
  assert.equal(snap.tiles.offer.currency, "CHF");
  assert.equal(snap.tiles.offer.status, "sent");
});

pruefe("Die Test-Kachel verändert die Stufe des Kundenbereichs nicht", () => {
  const ohne = C.customerAreaSnapshot({ intake: INTAKE(TOKEN_A), project: { id: "p" } });
  const mit = C.customerAreaSnapshot({
    intake: INTAKE(TOKEN_A),
    project: { id: "p", ftTestServiceTile: Object.assign({}, TEST_TILE, { released: true }) },
  });
  assert.equal(mit.stage, ohne.stage, "Die Test-Kachel hat die Stufe verschoben");
});

console.log(
  `Standard-AGB: ${geprueft} Prüfungen.\n` +
  `  Fassung ${C.standardTerms().version} · ${C.standardTerms().sections.length} Abschnitte · ` +
  `Fingerabdruck ${C.standardTermsFingerprint()}\n` +
  "  gleich auf Kundenlink, im Portal und in jedem Prompt-Modus; eingefroren und\n" +
  "  nicht durch Projekt- oder Kundendaten überschreibbar.\n" +
  "  TEST-Kachel: nur nach ausdrücklicher Freigabe, ohne Betrag und ohne Währung,\n" +
  "  HTTPS-only, widerrufbar — der echte Offertenweg bleibt unverändert."
);

/* ══ Der EINE Kundenlink: die vollständige, mitwachsende Kundensicht ══════
 *
 * Vorgabe: Auf genau einer Adresse erscheint alles, und zwar in dem Mass, in
 * dem das Projekt wächst — Fragebogen samt Vision Room, Vorschau, Offerte
 * (erst Test, später echt), zentrale AGB, Vertrag und später Verwaltung und
 * Änderungswünsche. Kein zweiter Link, keine internen Daten.
 * ---------------------------------------------------------------------- */

const VOLL = {
  id: "prj_lehner", title: "Testprojekt",
  previewUrl: "https://vorschau.example.ch/",
  adminUrl: "https://verwaltung.example.ch/",
  ftCustomerPreview: { released: true, releasedAt: "2026-08-10T08:00:00Z" },
  ftCustomerAdmin: { released: true, releasedAt: "2026-08-10T08:00:00Z" },
  ftCustomerContract: { released: true, releasedAt: "2026-08-10T08:00:00Z" },
  client: { company: "Kunde AG", name: "Max Muster", email: "max@kunde.example.ch" },
  ftContactLog: [{ text: "intern: Rückruf offen" }],
};

pruefe("Alle sechs Bereiche erscheinen auf EINEM Link", () => {
  const snap = C.customerAreaSnapshot({
    intake: INTAKE(TOKEN_A), project: VOLL,
    offers: [{ id: "o", status: "sent", sentAt: "2026-08-05T10:00:00Z", number: "A-1", title: "Offerte" }],
    offerAmount: 5400,
    prompt: { text: "Prompt steht" },
    contractHtml: "<h1>Projektauftrag</h1><p>Inhalt</p>", contractTitle: "Projektauftrag",
  });
  // 1 Fragebogen samt Vision Room
  assert.ok(snap.questions.length, "der Fragebogen fehlt");
  // 2 Vorschau · 3 Offerte · 4 AGB · 5 Vertrag · 6 Verwaltung
  ["preview", "offer", "terms", "contract", "admin"].forEach((key) => {
    assert.ok(snap.tiles[key], "Auf dem einen Link fehlt: " + key);
  });
  assert.equal(snap.tiles.preview.feedback, true, "Änderungswünsche sind nicht möglich");
  assert.ok(snap.tiles.contract.document.html.includes("Projektauftrag"));
});

pruefe("Der eine Link führt zu keinem zweiten Link und verrät nichts Internes", () => {
  const snap = C.customerAreaSnapshot({
    intake: INTAKE(TOKEN_A), project: VOLL, prompt: { text: "Prompt" },
    contractHtml: "<p>Vertrag</p>",
  });
  const roh = JSON.stringify(snap);
  ["kunde.html", "clientPortals", "portalToken", "prj_lehner",
    "max@kunde.example.ch", "Max Muster", "Rückruf offen", TOKEN_A,
  ].forEach((verboten) => {
    assert.ok(!roh.includes(verboten), "Der eine Link verrät: " + verboten);
  });
});

pruefe("Der Vertrag erscheint nur nach ausdrücklicher Freigabe", () => {
  const ohne = C.customerAreaSnapshot({
    intake: INTAKE(TOKEN_A),
    project: Object.assign({}, VOLL, { ftCustomerContract: { released: false } }),
    contractHtml: "<p>Vertrag</p>",
  });
  assert.equal(ohne.tiles.contract, null, "Ein nicht freigegebener Vertrag ist sichtbar");
  const ohneText = C.customerAreaSnapshot({
    intake: INTAKE(TOKEN_A), project: VOLL, contractHtml: "",
  });
  assert.equal(ohneText.tiles.contract, null, "Ein leerer Vertrag erzeugt eine Kachel");
});

pruefe("Der Stand für diesen Testlauf: Fragebogen, Vorschau, TEST-Offerte, AGB", () => {
  // Genau das, was jetzt sichtbar sein soll — und ausdrücklich noch KEINE
  // echte Offerte und noch kein Vertrag.
  const jetzt = C.customerAreaSnapshot({
    intake: INTAKE(TOKEN_A),
    project: {
      id: "prj_lehner", previewUrl: "https://beispiel-lehner.netlify.app/",
      ftCustomerPreview: { released: true, releasedAt: "2026-08-10T09:00:00Z" },
      ftTestServiceTile: {
        released: true, releasedAt: "2026-08-10T09:00:00Z",
        title: "Website-Neukonzept Brumag*CH",
        currentUrl: "https://www.bkh-brumag.ch/index.php",
        previewUrl: "https://beispiel-lehner.netlify.app/",
      },
    },
    prompt: { text: "Prompt steht" },
    offers: [{ id: "e", status: "draft", title: "Entwurf" }],
  });
  assert.ok(jetzt.questions.length, "der Fragebogen fehlt");
  assert.ok(jetzt.tiles.preview, "die Vorschau fehlt");
  assert.ok(jetzt.tiles.testService, "die kostenoffene Testkachel fehlt");
  assert.ok(jetzt.tiles.terms, "die statischen AGB fehlen");
  assert.equal(jetzt.tiles.offer, null, "ein Offerten-Entwurf ist sichtbar geworden");
  assert.equal(jetzt.tiles.contract, null, "ein Vertrag ist sichtbar, obwohl keiner freigegeben ist");
  assert.equal(jetzt.tiles.testService.title, "Website-Neukonzept Brumag*CH");
  assert.match(jetzt.tiles.testService.costStatus, /Kosten noch offen/);
  assert.ok(!JSON.stringify(jetzt.tiles.testService).includes("CHF"));
});

/* ══ Domain & Zugang ═════════════════════════════════════════════════════ */

pruefe("Der Abschnitt bietet genau die vier Wege an", () => {
  const qs = C.normalizeIntakeQuestions(C.DEFAULT_INTAKE_QUESTIONS);
  const auswahl = qs.find((q) => q.key === C.DOMAIN_ACCESS_QUESTION_KEY);
  assert.ok(auswahl, "die Auswahl „Domain & Zugang“ fehlt");
  assert.equal(auswahl.options.length, 4);
  assert.deepEqual(auswahl.options, C.DOMAIN_ACCESS_CHOICES.map((c) => c.label));
  assert.equal(auswahl.showIf, null, "die Auswahl selbst ist bedingt");
});

pruefe("Die Detailfragen hängen alle an „übertragen“", () => {
  const qs = C.normalizeIntakeQuestions(C.DEFAULT_INTAKE_QUESTIONS);
  const details = qs.filter((q) => q.showIf && q.showIf.key === C.DOMAIN_ACCESS_QUESTION_KEY);
  assert.ok(details.length >= 3, "es fehlen Detailfragen: " + details.length);
  // Kein E-Mail-Feld: Die Zugangs-E-Mail ist ein Zugangsdatum und wandert
  // ausserdem als Feld ohne Kontaktrolle ungefiltert in den Projekt-Prompt.
  assert.ok(!details.some((q) => q.type === "email"),
    "der Domain-Abschnitt fragt eine E-Mail ab");
  details.forEach((q) => assert.equal(q.showIf.value, C.DOMAIN_TRANSFER_CHOICE,
    q.key + " hängt an einem anderen Wert"));
  ["domain-name", "domain-registrar", "domain-inhaber"].forEach((key) => {
    assert.ok(details.some((q) => q.key === key), "Detailfrage fehlt: " + key);
  });
});

pruefe("Zugangsdaten werden gar nicht erst abgefragt", () => {
  const qs = C.normalizeIntakeQuestions(C.DEFAULT_INTAKE_QUESTIONS);
  qs.forEach((q) => {
    // Die Bestätigungsfrage darf „Zugangsdaten“ heissen — sie erfasst keine.
    if (q.key === "domain-zugang-uebermittelt") return;
    assert.ok(!C.SENSITIVE_ANSWER_PATTERN.test(q.label + " " + q.key),
      "Der Fragebogen fragt etwas Sensibles ab: " + q.label);
  });
  const bestaetigung = qs.find((q) => q.key === "domain-zugang-uebermittelt");
  assert.ok(bestaetigung, "die Bestätigungsfrage fehlt");
  assert.equal(bestaetigung.type, "select", "die Bestätigung ist ein Freitextfeld");
  assert.match(bestaetigung.hint, /nie ein Passwort/i);
});

pruefe("Käme doch ein Geheimnis herein, verlässt es den internen Bereich nicht", () => {
  const antworten = [
    { key: "domain-name", label: "Domainname", answer: "brumag.ch" },
    { key: "domain-passwort", label: "Passwort", answer: "GEHEIM123" },
    { key: "authcode", label: "Transfercode", answer: "AUTH-XYZ" },
    { key: "loginname", label: "Loginname", answer: "admin" },
    { key: "domain-zugang-uebermittelt", label: "Zugangsdaten sicher übermittelt", answer: "Ja" },
  ];
  const gefiltert = C.redactSensitiveAnswers(antworten);
  assert.equal(gefiltert.removed, 3);
  assert.deepEqual(gefiltert.answers.map((a) => a.key), ["domain-name", "domain-zugang-uebermittelt"]);

  // Kundensicht
  const portal = C.buildClientSnapshot({
    project: PROJEKT_A,
    intakeDocument: { intakeTitle: "Bogen", submittedAt: "x", answers: antworten },
  });
  const rohPortal = JSON.stringify(portal);
  ["GEHEIM123", "AUTH-XYZ"].forEach((geheim) => {
    assert.ok(!rohPortal.includes(geheim), "Die Kundensicht zeigt: " + geheim);
  });
  // Projekt-Prompt
  const prompt = C.buildClaudePrompt(
    { project: Object.assign({}, PROJEKT_A, { intakeAnswers: antworten }) },
    { briefing: true, client: true, internal: true }, { mode: "implement" }
  );
  ["GEHEIM123", "AUTH-XYZ"].forEach((geheim) => {
    assert.ok(!prompt.includes(geheim), "Der Prompt enthält: " + geheim);
  });
  assert.match(prompt, /nicht in diesen Prompt übernommen/);
  // Angebots- und Testkachel tragen ohnehin keine Antworten.
  const tile = C.customerTestServiceTile({
    project: { ftTestServiceTile: { released: true, title: "T", summary: "GEHEIM123" } },
  });
  assert.ok(!/GEHEIM123/.test(JSON.stringify(tile.currentUrl + tile.previewUrl + tile.costStatus)));
});

console.log(
  "Ein Link: Fragebogen + Vision Room, Vorschau, Offerte (Test wie echt), AGB,\n" +
  "  Vertrag und Verwaltung — alles auf derselben Adresse, kein zweiter Link,\n" +
  "  keine internen Daten.\n" +
  "Domain & Zugang: vier Wege, Detailfragen nur bei „übertragen“; Loginname,\n" +
  "  Passwort und Transfercode werden gar nicht erst erfasst — nur die\n" +
  "  Bestätigung, dass sie auf sicherem Weg übermittelt wurden."
);
