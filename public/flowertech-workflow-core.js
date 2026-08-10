/* ============================================================================
 * FlowerTech — Workflow-Kern
 * ----------------------------------------------------------------------------
 * Reine Logik ohne DOM: Kundenprozess (Lead → Abschluss), Bedarfsformular,
 * Änderungswünsche, Leistungsbeschreibung, Vertrag, AGB/Datenschutz und der
 * Claude-Code-Prompt.
 *
 * Die Datei wird an ZWEI Stellen benutzt:
 *   • im Browser als <script type="module"> — hängt sich als
 *     window.FlowerTechWorkflow ein, damit das klassische flowertech.js sie
 *     ohne Umbau nutzen kann;
 *   • in Node (Tests, Netlify-Funktion) als normales ES-Modul.
 * Deshalb: keine Browser-APIs, kein Zugriff auf APP, keine Seiteneffekte.
 *
 * WICHTIG zu den Rechtstexten: Vertrag, AGB und Datenschutzhinweise sind
 * ENTWÜRFE nach Schweizer Praxis. Sie sind bewusst als bearbeitbare Blöcke
 * angelegt und tragen überall den Prüfhinweis. Sie sind KEINE Rechtsberatung
 * und keine Zusicherung rechtlicher Verbindlichkeit.
 * ========================================================================== */

export const LEGAL_REVIEW_NOTICE =
  "ENTWURF — Schweizer Vorlage. Vor dem Einsatz rechtlich prüfen lassen. " +
  "Dieser Text ist keine Rechtsberatung und keine Zusicherung rechtlicher Verbindlichkeit.";

/* ── Die zwei Links, die zwei Phasen ─────────────────────────────────────
 * Der ganze Kundenablauf hat GENAU ZWEI oeffentliche Links, und sie duerfen
 * nie miteinander verwechselt werden:
 *
 *   Phase 1 — Fragebogen-Link (Briefing-Link)
 *       fragebogen.html?e=<Einladungstoken>
 *       Kundendaten, Bedarf UND Vision Room in EINER Einladung.
 *       Zeigt NIE Vorschau, Änderungswünsche, Angebot, Vertrag oder AGB.
 *       Erzeugt beim Absenden genau EIN Projekt und genau EINE Aufgabe.
 *
 *   Phase 2 — Kundenportal-Link
 *       kunde.html?t=<Portaltoken>
 *       Entsteht ERST, wenn Vorschau, Leistungsbeschreibung, Offerte,
 *       Vertrag und AGB stehen und ich bewusst veröffentlicht habe.
 *
 * Die Beschriftungen stehen hier, damit UI, Tests und Dokumentation
 * dieselben Worte benutzen. „Kundenlink" ist bewusst kein Begriff mehr —
 * er hat genau die Verwechslung erzeugt, die dieser Ablauf ausschliesst.
 * --------------------------------------------------------------------- */
export const LINK_LABELS = {
  intake: "Fragebogen-Link",
  intakeAlt: "Briefing-Link",
  intakeHint: "Kundendaten & Vision Room – noch keine Vorschau",
  intakeCreate: "Fragebogen-Link erstellen",
  intakeCopy: "Fragebogen-Link kopieren",
  portal: "Kundenportal-Link",
  portalUnpublished: "Kundenportal – noch nicht veröffentlicht",
};

/* ── Kundenprozess ───────────────────────────────────────────────────────── */
// Der FlowerTech-Kundenweg. Die Reihenfolge ist die Reihenfolge im UI.
export const WORKFLOW_STAGES = [
  { key: "lead", label: "Lead", hint: "Interesse ist da. Kontakt aufnehmen und Eckdaten festhalten." },
  { key: "intake", label: "Bestandesaufnahme", hint: "Bedarfsformular ausfüllen lassen oder gemeinsam durchgehen." },
  { key: "proposal", label: "Angebot / Vertrag", hint: "Leistungsbeschreibung, Preis und Vertrag zur Unterschrift." },
  { key: "build", label: "Umsetzung", hint: "Bauen, Zwischenstände zeigen, Aufgaben abarbeiten." },
  { key: "revision", label: "Änderungsrunde", hint: "Rückmeldungen sammeln, als Aufgaben umsetzen." },
  { key: "approval", label: "Freigabe / Abschluss", hint: "Abnahme, Übergabe, Schlussrechnung." },
];

// Alte Phasen bleiben lesbar, damit bestehende Projekte nicht plötzlich „—"
// anzeigen. Sie tauchen im Stepper nicht mehr als eigener Schritt auf.
export const LEGACY_STAGE_ALIASES = {
  discovery: "intake",
  won: "approval",
  lost: "approval",
};

export function stageIndex(stage) {
  const key = LEGACY_STAGE_ALIASES[stage] || stage || "lead";
  const i = WORKFLOW_STAGES.findIndex((s) => s.key === key);
  return i < 0 ? 0 : i;
}

export function stageLabel(stage) {
  if (stage === "won") return "Gewonnen";
  if (stage === "lost") return "Verloren";
  const s = WORKFLOW_STAGES[stageIndex(stage)];
  return s ? s.label : "Lead";
}

export function nextStage(stage) {
  const i = stageIndex(stage);
  return WORKFLOW_STAGES[Math.min(i + 1, WORKFLOW_STAGES.length - 1)].key;
}

export function previousStage(stage) {
  const i = stageIndex(stage);
  return WORKFLOW_STAGES[Math.max(i - 1, 0)].key;
}

/* ── Projekttyp ──────────────────────────────────────────────────────────── */
export const DELIVERY_TYPES = [
  { key: "website", label: "Website", hint: "Auftritt im Web: Seiten, Inhalte, Formulare, Auffindbarkeit." },
  { key: "program", label: "Programm", hint: "Anwendung mit Logik: Abläufe, Daten, Benutzerkonten, Auswertungen." },
];
export function deliveryLabel(type) {
  const hit = DELIVERY_TYPES.find((t) => t.key === type);
  return hit ? hit.label : "Website";
}

/* ── Änderungswünsche ────────────────────────────────────────────────────── */
export const CHANGE_STATUSES = [
  { key: "new", label: "Neu" },
  { key: "review", label: "In Prüfung" },
  { key: "accepted", label: "Angenommen" },
  { key: "in_progress", label: "In Arbeit" },
  { key: "done", label: "Erledigt" },
  { key: "rejected", label: "Abgelehnt" },
];
export function changeStatusLabel(status) {
  const hit = CHANGE_STATUSES.find((s) => s.key === status);
  return hit ? hit.label : "Neu";
}

/* ── Hilfsfunktionen ─────────────────────────────────────────────────────── */
function text(value, max) {
  return String(value == null ? "" : value).trim().replace(/\s+/g, " ").slice(0, max || 400);
}
function multiline(value, max) {
  return String(value == null ? "" : value).replace(/\r\n/g, "\n").trim().slice(0, max || 4000);
}
function list(value, maxItems, maxLen) {
  const raw = Array.isArray(value) ? value : String(value == null ? "" : value).split(/[\n,;]/);
  return raw.map((v) => text(v, maxLen || 120)).filter(Boolean).slice(0, maxItems || 25);
}
function money(value) {
  // "CHF 1'200" → 1200, "4500,50" → 4500.5. Enthaelt die Angabe gar keine
  // Ziffer ("keine Ahnung", "auf Anfrage"), ist sie KEIN Betrag — dann null
  // statt 0. Sonst stuende im Vertrag "CHF 0.00" als vereinbarter Preis.
  const raw = String(value == null ? "" : value).replace(/[^\d.,-]/g, "").replace(",", ".");
  if (!/\d/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

/* ── Bedarfsformular ─────────────────────────────────────────────────────── */
// Die Feldliste ist die einzige Wahrheit: Sie erzeugt das öffentliche Formular,
// das interne Formular und die Normalisierung. Ein Feld dazu = überall dabei.
export const BRIEFING_FIELDS = [
  { key: "contactName", label: "Ihr Name", type: "text", required: true, max: 120 },
  { key: "contactEmail", label: "E-Mail", type: "email", required: true, max: 160 },
  { key: "contactPhone", label: "Telefon (optional)", type: "text", max: 60 },
  { key: "company", label: "Firma / Organisation", type: "text", max: 160 },
  {
    key: "deliveryType", label: "Was brauchen Sie?", type: "select", required: true,
    options: [["website", "Website"], ["program", "Programm / Anwendung"]],
  },
  { key: "goal", label: "Was soll damit erreicht werden?", type: "textarea", required: true, max: 2000,
    hint: "Zum Beispiel: mehr Anfragen, weniger Papierkram, ein bestimmter Ablauf soll einfacher werden." },
  { key: "audience", label: "Wer benutzt es?", type: "textarea", max: 1000,
    hint: "Kundschaft, Team, Mitglieder — und wie technikaffin diese Personen sind." },
  { key: "features", label: "Gewünschte Funktionen", type: "textarea", max: 2000,
    hint: "Eine pro Zeile. Zum Beispiel: Kontaktformular, Terminbuchung, Login, Auswertung." },
  { key: "pages", label: "Seiten / Bereiche", type: "textarea", max: 1500,
    hint: "Eine pro Zeile, z. B. Startseite, Über uns, Angebot, Kontakt." },
  { key: "designWishes", label: "Design-Wünsche", type: "textarea", max: 1500,
    hint: "Farben, Stil, Vorbilder (gerne Links zu Seiten, die Ihnen gefallen)." },
  { key: "contentStatus", label: "Inhalte (Texte, Bilder, Logo)", type: "textarea", max: 1500,
    hint: "Was ist schon vorhanden, was müssten wir erstellen?" },
  { key: "currentSystem", label: "Aktuelles System", type: "textarea", max: 1500,
    hint: "Gibt es bereits eine Seite oder ein Programm? Wo läuft sie, wer betreut sie?" },
  { key: "currentProviderPrice", label: "Was zahlen Sie heute dafür? (CHF, optional)", type: "text", max: 40 },
  { key: "budget", label: "Ihre Preisvorstellung (CHF)", type: "text", max: 40 },
  { key: "deadline", label: "Wunschtermin", type: "date" },
  { key: "priorities", label: "Was ist Ihnen am wichtigsten?", type: "textarea", max: 1000,
    hint: "Eine pro Zeile — die oberste zuerst." },
  { key: "notes", label: "Sonstiges", type: "textarea", max: 2000 },
];

export function normalizeBriefing(raw, { now = new Date().toISOString() } = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  const deliveryType = r.deliveryType === "program" ? "program" : "website";
  return {
    contactName: text(r.contactName, 120),
    contactEmail: text(r.contactEmail, 160).toLowerCase(),
    contactPhone: text(r.contactPhone, 60),
    company: text(r.company, 160),
    deliveryType,
    goal: multiline(r.goal, 2000),
    audience: multiline(r.audience, 1000),
    features: list(r.features, 40, 160),
    pages: list(r.pages, 40, 120),
    designWishes: multiline(r.designWishes, 1500),
    contentStatus: multiline(r.contentStatus, 1500),
    currentSystem: multiline(r.currentSystem, 1500),
    currentProviderPrice: money(r.currentProviderPrice),
    budget: money(r.budget),
    deadline: /^\d{4}-\d{2}-\d{2}$/.test(String(r.deadline || "")) ? String(r.deadline) : "",
    priorities: list(r.priorities, 12, 160),
    notes: multiline(r.notes, 2000),
    submittedAt: now,
    source: text(r.source, 40) || "form",
  };
}

export function briefingIsUsable(briefing) {
  return !!(briefing && briefing.contactEmail && briefing.goal && briefing.goal.length >= 10);
}

// Aus der Antwort werden strukturierte Projektfelder. Bewusst konservativ:
// vorhandene, gepflegte Werte werden nicht überschrieben.
export function projectFieldsFromBriefing(briefing, current = {}) {
  const b = briefing || {};
  const patch = {};
  if (b.deliveryType && !current.deliveryType) patch.deliveryType = b.deliveryType;
  if (b.budget != null && current.budget == null) patch.budget = b.budget;
  if (b.currentProviderPrice != null && current.currentProviderPrice == null) {
    patch.currentProviderPrice = b.currentProviderPrice;
  }
  if (b.deadline && !current.dueDate) patch.dueDate = b.deadline;
  const client = Object.assign({}, current.client || {});
  if (b.contactName && !client.name) client.name = b.contactName;
  if (b.contactEmail && !client.email) client.email = b.contactEmail;
  if (b.contactPhone && !client.phone) client.phone = b.contactPhone;
  if (b.company && !client.company) client.company = b.company;
  patch.client = client;
  return patch;
}

/* ── Aufgaben aus dem Briefing ───────────────────────────────────────────── */
// Wichtig: Das sind ganz normale Quantus-Aufgaben. FlowerTech erfindet keine
// eigene Aufgabenart — deshalb tauchen sie automatisch in der zentralen
// Aufgaben-App auf.
export function buildBriefingTasks(briefing, projectId, { now = new Date().toISOString() } = {}) {
  const b = briefing || {};
  const tasks = [];
  const base = {
    projectId: projectId || null,
    status: "todo",
    category: "flowertech",
    source: "flowertech-briefing",
    createdAt: now,
    updatedAt: now,
  };
  tasks.push(Object.assign({}, base, {
    key: "briefing-review",
    title: "Bedarf durchgehen und Rückfragen klären",
    description: b.goal ? "Ziel laut Kunde:\n" + b.goal : "",
    priority: 1,
    tags: ["flowertech", "bedarf"],
  }));
  (b.features || []).forEach((feature, i) => {
    tasks.push(Object.assign({}, base, {
      key: "feature-" + i,
      title: "Funktion: " + feature,
      description: "Aus dem Bedarfsformular übernommen.",
      priority: 2,
      tags: ["flowertech", "funktion"],
    }));
  });
  (b.pages || []).forEach((page, i) => {
    tasks.push(Object.assign({}, base, {
      key: "page-" + i,
      title: (b.deliveryType === "program" ? "Bereich: " : "Seite: ") + page,
      description: "Aus dem Bedarfsformular übernommen.",
      priority: 3,
      tags: ["flowertech", b.deliveryType === "program" ? "bereich" : "seite"],
    }));
  });
  if (b.contentStatus) {
    tasks.push(Object.assign({}, base, {
      key: "content",
      title: "Inhalte beschaffen (Texte, Bilder, Logo)",
      description: b.contentStatus,
      priority: 2,
      tags: ["flowertech", "inhalte"],
    }));
  }
  tasks.push(Object.assign({}, base, {
    key: "offer",
    title: "Leistungsbeschreibung und Offerte erstellen",
    description: "Aus dem Bedarf ableiten, Preis festlegen, Vertrag vorbereiten.",
    priority: 1,
    dueDate: b.deadline || undefined,
    tags: ["flowertech", "offerte"],
  }));
  return tasks;
}

/* ── Änderungswünsche ────────────────────────────────────────────────────── */
export function normalizeChangeRequest(raw, { now = new Date().toISOString() } = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  const status = CHANGE_STATUSES.some((s) => s.key === r.status) ? r.status : "new";
  return {
    title: text(r.title, 160),
    detail: multiline(r.detail, 4000),
    area: text(r.area, 120),
    priority: [1, 2, 3].includes(Number(r.priority)) ? Number(r.priority) : 2,
    status,
    origin: r.origin === "internal" ? "internal" : "client",
    requestedBy: text(r.requestedBy, 120),
    createdAt: r.createdAt || now,
    updatedAt: now,
  };
}

export function changeRequestIsUsable(cr) {
  return !!(cr && cr.title && cr.title.length >= 3);
}

// Ein Änderungswunsch wird zu einer echten Quantus-Aufgabe.
export function buildChangeRequestTask(changeRequest, projectId, { now = new Date().toISOString() } = {}) {
  const cr = changeRequest || {};
  return {
    title: "Änderung: " + (cr.title || "Ohne Titel"),
    description: [
      cr.area ? "Bereich: " + cr.area : "",
      cr.requestedBy ? "Gewünscht von: " + cr.requestedBy : "",
      cr.origin === "internal" ? "Quelle: intern" : "Quelle: Kunde",
      "",
      cr.detail || "",
    ].filter((line, i) => line || i === 3).join("\n"),
    status: "todo",
    priority: cr.priority || 2,
    category: "flowertech",
    projectId: projectId || null,
    source: "flowertech-change",
    sourceChangeRequestId: cr.id || null,
    tags: ["flowertech", "änderung"],
    createdAt: cr.createdAt || now,
    updatedAt: now,
  };
}

// Der Status des Wunsches folgt der Aufgabe — nicht umgekehrt, damit die
// zentrale Aufgaben-App führend bleibt.
export function changeStatusFromTask(task, currentStatus) {
  if (!task) return currentStatus || "new";
  if (task.status === "done") return "done";
  if (task.status === "in_progress" || task.status === "doing") return "in_progress";
  if (currentStatus === "done") return "accepted";
  return currentStatus === "new" ? "accepted" : (currentStatus || "accepted");
}

/* ── Die Weggabelung: Offerte zuerst oder Direktprojekt ──────────────────
 * Ein neuer Vorgang startet genau einen von zwei Wegen. Die Entscheidung wird
 * am Projekt persistiert (ftRoute) — es gibt keine dritte, unklare Route.
 * KEIN paralleles Datenmodell: Ein Angebotsvorgang IST ein FlowerTech-Projekt.
 * Wird die Offerte angenommen, wird dasselbe Projekt zum Umsetzungsprojekt;
 * wird sie abgelehnt, endet derselbe Vorgang als verloren. Es entsteht in
 * keinem Fall ein zweites Projekt.
 * --------------------------------------------------------------------- */
export const ROUTES = [
  {
    key: "offer_first",
    label: "Offerte zuerst",
    hint: "Bedarf aufnehmen, offerieren, Entscheid abwarten. Erst bei Annahme wird umgesetzt.",
    stages: ["intake", "proposal", "build", "revision", "approval"],
    startStage: "intake",
  },
  {
    key: "direct",
    label: "Direktprojekt",
    hint: "Ohne Offerte direkt umsetzen. Der Angebotsschritt wird bewusst übersprungen.",
    stages: ["intake", "build", "revision", "approval"],
    startStage: "intake",
    skips: ["proposal"],
  },
];

export function routeLabel(route) {
  const hit = ROUTES.find((r) => r.key === route);
  return hit ? hit.label : "—";
}

// Bestehende Projekte tragen kein ftRoute. Sie werden NICHT migriert; ihr Weg
// wird beim Lesen abgeleitet: Wer schon eine Offerte hat, lief offensichtlich
// ueber "Offerte zuerst", alle anderen ueber "Direktprojekt". Damit hat jedes
// Projekt genau einen Weg, ohne dass ein einziges Datum angefasst wird.
export function routeOf(project, offers = []) {
  const explicit = project && project.ftRoute;
  if (ROUTES.some((r) => r.key === explicit)) return explicit;
  const hasOffer = (offers || []).some((o) => o && o.projectId === (project && project.id));
  return hasOffer ? "offer_first" : "direct";
}
export function routeIsExplicit(project) {
  return ROUTES.some((r) => r.key === (project && project.ftRoute));
}
export function routeSkipsOffer(project, offers = []) {
  return routeOf(project, offers) === "direct";
}

// Wo steht der Angebotsvorgang? Aus den vorhandenen Offerten abgeleitet —
// FlowerTech fuehrt dafuer keinen eigenen Statuszaehler.
export function offerDecisionState(project, offers = []) {
  const mine = (offers || []).filter((o) => o && o.projectId === (project && project.id));
  if (!mine.length) return "none";
  if (mine.some((o) => o.status === "accepted")) return "accepted";
  if (mine.some((o) => o.status === "sent")) return "sent";
  if (mine.every((o) => o.status === "declined")) return "declined";
  return "draft";
}

/* ── Beilage zur Offerte ─────────────────────────────────────────────────
 * Vor dem Senden wird verbindlich gewaehlt, was mitgeht: ein persoenlicher
 * Vision-Room-Link oder eine echte, selbst gepflegte Beispiel-URL. Erfundene
 * Links gibt es nicht — fehlt die URL, ist die Beilage unvollstaendig und die
 * UI fordert sie ein.
 * --------------------------------------------------------------------- */
export const OFFER_ATTACHMENTS = [
  {
    key: "vision",
    label: "Vision Room",
    hint: "Persönlicher Link: die Kundschaft baut ihre Idee selbst zusammen. Die Ausarbeitung hängt an dieser Offerte.",
  },
  {
    key: "example",
    label: "Website-Beispiel",
    hint: "Eine echte Vorschau-URL, die du selbst pflegst. Wird der Offerte beigelegt.",
  },
];

export function isHttpUrl(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return false;
  if (!/^https?:\/\//i.test(raw)) return false;
  try {
    const u = new URL(raw);
    return !!u.hostname && u.hostname.includes(".");
  } catch { return false; }
}

// Ist die gewaehlte Beilage versandfertig? Gibt bei "nein" den Grund zurueck,
// damit die UI genau das Fehlende einfordern kann.
export function offerAttachmentState(attachment = {}) {
  const kind = attachment.kind;
  if (kind === "vision") {
    return isShareToken(attachment.visionToken)
      ? { ready: true, kind, reason: "" }
      : { ready: false, kind, reason: "Der persönliche Vision-Room-Link fehlt noch." };
  }
  if (kind === "example") {
    return isHttpUrl(attachment.exampleUrl)
      ? { ready: true, kind, reason: "" }
      : { ready: false, kind, reason: "Trage eine echte Beispiel-URL ein (https://…) oder wähle den Vision Room." };
  }
  return { ready: false, kind: null, reason: "Wähle, was der Offerte beigelegt wird." };
}

/* ── Vision Room ─────────────────────────────────────────────────────────
 * Der Vision Room auf flowertech.ch erfasst Art, Idee, Funktionen und E-Mail.
 * Zwei Faelle:
 *   • ohne Token  → neuer Vorgang, Route "direct" (Direktprojekt)
 *   • mit Token   → Ausarbeitung zu genau der Offerte, an der der Token haengt
 * Der Token ist ein Freigabe-Geheimnis fuer EINEN Kontext — er enthaelt keine
 * Projekt-ID und keinen Zugang zu Quantus.
 * --------------------------------------------------------------------- */
export const VISION_TYPES = [
  { key: "Website", deliveryType: "website" },
  { key: "Web-Programm", deliveryType: "program" },
  { key: "Web-App", deliveryType: "program" },
];

export function visionDeliveryType(type) {
  const hit = VISION_TYPES.find((t) => t.key === type);
  return hit ? hit.deliveryType : "website";
}

export function normalizeVisionSubmission(raw, { now = new Date().toISOString() } = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  const type = VISION_TYPES.some((t) => t.key === r.type) ? r.type : "Website";
  return {
    type,
    deliveryType: visionDeliveryType(type),
    idea: text(r.idea, 120),
    features: list(r.features, 40, 90),
    contactEmail: text(r.email || r.contactEmail, 160).toLowerCase(),
    submittedAt: now,
    source: "vision-room",
  };
}

// Pflicht ist die Idee und ein Rueckkanal. Funktionen sind ein Angebot: wer
// nur einen Satz schreibt, soll trotzdem senden koennen. Keine kuenstliche
// Mindestlaenge — geprueft wird, ob nach dem Trimmen etwas dasteht.
export function visionIsUsable(vision) {
  return !!(vision
    && vision.idea && vision.idea.trim()
    && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(vision.contactEmail || ""));
}

// Aus einer Vision-Room-Eingabe entsteht ein Direktprojekt: die Idee ist der
// Titel, die Funktionen sind der Bedarf. Damit ist kein Nacharbeiten noetig.
export function projectFromVision(vision, { now = new Date().toISOString() } = {}) {
  const v = vision || {};
  const briefing = normalizeBriefing({
    contactEmail: v.contactEmail,
    deliveryType: v.deliveryType,
    goal: v.idea,
    features: v.features,
    source: "vision-room",
  }, { now });
  return {
    project: {
      title: v.idea || "Vision-Room-Projekt",
      description: [
        "Aus dem Vision Room auf flowertech.ch.",
        "Art: " + (v.type || "Website"),
        v.idea ? "Idee: " + v.idea : "",
        (v.features || []).length ? "Funktionen:\n- " + v.features.join("\n- ") : "",
      ].filter(Boolean).join("\n\n"),
      status: "active",
      projectType: "flowertech",
      // Der Vision Room ist die Bestandesaufnahme — sie ist bereits erfolgt.
      pipelineStage: "intake",
      ftRoute: "direct",
      ftRouteDecidedAt: now,
      ftRouteSource: "vision-room",
      deliveryType: v.deliveryType || "website",
      client: { email: v.contactEmail || "" },
      tags: ["flowertech", "visionroom"],
      createdAt: now,
      updatedAt: now,
    },
    briefing,
  };
}

/* ── Offertenanfrage ─────────────────────────────────────────────────────
 * Produktentscheidung: Eine Offerte entsteht NICHT intern auf Verdacht. Die
 * Kundschaft fuellt ueber ihren eigenen FlowerTech-Link aus, was sie braucht;
 * erst dieses Absenden erzeugt eine echte Offertenanfrage und genau EINE
 * Folgeaufgabe. Alles davor ist eine Anfrage, keine Offerte — und damit gibt
 * es auch keine leere Offerte mit Nummer und CHF 0.00.
 *
 * Bewusst niederschwellig: Pflicht ist allein der Bedarf. Keine kuenstliche
 * Mindestlaenge, kein erzwungenes Budget, kein erzwungener Termin. Was die
 * Kundschaft noch nicht weiss, muss sie nicht erfinden.
 * --------------------------------------------------------------------- */
export const QUOTE_REQUEST_STATUSES = [
  { key: "new", label: "Neu" },
  { key: "in_progress", label: "In Arbeit" },
  { key: "quoted", label: "Offeriert" },
  { key: "closed", label: "Abgeschlossen" },
];

export function quoteStatusLabel(status) {
  const hit = QUOTE_REQUEST_STATUSES.find((s) => s.key === status);
  return hit ? hit.label : "Neu";
}

// Die Feldliste ist die einzige Wahrheit: Sie beschreibt das oeffentliche
// Formular auf der Kundenseite und die Normalisierung hier.
export const QUOTE_REQUEST_FIELDS = [
  { key: "company", label: "Firma / Organisation", type: "text", max: 160 },
  { key: "contactName", label: "Ansprechperson", type: "text", max: 120 },
  { key: "contactEmail", label: "E-Mail", type: "email", max: 160,
    hint: "Nur nötig, wenn wir Ihnen per Mail antworten sollen." },
  { key: "contactPhone", label: "Telefon", type: "text", max: 60 },
  { key: "address", label: "Adresse", type: "text", max: 200 },
  { key: "need", label: "Was brauchen Sie?", type: "textarea", required: true, max: 4000,
    hint: "Ein paar Sätze genügen — wir fragen nach, wenn etwas unklar ist." },
  { key: "budget", label: "Budgetrahmen (CHF)", type: "text", max: 40 },
  { key: "deadline", label: "Wunschdatum", type: "date" },
  { key: "notes", label: "Ergänzungen", type: "textarea", max: 3000 },
];

const QUOTE_SOURCES = ["portal", "vision-room", "intern"];

export function normalizeQuoteRequest(raw, { now = new Date().toISOString() } = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  const source = QUOTE_SOURCES.includes(r.source) ? r.source : "portal";
  return {
    company: text(r.company, 160),
    contactName: text(r.contactName || r.name, 120),
    contactEmail: text(r.contactEmail || r.email, 160).toLowerCase(),
    contactPhone: text(r.contactPhone || r.phone, 60),
    address: text(r.address, 200),
    // Der Bedarf ist der Kern. Zeilenumbrueche bleiben erhalten — die
    // Kundschaft schreibt oft eine Liste.
    need: multiline(r.need || r.idea || r.goal, 4000),
    features: list(r.features, 40, 160),
    // Ohne ausdrueckliche Angabe leitet sich die Art aus dem Vision-Room-Typ ab —
    // sonst waere jede Vision-Anfrage stillschweigend eine Website.
    deliveryType: r.deliveryType === "program" ? "program"
      : r.deliveryType === "website" ? "website"
      : (r.type || r.visionType) ? visionDeliveryType(text(r.type || r.visionType, 40)) : "",
    visionType: text(r.type || r.visionType, 40),
    budget: money(r.budget),
    deadline: /^\d{4}-\d{2}-\d{2}$/.test(String(r.deadline || "")) ? String(r.deadline) : "",
    notes: multiline(r.notes, 3000),
    source,
    status: "new",
    submittedAt: now,
  };
}

// Ohne Rueckkanal keine Anfrage: Kommt sie ueber den Vision Room, kennt
// FlowerTech die Person noch gar nicht — dort ist die E-Mail deshalb Pflicht.
// Ueber den Portaltoken des Projekts ist der Vorgang bereits zugeordnet; dann ist
// sie freiwillig.
export function quoteRequestIsUsable(quote, { requireEmail = false } = {}) {
  if (!quote || !String(quote.need || "").trim()) return false;
  if (!requireEmail) return true;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(quote.contactEmail || "");
}

// Sprechender Titel fuer Aufgabe und Liste — nie leer, nie eine rohe ID.
export function quoteRequestLabel(quote = {}, project = {}) {
  const need = String(quote.need || "").replace(/\s+/g, " ").trim();
  const title = String(project.title || "").trim();
  const label = title || need || "Offertenanfrage";
  return label.length > 90 ? label.slice(0, 87).trimEnd() + "…" : label;
}

// GENAU eine Aufgabe pro Anfrage. Kein Faecher aus Funktionen: die Anfrage ist
// ein Vorgang, den ein Mensch einmal anschaut. Ganz normale Quantus-Aufgabe,
// damit sie in der zentralen Aufgaben-App erscheint.
export function buildQuoteRequestTask(quote, projectId, { now = new Date().toISOString(), project = {} } = {}) {
  const q = quote || {};
  const lines = [
    "Offertenanfrage der Kundschaft — eingegangen " + (q.submittedAt || now) + ".",
    "Quelle: " + (q.source === "vision-room" ? "Vision Room (flowertech.ch)" : "Kundenseite (flowertech.ch)"),
    q.company ? "Firma: " + q.company : "",
    q.contactName ? "Ansprechperson: " + q.contactName : "",
    q.contactEmail ? "E-Mail: " + q.contactEmail : "",
    q.contactPhone ? "Telefon: " + q.contactPhone : "",
    q.address ? "Adresse: " + q.address : "",
    q.need ? "\nBedarf:\n" + q.need : "",
    (q.features || []).length ? "\nGewünschte Funktionen:\n- " + q.features.join("\n- ") : "",
    q.budget != null ? "\nBudgetrahmen: CHF " + q.budget.toFixed(2) : "",
    q.deadline ? "Wunschdatum: " + q.deadline : "",
    q.notes ? "\nErgänzungen:\n" + q.notes : "",
  ].filter(Boolean);
  return {
    key: "quote-request",
    projectId: projectId || null,
    title: "Offertenanfrage bearbeiten: " + quoteRequestLabel(q, project),
    description: lines.join("\n"),
    status: "todo",
    priority: 1,
    category: "flowertech",
    source: "flowertech-quote",
    tags: ["flowertech", "offertenanfrage"],
    createdAt: now,
    updatedAt: now,
  };
}

/* ── Wann darf eine Offerte "versendet" heissen? ──────────────────────────
 * Eine Offerte ohne Kunde, ohne Leistung oder ohne Preis ist keine Offerte.
 * Sie als versendet zu markieren erzeugt eine falsche Versandhistorie — und
 * genau die Kombination "Ohne Kunde / CHF 0.00 / Versendet". Deshalb ist der
 * Statuswechsel fachlich gesperrt, solange Pflichtdaten fehlen. Geprueft wird
 * im Versandpfad selbst, nicht nur in der Anzeige: eine Anzeige liesse sich
 * mit einem Klick auf das Auswahlfeld umgehen.
 * --------------------------------------------------------------------- */
export function offerSendableState({ doc = {}, total = 0 } = {}) {
  const client = doc.client || {};
  const hasClient = !!(String(client.company || "").trim() || String(client.name || "").trim());
  const items = Array.isArray(doc.items) ? doc.items : [];
  const hasService = items.some((item) => String(item && item.description || "").trim());
  const hasPrice = Number(total) > 0;
  const missing = [];
  if (!hasClient) missing.push("Kunde (Firma oder Name)");
  if (!hasService) missing.push("mindestens eine Leistung");
  if (!hasPrice) missing.push("ein Preis über CHF 0.00");
  return {
    ready: missing.length === 0,
    missing,
    reason: missing.length
      ? "Noch keine vollständige Offerte — es fehlt: " + missing.join(", ") +
        ". Bis dahin bleibt der Vorgang eine Offertenanfrage."
      : "",
  };
}

/* ── Offerte ohne Projekt: der optionale Fragebogen-Link ─────────────────
 * Eine Offerte ohne Projekt ist ein vollwertiger und haeufiger Startpunkt.
 * Sie darf gepflegt, gedruckt und versendet werden, ohne dass vorher ein
 * Projekt angelegt oder — schlimmer — ein fremdes Projekt ausgewaehlt wird.
 * Ob sie versandfertig ist, entscheidet allein offerSendableState(); der
 * Fragebogen-Link sperrt weder Speichern noch Versenden.
 *
 * Fehlen Kundendaten, gibt es dafuer einen eigenen, freiwilligen Weg: den
 * Fragebogen-Link GENAU DIESER Offerte. Er zeigt ausschliesslich das Briefing
 * samt Vision Room — nie eine Vorschau und nie das Kundenportal, das an dieser
 * Stelle noch gar nicht existiert. Er darf ausdruecklich auch fuer eine noch
 * unfertige Offerte verschickt werden; genau dafuer ist er da.
 *
 * Sendet die Kundschaft ihn ab, entsteht genau ein Projekt und genau eine
 * Aufgabe „Offertenanfrage", und diese Offerte wird dem neuen Projekt
 * ZUGEORDNET — unveraendert, ohne zweite Kopie.
 * --------------------------------------------------------------------- */
export function offerBriefingLinkState({ offer = null, intake = null } = {}) {
  const doc = offer && typeof offer === "object" ? offer : {};
  const form = intake && typeof intake === "object" ? intake : null;
  const token = form && isShareToken(form.inviteToken) ? form.inviteToken : "";
  const url = token ? intakeFormUrl(token) : "";
  const base = { label: LINK_LABELS.intakeCopy, hint: LINK_LABELS.intakeHint, token, url };

  // Mit Projekt fuehrt der Weg ueber den Vorgang: dort steht der Fragebogen
  // der Phase 1, und das Kundenportal entsteht erst mit der Veroeffentlichung.
  if (String(doc.projectId || "")) {
    return Object.assign({}, base, {
      mode: "project",
      projectId: String(doc.projectId),
      explain: "Diese Offerte gehört zu einem Vorgang. Fehlende Angaben holst du über den "
        + "Fragebogen-Link dieses Projekts; das Kundenportal entsteht erst mit der "
        + "ausdrücklichen Veröffentlichung.",
    });
  }

  // Beantwortet: Projekt und Aufgabe sind entstanden, die Offerte haengt dran.
  if (form && String(form.projectId || "")) {
    return Object.assign({}, base, {
      mode: "answered",
      projectId: String(form.projectId),
      explain: "Der Fragebogen ist beantwortet. Daraus entstand genau ein Projekt mit genau einer "
        + "Aufgabe „Offertenanfrage“ — diese Offerte wurde ihm zugeordnet und bleibt unverändert.",
    });
  }

  if (url) {
    return Object.assign({}, base, {
      mode: "copy",
      projectId: "",
      explain: "Dieser Fragebogen-Link gehört zu genau dieser Offerte. Er zeigt der Kundschaft "
        + "Kundendaten und Vision Room — nie eine Vorschau und nie das Kundenportal. Du darfst ihn "
        + "auch für eine noch unfertige Offerte verschicken; Speichern und Versenden bleiben "
        + "davon unberührt. Sendet die Kundschaft ihn ab, entsteht genau ein Projekt mit genau "
        + "einer Aufgabe „Offertenanfrage“, und diese Offerte wird ihm zugeordnet.",
    });
  }

  return Object.assign({}, base, {
    mode: "create",
    label: LINK_LABELS.intakeCreate,
    projectId: "",
    explain: "Diese Offerte gehört zu keinem Projekt — das ist in Ordnung und ändert am Versand "
      + "nichts. Fehlen dir Kundendaten, erstelle den optionalen Fragebogen-Link dieser Offerte: "
      + "Kundendaten und Vision Room, ohne Vorschau. Antwortet die Kundschaft, entsteht genau ein "
      + "Projekt mit genau einer Aufgabe, und diese Offerte wird ihm zugeordnet.",
  });
}

// Die Zuordnung ist idempotent und haengt nichts um: Ein Reload, ein zweites
// Absenden oder ein spaeter Nachzuegler darf keine zweite Offerte und keine
// zweite Zuordnung erzeugen — und eine Offerte, die bereits zu einem anderen
// Vorgang gehoert, bleibt dort.
export function offerProjectLinkPlan({ offer = null, projectId = "" } = {}) {
  const doc = offer && typeof offer === "object" ? offer : null;
  const target = String(projectId || "");
  if (!doc || !doc.id || !target) {
    return { link: false, state: "missing", reason: "Ohne Offerte und ohne Projekt gibt es nichts zuzuordnen." };
  }
  const current = String(doc.projectId || "");
  if (!current) {
    return { link: true, state: "new", reason: "Die Offerte wird diesem Projekt zugeordnet — unverändert, ohne Kopie." };
  }
  if (current === target) {
    return { link: false, state: "already", reason: "Die Offerte gehört bereits zu diesem Projekt." };
  }
  return {
    link: false, state: "foreign",
    reason: "Diese Offerte gehört bereits zu einem anderen Vorgang und wird nicht umgehängt.",
  };
}

/* ── Kundenanfrage (Fragebogen) ──────────────────────────────────────────
 * Der Einstieg in eine Zusammenarbeit ist ein Fragebogen, kein Projekt und
 * keine Offerte. Ich lege die Fragen an, kopiere den oeffentlichen Link und
 * gebe ihn der Kundschaft. Erst ihre Antwort erzeugt — genau einmal — ein
 * Kundenprojekt samt Anfrage-Dokument und einer Aufgabe.
 *
 * Warum so: Ein Projekt vor der Antwort ist eine Behauptung. Es steht dann
 * leer in der Liste, verbraucht eine Nummer und muss von Hand aufgeraeumt
 * werden, wenn nie jemand antwortet.
 *
 * Die Fragen sind Daten, keine fest verdrahtete Maske: Jede Frage kann eine
 * „Rolle" tragen. Die Rolle sagt, wohin die Antwort im Projekt gehoert
 * (Firma, Kontakt, Bedarf, Budget, Termin). Fragen ohne Rolle sind frei —
 * sie landen vollstaendig im Anfrage-Dokument und im Prompt.
 * --------------------------------------------------------------------- */
export const INTAKE_QUESTION_TYPES = [
  { key: "text", label: "Kurzer Text" },
  { key: "textarea", label: "Langer Text" },
  { key: "email", label: "E-Mail" },
  { key: "tel", label: "Telefon" },
  { key: "select", label: "Auswahl" },
  { key: "date", label: "Datum" },
  { key: "number", label: "Zahl" },
];

// Rollen verbinden eine Frage mit einem Projektfeld. Alles andere bleibt
// bewusst frei — der Fragebogen soll nicht zum Formularkorsett werden.
export const INTAKE_ROLES = [
  { key: "", label: "— frei —" },
  { key: "company", label: "Firma / Organisation" },
  { key: "contactName", label: "Ansprechperson" },
  { key: "contactEmail", label: "E-Mail" },
  { key: "contactPhone", label: "Telefon" },
  { key: "address", label: "Adresse" },
  { key: "projectTitle", label: "Projektname" },
  { key: "need", label: "Bedarf / Ziel" },
  { key: "budget", label: "Budgetrahmen" },
  { key: "deadline", label: "Wunschtermin" },
  { key: "currentUrl", label: "Bisherige Website / URL" },
  { key: "currentProvider", label: "Bisheriger Anbieter" },
  { key: "currentPrice", label: "Bisher bezahlter Preis" },
];
const INTAKE_ROLE_KEYS = INTAKE_ROLES.map((r) => r.key).filter(Boolean);
// Rollen, deren Antwort Kontaktdaten sind. Sie gehoeren ins Projekt, aber
// niemals in einen oeffentlichen Snapshot.
export const INTAKE_CONTACT_ROLES = ["company", "contactName", "contactEmail", "contactPhone", "address"];

export const DEFAULT_INTAKE_TITLE = "Ihre Angaben für FlowerTech";
export const DEFAULT_INTAKE_INTRO =
  "Damit wir Ihnen etwas Passendes bauen können, brauchen wir ein paar Angaben. " +
  "Was Sie noch nicht wissen, lassen Sie einfach leer — wir fragen nach. " +
  "Am Schluss bauen Sie im Vision Room Ihre Idee zusammen — das gehört zu denselben Angaben.";

/* Der Vision Room ist KEIN zweiter Kanal, sondern zwei Fragen desselben
 * Fragebogens. Die Seite stellt sie als Mindmap dar; abgesendet werden sie
 * gemeinsam mit allen anderen Antworten. Deshalb entsteht auch aus einem
 * Vision-Room-Beitrag nie ein zweiter Vorgang. */
export const VISION_QUESTION_KEYS = { idea: "vision-idee", features: "vision-funktionen" };

export const DEFAULT_INTAKE_QUESTIONS = [
  { key: "projekt", role: "projectTitle", type: "text", label: "Projekt- / Firmenname", required: true,
    hint: "Wie sollen wir das Vorhaben bei uns nennen?" },
  { key: "company", role: "company", type: "text", label: "Firma / Organisation" },
  { key: "name", role: "contactName", type: "text", label: "Ansprechperson", required: true },
  { key: "email", role: "contactEmail", type: "email", label: "E-Mail", required: true,
    hint: "Damit wir Ihnen antworten können." },
  { key: "phone", role: "contactPhone", type: "tel", label: "Telefon", required: true },
  { key: "adresse", role: "address", type: "text", label: "Adresse", required: true,
    hint: "Strasse, PLZ, Ort — für Offerte und Vertrag." },
  { key: "kind", role: "", type: "select", label: "Was brauchen Sie?", required: true,
    options: ["Website", "Web-Programm", "Web-App", "Weiss ich noch nicht"] },
  { key: "website-url", role: "currentUrl", type: "text", label: "Bisherige Website / URL",
    hint: "Falls vorhanden — sonst leer lassen." },
  { key: "iststand", role: "", type: "textarea", label: "Iststand: Technik und Inhalte",
    hint: "Was läuft heute, womit ist es gebaut, was stört Sie daran?" },
  { key: "anbieter", role: "currentProvider", type: "text", label: "Bisheriger Anbieter",
    hint: "Wer betreut die Seite heute?" },
  { key: "bisheriger-preis", role: "currentPrice", type: "text", label: "Bisher bezahlter Preis (CHF, optional)",
    hint: "Freiwillig — hilft uns beim fairen Vergleich." },
  { key: "need", role: "need", type: "textarea", label: "Ziel: Was soll damit erreicht werden?", required: true,
    hint: "Ein paar Sätze genügen. Zum Beispiel: mehr Anfragen, weniger Papierkram." },
  { key: "audience", role: "", type: "textarea", label: "Wer benutzt es?" },
  { key: "pages", role: "", type: "textarea", label: "Seiten / Inhalte",
    hint: "Eine pro Zeile, z. B. Startseite, Über uns, Angebot, Kontakt." },
  { key: "features", role: "", type: "textarea", label: "Gewünschte Funktionen",
    hint: "Eine pro Zeile — gerne unvollständig." },
  { key: "content", role: "", type: "textarea", label: "Inhalte (Texte, Bilder, Logo)",
    hint: "Was ist schon vorhanden, was müssten wir erstellen?" },
  { key: "design", role: "", type: "textarea", label: "Stil und Referenzen",
    hint: "Farben, Stil, Vorbilder — gerne Links zu Seiten, die Ihnen gefallen." },
  { key: "budget", role: "budget", type: "text", label: "Budgetrahmen (CHF)" },
  { key: "deadline", role: "deadline", type: "date", label: "Wunschtermin" },
  { key: "fragen", role: "", type: "textarea", label: "Ihre eigenen Fragen an uns",
    hint: "Was möchten Sie von uns wissen? Wir beantworten es in der Rückmeldung." },
  { key: VISION_QUESTION_KEYS.idea, role: "", type: "text", vision: "idea",
    label: "Vision Room: Ihre Idee in einem Satz",
    hint: "Zum Beispiel: «Eine Seite, auf der Kundschaft direkt einen Termin bucht.»" },
  { key: VISION_QUESTION_KEYS.features, role: "", type: "textarea", vision: "features",
    label: "Vision Room: Funktionen, die Sie sich vorstellen",
    hint: "Eine pro Zeile. Wählen Sie aus den Vorschlägen oder tragen Sie eigene ein." },
  { key: "notes", role: "", type: "textarea", label: "Sonstiges" },
];

/* ── Vollständigkeit des Fragebogens ─────────────────────────────────────
 * Der Fragebogen ist frei bearbeitbar — er darf aber nicht unter das fallen,
 * was für Offerte, Vertrag und Umsetzung gebraucht wird. Die Liste ist Daten,
 * damit UI und Test dieselbe Wahrheit benutzen: die UI warnt, der Test beweist.
 * --------------------------------------------------------------------- */
export const INTAKE_REQUIRED_TOPICS = [
  { key: "projectTitle", label: "Projekt-/Firmenname", roles: ["projectTitle", "company"] },
  { key: "contactName", label: "Kontaktperson", roles: ["contactName"] },
  { key: "contactEmail", label: "E-Mail", roles: ["contactEmail"] },
  { key: "contactPhone", label: "Telefon", roles: ["contactPhone"] },
  { key: "address", label: "Adresse", roles: ["address"] },
  { key: "currentUrl", label: "Bisherige Website / URL", roles: ["currentUrl"] },
  { key: "currentState", label: "Technischer/inhaltlicher Iststand", keys: ["iststand"] },
  { key: "currentProvider", label: "Bisheriger Anbieter", roles: ["currentProvider"] },
  { key: "currentPrice", label: "Bisher bezahlter Preis", roles: ["currentPrice"] },
  { key: "goal", label: "Ziel", roles: ["need"] },
  { key: "pages", label: "Seiten/Inhalte", keys: ["pages", "content"] },
  { key: "features", label: "Funktionen", keys: ["features", VISION_QUESTION_KEYS.features] },
  { key: "design", label: "Stil/Referenzen", keys: ["design"] },
  { key: "budget", label: "Budget", roles: ["budget"] },
  { key: "deadline", label: "Zeitrahmen", roles: ["deadline"] },
  { key: "ownQuestions", label: "Eigene Fragen", keys: ["fragen"] },
  { key: "vision", label: "Vision Room", vision: true },
];

// Welche Pflichtthemen deckt dieser Fragebogen ab? Nur lesend — es wird
// nichts erzwungen, damit ein bestehender Fragebogen weiter funktioniert.
export function intakeCoverage(questions) {
  const qs = normalizeIntakeQuestions(questions);
  const roles = new Set(qs.map((q) => q.role).filter(Boolean));
  const keys = new Set(qs.map((q) => q.key));
  const hasVision = qs.some((q) => q.vision);
  const missing = INTAKE_REQUIRED_TOPICS.filter((topic) => {
    if (topic.vision) return !hasVision;
    if ((topic.roles || []).some((r) => roles.has(r))) return false;
    if ((topic.keys || []).some((k) => keys.has(k))) return false;
    return true;
  });
  return { complete: missing.length === 0, missing: missing.map((t) => t.label) };
}

function slug(value, fallback) {
  const out = String(value == null ? "" : value).toLowerCase()
    .replace(/[äàâ]/g, "a").replace(/[öô]/g, "o").replace(/[üû]/g, "u").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return out || fallback;
}

export function normalizeIntakeQuestions(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  list.forEach((entry, i) => {
    const q = entry && typeof entry === "object" ? entry : {};
    const label = text(q.label, 200);
    if (!label) return;                                   // ohne Frage keine Frage
    const type = INTAKE_QUESTION_TYPES.some((t) => t.key === q.type) ? q.type : "text";
    let key = slug(q.key || label, "frage-" + (i + 1));
    while (seen.has(key)) key = key + "-" + (i + 1);
    seen.add(key);
    out.push({
      key,
      label,
      type,
      role: INTAKE_ROLE_KEYS.includes(q.role) ? q.role : "",
      required: !!q.required,
      hint: text(q.hint, 300),
      options: type === "select" ? list_(q.options, 20, 120) : [],
      // Vision-Room-Fragen sind normale Fragen mit einer besonderen Darstellung.
      // Der Wert sagt der Seite, welche Rolle die Frage in der Mindmap spielt.
      vision: q.vision === "idea" || q.vision === "features" ? q.vision : "",
    });
  });
  return out.slice(0, 40);
}
// list() heisst intern anders, damit der Name oben lesbar bleibt.
const list_ = list;

/* Der Fragebogen sendet seine Antworten als LISTE ({answers:[{key,answer}]}),
 * n8n und interne Aufrufe als ZUORDNUNG ({key: wert}). Beide Formen sind
 * gültig und müssen hier zusammenlaufen — sonst kommt eine korrekt ausgefüllte
 * Einreichung als „unvollständig" zurück, obwohl sie vollständig ist. */
export function intakeAnswerMap(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const list = Array.isArray(src.answers) ? src.answers : (Array.isArray(src) ? src : null);
  if (!list) return src;
  const map = {};
  list.forEach((a) => {
    if (a && typeof a === "object" && a.key) map[a.key] = a.answer;
  });
  return map;
}

// Die Antworten werden gegen die Fragen normalisiert: Was nicht gefragt wurde,
// kommt nicht durch. Das ist die serverseitige Grenze des Fragebogens.
export function normalizeIntakeAnswers(questions, raw, { now = new Date().toISOString() } = {}) {
  const qs = normalizeIntakeQuestions(questions);
  const src = intakeAnswerMap(raw);
  const answers = qs.map((q) => {
    const value = src[q.key];
    let answer;
    if (q.type === "textarea") answer = multiline(value, 4000);
    else if (q.type === "date") answer = /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : "";
    else if (q.type === "select") answer = q.options.includes(text(value, 120)) ? text(value, 120) : "";
    else if (q.type === "email") answer = text(value, 160).toLowerCase();
    else answer = text(value, 400);
    return { key: q.key, label: q.label, type: q.type, role: q.role, vision: q.vision || "", answer };
  });
  return { answers, submittedAt: now };
}

// Der Vision-Room-Teil einer Antwort — als ganz normale Antworten, nicht als
// eigener Vorgang. Wird für Prompt und Projektbeschreibung gebraucht.
export function visionFromAnswers(answers) {
  const find = (role) => (answers || []).find((a) => a.vision === role);
  const idea = String((find("idea") || {}).answer || "").trim();
  const features = list(String((find("features") || {}).answer || ""), 40, 160);
  return { idea, features, present: !!(idea || features.length) };
}

export function answerByRole(answers, role) {
  const hit = (answers || []).find((a) => a.role === role && String(a.answer || "").trim());
  return hit ? String(hit.answer).trim() : "";
}

// Brauchbar heisst: jede Pflichtfrage ist beantwortet und es gibt einen
// Rueckkanal. Keine kuenstliche Mindestlaenge — getrimmter Text genuegt.
export function intakeAnswersUsable(questions, answers) {
  const qs = normalizeIntakeQuestions(questions);
  const byKey = {};
  (answers || []).forEach((a) => { byKey[a.key] = String(a.answer || "").trim(); });
  const missing = qs.filter((q) => q.required && !byKey[q.key]).map((q) => q.label);
  const email = answerByRole(answers, "contactEmail");
  const hasMail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  if (!hasMail) missing.push("eine gültige E-Mail-Adresse");
  return { usable: missing.length === 0, missing };
}

// Das „erste Dokument": die vollstaendige erste Eingabe, unveraendert.
export function buildIntakeDocument({ intake = {}, answers = [], now = new Date().toISOString() } = {}) {
  return {
    kind: "intake",
    intakeTitle: text(intake.title, 200) || DEFAULT_INTAKE_TITLE,
    intakeId: intake.id || null,
    submittedAt: now,
    answers: (answers || []).map((a) => ({
      key: a.key, label: a.label, type: a.type, role: a.role || "",
      answer: String(a.answer == null ? "" : a.answer),
    })),
  };
}

export function projectFromIntake({ intake = {}, answers = [], now = new Date().toISOString() } = {}) {
  const need = answerByRole(answers, "need");
  const title = answerByRole(answers, "projectTitle")
    || answerByRole(answers, "company")
    || (need ? need.replace(/\s+/g, " ").slice(0, 80) : "")
    || text(intake.title, 80) || "Kundenanfrage";
  const free = (answers || []).filter((a) => !INTAKE_CONTACT_ROLES.includes(a.role) && String(a.answer || "").trim());
  const vision = visionFromAnswers(answers);
  return {
    // Der Iststand der bisherigen Lösung gehört ans Projekt, nicht nur in den
    // Fliesstext: er steuert Offerte, Vergleichspreis und Code-Prompt.
    ftCurrentUrl: answerByRole(answers, "currentUrl"),
    ftCurrentProvider: answerByRole(answers, "currentProvider"),
    currentProviderPrice: money(answerByRole(answers, "currentPrice")),
    // Der Vision Room ist Teil DIESES Briefings — er hängt am selben Projekt
    // und erzeugt niemals einen zweiten Vorgang.
    ftVision: vision.present
      ? { idea: vision.idea, features: vision.features, source: "fragebogen", submittedAt: now }
      : null,
    title,
    description: [
      "Aus dem FlowerTech-Fragebogen „" + (text(intake.title, 120) || DEFAULT_INTAKE_TITLE) + "“.",
      ...free.map((a) => a.label + ":\n" + a.answer),
    ].join("\n\n").slice(0, 8000),
    status: "active",
    projectType: "flowertech",
    // Die Bestandesaufnahme ist mit dem Fragebogen erfolgt.
    pipelineStage: "intake",
    ftRoute: "offer_first",
    ftRouteDecidedAt: now,
    ftRouteSource: "kundenanfrage",
    deliveryType: intake.deliveryType === "program" ? "program" : "website",
    client: {
      company: answerByRole(answers, "company"),
      name: answerByRole(answers, "contactName"),
      email: answerByRole(answers, "contactEmail"),
      phone: answerByRole(answers, "contactPhone"),
      street: answerByRole(answers, "address"),
    },
    budget: money(answerByRole(answers, "budget")),
    dueDate: answerByRole(answers, "deadline"),
    tags: ["flowertech", "kundenanfrage"],
    createdAt: now,
    updatedAt: now,
  };
}

// GENAU eine Aufgabe. Der Fragebogen ist ein Vorgang, den ein Mensch einmal
// anschaut — kein Faecher aus Einzelaufgaben pro Antwort.
export function buildIntakeTask({ project = {}, document: doc = {}, projectId = null, now = new Date().toISOString() } = {}) {
  const lines = (doc.answers || [])
    .filter((a) => String(a.answer || "").trim())
    .map((a) => a.label + ": " + String(a.answer).replace(/\n/g, "\n  "));
  return {
    key: "intake",
    projectId,
    title: "Offertenanfrage bearbeiten: " + (String(project.title || "Kundenanfrage").slice(0, 90)),
    description: [
      "Die Kundschaft hat den Fragebogen „" + (doc.intakeTitle || DEFAULT_INTAKE_TITLE) + "“ ausgefüllt.",
      "Eingegangen: " + (doc.submittedAt || now),
      "",
      ...lines,
    ].join("\n").slice(0, 8000),
    status: "todo",
    priority: 1,
    category: "flowertech",
    source: "flowertech-intake",
    tags: ["flowertech", "kundenanfrage"],
    createdAt: now,
    updatedAt: now,
  };
}

/* ── Kundenportal: Fortschritt, Vorlage, Zustimmung ──────────────────────
 * Das Portal ist mehr als ein Formular: Vorschau, Änderungswünsche, AGB und
 * laufende Fragen. Der Fortschritt ist deshalb eigenstaendig — er beschreibt,
 * was die Kundschaft sieht, nicht die interne Pipeline.
 * --------------------------------------------------------------------- */
export const PORTAL_STEPS = [
  { key: "intake", label: "Fragebogen erhalten" },
  { key: "preview", label: "Vorschau" },
  { key: "changes", label: "Änderungen" },
  { key: "approval", label: "Freigabe" },
];

export function portalProgress({ project = {}, hasPreview = false, changes = [], versions = [] } = {}) {
  const approved = (versions || []).some((v) => v.approved);
  const openChanges = (changes || []).filter((c) => c.status !== "done" && c.status !== "rejected");
  let index = 0;
  if (hasPreview) index = 1;
  if (hasPreview && (changes || []).length) index = 2;
  if (approved) index = 3;
  return {
    key: PORTAL_STEPS[index].key,
    label: PORTAL_STEPS[index].label,
    index,
    total: PORTAL_STEPS.length,
    openChanges: openChanges.length,
    steps: PORTAL_STEPS.map((s, n) => ({ label: s.label, done: n < index, current: n === index })),
  };
}

/* ── Freigabe des Kundenportals ──────────────────────────────────────────
 * Das Kundenportal ist der ZWEITE Link. Er existiert erst, wenn er etwas zu
 * zeigen hat: Vorschau, Leistungsbeschreibung, Offerte, Vertrag und AGB — und
 * wenn ich ihn bewusst veröffentliche. Vorher darf er nirgends als Link zum
 * Versenden erscheinen; ein vorbereiteter Token ist intern sichtbar als
 * „Kundenportal – noch nicht veröffentlicht".
 *
 * Warum als Daten: Damit UI, Snapshot und Test dieselbe Bedingung benutzen.
 * Eine Bedingung, die nur in der Anzeige steht, ist mit einem Klick umgangen.
 * --------------------------------------------------------------------- */
export const PORTAL_RELEASE_REQUIREMENTS = [
  { key: "preview", label: "Website-Vorschau" },
  { key: "service", label: "Leistungsbeschreibung" },
  { key: "offer", label: "Offerte mit Kosten" },
  { key: "contract", label: "Vertrag" },
  { key: "terms", label: "AGB" },
];

export function portalReleaseState({
  hasPreview = false, hasService = false, hasOffer = false,
  hasContract = false, hasTerms = false, released = false, releasedAt = "",
} = {}) {
  const have = {
    preview: !!hasPreview, service: !!hasService,
    offer: !!hasOffer, contract: !!hasContract, terms: !!hasTerms,
  };
  const missing = PORTAL_RELEASE_REQUIREMENTS
    .filter((r) => !have[r.key])
    .map((r) => r.label);
  const ready = missing.length === 0;
  return {
    ready,
    missing,
    published: !!released && ready,
    releasedAt: released && ready ? String(releasedAt || "") : "",
    // Ein Token darf vorbereitet sein — als Link zum Versenden gilt er erst
    // nach der Freigabe. Diese Beschriftung ist die einzige, die vorher gilt.
    label: (released && ready) ? LINK_LABELS.portal : LINK_LABELS.portalUnpublished,
    reason: ready
      ? (released ? "" : "Das Kundenportal ist vorbereitet, aber noch nicht veröffentlicht.")
      : "Noch nicht vollständig — es fehlt: " + missing.join(", ") + ".",
  };
}

export const MAX_TEMPLATE_BYTES = 400 * 1024;
export const MAX_PROMPT_BYTES = 200 * 1024;

// Die Vorschau ist fremder HTML-Code, den ich selbst hochlade — trotzdem wird
// sie entschaerft, bevor sie in einen oeffentlichen Snapshot geht. Ein Skript
// in der Vorlage liefe sonst im Browser der Kundschaft. Zusaetzlich zeigt die
// Kundenseite sie in einem sandboxed iframe: zwei Schichten, nicht eine.
export function sanitizeTemplateHtml(raw, { max = MAX_TEMPLATE_BYTES } = {}) {
  let html = String(raw == null ? "" : raw);
  const removed = [];
  const drop = (re, label) => {
    if (re.test(html)) removed.push(label);
    html = html.replace(re, "");
  };
  drop(/<script\b[\s\S]*?<\/script\s*>/gi, "Skripte");
  drop(/<script\b[^>]*>/gi, "Skripte");
  drop(/<iframe\b[\s\S]*?<\/iframe\s*>/gi, "eingebettete Seiten");
  drop(/<object\b[\s\S]*?<\/object\s*>/gi, "Objekte");
  drop(/<embed\b[^>]*>/gi, "Objekte");
  drop(/\son[a-z]+\s*=\s*"[^"]*"/gi, "Ereignis-Attribute");
  drop(/\son[a-z]+\s*=\s*'[^']*'/gi, "Ereignis-Attribute");
  drop(/\son[a-z]+\s*=\s*[^\s>]+/gi, "Ereignis-Attribute");
  drop(/javascript:/gi, "javascript:-Adressen");
  const truncated = html.length > max;
  if (truncated) html = html.slice(0, max);
  return { html, removed: Array.from(new Set(removed)), truncated };
}

// Eine brauchbare, responsive Standardvorlage — damit sofort eine echte
// Vorschau dasteht. Bewusst ohne fremde Inhalte: gefuellt wird sie aus den
// Antworten der Kundschaft.
export function defaultTemplateHtml({ project = {}, document: doc = {}, company = {} } = {}) {
  const esc = (v) => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const answers = (doc.answers || []).filter(
    (a) => !INTAKE_CONTACT_ROLES.includes(a.role) && String(a.answer || "").trim());
  const need = answers.find((a) => a.role === "need");
  const cards = answers.filter((a) => a.role !== "need").slice(0, 6);
  const title = project.title || "Ihr neuer Auftritt";
  const claim = need ? String(need.answer).split(/\n/)[0] : "Ein Auftritt, der zu Ihnen passt.";
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root{--bg:#07070a;--card:#101018;--line:#1d1d29;--text:#f4f2f8;--muted:#9a94a8;
        --lime:#c8ff2e;--cyan:#25d5ff;--violet:#a06bff}
  @media (prefers-color-scheme:light){:root{--bg:#f7f6fa;--card:#fff;--line:#e6e3ee;--text:#14121a;--muted:#66607a}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
       font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  .wrap{max-width:960px;margin:0 auto;padding:0 20px}
  header{padding:64px 0 40px}
  .k{font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:var(--muted)}
  h1{font-size:clamp(28px,6vw,52px);line-height:1.08;letter-spacing:-.03em;margin:12px 0 14px}
  .claim{font-size:clamp(17px,2.4vw,21px);color:var(--muted);max-width:36em;margin:0}
  .ctas{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}
  .btn{display:inline-block;padding:14px 26px;border-radius:999px;text-decoration:none;font-weight:700;
       background:linear-gradient(135deg,var(--lime),var(--cyan));color:#07070a}
  .btn.ghost{background:none;border:1px solid var(--line);color:var(--text)}
  section{padding:40px 0;border-top:1px solid var(--line)}
  h2{font-size:20px;letter-spacing:-.01em;margin:0 0 18px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px}
  .card h3{margin:0 0 8px;font-size:15px}
  .card p{margin:0;color:var(--muted);font-size:14px;white-space:pre-wrap}
  footer{padding:36px 0 64px;color:var(--muted);font-size:14px}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="k">${esc(company.name || "FlowerTech")}</div>
    <h1>${esc(title)}</h1>
    <p class="claim">${esc(claim)}</p>
    <div class="ctas"><a class="btn" href="#kontakt">Kontakt aufnehmen</a>
      <a class="btn ghost" href="#angebot">Was wir bauen</a></div>
  </header>

  <section id="angebot">
    <h2>Was wir für Sie bauen</h2>
    <div class="grid">
${cards.map((a) => `      <div class="card"><h3>${esc(a.label)}</h3><p>${esc(a.answer)}</p></div>`).join("\n")
  || '      <div class="card"><h3>Ihr Vorhaben</h3><p>Die Inhalte entstehen aus Ihren Angaben.</p></div>'}
    </div>
  </section>

  <section id="kontakt">
    <h2>Kontakt</h2>
    <p class="claim">Schreiben Sie uns — wir melden uns innert 24 h.</p>
  </section>

  <footer>Entwurf · ${esc(company.name || "FlowerTech")} · Diese Vorschau ist unverbindlich.</footer>
</div>
</body>
</html>
`;
}

/* ── Der Prompt fuer die spaetere HTML-Erstellung ─────────────────────────
 * Er ist die Eingabe fuer Claude Code. Deshalb muss er ALLES enthalten, was
 * die Kundschaft gesagt hat — die selbst definierten Fragen mit ihren
 * Antworten, die Vorlage, die Aenderungswuensche und den Projektkontext.
 * Fehlt etwas, faellt es in der spaeteren Umsetzung stillschweigend weg.
 * --------------------------------------------------------------------- */
export function buildProjectPrompt({
  project = {}, document: doc = {}, changes = [], questions = [],
  templateName = "", company = {}, now = new Date().toISOString(),
  includeContact = false,
} = {}) {
  const out = [];
  out.push("# Auftrag: " + (project.title || "FlowerTech-Projekt"));
  out.push("");
  out.push("Erstelle eine vollständige, responsive Website als einzelne HTML-Datei.");
  out.push("Alles Nötige (CSS, kleine Interaktionen) gehört in diese Datei. Keine externen");
  out.push("Abhängigkeiten, kein Build-Schritt, keine erfundenen Inhalte: Was unten nicht");
  out.push("steht, wird nicht behauptet.");
  out.push("");
  out.push("## Projektkontext");
  out.push("- Art: " + (project.deliveryType === "program" ? "Programm / Anwendung" : "Website"));
  out.push("- Phase: " + stageLabel(project.pipelineStage));
  // Budget und Termin sind website-relevant: sie bestimmen Umfang und Tiefe.
  out.push("- Budgetrahmen: " + (project.budget != null
    ? "CHF " + Number(project.budget).toFixed(2) : "nicht angegeben"));
  out.push("- Wunschtermin: " + (project.dueDate || "nicht angegeben"));
  out.push("- Anbieter: " + (company.name || "FlowerTech"));
  out.push("- Vorlage: " + (templateName || "FlowerTech-Standardvorlage"));
  out.push("- Stand: " + now);
  out.push("");

  // Der Iststand: die bisherige Lösung ist der Massstab, an dem die Kundschaft
  // das Ergebnis misst. Er darf im Prompt nie fehlen.
  out.push("## Bisherige Lösung (Iststand)");
  out.push("");
  out.push("- Bisherige Website / URL: " + (project.ftCurrentUrl || "keine angegeben"));
  out.push("- Bisheriger Anbieter: " + (project.ftCurrentProvider || "nicht angegeben"));
  out.push("- Bisher bezahlter Preis: " + (project.currentProviderPrice != null
    ? "CHF " + Number(project.currentProviderPrice).toFixed(2) : "nicht angegeben"));
  out.push("");

  // Kontaktdaten bleiben intern. Sie wandern NUR mit, wenn ich das ausdrücklich
  // wähle — und auch dann nur hierher, nie in einen öffentlichen Snapshot.
  if (includeContact) {
    const c = project.client || {};
    out.push("## Kontaktdaten (intern — nicht auf der Website veröffentlichen)");
    out.push("");
    out.push([c.company, c.name, c.email, c.phone, c.street].filter(Boolean).join(" · ") || "(keine Angaben)");
    out.push("");
  }

  out.push("## Erstes Dokument — Antworten der Kundschaft");
  out.push("");
  out.push("Fragebogen: " + (doc.intakeTitle || DEFAULT_INTAKE_TITLE));
  if (doc.submittedAt) out.push("Eingegangen: " + doc.submittedAt);
  out.push("");
  const answered = (doc.answers || []).filter((a) => String(a.answer || "").trim());
  if (!answered.length) {
    out.push("_Noch keine Antworten erfasst._");
  } else {
    answered.forEach((a) => {
      // Kontaktdaten gehoeren nicht in einen Prompt, der eine Website baut —
      // ausser ich habe sie oben ausdrücklich freigegeben.
      const isContact = INTAKE_CONTACT_ROLES.includes(a.role);
      if (isContact && !includeContact) {
        out.push("### " + a.label);
        out.push("");
        out.push("(intern hinterlegt)");
        out.push("");
        return;
      }
      out.push("### " + a.label);
      out.push("");
      out.push(String(a.answer));
      out.push("");
    });
  }

  // Der Vision Room gehört zum selben Briefing — seine Ideen und Funktionen
  // sind Auftragsinhalt, nicht Beiwerk.
  const vision = (doc.answers || []).length
    ? visionFromAnswers(doc.answers)
    : (project.ftVision
      ? { idea: project.ftVision.idea || "", features: project.ftVision.features || [], present: true }
      : { idea: "", features: [], present: false });
  out.push("## Vision Room — die Idee der Kundschaft");
  out.push("");
  if (!vision.present) out.push("_Nichts erfasst._");
  else {
    if (vision.idea) out.push("Idee: " + vision.idea);
    if (vision.features.length) {
      out.push("");
      out.push("Gewünschte Funktionen aus dem Vision Room:");
      vision.features.forEach((f) => out.push("- " + f));
    }
  }
  out.push("");

  out.push("## Änderungswünsche");
  out.push("");
  const openChanges = (changes || []).filter((c) => c.status !== "rejected");
  if (!openChanges.length) out.push("_Keine._");
  else {
    openChanges.forEach((c) => {
      out.push("- **" + (c.title || "Änderung") + "**" +
        (c.area ? " (" + c.area + ")" : "") +
        " — Status: " + changeStatusLabel(c.status) +
        (c.detail ? "\n  " + String(c.detail).replace(/\n/g, "\n  ") : ""));
    });
  }
  out.push("");
  out.push("## Weitere Fragen und Antworten");
  out.push("");
  const answeredQuestions = (questions || []).filter((q) => String(q.answer || "").trim());
  if (!answeredQuestions.length) out.push("_Keine._");
  else {
    answeredQuestions.forEach((q) => {
      out.push("- **" + (q.question || "Frage") + "**");
      out.push("  " + String(q.answer).replace(/\n/g, "\n  "));
    });
  }
  out.push("");
  out.push("## Vorgaben");
  out.push("");
  out.push("- Mobil zuerst, danach Desktop. Keine horizontale Scrollleiste.");
  out.push("- Helles und dunkles Farbschema über `prefers-color-scheme`.");
  out.push("- Sinnvolle Überschriftenhierarchie, sichtbarer Fokus, Bedienung per Tastatur.");
  out.push("- Deutsche Sprache, Schweizer Schreibweise (ss statt ß).");
  out.push("- Keine Tracker, keine externen Schriften, keine Platzhalter-Bilder von fremden Servern.");
  out.push("- Texte aus den Angaben oben ableiten. Wo etwas fehlt: knapp und ehrlich formulieren,");
  out.push("  statt Zahlen, Referenzen oder Auszeichnungen zu erfinden.");
  out.push("");
  return out.join("\n");
}

/* ── AGB-Zustimmung im Portal ────────────────────────────────────────────
 * Die Zustimmung ist ein Ereignis mit Zeitpunkt und Fassung — nicht ein
 * Haeklein, das man spaeter nicht mehr nachvollziehen kann. Der Text bleibt
 * ein Entwurf nach Schweizer Praxis (siehe LEGAL_REVIEW_NOTICE).
 * --------------------------------------------------------------------- */
export function termsState({ terms = {}, consent = null } = {}) {
  const version = text(terms.version, 40) || "1";
  const accepted = !!(consent && consent.acceptedAt && consent.version === version);
  return {
    version,
    title: text(terms.title, 200) || "Allgemeine Geschäftsbedingungen (Entwurf)",
    accepted,
    acceptedAt: accepted ? String(consent.acceptedAt) : "",
    // Veraltete Zustimmung: Es gab eine, aber zu einer anderen Fassung.
    outdated: !!(consent && consent.acceptedAt && consent.version !== version),
  };
}

export function normalizePortalQuestion(raw, { now = new Date().toISOString() } = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    question: multiline(r.question, 1500),
    answer: multiline(r.answer, 4000),
    askedAt: r.askedAt || now,
    answeredAt: r.answer ? (r.answeredAt || now) : "",
  };
}

/* ── Der Prozess als Daten ───────────────────────────────────────────────
 * Statt einer Liste von Bereichen: die konkret naechsten Schritte, aus dem
 * Datenstand abgeleitet. „Eine Anfrage wird zum Projekt" ist damit kein Knopf,
 * den man finden muss, sondern ein Schritt, der von selbst auftaucht.
 * Reine Funktion — keine DOM-Kenntnis, deshalb testbar.
 * --------------------------------------------------------------------- */
export const PROCESS_STEPS = [
  { key: "inquiry", label: "Fragebogen-Link schicken", stage: "lead" },
  { key: "quote", label: "Offertenanfrage bearbeiten", stage: "lead" },
  { key: "briefing", label: "Bedarf aufnehmen", stage: "intake" },
  { key: "offer", label: "Angebot erstellen", stage: "proposal" },
  { key: "offer_send", label: "Offerte senden", stage: "proposal" },
  { key: "offer_decision", label: "Entscheidung festhalten", stage: "proposal" },
  { key: "direct_build", label: "Direktprojekt umsetzen", stage: "build" },
  { key: "changes", label: "Änderungen abarbeiten", stage: "revision" },
  { key: "approval", label: "Freigabe einholen", stage: "approval" },
];

/* ── Anfrage aus dem öffentlichen Vision Room ────────────────────────────
 * Der Vision Room auf flowertech.ch ist ohne Einladung öffentlich. Was dort
 * ankommt, ist eine ANFRAGE — kein Projekt und kein Direktauftrag. Erst wenn
 * ich darauf den Fragebogen-Link schicke und die Kundschaft ihn absendet,
 * entsteht ein Projekt. Sonst stünden Projekte in der Liste, zu denen nie
 * jemand geantwortet hat, und der Ablauf hätte zwei Eingänge statt einem.
 * --------------------------------------------------------------------- */
export function inquiryFromVision(raw, { now = new Date().toISOString(), id = "" } = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  const idea = text(r.idea || r.need, 400);
  const features = list(r.features, 40, 160);
  const type = text(r.type || r.visionType, 40);
  return {
    id: id || "",
    name: text(r.name, 120),
    company: text(r.company, 160),
    email: text(r.email || r.contactEmail, 160).toLowerCase(),
    phone: text(r.phone, 60),
    service: type || "Vision Room",
    message: [
      idea ? "Idee: " + idea : "",
      features.length ? "Gewünschte Funktionen:\n- " + features.join("\n- ") : "",
    ].filter(Boolean).join("\n\n"),
    source: "vision-room",
    status: "new",
    createdAt: now,
    updatedAt: now,
  };
}

export function inquiryFromVisionIsUsable(inquiry) {
  return !!(inquiry
    && String(inquiry.message || "").trim()
    && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inquiry.email || ""));
}

// Eine Anfrage gilt als offen, solange kein Projekt daraus entstanden ist und
// sie nicht ausdruecklich abgelehnt wurde.
export function inquiryIsOpen(inquiry) {
  if (!inquiry) return false;
  if (inquiry.projectId) return false;
  return inquiry.status !== "lost" && inquiry.status !== "won";
}

export function nextProcessSteps({
  inquiries = [], projects = [], briefings = {}, offers = [], changeRequests = [],
} = {}) {
  const steps = [];
  const active = projects.filter((p) => p && p.status !== "archived" && !p.deleted);

  // 1. Anfragen, aus denen noch kein Projekt geworden ist.
  const openInquiries = inquiries.filter(inquiryIsOpen);
  if (openInquiries.length) {
    steps.push({
      key: "inquiry",
      label: "Fragebogen-Link schicken",
      // Kein Projekt an dieser Stelle: Der Fragebogen-Link ist der ganze
      // Schritt. Kundendaten & Vision Room – noch keine Vorschau.
      hint: openInquiries.length === 1
        ? "Eine Anfrage wartet auf den Fragebogen-Link (Kundendaten & Vision Room – noch keine Vorschau)."
        : openInquiries.length + " Anfragen warten auf den Fragebogen-Link.",
      count: openInquiries.length,
      items: openInquiries.map((i) => ({
        id: i.id,
        title: i.company || i.name || i.email || "Anfrage",
        sub: i.service || i.email || "",
      })),
    });
  }

  // 1b. Offertenanfragen der Kundschaft. Der konkreteste offene Vorgang: hier
  //     hat jemand von sich aus ausgefuellt, was er braucht.
  const openQuotes = active.filter((p) => p.ftQuoteRequest
    && (p.ftQuoteRequest.status || "new") === "new");
  if (openQuotes.length) {
    steps.push({
      key: "quote",
      label: "Offertenanfrage bearbeiten",
      hint: "Über das Kundenportal eingegangen — Angaben prüfen und Offerte erstellen.",
      count: openQuotes.length,
      items: openQuotes.map((p) => ({
        id: p.id,
        title: p.title || "Projekt",
        sub: "Offertenanfrage · " + quoteStatusLabel(p.ftQuoteRequest.status),
      })),
    });
  }

  // 2. Projekte ohne aufgenommenen Bedarf.
  const withoutBriefing = active.filter((p) => !briefings[p.id]
    && stageIndex(p.pipelineStage) <= stageIndex("intake"));
  if (withoutBriefing.length) {
    steps.push({
      key: "briefing",
      label: "Bedarf aufnehmen",
      hint: "Formular teilen oder gemeinsam ausfüllen — daraus entstehen Projektfelder und Aufgaben.",
      count: withoutBriefing.length,
      items: withoutBriefing.map((p) => ({ id: p.id, title: p.title || "Projekt", sub: stageLabel(p.pipelineStage) })),
    });
  }

  // 3. Angebotsweg: Offerte erstellen, senden, Entscheid abwarten.
  //    Direktprojekte kommen hier bewusst NICHT vor — sie ueberspringen ihn.
  const offerRoute = active.filter((p) => routeOf(p, offers) === "offer_first");
  const needOffer = offerRoute.filter((p) => briefings[p.id] && offerDecisionState(p, offers) === "none");
  if (needOffer.length) {
    steps.push({
      key: "offer",
      label: "Angebot erstellen",
      hint: "Leistungsbeschreibung und Preis aus dem Bedarf ableiten.",
      count: needOffer.length,
      items: needOffer.map((p) => ({ id: p.id, title: p.title || "Projekt", sub: stageLabel(p.pipelineStage) })),
    });
  }
  const toSend = offerRoute.filter((p) => offerDecisionState(p, offers) === "draft");
  if (toSend.length) {
    steps.push({
      key: "offer_send",
      label: "Offerte senden",
      hint: "Beilage wählen — persönlicher Vision-Room-Link oder Beispiel-URL — und verschicken.",
      count: toSend.length,
      items: toSend.map((p) => ({ id: p.id, title: p.title || "Projekt", sub: "Offerte im Entwurf" })),
    });
  }
  const awaiting = offerRoute.filter((p) => offerDecisionState(p, offers) === "sent");
  if (awaiting.length) {
    steps.push({
      key: "offer_decision",
      label: "Entscheidung festhalten",
      hint: "Offerte ist draussen. Annahme startet die Umsetzung, Ablehnung schliesst den Vorgang.",
      count: awaiting.length,
      items: awaiting.map((p) => ({
        id: p.id,
        title: p.title || "Projekt",
        sub: (p.ftOfferAttachment && p.ftOfferAttachment.kind === "vision")
          ? "Vision-Ausarbeitung prüfen" : "wartet auf Antwort",
      })),
    });
  }

  // 4. Offene Änderungswünsche.
  const openChanges = changeRequests.filter((c) => c && c.status !== "done" && c.status !== "rejected");
  if (openChanges.length) {
    const byProject = {};
    openChanges.forEach((c) => { byProject[c.projectId] = (byProject[c.projectId] || 0) + 1; });
    steps.push({
      key: "changes",
      label: "Änderungen abarbeiten",
      hint: "Jeder Wunsch ist eine normale Aufgabe — der Status folgt ihr.",
      count: openChanges.length,
      items: Object.keys(byProject).map((id) => {
        const p = active.find((x) => x.id === id);
        return { id, title: (p && p.title) || "Projekt", sub: byProject[id] + " offen" };
      }),
    });
  }

  // 4b. Direktprojekte: der Angebotsschritt ist bewusst uebersprungen, es geht
  //     sofort in die Umsetzung.
  const directBuild = active.filter((p) => routeOf(p, offers) === "direct"
    && briefings[p.id]
    && stageIndex(p.pipelineStage) < stageIndex("revision"));
  if (directBuild.length) {
    steps.push({
      key: "direct_build",
      label: "Direktprojekt umsetzen",
      hint: "Ohne Offerte vereinbart — Leistung und Vertrag festhalten, dann bauen.",
      count: directBuild.length,
      items: directBuild.map((p) => ({
        id: p.id, title: p.title || "Projekt", sub: "Angebotsschritt übersprungen",
      })),
    });
  }

  // 5. Fertig gebaut, aber noch nicht freigegeben.
  const awaitingApproval = active.filter((p) => stageIndex(p.pipelineStage) === stageIndex("approval")
    && p.status !== "done");
  if (awaitingApproval.length) {
    steps.push({
      key: "approval",
      label: "Freigabe einholen",
      hint: "Abnahme, Übergabe, Schlussrechnung.",
      count: awaitingApproval.length,
      items: awaitingApproval.map((p) => ({ id: p.id, title: p.title || "Projekt", sub: "wartet auf Freigabe" })),
    });
  }

  return steps;
}

// Aus einer Anfrage wird ein Projekt: Felder, Startphase und ein Briefing-
// Entwurf in einem Schritt. Die Nachricht der Anfrage ist das erste Ziel —
// der Kunde hat es ja schon formuliert.
export function projectFromInquiry(inquiry, { now = new Date().toISOString(), route = null } = {}) {
  const i = inquiry || {};
  // Ohne ausdrueckliche Wahl wird KEINE Route gesetzt — die UI muss fragen.
  const chosen = ROUTES.some((r) => r.key === route) ? route : null;
  const message = String(i.message || "").trim();
  return {
    project: {
      title: i.company || i.name || "FlowerTech-Projekt",
      description: [i.service ? "Interesse: " + i.service : "", message].filter(Boolean).join("\n\n"),
      status: "active",
      projectType: "flowertech",
      // Der Kundenprozess startet bei der Bestandesaufnahme: der Lead ist ja
      // schon da, es fehlt der Bedarf.
      pipelineStage: "intake",
      ftRoute: chosen,
      ftRouteDecidedAt: chosen ? now : null,
      ftRouteSource: chosen ? "anfrage" : null,
      deliveryType: /programm|program|app|software|tool/i.test(i.service || "") ? "program" : "website",
      client: {
        name: i.name || "", company: i.company || "",
        email: i.email || "", phone: i.phone || "",
      },
      sourceInquiryId: i.id || null,
      tags: ["flowertech"],
      createdAt: now,
      updatedAt: now,
    },
    // Nur uebernehmen, wenn die Nachricht als Zielbeschreibung taugt.
    briefing: message.length >= 10
      ? normalizeBriefing({
          contactName: i.name, contactEmail: i.email, contactPhone: i.phone,
          company: i.company, goal: message, source: "anfrage",
        }, { now })
      : null,
  };
}

/* ── Kostenübersicht ─────────────────────────────────────────────────────── */
// Eine Zahl, die der Kunde versteht: was offeriert, was fakturiert, was bezahlt
// und was noch offen ist. Rechnet nur mit dem, was übergeben wird.
export function costOverview({ offers = [], invoices = [], totals } = {}) {
  const sum = (docs, filter) => docs.filter(filter || (() => true))
    .reduce((acc, d) => acc + (totals ? Number(totals(d)) || 0 : Number(d.total) || 0), 0);
  const offered = sum(offers, (o) => o.status !== "declined" && o.status !== "cancelled");
  const accepted = sum(offers, (o) => o.status === "accepted");
  const invoiced = sum(invoices, (i) => i.status !== "cancelled");
  const paid = sum(invoices, (i) => i.status === "paid");
  return {
    offered: Math.round(offered * 100) / 100,
    accepted: Math.round(accepted * 100) / 100,
    invoiced: Math.round(invoiced * 100) / 100,
    paid: Math.round(paid * 100) / 100,
    open: Math.round((invoiced - paid) * 100) / 100,
  };
}

/* ── Variablen & Vorlagen ────────────────────────────────────────────────── */
// Vorlagen benutzen {{variable}}. Unbekannte Variablen bleiben sichtbar stehen,
// damit niemand versehentlich eine Lücke im Vertrag übersieht.
export function renderTemplate(template, vars) {
  const v = vars || {};
  return String(template == null ? "" : template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key) => {
    const value = v[key];
    if (value == null || value === "") return whole;
    return String(value);
  });
}

export function templateVariables(template) {
  const out = [];
  const re = /\{\{\s*([\w.]+)\s*\}\}/g;
  let m;
  while ((m = re.exec(String(template || "")))) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

export function contractVariables({ project = {}, company = {}, briefing = {}, milestones = [], amount = null, links = {} } = {}) {
  const client = project.client || {};
  const chf = (n) => (n == null || n === "" ? "" : Number(n).toLocaleString("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const scope = (briefing.features || []).length
    ? briefing.features.join(", ")
    : (project.scopeSummary || "");
  return {
    // FlowerTech / Anbieter
    flowertech_name: company.name || "FlowerTech",
    flowertech_adresse: company.address || "",
    datenschutz_email: company.privacyEmail || company.email || "",
    // Kundin / Kunde
    kundin_name: client.company || client.name || "",
    kundin_adresse: client.address || "",
    ansprechperson: client.name || client.company || "",
    kundin_email: client.email || "",
    // Projekt
    projektname: project.title || "",
    projekt_typ: deliveryLabel(project.deliveryType || briefing.deliveryType),
    ziel_des_projekts: (briefing.goal || project.description || "").replace(/\n+/g, " ").trim(),
    leistungsumfang: scope,
    meilensteine: (milestones || []).map((m) => "· " + (m.title || "") + (m.date ? " (" + m.date + ")" : "")).join("\n"),
    termin: project.dueDate || briefing.deadline || "",
    // Geld und Fristen
    preis_chf: chf(amount != null ? amount : project.budget),
    mwst_hinweis: company.vatNote || "(zzgl. MWST, sofern anwendbar)",
    zahlungsplan: company.paymentPlan || "40 % bei Auftragserteilung, 60 % nach Abnahme",
    zahlungsfrist: String(company.paymentDays || 30),
    freigabe_frist_tage: String(company.approvalDays || 10),
    angebotsgueltigkeit_tage: String(company.offerValidDays || 30),
    bisheriger_preis: chf(project.currentProviderPrice != null ? project.currentProviderPrice : briefing.currentProviderPrice),
    // Recht und Formales
    gerichtsstand: company.venue || "am Sitz von FlowerTech",
    datum: new Date().toISOString().slice(0, 10),
    // Links (nur gesetzt, wenn ein Freigabe-Link existiert)
    formularLink: links.form || "",
    kundenLink: links.portal || "",
  };
}

/* ── Leistungsbeschreibung / Angebot ─────────────────────────────────────
 * Der jeweils erste Block ist der verbindliche FlowerTech-Starttext. Die
 * folgenden Blöcke ergänzen ihn kundenfreundlich — alle sind im Projekt
 * editierbar, umsortierbar und abwählbar.
 * ---------------------------------------------------------------------- */
export const SERVICE_DESCRIPTION_TEMPLATES = {
  website: [
    { key: "angebotsstart", title: "Angebot — Website", body:
      "FlowerTech entwickelt für {{kundin_name}} eine klare, schnelle und pflegeleichte Website, die " +
      "{{ziel_des_projekts}} unterstützt. Der vereinbarte Umfang umfasst {{leistungsumfang}}. Dazu gehören " +
      "Konzeption, Gestaltung, technische Umsetzung, responsives Verhalten für Mobile und Desktop, die " +
      "vereinbarten Inhalte sowie eine gemeinsame Abnahme. Nicht vereinbarte Funktionen, externe Lizenzen, " +
      "Texte, Bilder, Übersetzungen oder spätere Erweiterungen sind erst nach schriftlicher Freigabe " +
      "Bestandteil des Auftrags." },
    { key: "ablauf", title: "Wie wir vorgehen", body:
      "1. Bedarf aufnehmen — Sie füllen das kurze Formular aus, wir gehen es gemeinsam durch.\n" +
      "2. Angebot — Sie erhalten Leistungsbeschreibung und Preis schriftlich.\n" +
      "3. Umsetzung — wir bauen und zeigen Ihnen Zwischenstände.\n" +
      "4. Änderungsrunde — Sie sammeln Rückmeldungen, wir setzen sie um.\n" +
      "5. Freigabe — Sie schauen alles an, wir gehen live und übergeben die Zugänge." },
    { key: "funktionen", title: "Vereinbarte Funktionen", body:
      "{{funktionen}}\n\nFunktionen, die hier nicht stehen, sind nicht Teil des vereinbarten Umfangs. " +
      "Sie lassen sich jederzeit als Änderungswunsch ergänzen — mit Auswirkung auf Umfang, Termin und Preis, " +
      "sichtbar bevor etwas umgesetzt wird." },
    { key: "mitwirkung", title: "Was wir von Ihnen brauchen", body:
      "· Texte, Bilder und Ihr Logo (oder den Auftrag, diese zu erstellen)\n" +
      "· Eine Ansprechperson, die Rückfragen beantworten und freigeben darf\n" +
      "· Zugang zur Domain, falls schon vorhanden\n\n" +
      "Fehlen Inhalte, verschiebt sich der Termin entsprechend — wir melden uns rechtzeitig." },
    { key: "danach", title: "Nach dem Start", body:
      "Sie erhalten alle Zugänge und eine kurze Einführung. Auf Wunsch betreuen wir die Seite weiter " +
      "(Aktualisierungen, kleine Anpassungen, Erweiterungen) — das vereinbaren wir separat." },
  ],
  program: [
    { key: "angebotsstart", title: "Angebot — Programm", body:
      "FlowerTech konzipiert und entwickelt für {{kundin_name}} das Programm {{projektname}}. Ziel ist " +
      "{{ziel_des_projekts}}. Der vereinbarte Umfang umfasst {{leistungsumfang}} sowie die im Projektboard " +
      "bestätigten Änderungswünsche. Wir arbeiten in nachvollziehbaren Etappen: Briefing, Entwurf, " +
      "Entwicklung, gemeinsamer Test, Freigabe und Übergabe. Dadurch bleibt jederzeit sichtbar, was " +
      "umgesetzt ist, was als Nächstes folgt und welche Entscheidungen noch offen sind." },
    { key: "funktionen", title: "Vereinbarte Funktionen", body:
      "{{funktionen}}\n\nWas hier nicht steht, ist nicht Teil des vereinbarten Umfangs und lässt sich als " +
      "Änderungswunsch ergänzen — mit sichtbarer Auswirkung auf Umfang, Termin und Preis." },
    { key: "etappen", title: "Etappen", body:
      "1. Briefing — wir schauen uns Ihren heutigen Ablauf an.\n" +
      "2. Entwurf — Sie sehen früh, wie es aussehen und funktionieren wird.\n" +
      "3. Entwicklung — in Etappen, damit Sie zwischendurch ausprobieren können.\n" +
      "4. Gemeinsamer Test — Ihre Rückmeldungen fliessen ein.\n" +
      "5. Freigabe und Übergabe — Abnahme, Schulung, Zugänge." },
    { key: "mitwirkung", title: "Was wir von Ihnen brauchen", body:
      "· Eine Ansprechperson, die den Ablauf kennt und entscheiden darf\n" +
      "· Beispieldaten oder eine Beschreibung der heutigen Arbeitsweise\n" +
      "· Zeitfenster für kurze Rückfragen und das Ausprobieren von Zwischenständen" },
    { key: "danach", title: "Nach der Übergabe", body:
      "Sie erhalten die Zugänge, eine kurze Anleitung und eine Einführung. Betrieb, Sicherung und " +
      "Weiterentwicklung vereinbaren wir separat." },
  ],
};

// Editierbare Positionierungskarte — erscheint in der Kundenansicht.
export const WHY_FLOWERTECH_CARD = {
  key: "warum-flowertech",
  title: "Warum FlowerTech?",
  body:
    "Wir machen digitale Projekte verständlich: Du siehst jederzeit Ziel, Kostenrahmen, nächste Schritte " +
    "und offene Wünsche. Website oder Programm werden nicht im Verborgenen entwickelt, sondern gemeinsam " +
    "in klaren Etappen. Du entscheidest bei Änderungen bewusst – transparent vor der Umsetzung, nicht " +
    "erst auf der Rechnung.",
};

export function buildServiceDescription(project = {}, briefing = {}, context = {}) {
  const type = project.deliveryType || briefing.deliveryType || "website";
  const blocks = SERVICE_DESCRIPTION_TEMPLATES[type] || SERVICE_DESCRIPTION_TEMPLATES.website;
  const features = (briefing.features || []).length
    ? briefing.features.map((f) => "· " + f).join("\n")
    : "· (noch offen — wir tragen die Funktionen nach der Bestandesaufnahme ein)";
  const vars = Object.assign(
    contractVariables(Object.assign({ project, briefing }, context)),
    { funktionen: features }
  );
  return {
    deliveryType: type,
    status: "draft",
    version: 1,
    updatedAt: new Date().toISOString(),
    blocks: blocks.concat([WHY_FLOWERTECH_CARD]).map((b) => ({
      key: b.key,
      title: b.title,
      body: renderTemplate(b.body, vars),
      enabled: true,
      variables: templateVariables(b.body),
    })),
  };
}

/* ── Vertrag / Projektauftrag ────────────────────────────────────────────
 * Verbindliche FlowerTech-Starttexte. Jede Klausel ist ein eigener,
 * editierbarer Block mit Variablen; Reihenfolge und Titel sind änderbar,
 * Blöcke lassen sich abwählen. Der Rechtsprüf-Hinweis bleibt immer sichtbar.
 * ---------------------------------------------------------------------- */
export const CONTRACT_TITLE_TEMPLATE = "Projektauftrag {{projektname}}";
export const CONTRACT_INTRO_NOTICE =
  "Bearbeitbare FlowerTech-Vorlage für Schweizer Projekte. Vor Unterzeichnung rechtlich prüfen und auf " +
  "den konkreten Auftrag anpassen.";

export const CONTRACT_SECTIONS = [
  { key: "parteien", title: "1. Parteien und Projekt", body:
    "Dieser Projektauftrag wird zwischen FlowerTech, {{flowertech_adresse}}, nachfolgend ‚FlowerTech‘, " +
    "und {{kundin_name}}, {{kundin_adresse}}, nachfolgend ‚Kundin/Kunde‘, geschlossen. Gegenstand ist " +
    "{{projektname}} vom Typ {{projekt_typ}}." },
  { key: "leistung", title: "2. Leistung und Abgrenzung", body:
    "FlowerTech erbringt die im Angebot und im bestätigten Projektboard beschriebenen Leistungen: " +
    "{{leistungsumfang}}. Entscheidend für den Umfang sind die als bestätigt markierten Anforderungen, " +
    "Designs, Inhalte und Änderungswünsche. Nicht ausdrücklich enthaltene Leistungen werden erst nach " +
    "einer schriftlichen Ergänzung umgesetzt." },
  { key: "mitwirkung", title: "3. Zusammenarbeit und Mitwirkung", body:
    "Die Kundin/der Kunde liefert notwendige Inhalte, Zugänge, Freigaben und Rückmeldungen rechtzeitig " +
    "und in geeigneter Form. Verzögerungen oder Mehraufwand, die durch fehlende Mitwirkung entstehen, " +
    "können Terminplan und Kostenrahmen angemessen beeinflussen. FlowerTech informiert darüber transparent, " +
    "sobald dies absehbar ist." },
  { key: "termine", title: "4. Termine und Meilensteine", body:
    "Der geplante Ablauf ist: {{meilensteine}}. Termine sind Plantermine, sofern nicht schriftlich " +
    "ausdrücklich als verbindlich bezeichnet. Eine Phase gilt als freigegeben, wenn die Kundin/der Kunde " +
    "sie im Projekt bestätigt oder innerhalb von {{freigabe_frist_tage}} Arbeitstagen keine konkreten " +
    "Mängel meldet." },
  { key: "verguetung", title: "5. Vergütung und Zahlung", body:
    "Der vereinbarte Preis beträgt CHF {{preis_chf}} {{mwst_hinweis}}. Zahlungsplan: {{zahlungsplan}}. " +
    "Zusätzliche Leistungen werden nur nach transparenter Schätzung und schriftlicher Freigabe verrechnet. " +
    "FlowerTech positioniert sich fair im Markt: Liegt vor der verbindlichen Beauftragung ein vergleichbares, " +
    "nachvollziehbares Konkurrenzangebot für denselben Umfang vor, prüfen wir den Preis im Einzelfall; ein " +
    "Preisvergleich ist keine pauschale Preisgarantie und umfasst keine abweichenden Leistungen oder " +
    "Drittanbietergebühren." },
  { key: "aenderungen", title: "6. Änderungswünsche", body:
    "Änderungswünsche werden im FlowerTech-Projekt erfasst. FlowerTech zeigt vor der Umsetzung die " +
    "Auswirkung auf Umfang, Termin und Kosten. Eine Änderung wird erst verbindlich, wenn beide Seiten sie " +
    "im Projekt oder schriftlich freigeben. Fehlerbehebungen innerhalb des bestätigten Umfangs sind keine " +
    "kostenpflichtige Erweiterung." },
  { key: "abnahme", title: "7. Abnahme und Übergabe", body:
    "Nach Bereitstellung prüft die Kundin/der Kunde die vereinbarten Leistungen. Konkrete, reproduzierbare " +
    "Mängel sind innerhalb von {{freigabe_frist_tage}} Arbeitstagen zu melden. FlowerTech behebt berechtigte " +
    "Mängel innert angemessener Frist. Nach vollständiger Zahlung erfolgt die vereinbarte Übergabe von " +
    "Zugängen, Dateien und Dokumentation." },
  { key: "rechte", title: "8. Rechte, Inhalte und Drittanbieter", body:
    "Bis zur vollständigen Bezahlung verbleiben Arbeitsergebnisse bei FlowerTech, soweit zwingendes Recht " +
    "nichts anderes bestimmt. Danach erhält die Kundin/der Kunde die für den vereinbarten Zweck notwendigen " +
    "Nutzungsrechte. Rechte Dritter – insbesondere Schriftarten, Bilder, Plug-ins, Zahlungsdienste, Hosting " +
    "und KI-Dienste – richten sich nach deren Bedingungen und können separate Kosten auslösen." },
  { key: "vertraulichkeit", title: "9. Vertraulichkeit und Datenschutz", body:
    "Beide Parteien behandeln nicht öffentliche Projektinformationen vertraulich. FlowerTech bearbeitet " +
    "Personendaten nur, soweit dies für Anfrage, Projektabwicklung, Kommunikation, Sicherheit und gesetzliche " +
    "Pflichten erforderlich ist. Die aktuelle Datenschutzerklärung und die im Projekt sichtbaren eingesetzten " +
    "Dienste sind Bestandteil der Transparenzinformation." },
  { key: "haftung", title: "10. Haftung", body:
    "FlowerTech haftet bei Vorsatz und grober Fahrlässigkeit nach den gesetzlichen Vorschriften. Soweit " +
    "gesetzlich zulässig, ist die Haftung für indirekte Schäden, Folgeschäden, entgangenen Gewinn, " +
    "Datenverlust und Ansprüche Dritter ausgeschlossen. Für einfache Fahrlässigkeit ist die Haftung, soweit " +
    "zulässig, auf den für das betroffene Projekt bezahlten Betrag begrenzt. Datensicherungen und die Prüfung " +
    "produktiver Inhalte bleiben gemeinsame Verantwortung." },
  { key: "schluss", title: "11. Laufzeit, Kündigung und Schlussbestimmungen", body:
    "Der Auftrag endet mit Abnahme und vollständiger Zahlung. Eine vorzeitige Beendigung ist schriftlich " +
    "möglich; bereits erbrachte und verbindlich beauftragte Leistungen werden abgerechnet. Änderungen und " +
    "Ergänzungen bedürfen der nachvollziehbaren Textform. Es gilt Schweizer Recht. Gerichtsstand ist, soweit " +
    "gesetzlich zulässig, {{gerichtsstand}}." },
  { key: "signatur", title: "Unterschriften", body:
    "Ort/Datum {{datum}} | FlowerTech {{flowertech_name}} | Kundin/Kunde {{kundin_name}}" },
];

export function buildContractDraft(context = {}) {
  const vars = contractVariables(context);
  return {
    title: renderTemplate(CONTRACT_TITLE_TEMPLATE, vars),
    titleTemplate: CONTRACT_TITLE_TEMPLATE,
    intro: CONTRACT_INTRO_NOTICE,
    status: "draft",
    version: 1,
    legalNotice: LEGAL_REVIEW_NOTICE,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sections: CONTRACT_SECTIONS.map((s) => ({
      key: s.key,
      title: s.title,
      body: renderTemplate(s.body, vars),
      enabled: true,
      variables: templateVariables(s.body),
    })),
  };
}

export function contractToText(contract, vars) {
  const c = contract || {};
  const head = [
    c.title || "Projektauftrag",
    "",
    "⚠ " + (c.intro || CONTRACT_INTRO_NOTICE),
    "⚠ " + (c.legalNotice || LEGAL_REVIEW_NOTICE),
    "",
  ].join("\n");
  const body = (c.sections || []).filter((s) => s.enabled !== false)
    .map((s) => (s.title || "") + "\n" + renderTemplate(s.body || "", vars || {}))
    .join("\n\n");
  return head + "\n" + body + "\n";
}

/* ── AGB und Datenschutz ─────────────────────────────────────────────────
 * Verbindliche FlowerTech-Starttexte, wortgetreu als bearbeitbare Blöcke.
 * ---------------------------------------------------------------------- */
export const LEGAL_TEMPLATES = {
  agb: {
    title: "AGB — Kurzfassung (Entwurf)",
    intro: "Bearbeitbare FlowerTech-Vorlage für Schweizer Projekte. Vor Verwendung rechtlich prüfen.",
    sections: [
      { key: "kurzfassung", title: "AGB-Kurzfassung", body:
        "Diese AGB gelten ergänzend zu bestätigten FlowerTech-Angeboten. Der konkrete Projektauftrag hat bei " +
        "Widersprüchen Vorrang. Angebote sind {{angebotsgueltigkeit_tage}} Tage gültig. Kundenseitige Inhalte " +
        "und Rechte daran verantwortet die Kundin/der Kunde. Externe Dienste, Domains, Hosting, Lizenzen und " +
        "Zahlungsanbieter können eigene Bedingungen und Kosten haben. Projektkommunikation und Freigaben " +
        "erfolgen vorrangig im FlowerTech-Projekt; Änderungen gelten erst nach bestätigter Auswirkung. Eine " +
        "bestimmte wirtschaftliche Wirkung, Auffindbarkeit, Verfügbarkeit externer Plattformen oder rechtliche " +
        "Zulässigkeit kundenseitiger Inhalte wird nicht geschuldet. Im Übrigen gelten die Regelungen zu " +
        "Zahlung, Abnahme, Rechten, Datenschutz, Haftung und Schweizer Recht aus dem Projektauftrag." },
    ],
  },
  privacy: {
    title: "Datenschutz — Kurzinformation (Entwurf)",
    intro: "Diese Vorlage muss vor Veröffentlichung mit den tatsächlich eingesetzten Diensten, " +
      "Speicherfristen und Datenflüssen abgeglichen werden.",
    sections: [
      { key: "kurzinformation", title: "Datenschutz-Kurzinformation", body:
        "Verantwortlich für die Datenbearbeitung ist FlowerTech, {{flowertech_adresse}}, {{datenschutz_email}}. " +
        "Wir bearbeiten Kontakt-, Kommunikations-, Projekt-, Vertrags- und Abrechnungsdaten, die du uns " +
        "übermittelst oder die im Rahmen eines Projekts entstehen. Dies geschieht zur Bearbeitung deiner " +
        "Anfrage, zur Vertragsabwicklung, zur Projektkommunikation, zur Sicherung unserer Systeme und zur " +
        "Erfüllung gesetzlicher Pflichten. Daten werden nur an die im konkreten Projekt eingesetzten " +
        "Auftragsbearbeiter und Dienste weitergegeben, soweit dies für diese Zwecke erforderlich ist; die im " +
        "Projekt aktivierten Dienste werden transparent ausgewiesen. Wir bewahren Daten nur so lange auf, wie " +
        "es der jeweilige Zweck oder gesetzliche Aufbewahrungspflichten erfordern. Du kannst dich für Auskunft, " +
        "Berichtigung oder Löschung an {{datenschutz_email}} wenden. Diese Vorlage muss vor Veröffentlichung " +
        "mit den tatsächlich eingesetzten Diensten, Speicherfristen und Datenflüssen abgeglichen werden." },
    ],
  },
};

export function buildLegalDraft(kind, context = {}) {
  const key = LEGAL_TEMPLATES[kind] ? kind : "agb";
  const tpl = LEGAL_TEMPLATES[key];
  const vars = contractVariables(context);
  return {
    kind: key,
    title: tpl.title,
    intro: tpl.intro,
    status: "draft",
    version: 1,
    legalNotice: LEGAL_REVIEW_NOTICE,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sections: tpl.sections.map((s) => ({
      key: s.key,
      title: s.title,
      body: renderTemplate(s.body, vars),
      enabled: true,
      variables: templateVariables(s.body),
    })),
  };
}

/* ── Kundenkommunikation ─────────────────────────────────────────────────
 * Freundliche Entwürfe. Der Projekt-Überblick ist der verbindliche
 * FlowerTech-Starttext; alle Vorlagen sind vor dem Senden editierbar.
 * ---------------------------------------------------------------------- */
export const MESSAGE_TEMPLATES = [
  { key: "overview", stage: "lead", subject: "Dein Projekt {{projektname}} bei FlowerTech", body:
    "Hallo {{ansprechperson}}, danke für dein Interesse an {{projektname}}. In deinem FlowerTech-Projekt " +
    "findest du Briefing, Kostenrahmen, aktuelle Version, Änderungswünsche und die nächsten Schritte an " +
    "einem Ort. Du kannst Wünsche direkt eintragen; wir prüfen Auswirkung auf Umfang, Termin und Preis " +
    "transparent, bevor etwas zusätzlich umgesetzt wird.\n\n{{kundenLink}}" },
  { key: "intake", stage: "lead", subject: "Kurzes Bedarfsformular für {{projektname}}", body:
    "Hallo {{ansprechperson}}\n\n" +
    "Danke für dein Interesse — schön, von dir zu hören.\n\n" +
    "Damit ich dir ein passendes Angebot machen kann, brauche ich ein paar Angaben zu deinem Vorhaben. " +
    "Über den folgenden Link kannst du das in etwa zehn Minuten ausfüllen:\n\n{{formularLink}}\n\n" +
    "Wenn du lieber telefonierst: melde dich einfach, dann gehen wir es gemeinsam durch.\n\n" +
    "Freundliche Grüsse\n{{flowertech_name}}" },
  { key: "offer", stage: "proposal", subject: "Dein Angebot für {{projektname}}", body:
    "Hallo {{ansprechperson}}\n\n" +
    "Anbei mein Angebot für {{projektname}}. Die Leistungsbeschreibung sagt in einfachen Worten, was " +
    "enthalten ist und wie wir vorgehen.\n\n" +
    "Preis: CHF {{preis_chf}} {{mwst_hinweis}}\n\n" +
    "Wenn etwas fehlt oder anders sein soll, sag es mir — wir passen das an, bevor du zusagst.\n\n" +
    "Freundliche Grüsse\n{{flowertech_name}}" },
  { key: "progress", stage: "build", subject: "Zwischenstand {{projektname}}", body:
    "Hallo {{ansprechperson}}\n\n" +
    "Kurzes Update zu deinem Projekt: Du kannst dir den aktuellen Stand hier ansehen:\n\n{{kundenLink}}\n\n" +
    "Schau in Ruhe durch. Alles, was dir auffällt, kannst du direkt auf der Seite als Änderungswunsch " +
    "melden — ich sehe das sofort und melde mich zurück.\n\n" +
    "Freundliche Grüsse\n{{flowertech_name}}" },
  { key: "approval", stage: "approval", subject: "Freigabe {{projektname}}", body:
    "Hallo {{ansprechperson}}\n\n" +
    "Dein Projekt ist fertig. Bitte schau alles noch einmal an und gib mir Bescheid, ob wir freigeben " +
    "können.\n\n{{kundenLink}}\n\n" +
    "Nach der Freigabe erhältst du alle Zugänge und eine kurze Einführung.\n\n" +
    "Freundliche Grüsse\n{{flowertech_name}}" },
];

export function buildMessageDraft(key, vars) {
  const tpl = MESSAGE_TEMPLATES.find((m) => m.key === key) || MESSAGE_TEMPLATES[0];
  return {
    key: tpl.key,
    subject: renderTemplate(tpl.subject, vars || {}),
    body: renderTemplate(tpl.body, vars || {}),
  };
}

/* ── Claude-Code-Prompt ──────────────────────────────────────────────────── */
// Datensparsam: Der Aufrufer wählt, was übertragen wird. Ohne Auswahl bleiben
// Kundendaten und Preise draussen.
// Wofuer der Prompt gedacht ist. Ohne Modus liess sich nur "setze die offenen
// Punkte um" erzeugen — fuer ein frisches Projekt ohne Aenderungswuensche
// nutzlos. Der Beispielmodus baut aus dem Bedarf einen zeigbaren Entwurf.
export const PROMPT_MODES = [
  {
    key: "demo",
    label: "Beispiel bauen",
    hint: "Aus dem Bedarf einen zeigbaren Entwurf erzeugen — noch ohne echte Inhalte.",
    instruction:
      "Baue daraus einen vollständigen, lauffähigen BEISPIEL-Entwurf, den ich der Kundschaft zeigen kann.\n\n" +
      "- Alle beschriebenen Seiten bzw. Bereiche und Funktionen sind angelegt und bedienbar.\n" +
      "- Inhalte sind Platzhalter: erfundene, aber zur Branche passende Texte und Bilder. " +
      "Markiere sie sichtbar als Beispiel, damit niemand sie für endgültig hält.\n" +
      "- Keine echten Kundendaten, keine echten Preise, keine erfundenen Referenzen oder Bewertungen.\n" +
      "- Läuft eigenständig und ohne Konten oder Schlüssel; externe Dienste werden nur angedeutet.\n" +
      "- Funktioniert auf Handy, Tablet und Computer.\n" +
      "- Schreib mir am Schluss in drei bis fünf Sätzen, was du angenommen hast und welche " +
      "Entscheidungen die Kundschaft noch treffen muss.",
  },
  {
    key: "implement",
    label: "Umsetzen",
    hint: "Die offenen Punkte im bestehenden Projekt umsetzen.",
    instruction:
      "Setze die offenen Punkte um. Halte dich an den beschriebenen Umfang, frage nach, bevor du " +
      "den Umfang erweiterst, und erkläre Änderungen in einem Satz pro Punkt.",
  },
  {
    key: "changes",
    label: "Nur Änderungswünsche",
    hint: "Ausschliesslich die offenen Änderungswünsche abarbeiten.",
    instruction:
      "Arbeite ausschliesslich die offenen Änderungswünsche ab — nichts darüber hinaus. Wenn ein Wunsch " +
      "unklar ist oder den vereinbarten Umfang sprengt, setze ihn NICHT um, sondern schreib mir, was du " +
      "wissen musst und was er kosten würde.",
  },
  {
    key: "review",
    label: "Prüfen",
    hint: "Den aktuellen Stand gegen den Bedarf prüfen, ohne etwas zu ändern.",
    instruction:
      "Prüfe den aktuellen Stand gegen den beschriebenen Bedarf, ohne etwas zu ändern. Nenne mir, was " +
      "fehlt, was nicht zum Bedarf passt und was der Kundschaft auffallen wird — nach Wichtigkeit sortiert.",
  },
];

export function promptModeInstruction(mode) {
  const hit = PROMPT_MODES.find((m) => m.key === mode);
  return (hit || PROMPT_MODES.find((m) => m.key === "implement")).instruction;
}

export const PROMPT_DATA_OPTIONS = [
  { key: "briefing", label: "Briefing (Ziel, Zielgruppe, Funktionen)", default: true },
  { key: "changes", label: "Offene Änderungswünsche", default: true },
  { key: "tech", label: "Aktuelles System / Technik", default: true },
  // Kontakt- und Adressdaten sind intern. Diese Wahl steuert BEIDE Prompts:
  // den Reiter-Prompt und den Projekt-Prompt (buildProjectPrompt).
  { key: "client", label: "Kontakt- und Adressdaten (Name, Firma, E-Mail, Telefon, Adresse)", default: false },
  { key: "prices", label: "Preise und Budget", default: false },
  { key: "internal", label: "Interne Notizen", default: false },
];

export function buildClaudePrompt(
  { project = {}, briefing = {}, changeRequests = [], notes = [] } = {},
  include = {},
  { mode = "implement" } = {}
) {
  const on = (key) => include[key] === true;
  // Im Beispielmodus gibt es noch nichts umzusetzen — der Bedarf ist der
  // ganze Auftrag. Aenderungswuensche waeren dort nur Rauschen.
  const isDemo = mode === "demo";
  const type = deliveryLabel(project.deliveryType || briefing.deliveryType);
  const out = [];
  out.push("# Auftrag: " + (project.title || "FlowerTech-Projekt"));
  out.push("");
  out.push("Typ: " + type);
  if (project.description) out.push("Kurzbeschreibung: " + project.description);
  out.push("");

  if (on("client")) {
    const c = project.client || {};
    out.push("## Kunde");
    out.push([c.company, c.name, c.email].filter(Boolean).join(" · ") || "(keine Angaben)");
    out.push("");
  }

  if (on("briefing")) {
    out.push("## Briefing");
    if (briefing.goal) out.push("Ziel: " + briefing.goal);
    if (briefing.audience) out.push("Zielgruppe: " + briefing.audience);
    if ((briefing.features || []).length) {
      out.push("Funktionen:");
      briefing.features.forEach((f) => out.push("- " + f));
    }
    if ((briefing.pages || []).length) {
      out.push((briefing.deliveryType === "program" ? "Bereiche:" : "Seiten:"));
      briefing.pages.forEach((p) => out.push("- " + p));
    }
    if (briefing.designWishes) out.push("Design: " + briefing.designWishes);
    if ((briefing.priorities || []).length) {
      out.push("Prioritäten (wichtigste zuerst):");
      briefing.priorities.forEach((p) => out.push("- " + p));
    }
    out.push("");
  }

  if (on("tech") && briefing.currentSystem) {
    out.push("## Aktuelles System");
    out.push(briefing.currentSystem);
    out.push("");
  }

  if (on("changes") && !isDemo) {
    const openChanges = (changeRequests || []).filter((c) => c.status !== "done" && c.status !== "rejected");
    out.push("## Offene Änderungswünsche (" + openChanges.length + ")");
    if (!openChanges.length) out.push("(keine)");
    openChanges.forEach((c) => {
      out.push("- " + (c.title || "") + (c.detail ? ": " + String(c.detail).replace(/\n+/g, " ") : ""));
    });
    out.push("");
  }

  if (on("prices")) {
    out.push("## Rahmen");
    if (project.budget != null) out.push("Budget: CHF " + project.budget);
    if (project.currentProviderPrice != null) out.push("Bisheriger Anbieterpreis: CHF " + project.currentProviderPrice);
    if (project.dueDate) out.push("Termin: " + project.dueDate);
    out.push("");
  }

  if (on("internal") && (notes || []).length) {
    out.push("## Interne Notizen");
    notes.forEach((n) => out.push("- " + (typeof n === "string" ? n : n.text || "")));
    out.push("");
  }

  out.push("## Was ich von dir brauche");
  out.push(promptModeInstruction(mode));
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/* ── Freigabe-Links ──────────────────────────────────────────────────────── */
// Der Token ist ein Freigabe-Geheimnis für genau ein Projekt — kein API-Schlüssel
// und kein Zugang zu Quantus. Er darf im Link stehen; deshalb muss er lang und
// zufällig sein.
export function isShareToken(token) {
  return typeof token === "string" && /^[A-Za-z0-9_-]{24,64}$/.test(token);
}

export function formUrl(origin, token) {
  if (!isShareToken(token)) return "";
  return String(origin || "").replace(/\/+$/, "") + "/flowertech-formular.html?t=" + token;
}
export function portalUrl(origin, token) {
  if (!isShareToken(token)) return "";
  return String(origin || "").replace(/\/+$/, "") + "/flowertech-kunde.html?t=" + token;
}

/* ── Kundenseite: Snapshot und Link ──────────────────────────────────────
 * Jedes FlowerTech-Projekt bekommt automatisch eine Kundenseite auf
 * flowertech.ch. Sie liest ausschliesslich diesen Snapshot — nie die App.
 *
 * Der Snapshot ist eine POSITIVLISTE: Was hier nicht ausdruecklich aufgebaut
 * wird, verlaesst Quantus nicht. Insbesondere niemals: interne Notizen,
 * Mailverlauf, Rechnungsdetails, interne IDs, Kontaktdaten der Kundschaft
 * (die kennt sie selbst) oder irgendetwas Bearbeitbares.
 *
 * Der Link ist ein Bearer-Link: Wer ihn hat, sieht die Seite. Deshalb ist der
 * Token lang und zufaellig, und "Link erneuern" loescht den alten Snapshot.
 * --------------------------------------------------------------------- */
export const CLIENT_PORTAL_BASE = "https://flowertech.ch";

export function clientPortalUrl(token, { base = CLIENT_PORTAL_BASE } = {}) {
  if (!isShareToken(token)) return "";
  return String(base).replace(/\/+$/, "") + "/kunde.html?t=" + token;
}

// Der oeffentliche Fragebogen. Eigener Token, eigene Seite: Die Einladung ist
// nicht dasselbe wie der spaetere Portalzugang und wird auch nicht dazu.
export function intakeFormUrl(token, { base = CLIENT_PORTAL_BASE } = {}) {
  if (!isShareToken(token)) return "";
  return String(base).replace(/\/+$/, "") + "/fragebogen.html?e=" + token;
}

// Nur diese Phasen zeigt die Kundenseite. "lost" bleibt bewusst draussen —
// ein verlorener Vorgang bekommt keine Fortschrittsanzeige.
export function clientStageProgress(stage) {
  const i = stageIndex(stage);
  return {
    key: WORKFLOW_STAGES[i].key,
    label: WORKFLOW_STAGES[i].label,
    index: i,
    total: WORKFLOW_STAGES.length,
    steps: WORKFLOW_STAGES.map((s, n) => ({
      label: s.label,
      done: n < i,
      current: n === i,
    })),
  };
}

function safeUrl(value) {
  // Nur echte HTTPS-Adressen verlassen Quantus. Kein http, kein javascript:,
  // kein data:, nichts Erfundenes.
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return "";
    if (!u.hostname || !u.hostname.includes(".")) return "";
    return u.toString();
  } catch { return ""; }
}
export { safeUrl as clientSafeUrl };

export function buildClientSnapshot({
  project = {}, company = {}, content = [], milestones = [], changes = [],
  versions = [], costs = {}, quote = null, prefill = {}, now = new Date().toISOString(),
  previewHtml = "", previewUpdatedAt = "", terms = {}, consent = null,
  questions = [], intakeDocument = null, release = null,
} = {}) {
  const stage = clientStageProgress(project.pipelineStage);
  const preview = sanitizeTemplateHtml(previewHtml);
  const portal = portalProgress({
    project, hasPreview: !!preview.html.trim(), changes, versions,
  });
  const money = (v) => (v == null || v === "" ? null : Math.round(Number(v) * 100) / 100);
  return {
    // Kein projectId, keine Token, keine E-Mail-Adresse der Kundschaft.
    schema: 1,
    // Ein Snapshot entsteht nur nach ausdrücklicher Freigabe. Das Feld ist die
    // zweite Schicht: Selbst wenn je ein unfertiger Snapshot geschrieben würde,
    // erkennt die Kundenseite ihn und zeigt keinen halben Vorgang.
    published: release ? !!release.published : true,
    releasedAt: release ? String(release.releasedAt || "") : "",
    title: String(project.title || "Projekt").slice(0, 160),
    deliveryType: project.deliveryType === "program" ? "program" : "website",
    stage: stage.key,
    stageLabel: stage.label,
    stageIndex: stage.index,
    stageSteps: stage.steps,
    closed: project.ftOutcome === "lost",
    updatedAt: now,
    company: {
      name: String(company.name || "FlowerTech").slice(0, 120),
      email: String(company.email || "").slice(0, 160),
    },
    // Vereinbarte Kosten — Summen, keine Rechnungsdetails, keine Positionen.
    costs: {
      agreed: money(costs.accepted != null ? costs.accepted : project.budget),
      invoiced: money(costs.invoiced),
      paid: money(costs.paid),
      open: money(costs.open),
    },
    content: (content || []).slice(0, 30).map((b) => ({
      title: String(b.title || "").slice(0, 160),
      body: String(b.body || "").slice(0, 6000),
    })),
    milestones: (milestones || []).slice(0, 40).map((m) => ({
      title: String(m.title || "").slice(0, 160),
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(m.date || "")) ? m.date : "",
      done: !!m.done,
    })),
    changes: (changes || []).slice(0, 60).map((c) => ({
      title: String(c.title || "").slice(0, 160),
      detail: String(c.detail || "").slice(0, 1500),
      status: c.status || "new",
      statusLabel: changeStatusLabel(c.status),
      createdAt: c.createdAt || "",
    })),
    versions: (versions || []).slice(0, 20).map((v) => ({
      label: String(v.label || "").slice(0, 160),
      at: v.at || "",
      approved: !!v.approved,
    })),
    previewUrl: safeUrl(project.previewUrl),
    adminUrl: safeUrl(project.adminUrl),
    // Offertenanfrage: das Formular, das die Kundschaft selbst ausfuellt.
    // Vorbelegt wird ausschliesslich Inhaltliches (Bedarf, Art, Budget,
    // Wunschdatum). Bewusst KEINE Kontaktdaten: Der Link ist ein Bearer-Link —
    // wer ihn in die Finger bekommt, soll dort keine Firmen-, Namens-, Mail-
    // oder Telefonangaben vorfinden. Die Kundschaft kennt ihre eigenen Daten
    // und traegt sie in zwei Feldern selbst ein.
    quote: {
      open: !quote,
      status: quote ? (quote.status || "new") : null,
      statusLabel: quote ? quoteStatusLabel(quote.status) : "",
      submittedAt: quote ? String(quote.submittedAt || "") : "",
      prefill: {
        need: String(prefill.need || "").slice(0, 4000),
        deliveryType: prefill.deliveryType === "program" ? "program"
          : (prefill.deliveryType === "website" ? "website" : ""),
        budget: money(prefill.budget),
        deadline: /^\d{4}-\d{2}-\d{2}$/.test(String(prefill.deadline || "")) ? String(prefill.deadline) : "",
      },
    },
    // ── Kundenportal ────────────────────────────────────────────────────
    // Der eigene Fortschritt der Kundschaft: Fragebogen → Vorschau →
    // Änderungen → Freigabe. Das ist bewusst nicht die interne Pipeline.
    portal: {
      key: portal.key, label: portal.label, index: portal.index,
      total: portal.total, steps: portal.steps, openChanges: portal.openChanges,
    },
    // Die Vorschau ist entschaerftes HTML. Die Kundenseite zeigt es
    // zusaetzlich in einem sandboxed iframe — zwei Schichten, nicht eine.
    preview: {
      html: preview.html,
      updatedAt: preview.html.trim() ? String(previewUpdatedAt || now) : "",
      sanitized: preview.removed,
    },
    terms: (function () {
      const state = termsState({ terms, consent });
      return {
        title: state.title,
        version: state.version,
        body: String(terms.body || "").slice(0, 40000),
        notice: LEGAL_REVIEW_NOTICE,
        accepted: state.accepted,
        acceptedAt: state.acceptedAt,
        outdated: state.outdated,
      };
    })(),
    // Laufende Fragen. Der Name der antwortenden Person steht bewusst nicht
    // drin — die Kundschaft weiss, wer sie ist.
    questions: (questions || []).slice(0, 60).map((q) => ({
      id: String(q.id || ""),
      question: String(q.question || "").slice(0, 1500),
      answer: String(q.answer || "").slice(0, 4000),
      askedAt: q.askedAt || "",
      answeredAt: q.answeredAt || "",
    })),
    // Die eigenen Angaben aus dem Fragebogen — ohne die Kontaktfelder.
    intake: intakeDocument ? {
      title: String(intakeDocument.intakeTitle || "").slice(0, 200),
      submittedAt: intakeDocument.submittedAt || "",
      answers: (intakeDocument.answers || [])
        .filter((a) => !INTAKE_CONTACT_ROLES.includes(a.role) && String(a.answer || "").trim())
        .slice(0, 40)
        .map((a) => ({ label: String(a.label).slice(0, 200), answer: String(a.answer).slice(0, 4000) })),
    } : null,
  };
}

// Was der Snapshot NIE enthalten darf. Wird im Test gegen echte Projektdaten
// geprueft, damit ein neues Feld nicht versehentlich mitwandert.
export const CLIENT_SNAPSHOT_FORBIDDEN_KEYS = [
  "projectId", "id", "sourceInquiryId", "sourceVisionId", "sourceQuoteId", "sourceIntakeId",
  "intakeId", "inviteToken", "portalToken", "formToken", "visionToken", "ftContactLog",
  "ftOfferAttachment", "ftVision", "ftQuoteRequest", "ftQuoteRequests",
  "client", "contact", "notesInternal",
  "invoices", "offers", "mailThreadIds", "ftRouteSource", "budgetInternal",
];

/* ── Mailzuordnung ───────────────────────────────────────────────────────── */
// Keine globale Postfachüberwachung: Eine Mail gehört nur dann zum Projekt,
// wenn sie eine ausdrücklich hinterlegte Projektadresse betrifft oder bereits
// ausdrücklich verknüpft wurde. Fehlt beides, bleibt sie unverknüpft.
export function projectMailAddresses(project = {}) {
  const client = project.client || {};
  const extra = Array.isArray(project.mailContacts) ? project.mailContacts : [];
  return [client.email, ...extra]
    .map((v) => String(v || "").trim().toLowerCase())
    .filter((v) => v && v.includes("@"));
}

export function mailBelongsToProject(mail, project) {
  if (!mail || !project) return false;
  if (mail.linkedEntity && mail.linkedEntity.kind === "project" && mail.linkedEntity.id === project.id) return true;
  const addresses = projectMailAddresses(project);
  if (!addresses.length) return false;
  const participants = []
    .concat(mail.from || [], mail.to || [], mail.cc || [])
    .map((v) => String(v || "").toLowerCase());
  const haystack = participants.join(" ");
  return addresses.some((a) => haystack.includes(a));
}

/* ── Idempotenz (n8n / Webhooks) ─────────────────────────────────────────── */
// Derselbe Schlüssel darf nur einmal wirken. Der Aufrufer hält die Menge der
// bereits gesehenen Schlüssel.
export function idempotencyKey(payload = {}) {
  const parts = [
    payload.token || "",
    payload.kind || "",
    payload.contactEmail || payload.email || "",
    payload.title || payload.goal || payload.message || "",
  ].join("|");
  let hash = 5381;
  for (let i = 0; i < parts.length; i++) hash = ((hash << 5) + hash + parts.charCodeAt(i)) >>> 0;
  return "ft_" + hash.toString(36) + "_" + parts.length.toString(36);
}

export function isDuplicate(key, seen) {
  if (!key) return false;
  if (seen instanceof Set) return seen.has(key);
  return !!(seen && Object.prototype.hasOwnProperty.call(seen, key));
}

/* ── Browser-Bridge ──────────────────────────────────────────────────────── */
const API = {
  LEGAL_REVIEW_NOTICE,
  WORKFLOW_STAGES, LEGACY_STAGE_ALIASES, stageIndex, stageLabel, nextStage, previousStage,
  DELIVERY_TYPES, deliveryLabel,
  CHANGE_STATUSES, changeStatusLabel,
  BRIEFING_FIELDS, normalizeBriefing, briefingIsUsable, projectFieldsFromBriefing, buildBriefingTasks,
  normalizeChangeRequest, changeRequestIsUsable, buildChangeRequestTask, changeStatusFromTask,
  ROUTES, routeLabel, routeOf, routeIsExplicit, routeSkipsOffer, offerDecisionState,
  OFFER_ATTACHMENTS, isHttpUrl, offerAttachmentState,
  VISION_TYPES, visionDeliveryType, normalizeVisionSubmission, visionIsUsable, projectFromVision,
  INTAKE_QUESTION_TYPES, INTAKE_ROLES, INTAKE_CONTACT_ROLES, DEFAULT_INTAKE_TITLE,
  DEFAULT_INTAKE_INTRO, DEFAULT_INTAKE_QUESTIONS, normalizeIntakeQuestions, normalizeIntakeAnswers,
  answerByRole, intakeAnswersUsable, buildIntakeDocument, projectFromIntake, buildIntakeTask,
  intakeAnswerMap, LINK_LABELS, VISION_QUESTION_KEYS, INTAKE_REQUIRED_TOPICS, intakeCoverage, visionFromAnswers,
  PORTAL_RELEASE_REQUIREMENTS, portalReleaseState,
  inquiryFromVision, inquiryFromVisionIsUsable,
  PORTAL_STEPS, portalProgress, MAX_TEMPLATE_BYTES, MAX_PROMPT_BYTES, sanitizeTemplateHtml,
  defaultTemplateHtml, buildProjectPrompt, termsState, normalizePortalQuestion,
  QUOTE_REQUEST_STATUSES, quoteStatusLabel, QUOTE_REQUEST_FIELDS, normalizeQuoteRequest,
  quoteRequestIsUsable, quoteRequestLabel, buildQuoteRequestTask, offerSendableState,
  offerBriefingLinkState, offerProjectLinkPlan,
  PROCESS_STEPS, inquiryIsOpen, nextProcessSteps, projectFromInquiry,
  costOverview,
  renderTemplate, templateVariables, contractVariables,
  SERVICE_DESCRIPTION_TEMPLATES, WHY_FLOWERTECH_CARD, buildServiceDescription,
  CONTRACT_SECTIONS, CONTRACT_TITLE_TEMPLATE, CONTRACT_INTRO_NOTICE, buildContractDraft, contractToText,
  LEGAL_TEMPLATES, buildLegalDraft,
  MESSAGE_TEMPLATES, buildMessageDraft,
  PROMPT_MODES, promptModeInstruction, PROMPT_DATA_OPTIONS, buildClaudePrompt,
  isShareToken, formUrl, portalUrl,
  CLIENT_PORTAL_BASE, clientPortalUrl, intakeFormUrl, clientStageProgress, buildClientSnapshot,
  clientSafeUrl: safeUrl, CLIENT_SNAPSHOT_FORBIDDEN_KEYS,
  projectMailAddresses, mailBelongsToProject,
  idempotencyKey, isDuplicate,
};

if (typeof window !== "undefined") window.FlowerTechWorkflow = API;

export default API;
