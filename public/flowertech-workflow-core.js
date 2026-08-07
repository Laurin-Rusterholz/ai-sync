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

/* ── Der Prozess als Daten ───────────────────────────────────────────────
 * Statt einer Liste von Bereichen: die konkret naechsten Schritte, aus dem
 * Datenstand abgeleitet. „Eine Anfrage wird zum Projekt" ist damit kein Knopf,
 * den man finden muss, sondern ein Schritt, der von selbst auftaucht.
 * Reine Funktion — keine DOM-Kenntnis, deshalb testbar.
 * --------------------------------------------------------------------- */
export const PROCESS_STEPS = [
  { key: "inquiry", label: "Anfrage → Projekt", stage: "lead" },
  { key: "briefing", label: "Bedarf aufnehmen", stage: "intake" },
  { key: "offer", label: "Angebot erstellen", stage: "proposal" },
  { key: "changes", label: "Änderungen abarbeiten", stage: "revision" },
  { key: "approval", label: "Freigabe einholen", stage: "approval" },
];

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
      label: "Anfrage → Projekt",
      hint: openInquiries.length === 1
        ? "Eine Anfrage wartet darauf, ein Projekt zu werden."
        : openInquiries.length + " Anfragen warten darauf, Projekte zu werden.",
      count: openInquiries.length,
      items: openInquiries.map((i) => ({
        id: i.id,
        title: i.company || i.name || i.email || "Anfrage",
        sub: i.service || i.email || "",
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

  // 3. Bedarf steht, aber es gibt noch kein Angebot.
  const offeredProjects = new Set(offers
    .filter((o) => o && o.status !== "declined" && o.projectId)
    .map((o) => o.projectId));
  const withoutOffer = active.filter((p) => briefings[p.id] && !offeredProjects.has(p.id));
  if (withoutOffer.length) {
    steps.push({
      key: "offer",
      label: "Angebot erstellen",
      hint: "Leistungsbeschreibung und Preis aus dem Bedarf ableiten.",
      count: withoutOffer.length,
      items: withoutOffer.map((p) => ({ id: p.id, title: p.title || "Projekt", sub: stageLabel(p.pipelineStage) })),
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
export function projectFromInquiry(inquiry, { now = new Date().toISOString() } = {}) {
  const i = inquiry || {};
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
export const PROMPT_DATA_OPTIONS = [
  { key: "briefing", label: "Briefing (Ziel, Zielgruppe, Funktionen)", default: true },
  { key: "changes", label: "Offene Änderungswünsche", default: true },
  { key: "tech", label: "Aktuelles System / Technik", default: true },
  { key: "client", label: "Kundendaten (Name, Firma, E-Mail)", default: false },
  { key: "prices", label: "Preise und Budget", default: false },
  { key: "internal", label: "Interne Notizen", default: false },
];

export function buildClaudePrompt({ project = {}, briefing = {}, changeRequests = [], notes = [] } = {}, include = {}) {
  const on = (key) => include[key] === true;
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

  if (on("changes")) {
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
  out.push("Setze die offenen Punkte um. Halte dich an den beschriebenen Umfang, frage nach, bevor du " +
    "den Umfang erweiterst, und erkläre Änderungen in einem Satz pro Punkt.");
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
  PROCESS_STEPS, inquiryIsOpen, nextProcessSteps, projectFromInquiry,
  costOverview,
  renderTemplate, templateVariables, contractVariables,
  SERVICE_DESCRIPTION_TEMPLATES, WHY_FLOWERTECH_CARD, buildServiceDescription,
  CONTRACT_SECTIONS, CONTRACT_TITLE_TEMPLATE, CONTRACT_INTRO_NOTICE, buildContractDraft, contractToText,
  LEGAL_TEMPLATES, buildLegalDraft,
  MESSAGE_TEMPLATES, buildMessageDraft,
  PROMPT_DATA_OPTIONS, buildClaudePrompt,
  isShareToken, formUrl, portalUrl,
  projectMailAddresses, mailBelongsToProject,
  idempotencyKey, isDuplicate,
};

if (typeof window !== "undefined") window.FlowerTechWorkflow = API;

export default API;
