(function () {
  "use strict";

  // ==========================================================================
  //  FlowerTech — eigenständiger Arbeitsbereich in Quantus
  //  --------------------------------------------------------------------
  //  Projekte werden vollständig IN FlowerTech angezeigt und bearbeitet
  //  (Detailansicht mit Aufgaben, Offerten, Rechnungen, Notizen, Links).
  //  Dazu: Offerten, Rechnungen inkl. selbst hochgeladenem QR-Code,
  //  Finanzen, Leads, Instagram-Videos und KI-Funktionen.
  //  Alles läuft über die bestehenden Quantus-Bausteine (createEntity,
  //  scheduleSave, uploadToFirebase, callAI) — kein neuer Backend-Pfad.
  // ==========================================================================

  var RTDB = "https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app";
  var VAT_DEFAULT = 8.1;                 // Schweizer Normalsatz
  var QR_INLINE_LIMIT = 400 * 1024;      // Fallback ohne Firebase: max. 400 KB

  var inquiryRef = null;
  var videoRef = null;
  var submissionRef = null;
  var initialized = false;

  // ── kleine Helfer ────────────────────────────────────────────────────────
  function esc(value) {
    return window.esc ? window.esc(value) : String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function attr(value) { return esc(value).replace(/'/g, "&#039;"); }

  function id() {
    return window.uuid ? window.uuid() : "ft_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function now() { return window.nowIso ? window.nowIso() : new Date().toISOString(); }
  function today() { return window.todayYmd ? window.todayYmd() : new Date().toISOString().slice(0, 10); }
  function save() { if (window.scheduleSave) window.scheduleSave(); }
  function rerender() { if (window.render) window.render(); }
  function notify(type, title, message) { if (window.toast) window.toast(type, title, message); }
  function data() { return window.APP && APP.state && APP.state.data; }

  function num(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : (fallback || 0);
  }

  function addDays(ymd, days) {
    var d = new Date((ymd || today()) + "T12:00:00");
    if (isNaN(d)) d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  // ── Zustand ──────────────────────────────────────────────────────────────
  function state() {
    var root = data();
    if (!root) return null;
    root.flowertech = root.flowertech || {};
    var ft = root.flowertech;
    ft.activeTab = ft.activeTab || "dashboard";
    ft.inquiries = ft.inquiries || {};
    // Kundenanfragen (Fragebögen). Der Einstieg in eine Zusammenarbeit —
    // vor jedem Projekt und vor jeder Offerte.
    ft.intakes = ft.intakes && typeof ft.intakes === "object" ? ft.intakes : {};
    ft.videos = ft.videos || {};
    ft.finances = Array.isArray(ft.finances) ? ft.finances : [];
    ft.notes = Array.isArray(ft.notes) ? ft.notes : [];
    ft.links = Array.isArray(ft.links) ? ft.links : [];
    ft.offers = Array.isArray(ft.offers) ? ft.offers : [];
    ft.invoices = Array.isArray(ft.invoices) ? ft.invoices : [];
    ft.clients = Array.isArray(ft.clients) ? ft.clients : [];
    ft.milestones = Array.isArray(ft.milestones) ? ft.milestones : [];   // Planung: Phasen/Termine je Projekt
    ft.aiLog = Array.isArray(ft.aiLog) ? ft.aiLog : [];
    ft.counters = ft.counters && typeof ft.counters === "object" ? ft.counters : {};
    ft.company = ft.company && typeof ft.company === "object" ? ft.company : {};
    if (ft.company.name == null) ft.company.name = "FlowerTech";
    if (ft.company.tagline == null) ft.company.tagline = "Web-Apps & KI · Schweizer KMU";
    if (ft.company.vatRate == null) ft.company.vatRate = VAT_DEFAULT;
    if (ft.company.paymentDays == null) ft.company.paymentDays = 30;
    ft.ui = ft.ui && typeof ft.ui === "object" ? ft.ui : {};
    ft.syncStatus = ft.syncStatus || "idle";
    return ft;
  }

  function projects() {
    var root = data();
    return Object.values(root && root.entities && root.entities.projects || {})
      .filter(function (project) { return project && project.projectType === "flowertech" && !project.deleted; });
  }

  function projectById(projectId) {
    var root = data();
    return (root && root.entities && root.entities.projects && root.entities.projects[projectId]) || null;
  }

  function tasks() {
    var root = data();
    var projectIds = new Set(projects().map(function (project) { return project.id; }));
    return Object.values(root && root.entities && root.entities.tasks || {})
      .filter(function (task) {
        return task && !task.deleted &&
          (task.sourceInquiryId || task.category === "flowertech" || projectIds.has(task.projectId));
      });
  }

  function tasksOfProject(projectId) {
    return tasks().filter(function (task) { return task.projectId === projectId; });
  }

  function inquiries() {
    var ft = state();
    return Object.entries(ft && ft.inquiries || {}).map(function (entry) {
      return Object.assign({ id: entry[0] }, entry[1] || {});
    }).sort(function (a, b) {
      return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    });
  }

  function videos() {
    var ft = state();
    return Object.entries(ft && ft.videos || {}).map(function (entry) {
      return Object.assign({ id: entry[0] }, entry[1] || {});
    }).sort(function (a, b) {
      return String(b.publishedAt || b.createdAt || "").localeCompare(String(a.publishedAt || a.createdAt || ""));
    });
  }

  function docs(kind) {
    var ft = state();
    if (!ft) return [];
    return kind === "invoice" ? ft.invoices : ft.offers;
  }

  function docById(kind, docId) {
    return docs(kind).find(function (doc) { return doc.id === docId; }) || null;
  }

  function docsOfProject(kind, projectId) {
    return docs(kind).filter(function (doc) { return doc.projectId === projectId; });
  }

  // ── Formatierung ─────────────────────────────────────────────────────────
  function money(value) {
    return new Intl.NumberFormat("de-CH", { style: "currency", currency: "CHF" }).format(num(value));
  }

  function dateTime(value) {
    if (!value) return "—";
    try { return new Date(value).toLocaleString("de-CH", { dateStyle: "medium", timeStyle: "short" }); }
    catch (error) { return String(value); }
  }

  function dateOnly(value) {
    if (!value) return "—";
    try {
      var d = new Date(String(value).length <= 10 ? value + "T12:00:00" : value);
      return isNaN(d) ? String(value) : d.toLocaleDateString("de-CH", { dateStyle: "medium" });
    } catch (error) { return String(value); }
  }

  function safeUrl(value) {
    try {
      var url = new URL(String(value || ""));
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : "#";
    } catch (error) { return "#"; }
  }

  function empty(label) { return '<div class="ft-empty">' + esc(label) + "</div>"; }

  // ── Dokument-Mathematik ──────────────────────────────────────────────────
  // Betrag einer einzelnen Position — inklusive Positionsrabatt. Ältere
  // Dokumente kennen discountPercent auf der Position nicht; num() macht daraus
  // 0, der Betrag bleibt damit exakt wie vorher.
  function itemAmount(item) {
    var gross = num(item && item.qty) * num(item && item.price);
    return gross - gross * (num(item && item.discountPercent) / 100);
  }

  function docTotals(doc) {
    var items = Array.isArray(doc && doc.items) ? doc.items : [];
    var listed = items.reduce(function (sum, item) { return sum + num(item.qty) * num(item.price); }, 0);
    var subtotal = items.reduce(function (sum, item) { return sum + itemAmount(item); }, 0);
    var itemDiscount = listed - subtotal;
    var discount = subtotal * (num(doc && doc.discountPercent) / 100);
    var net = subtotal - discount;
    var vat = net * (num(doc && doc.vatRate) / 100);
    var gross = net + vat;
    return {
      listed: listed, itemDiscount: itemDiscount,
      subtotal: subtotal, discount: discount, net: net, vat: vat, gross: gross,
      rounded: Math.round(gross * 20) / 20      // Rappenrundung auf 5 Rappen
    };
  }

  // ── Dokument-Verlauf ─────────────────────────────────────────────────────
  // Jede Statusänderung wird mit Zeitpunkt festgehalten, damit im Dokument
  // nachvollziehbar bleibt, wann es versendet, angenommen oder bezahlt wurde.
  function pushHistory(doc, event, detail) {
    if (!doc) return;
    doc.history = Array.isArray(doc.history) ? doc.history : [];
    doc.history.unshift({ id: id(), event: event, detail: detail || "", at: now() });
    if (doc.history.length > 60) doc.history.length = 60;
  }

  // Eine Offerte gilt als abgelaufen, sobald das Gültigkeitsdatum vorbei ist und
  // sie weder angenommen noch abgelehnt wurde.
  function offerExpired(offer) {
    return offer && offer.status === "sent" && offer.validUntil && offer.validUntil < today();
  }

  function daysUntil(ymd) {
    if (!ymd) return null;
    var target = new Date(String(ymd).slice(0, 10) + "T12:00:00");
    if (isNaN(target)) return null;
    var base = new Date(today() + "T12:00:00");
    return Math.round((target - base) / 86400000);
  }

  function dueLabel(ymd) {
    var d = daysUntil(ymd);
    if (d === null) return "";
    if (d < 0) return Math.abs(d) + " Tage überfällig";
    if (d === 0) return "heute fällig";
    if (d === 1) return "morgen fällig";
    return "in " + d + " Tagen";
  }

  function nextNumber(kind) {
    var ft = state();
    var year = new Date().getFullYear();
    var key = kind + "_" + year;
    var used = docs(kind).map(function (doc) {
      var match = /-(\d{4})-(\d+)$/.exec(String(doc.number || ""));
      return match && Number(match[1]) === year ? Number(match[2]) : 0;
    });
    var highest = used.length ? Math.max.apply(null, used) : 0;
    var next = Math.max(num(ft.counters[key]), highest) + 1;
    ft.counters[key] = next;
    return (kind === "invoice" ? "RE-" : "OF-") + year + "-" + String(next).padStart(4, "0");
  }

  // Der Kundenprozess kommt aus dem geteilten Workflow-Kern, damit Pipeline,
  // Projektseite und Kundenansicht dieselben Phasen benennen. Die alten Phasen
  // bleiben als Zusatzeinträge lesbar, damit bestehende Projekte nichts verlieren.
  // Der Kundenprozess (identisch zu WORKFLOW_STAGES im geteilten Workflow-Kern).
  // Bewusst hier als Literal: flowertech.js ist ein klassisches Script und läuft
  // VOR dem deferred Modul — ein Zugriff auf window.FlowerTechWorkflow zur
  // Ladezeit wäre leer. Innerhalb der Funktionen wird das Modul lazy geholt.
  var STAGES = [
    ["lead", "Lead"], ["intake", "Bestandesaufnahme"], ["proposal", "Angebot / Vertrag"],
    ["build", "Umsetzung"], ["revision", "Änderungsrunde"], ["approval", "Freigabe / Abschluss"]
  ];
  // Die Bereiche von FlowerTech. Frueher waren sie eine horizontale Leiste
  // ueber dem Inhalt — eine zweite App-Navigation im Inhalt, direkt unter der
  // globalen. Die Leiste ist ersatzlos entfernt. Die Bereiche bleiben ueber
  // Deep Links (#/flowertech/<bereich>), die globale Suche (Cmd/Ctrl+K) und die
  // Einstiegskarten auf der Uebersicht erreichbar.
  var SECTIONS = [
    ["dashboard", "Übersicht", "🌸", "Zahlen, Projekte und letzte Anfragen auf einen Blick"],
    ["intakes", "Kundenanfragen", "📨", "Fragebogen anlegen, Link geben, Antworten sehen"],
    ["projects", "Projekte", "📦", "FlowerTech-Projekte anlegen und öffnen"],
    ["planung", "Planung", "🗓️", "Termine, Meilensteine und Fristen über alle Projekte"],
    ["tasks", "Aufgaben", "✅", "Alle FlowerTech-Aufgaben"],
    ["offers", "Offerten", "📄", "Offerten erstellen, versenden, nachfassen"],
    ["invoices", "Rechnungen", "🧾", "Rechnungen, Zahlungen, Mahnungen"],
    ["ai", "KI", "✨", "Textentwürfe, Statusberichte, Antworten"],
    ["leads", "Leads / Anfragen", "📥", "Anfragen von der Website"],
    ["pipeline", "Pipeline", "📊", "Projekte nach Phase"],
    ["finances", "Finanzen", "💰", "Einnahmen und Ausgaben"],
    ["notes", "Notizen", "📝", "Notizen zu FlowerTech"],
    ["links", "Links", "🔗", "Gesammelte Links"],
    ["videos", "Instagram-Videos", "🎬", "Videos und Veröffentlichungen"],
    ["settings", "Firma", "⚙️", "Firmendaten für Offerten und Rechnungen"]
  ];
  function sectionOf(key) {
    return SECTIONS.find(function (s) { return s[0] === key; }) || SECTIONS[0];
  }
  // Der Bereich steht im Hash (#/flowertech/offers), damit er verlinkbar,
  // teilbar und ueber die globale Suche erreichbar ist.
  function sectionFromHash() {
    var parts = String(location.hash || "").split("/");
    var key = parts[2] || "";
    return SECTIONS.some(function (s) { return s[0] === key; }) ? key : "";
  }

  // Alte Phasenschlüssel bleiben lesbar, tauchen aber nicht als Pipeline-Spalte auf.
  var LEGACY_STAGE_LABELS = { discovery: "Abklärung", won: "Gewonnen", lost: "Verloren" };

  var INQUIRY_STATUSES = [
    ["new", "Neu"], ["contacted", "Kontaktiert"], ["qualified", "Qualifiziert"],
    ["proposal", "Offerte"], ["won", "Gewonnen"], ["lost", "Verloren"]
  ];

  var OFFER_STATUSES = [
    ["draft", "Entwurf"], ["sent", "Versendet"], ["accepted", "Angenommen"],
    ["declined", "Abgelehnt"], ["expired", "Abgelaufen"]
  ];

  var INVOICE_STATUSES = [
    ["draft", "Entwurf"], ["sent", "Versendet"], ["paid", "Bezahlt"],
    ["overdue", "Überfällig"], ["cancelled", "Storniert"]
  ];

  function labelOf(list, value, fallback) {
    var hit = list.find(function (entry) { return entry[0] === value; });
    if (hit) return hit[1];
    if (list === STAGES && LEGACY_STAGE_LABELS[value]) return LEGACY_STAGE_LABELS[value];
    return fallback || value || "—";
  }

  function isOverdue(invoice) {
    return invoice.status === "sent" && invoice.dueDate && invoice.dueDate < today();
  }

  // ── Anfragen → Aufgaben (bestehendes Verhalten, unverändert) ─────────────
  function syncInquiryTasks(items) {
    var root = data();
    if (!root) return 0;
    root.entities = root.entities || {};
    root.entities.tasks = root.entities.tasks || {};
    var taskMap = root.entities.tasks;
    var known = new Set(Object.values(taskMap).map(function (task) {
      return task && task.sourceInquiryId;
    }).filter(Boolean));
    var created = 0;
    items.forEach(function (inquiry) {
      if (!inquiry || !inquiry.id || known.has(inquiry.id)) return;
      var taskId = "flowertech-inquiry-" + inquiry.id;
      taskMap[taskId] = {
        id: taskId,
        title: "FlowerTech-Anfrage: " + (inquiry.name || inquiry.email || inquiry.id),
        description: [
          inquiry.company ? "Unternehmen: " + inquiry.company : "",
          inquiry.email ? "E-Mail: " + inquiry.email : "",
          inquiry.phone ? "Telefon: " + inquiry.phone : "",
          "",
          inquiry.message || ""
        ].filter(function (line, index) { return line || index === 3; }).join("\n"),
        status: "todo",
        priority: 2,
        category: "flowertech",
        projectId: inquiry.projectId || null,
        source: "flowertech-inquiry",
        sourceInquiryId: inquiry.id,
        tags: ["flowertech", "anfrage"],
        createdAt: inquiry.createdAt || now(),
        updatedAt: inquiry.updatedAt || inquiry.createdAt || now()
      };
      known.add(inquiry.id);
      created++;
    });
    if (created) {
      root.meta = root.meta || {};
      root.meta.updatedAt = now();
      save();
    }
    return created;
  }

  // Eingänge aus den geteilten Links verarbeiten. Ein Eintrag wirkt genau
  // einmal (Idempotenz-Schlüssel) und nur, wenn sein Token zu einem Projekt
  // gehört. Unbekannte Token werden ignoriert, nicht geraten.
  function ingestSubmissions(raw) {
    var core = W();
    var ft = wf();
    if (!core || !ft) return 0;
    ft.processedSubmissions = ft.processedSubmissions && typeof ft.processedSubmissions === "object"
      ? ft.processedSubmissions : {};
    var byToken = {};
    Object.keys(ft.shares || {}).forEach(function (projectId) {
      var share = ft.shares[projectId] || {};
      // Jeder Token oeffnet genau die Wege, fuer die er gedacht ist — nicht
      // mehr. Der Portaltoken traegt Aenderungswunsch UND Offertenanfrage,
      // weil beides auf derselben Kundenseite steht.
      if (share.formToken) byToken[share.formToken] = { projectId: projectId, kinds: ["briefing"] };
      if (share.portalToken) byToken[share.portalToken] = { projectId: projectId, kinds: ["change", "quote"] };
      // Ohne diese Zeile findet eine Vision-Ausarbeitung (?v=…) ihren Vorgang
      // nie und liefe ins Leere.
      if (share.visionToken) byToken[share.visionToken] = { projectId: projectId, kinds: ["vision", "quote"] };
    });
    // Der Portaltoken traegt zusaetzlich Zustimmung und Rueckantwort.
    Object.keys(byToken).forEach(function (token) {
      if (byToken[token].kinds.indexOf("change") >= 0) {
        byToken[token].kinds = byToken[token].kinds.concat(["terms", "answer"]);
      }
    });
    // Einladungen zu Fragebögen sind ein eigener Kreis: ein Einladungstoken
    // oeffnet ausschliesslich seinen Fragebogen und nichts sonst.
    var byInvite = {};
    Object.keys(ft.intakes || {}).forEach(function (intakeId) {
      var intake = ft.intakes[intakeId] || {};
      if (intake.inviteToken) byInvite[intake.inviteToken] = intakeId;
    });
    var handled = 0;
    Object.keys(raw).forEach(function (key) {
      var entry = raw[key] || {};
      if (ft.processedSubmissions[key]) return;
      // Öffentlicher Vision Room (ohne Einladung): Das ist eine ANFRAGE, kein
      // Projekt. Ein Projekt entsteht ausschliesslich, wenn jemand den
      // Fragebogen tatsächlich absendet — vorher wäre es eine Behauptung.
      if (!entry.token && ["inquiry", "vision", "quote"].indexOf(entry.kind) >= 0) {
        if (createInquiryFromSubmission(entry)) handled++;
        ft.processedSubmissions[key] = now();
        return;
      }
      // Fragebogen: eigener Tokenkreis, eigener Weg. Der Vision Room gehört zu
      // DIESER Einladung — eine Vision-Eingabe mit Einladungstoken ist deshalb
      // eine Antwort auf denselben Fragebogen und niemals ein zweiter Vorgang.
      // Ein Änderungswunsch gehört dazu, sobald der Kundenbereich seine
      // Vorschau-Kachel zeigt: Dann ist derselbe Link auch der Weg, dazu
      // strukturiert Rückmeldung zu geben.
      if (["intake", "vision", "quote", "change"].indexOf(entry.kind) >= 0 && byInvite[entry.token]) {
        var intakeId = byInvite[entry.token];
        var done = entry.kind === "intake"
          ? applyIntakeSubmission(intakeId, entry)
          : entry.kind === "change"
            ? applyCustomerAreaChange(intakeId, entry)
            : applyVisionToIntake(intakeId, entry);
        if (done) handled++;
        ft.processedSubmissions[key] = now();
        return;
      }
      if (entry.kind === "intake") return;       // fremde oder widerrufene Einladung
      var match = byToken[entry.token];
      if (!match) return;                       // fremder oder abgelaufener Link
      // Ein Formular-Token darf keine Vision-Ausarbeitung einschleusen und
      // umgekehrt. Erlaubt ist nur, wofuer der Token ausgegeben wurde.
      if (match.kinds.indexOf(entry.kind) < 0) return;
      if (entry.kind === "briefing") {
        applyBriefing(match.projectId, entry.payload || {}, { createTasks: true });
        handled++;
      } else if (entry.kind === "vision") {
        applyVision(match.projectId, entry.payload || {});
        handled++;
      } else if (entry.kind === "quote") {
        if (applyQuoteRequest(match.projectId, entry.payload || {}, entry.id || key)) handled++;
      } else if (entry.kind === "terms") {
        if (applyTermsConsent(match.projectId, entry.payload || {})) handled++;
      } else if (entry.kind === "answer") {
        if (applyPortalAnswer(match.projectId, entry.payload || {})) handled++;
      } else if (entry.kind === "change") {
        var cr = core.normalizeChangeRequest(
          Object.assign({}, entry.payload || {}, { origin: "client" }), { now: now() });
        if (core.changeRequestIsUsable(cr)) { addChangeRequest(match.projectId, cr); handled++; }
      }
      ft.processedSubmissions[key] = now();
    });
    if (handled) save();
    return handled;
  }
  /* ── Öffentlicher Vision Room → ANFRAGE ─────────────────────────────────
     Ohne Einladung gibt es keinen Vorgang, an dem eine Eingabe hängen könnte.
     Sie wird deshalb zu einer Anfrage in der Leadliste — mit genau einem
     nächsten Schritt: „Fragebogen-Link kopieren". Ein Projekt entsteht erst,
     wenn die Kundschaft den Fragebogen tatsächlich absendet.

     Idempotenz: die Submission-ID steht an der Anfrage. Ein erneuter Import
     legt keine zweite Anfrage an.
     ------------------------------------------------------------------- */
  function createInquiryFromSubmission(entry) {
    var core = W();
    var ft = state();
    if (!core || !ft) return false;
    var inquiryId = "ftq_" + String(entry.id || id()).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    ft.inquiries = ft.inquiries && typeof ft.inquiries === "object" ? ft.inquiries : {};
    if (ft.inquiries[inquiryId]) return false;
    var inquiry = core.inquiryFromVision(entry.payload || {}, {
      now: entry.createdAt || now(), id: inquiryId,
    });
    if (!core.inquiryFromVisionIsUsable(inquiry)) return false;
    inquiry.submissionId = entry.id || null;
    ft.inquiries[inquiryId] = inquiry;
    syncInquiryTasks([inquiry]);
    save();
    notify("ok", "Anfrage", "Neue Anfrage aus dem Vision Room — schick ihr den Fragebogen-Link.");
    return true;
  }
  window._ftCreateInquiryFromSubmission = createInquiryFromSubmission;

  /* ── Vision Room innerhalb derselben Einladung ───────────────────────────
     Kommt eine Vision-Eingabe mit dem Einladungstoken herein (etwa weil sie
     getrennt abgeschickt wurde), gehört sie zu genau diesem Fragebogen. Sie
     wird als Antwort auf die Vision-Fragen übernommen — nicht als zweiter
     Vorgang. Wurde der Fragebogen schon beantwortet, ergänzt sie das
     bestehende Projekt und den Prompt.
     ------------------------------------------------------------------- */
  function applyVisionToIntake(intakeId, entry) {
    var core = W();
    var intake = intakeById(intakeId);
    if (!core || !intake) return false;
    var payload = entry.payload || {};
    var idea = String(payload.idea || payload.need || "").trim();
    var features = Array.isArray(payload.features) ? payload.features : [];
    if (!idea && !features.length) return false;

    var keys = core.VISION_QUESTION_KEYS;
    intake.visionDraft = {
      idea: idea, features: features,
      submissionId: entry.id || null, submittedAt: entry.createdAt || now(),
    };
    intake.updatedAt = now();

    // Noch keine Antwort UND kein gebundenes Projekt? Dann wartet die Vision
    // auf das Absenden des Fragebogens — sie erzeugt bewusst nichts von sich
    // aus. Hängt der Fragebogen an einem bestehenden Projekt, gehört sie
    // dorthin; auch dann entsteht kein zweiter Vorgang.
    var target = core.intakeBinding(intake).projectId;
    if (!target) { save(); return true; }

    var project = projectById(target);
    if (!project) { save(); return true; }
    var doc = project.ftIntakeDocument || { answers: [] };
    doc.answers = (doc.answers || []).map(function (a) {
      if (a.key === keys.idea && idea) return Object.assign({}, a, { answer: idea });
      if (a.key === keys.features && features.length) {
        var known = String(a.answer || "").split("\n").map(function (v) { return v.trim(); }).filter(Boolean);
        features.forEach(function (f) { if (known.indexOf(f) < 0) known.push(f); });
        return Object.assign({}, a, { answer: known.join("\n") });
      }
      return a;
    });
    project.ftIntakeDocument = doc;
    project.ftVision = { idea: idea, features: features, source: "fragebogen", submittedAt: now() };
    project.updatedAt = now();
    regeneratePrompt(target);
    save();
    notify("ok", "Vision Room", "Ergänzung zum Fragebogen übernommen");
    return true;
  }
  window._ftApplyVisionToIntake = applyVisionToIntake;

  /* ── Offertenanfrage der Kundschaft ──────────────────────────────────────
     Produktentscheidung: FlowerTech erzeugt keine leere Offerte auf Verdacht
     und schickt auch keinen Mail-Entwurf. Die Kundschaft fuellt ueber ihren
     eigenen flowertech.ch-Link aus, was sie braucht — erst dieses Absenden
     erzeugt hier eine echte Offertenanfrage und GENAU EINE Folgeaufgabe.

     Idempotenz auf zwei Ebenen: processedSubmissions (der Eingang wirkt
     einmal) und submissionId am Vorgang (auch ein erneuter Import legt nichts
     doppelt an). Bestehende Angaben werden ergaenzt, nie ueberschrieben und
     nie geloescht.
     ------------------------------------------------------------------- */
  function quoteTaskKey(projectId, quote) {
    return projectId + ":quote:" + (quote.submissionId || quote.id);
  }

  // GENAU eine Aufgabe pro Anfrage — der Schluessel verhindert Doppel.
  function createQuoteTask(projectId, quote, project) {
    var core = W();
    var root = data();
    if (!core || !root) return "";
    var key = quoteTaskKey(projectId, quote);
    var existing = Object.keys(root.entities.tasks || {}).find(function (taskId) {
      var task = root.entities.tasks[taskId];
      return task && task.sourceQuoteKey === key;
    });
    if (existing) return existing;
    var draft = core.buildQuoteRequestTask(quote, projectId, { now: now(), project: project || {} });
    var payload = Object.assign({}, draft);
    delete payload.key;
    payload.sourceQuoteKey = key;
    return window.createEntity("task", payload) || "";
  }

  // Vorhandenes bleibt stehen. Ergaenzt wird nur, was noch leer ist.
  function fillFromQuote(project, quote) {
    var client = project.client = project.client || {};
    if (quote.company && !client.company) client.company = quote.company;
    if (quote.contactName && !client.name) client.name = quote.contactName;
    if (quote.contactEmail && !client.email) client.email = quote.contactEmail;
    if (quote.contactPhone && !client.phone) client.phone = quote.contactPhone;
    if (quote.address && !client.street) client.street = quote.address;
    if (quote.budget != null && project.budget == null) project.budget = quote.budget;
    if (quote.deadline && !project.dueDate) project.dueDate = quote.deadline;
    if (quote.deliveryType && !project.deliveryType) project.deliveryType = quote.deliveryType;
  }

  function applyQuoteRequest(projectId, payload, submissionId) {
    var core = W();
    var ft = wf();
    var project = projectById(projectId);
    if (!core || !ft || !project) return false;
    var quote = core.normalizeQuoteRequest(payload, { now: now() });
    // Ueber den Portaltoken ist der Vorgang bereits zugeordnet — die E-Mail ist
    // dort freiwillig. Pflicht ist allein der Bedarf.
    if (!core.quoteRequestIsUsable(quote)) return false;

    var list = project.ftQuoteRequests = Array.isArray(project.ftQuoteRequests) ? project.ftQuoteRequests : [];
    if (submissionId && list.some(function (q) { return q.submissionId === submissionId; })) return false;
    quote.id = id();
    quote.submissionId = submissionId || null;
    list.unshift(quote);
    if (list.length > 40) list.length = 40;
    project.ftQuoteRequest = quote;
    fillFromQuote(project, quote);

    var taskId = createQuoteTask(projectId, quote, project);
    if (taskId) quote.taskId = taskId;

    var log = project.ftContactLog = Array.isArray(project.ftContactLog) ? project.ftContactLog : [];
    log.unshift({
      id: id(), at: now(), channel: "note",
      text: "Offertenanfrage der Kundschaft eingegangen (" +
        (quote.source === "vision-room" ? "Vision Room" : "Kundenseite") + ").",
    });
    project.updatedAt = now();
    save();
    refreshClientPortal(projectId);
    notify("ok", "Offertenanfrage", "Neue Offertenanfrage: " + core.quoteRequestLabel(quote, project));
    return true;
  }
  window._ftApplyQuoteRequest = applyQuoteRequest;

  /* Es gibt genau EINEN Weg in ein Projekt: das Absenden eines Fragebogens.
     Der frühere Zweig „Vision Room → Direktprojekt" ist bewusst entfernt —
     zwei Wege in denselben Zustand driften auseinander, und ein Projekt vor
     der Antwort der Kundschaft ist eine Behauptung, keine Tatsache. Eine
     Vision-Room-Eingabe ohne Einladung wird zur Anfrage (siehe
     createInquiryFromSubmission), mit Einladung zur Antwort auf denselben
     Fragebogen (siehe applyVisionToIntake). */

  // Die AGB-Zustimmung wird als Ereignis festgehalten: Fassung und Zeitpunkt.
  // Eine bereits erteilte Zustimmung zur selben Fassung wirkt nicht doppelt.
  function applyTermsConsent(projectId, payload) {
    var project = projectById(projectId);
    if (!project || payload.accepted !== true) return false;
    var version = String(payload.version || "").trim();
    if (!version) return false;
    var current = project.ftTermsConsent || null;
    if (current && current.version === version && current.acceptedAt) return false;
    project.ftTermsConsent = { version: version, acceptedAt: payload.acceptedAt || now() };
    project.ftContactLog = Array.isArray(project.ftContactLog) ? project.ftContactLog : [];
    project.ftContactLog.unshift({
      id: id(), at: now(), channel: "note",
      text: "AGB-Fassung " + version + " im Kundenportal ausdrücklich zugestimmt.",
    });
    project.updatedAt = now();
    save();
    refreshClientPortal(projectId);
    notify("ok", "AGB", "Zustimmung eingegangen (Fassung " + version + ")");
    return true;
  }
  window._ftApplyTermsConsent = applyTermsConsent;

  // Antwort auf eine Rueckfrage. Eine bereits beantwortete Frage wird nicht
  // ueberschrieben — sonst ginge der Verlauf der Kommunikation verloren.
  function applyPortalAnswer(projectId, payload) {
    var core = W();
    var project = projectById(projectId);
    if (!core || !project) return false;
    var list = project.ftPortalQuestions || [];
    var hit = list.find(function (q) { return q.id === String(payload.questionId || ""); });
    if (!hit || String(hit.answer || "").trim()) return false;
    hit.answer = String(payload.answer || "").slice(0, 4000);
    hit.answeredAt = payload.answeredAt || now();
    project.updatedAt = now();
    save();
    refreshClientPortal(projectId);
    notify("ok", "Kundenportal", "Antwort der Kundschaft eingegangen");
    return true;
  }
  window._ftApplyPortalAnswer = applyPortalAnswer;

  // Vision-Ausarbeitung zu einer bestehenden Offerte: sie ergaenzt den Bedarf
  // des vorhandenen Projekts, statt ein zweites anzulegen.
  function applyVision(projectId, payload) {
    var core = W();
    var ft = wf();
    var project = projectById(projectId);
    if (!core || !ft || !project) return;
    var vision = core.normalizeVisionSubmission(payload, { now: now() });
    if (!core.visionIsUsable(vision)) return;
    project.ftVision = vision;
    project.updatedAt = now();
    // Der Bedarf wird ergaenzt, nicht ersetzt — Gepflegtes bleibt stehen.
    var briefing = ft.briefings[projectId];
    if (!briefing) {
      applyBriefing(projectId, {
        contactEmail: vision.contactEmail, deliveryType: vision.deliveryType,
        goal: vision.idea, features: vision.features, source: "vision-room",
      }, { createTasks: true });
    } else {
      var known = new Set(briefing.features || []);
      vision.features.forEach(function (f) { if (!known.has(f)) briefing.features.push(f); });
      createBriefingTasks(projectId, briefing);
      save();
    }
    notify("ok", "Vision Room", "Ausarbeitung der Kundschaft übernommen");
  }
  window._ftApplyVision = applyVision;

  window._ftIngestSubmissions = ingestSubmissions;

  function stopListeners() {
    try { if (inquiryRef) inquiryRef.off(); } catch (error) {}
    try { if (videoRef) videoRef.off(); } catch (error) {}
    try { if (submissionRef) submissionRef.off(); } catch (error) {}
    inquiryRef = null;
    videoRef = null;
    submissionRef = null;
  }

  function routeIsFlowerTech() {
    return String(location.hash || "").split("/")[1] === "flowertech";
  }

  function initializeSync() {
    if (initialized || !state()) return;
    initialized = true;
    if (!window.firebase || !firebase.auth || !firebase.app) {
      state().syncStatus = "unavailable";
      return;
    }
    firebase.auth().onAuthStateChanged(function (user) {
      stopListeners();
      var ft = state();
      if (!ft) return;
      if (!user) {
        ft.syncStatus = "login_required";
        if (routeIsFlowerTech()) rerender();
        return;
      }
      try {
        var db = firebase.app().database(RTDB);
        inquiryRef = db.ref("flowertech/inquiries");
        videoRef = db.ref("flowertech/videos");
        ft.syncStatus = "syncing";

        inquiryRef.on("value", function (snapshot) {
          var raw = snapshot.val() || {};
          ft.inquiries = raw;
          var list = Object.entries(raw).map(function (entry) {
            return Object.assign({ id: entry[0] }, entry[1] || {});
          });
          var created = syncInquiryTasks(list);
          ft.lastSyncAt = now();
          ft.syncStatus = "connected";
          if (!created) save();
          if (routeIsFlowerTech()) rerender();
        }, function (error) {
          ft.syncStatus = "error";
          console.warn("[FlowerTech] Inquiry-Sync:", error && error.message);
          if (routeIsFlowerTech()) rerender();
        });

        // Kundeneingänge aus den geteilten Links (Bedarfsformular, Änderungs-
        // wünsche). Zuordnung ausschliesslich über den Freigabe-Token des
        // Projekts — nichts wird „irgendwie" erraten.
        submissionRef = db.ref("flowertech/submissions");
        submissionRef.on("value", function (snapshot) {
          try { ingestSubmissions(snapshot.val() || {}); }
          catch (error) { console.warn("[FlowerTech] Eingänge:", error && error.message); }
          if (routeIsFlowerTech() || /#\/projects\//.test(location.hash)) rerender();
        }, function (error) {
          console.warn("[FlowerTech] Eingangs-Sync:", error && error.message);
        });

        videoRef.on("value", function (snapshot) {
          ft.videos = snapshot.val() || {};
          ft.lastSyncAt = now();
          ft.syncStatus = "connected";
          save();
          if (routeIsFlowerTech()) rerender();
        }, function (error) {
          ft.syncStatus = "error";
          console.warn("[FlowerTech] Video-Sync:", error && error.message);
        });
      } catch (error) {
        ft.syncStatus = "error";
        console.warn("[FlowerTech] Firebase:", error.message);
      }
    });
  }

  // ==========================================================================
  //  Aktionen
  // ==========================================================================
  // Bereichswechsel = Navigation. Der Hash ist die Wahrheit, damit ein Bereich
  // verlinkbar bleibt und Zurueck/Vor im Browser funktioniert.
  function setActiveTab(tab) {
    var ft = state();
    if (!ft) return;
    ft.activeTab = tab;
    ft.ui.docId = null;
    save();
  }
  window._ftSetTab = function (tab) {
    setActiveTab(tab);
    var target = "#/flowertech" + (tab && tab !== "dashboard" ? "/" + tab : "");
    if (location.hash === target) rerender();
    else location.hash = target;
  };

  // Ein FlowerTech-Projekt hat keine eigene, abgespeckte Ansicht mehr. Es wird
  // auf der ganz normalen Quantus-Projektseite geöffnet — dieselbe Tiefe wie
  // jedes andere Projekt (Aufgaben, Notizen, Zeit, Verknüpfungen, Mail-Verlauf).
  // Die FlowerTech-Zusätze (Pipeline, Offerten, Rechnungen, Planung) hängt
  // ftProjectPanel() dort als eigener Block ein.
  window._ftOpenProject = function (projectId) {
    if (!projectId) return;
    var ft = state();
    if (ft) { ft.ui.docId = null; save(); }
    location.hash = "#/projects/" + projectId;
  };

  window._ftCreateProject = function () {
    var title = ((document.getElementById("ftProjectTitle") || {}).value || "").trim();
    var description = ((document.getElementById("ftProjectDescription") || {}).value || "").trim();
    if (!title) return notify("warn", "FlowerTech", "Projektname erforderlich");
    var projectId = window.createEntity("project", {
      title: title,
      description: description,
      status: "active",
      projectType: "flowertech",
      pipelineStage: "lead",
      tags: ["flowertech"]
    });
    save();
    notify("ok", "FlowerTech", "Projekt erstellt");
    if (projectId) window._ftOpenProject(projectId);
    else rerender();
  };

  window._ftSetProjectStage = function (projectId, stage) {
    var project = projectById(projectId);
    if (!project) return;
    project.pipelineStage = stage;
    project.updatedAt = now();
    save();
    refreshClientPortal(projectId);
    rerender();
  };

  window._ftSetProjectField = function (projectId, field, value) {
    var project = projectById(projectId);
    if (!project) return;
    project[field] = value;
    project.updatedAt = now();
    save();
    refreshClientPortal(projectId);
  };

  window._ftCreateTask = function () {
    var title = ((document.getElementById("ftTaskTitle") || {}).value || "").trim();
    var projectId = (document.getElementById("ftTaskProject") || {}).value || null;
    if (!title) return notify("warn", "FlowerTech", "Aufgabentitel erforderlich");
    window.createEntity("task", {
      title: title, projectId: projectId || null, status: "todo", priority: 3,
      category: "flowertech", tags: ["flowertech"]
    });
    save();
    notify("ok", "FlowerTech", "Aufgabe erstellt");
    rerender();
  };

  window._ftToggleTask = function (taskId) {
    var root = data();
    var task = root && root.entities && root.entities.tasks && root.entities.tasks[taskId];
    if (!task) return;
    task.status = task.status === "done" ? "todo" : "done";
    task.completedAt = task.status === "done" ? now() : null;
    task.updatedAt = now();
    save();
    rerender();
  };

  // ── Finanzen ─────────────────────────────────────────────────────────────
  window._ftAddFinance = function () {
    var title = ((document.getElementById("ftFinanceTitle") || {}).value || "").trim();
    var amount = num((document.getElementById("ftFinanceAmount") || {}).value);
    var type = (document.getElementById("ftFinanceType") || {}).value || "income";
    if (!title || amount <= 0) return notify("warn", "FlowerTech", "Titel und positiver Betrag erforderlich");
    state().finances.unshift({ id: id(), title: title, amount: amount, type: type, date: today(), createdAt: now() });
    save();
    rerender();
  };

  window._ftDeleteFinance = function (entryId) {
    var ft = state();
    ft.finances = ft.finances.filter(function (entry) { return entry.id !== entryId; });
    save();
    rerender();
  };

  // ── Notizen & Links ──────────────────────────────────────────────────────
  window._ftAddNote = function (projectId) {
    var title = ((document.getElementById("ftNoteTitle") || {}).value || "").trim();
    var content = ((document.getElementById("ftNoteContent") || {}).value || "").trim();
    if (!title && !content) return notify("warn", "FlowerTech", "Notiz ist leer");
    state().notes.unshift({
      id: id(), title: title || "Notiz", content: content,
      projectId: projectId || null, createdAt: now(), updatedAt: now()
    });
    save();
    rerender();
  };

  window._ftDeleteNote = function (entryId) {
    var ft = state();
    ft.notes = ft.notes.filter(function (entry) { return entry.id !== entryId; });
    save();
    rerender();
  };

  window._ftAddLink = function (projectId) {
    var title = ((document.getElementById("ftLinkTitle") || {}).value || "").trim();
    var url = safeUrl(((document.getElementById("ftLinkUrl") || {}).value || "").trim());
    if (!title || url === "#") return notify("warn", "FlowerTech", "Titel und gültige URL erforderlich");
    state().links.unshift({ id: id(), title: title, url: url, projectId: projectId || null, createdAt: now() });
    save();
    rerender();
  };

  window._ftDeleteLink = function (entryId) {
    var ft = state();
    ft.links = ft.links.filter(function (entry) { return entry.id !== entryId; });
    save();
    rerender();
  };

  // ── Leads ────────────────────────────────────────────────────────────────
  window._ftSetInquiryStatus = async function (inquiryId, status) {
    var ft = state();
    if (ft.inquiries[inquiryId]) {
      ft.inquiries[inquiryId].status = status;
      ft.inquiries[inquiryId].updatedAt = now();
    }
    try {
      await firebase.app().database(RTDB)
        .ref("flowertech/inquiries/" + inquiryId).update({ status: status, updatedAt: now() });
      save();
      rerender();
    } catch (error) {
      notify("err", "FlowerTech", "Status konnte nicht gespeichert werden");
    }
  };

  // Anfrage → Projekt: ein Prozessschritt, nicht nur ein Knopf. In einem Zug
  // entstehen Projekt, Freigabe-Links und ein Bedarfsentwurf aus der Nachricht;
  // die bereits angelegte Anfrage-Aufgabe wird dem Projekt zugeordnet und die
  // Anfrage als umgewandelt markiert, damit kein zweites Projekt entsteht.
  // Ohne ausdrueckliche Wahl wird KEIN Weg gestartet: der Klick oeffnet die
  // Wahl "Offerte zuerst / Direktprojekt" statt still ein Projekt anzulegen.
  window._ftInquiryToProject = function (inquiryId, route) {
    var core = W();
    var ft = wf();
    var inquiry = (state().inquiries || {})[inquiryId];
    if (!core || !ft || !inquiry) return;
    if (!core.ROUTES.some(function (r) { return r.key === route; })) {
      ft.ui.routeChoice = { inquiryId: inquiryId };
      save();
      return rerender();
    }
    ft.ui.routeChoice = null;

    // Schon umgewandelt? Dann das bestehende Projekt oeffnen statt ein zweites
    // anzulegen.
    var existing = projects().find(function (p) { return p.sourceInquiryId === inquiryId; });
    if (existing) {
      notify("ok", "FlowerTech", "Diese Anfrage ist bereits ein Projekt");
      return window._ftOpenProject(existing.id);
    }

    var built = core.projectFromInquiry(
      Object.assign({ id: inquiryId }, inquiry), { now: now(), route: route });
    var projectId = window.createEntity("project", built.project);
    if (!projectId) return rerender();

    // Freigabe-Links sofort bereitstellen — der naechste Schritt ist das
    // Bedarfsformular.
    ensureToken(projectId, "formToken");

    // Der Bedarf startet mit dem, was der Kunde schon geschrieben hat.
    if (built.briefing) ft.briefings[projectId] = built.briefing;

    // Die aus der Anfrage entstandene Aufgabe gehoert ab jetzt zum Projekt.
    var root = data();
    var task = root && root.entities.tasks && root.entities.tasks["flowertech-inquiry-" + inquiryId];
    if (task && !task.projectId) { task.projectId = projectId; task.updatedAt = now(); }

    // Anfrage als umgewandelt markieren.
    inquiry.projectId = projectId;
    inquiry.status = "qualified";
    inquiry.updatedAt = now();

    var project = projectById(projectId);
    if (project) {
      project.ftContactLog = [{
        id: id(), at: now(), channel: "note",
        text: "Aus Website-Anfrage übernommen" + (inquiry.email ? " (" + inquiry.email + ")" : "") + ".",
      }];
    }

    save();
    notify("ok", "FlowerTech", built.briefing
      ? "Projekt erstellt — Bedarf aus der Anfrage übernommen"
      : "Projekt aus Anfrage erstellt");
    window._ftOpenProject(projectId);
  };

  // ── Offerten & Rechnungen ────────────────────────────────────────────────
  function blankDoc(kind, projectId) {
    var ft = state();
    var project = projectId ? projectById(projectId) : null;
    var client = (project && project.client) || {};
    var doc = {
      id: id(),
      kind: kind,
      // Eine leere Offerte ist keine Offerte. Sie bekommt ihre OF-Nummer erst,
      // wenn sie vollstaendig ist und tatsaechlich rausgeht — sonst entstuende
      // sofort eine numerierte CHF-0.00-Offerte, die es gar nicht gibt, und die
      // Nummernfolge haette Luecken aus verworfenen Entwuerfen.
      number: kind === "invoice" ? nextNumber(kind) : "",
      status: "draft",
      projectId: projectId || null,
      client: {
        name: client.name || "", company: client.company || "", email: client.email || "",
        phone: client.phone || "", street: client.street || "", zip: client.zip || "", city: client.city || ""
      },
      title: project ? project.title : (kind === "invoice" ? "Rechnung" : "Offerte"),
      reference: "",                 // „Ihre Referenz" / Bestellnummer des Kunden
      contactPerson: client.name || "",
      periodFrom: "",                // Leistungszeitraum von / bis
      periodTo: "",
      paymentTerms: kind === "invoice"
        ? num(ft.company.paymentDays, 30) + " Tage netto"
        : "Zahlbar nach Aufwand gemäss Vereinbarung",
      terms: "",                     // Konditionen / Bemerkungen zum Vertrag
      notesInternal: "",             // nur intern, erscheint nie im Druck
      history: [],
      intro: kind === "invoice"
        ? "Vielen Dank für die gute Zusammenarbeit. Wir erlauben uns, folgende Leistungen in Rechnung zu stellen:"
        : "Vielen Dank für Ihre Anfrage. Gerne unterbreiten wir Ihnen folgende Offerte:",
      outro: kind === "invoice"
        ? "Zahlbar innert " + num(ft.company.paymentDays, 30) + " Tagen."
        : "Wir freuen uns auf die Zusammenarbeit.",
      items: [{ id: id(), description: "", detail: "", qty: 1, unit: "Pauschal", price: 0, discountPercent: 0 }],
      vatRate: num(ft.company.vatRate, VAT_DEFAULT),
      discountPercent: 0,
      currency: "CHF",
      issueDate: today(),
      createdAt: now(),
      updatedAt: now()
    };
    if (kind === "invoice") {
      doc.dueDate = addDays(today(), num(ft.company.paymentDays, 30));
      doc.qr = null;
      doc.paidAt = null;
    } else {
      doc.validUntil = addDays(today(), 30);
    }
    return doc;
  }

  window._ftNewDoc = function (kind, projectId) {
    var ft = state();
    var doc = blankDoc(kind, projectId || null);
    pushHistory(doc, "created", (kind === "invoice" ? "Rechnung" : "Offerte") + " angelegt");
    docs(kind).unshift(doc);
    // Ohne Projekt: in den passenden FlowerTech-Reiter wechseln. Mit Projekt
    // bleibt man auf der Projektseite — dort öffnet ftProjectPanel() denselben
    // Editor direkt beim Projekt.
    if (!projectId) setActiveTab(kind === "invoice" ? "invoices" : "offers");
    ft.ui.docId = doc.id;
    ft.ui.docKind = kind;
    save();
    rerender();
  };

  window._ftOpenDoc = function (kind, docId) {
    var ft = state();
    ft.ui.docId = ft.ui.docId === docId ? null : docId;
    ft.ui.docKind = kind;
    save();
    rerender();
  };

  window._ftDeleteDoc = function (kind, docId) {
    var ft = state();
    var doc = docById(kind, docId);
    if (!doc) return;
    if (!confirm((kind === "invoice" ? "Rechnung " : "Offerte ") + (doc.number || "") + " wirklich löschen?")) return;
    if (kind === "invoice") ft.invoices = ft.invoices.filter(function (entry) { return entry.id !== docId; });
    else ft.offers = ft.offers.filter(function (entry) { return entry.id !== docId; });
    if (ft.ui.docId === docId) ft.ui.docId = null;
    save();
    rerender();
  };

  // Feldänderung ohne Re-Render — der Fokus bleibt im Eingabefeld.
  window._ftDocSet = function (kind, docId, field, value) {
    var doc = docById(kind, docId);
    if (!doc) return;
    if (field === "vatRate" || field === "discountPercent") value = num(value);
    doc[field] = value;
    doc.updatedAt = now();
    save();
    refreshTotals(kind, docId);
  };

  window._ftDocClientSet = function (kind, docId, field, value) {
    var doc = docById(kind, docId);
    if (!doc) return;
    doc.client = doc.client || {};
    doc.client[field] = value;
    doc.updatedAt = now();
    save();
  };

  // Die Beilage ist verbindlich: Eine Offerte darf erst raus, wenn sie
  // vollstaendig ist. Geprueft wird GENAU im Versandpfad — eine Anzeige allein
  // haette sich mit einem Klick auf "Versendet" umgehen lassen.
  function offerReadyToSend(doc) {
    var core = W();
    if (!core) return { ready: true, reason: "" };
    // Zuerst die Pflichtdaten: ohne Kunde, ohne Leistung oder ohne Preis ist es
    // keine Offerte, sondern weiterhin eine Offertenanfrage. Sie als versendet
    // zu markieren erzeugte eine falsche Versandhistorie.
    var basis = core.offerSendableState({ doc: doc, total: docTotals(doc).rounded });
    if (!basis.ready) return { ready: false, reason: basis.reason, missing: basis.missing };
    var project = doc && doc.projectId ? projectById(doc.projectId) : null;
    if (!project) return { ready: true, reason: "" };
    if (core.routeOf(project, docs("offer")) !== "offer_first") return { ready: true, reason: "" };
    var attachment = project.ftOfferAttachment || {};
    var state = core.offerAttachmentState({
      kind: attachment.kind,
      visionToken: attachment.visionToken,
      exampleUrl: attachment.exampleUrl,
    });
    return { ready: state.ready, reason: state.reason };
  }
  window._ftOfferReadyToSend = offerReadyToSend;

  // Beim Versand wandert die Beilage in das Dokument selbst — sie steht damit
  // im gedruckten und im gemailten Angebot, nicht nur in einem Projektfeld.
  function attachToOfferDoc(doc) {
    var core = W();
    var project = doc && doc.projectId ? projectById(doc.projectId) : null;
    if (!core || !project) return;
    var attachment = project.ftOfferAttachment || {};
    if (attachment.kind === "vision") {
      var link = visionLinkFor(project.id);
      if (!link) return;
      doc.attachment = { kind: "vision", label: "Vision Room", url: link, addedAt: now() };
    } else if (attachment.kind === "example" && core.isHttpUrl(attachment.exampleUrl)) {
      doc.attachment = {
        kind: "example", label: "Website-Beispiel",
        url: String(attachment.exampleUrl).trim(), addedAt: now(),
      };
    }
  }

  // Die Nummer entsteht genau dann, wenn aus der Anfrage eine echte Offerte
  // wird. Vorhandene Nummern bleiben unberuehrt.
  function assignOfferNumber(doc) {
    if (!doc || doc.number) return doc && doc.number;
    doc.number = nextNumber(doc.kind || "offer");
    pushHistory(doc, "number", "Offertennummer " + doc.number + " vergeben");
    return doc.number;
  }
  window._ftAssignOfferNumber = assignOfferNumber;

  window._ftDocStatus = function (kind, docId, status) {
    var doc = docById(kind, docId);
    if (!doc || doc.status === status) return;
    if (kind === "offer" && status === "sent") {
      var gate = offerReadyToSend(doc);
      if (!gate.ready) {
        notify("warn", "Offerte", gate.reason + " Der Versand ist bis dahin blockiert.");
        return;
      }
      attachToOfferDoc(doc);
      assignOfferNumber(doc);
    }
    var list = kind === "invoice" ? INVOICE_STATUSES : OFFER_STATUSES;
    pushHistory(doc, "status", labelOf(list, doc.status) + " → " + labelOf(list, status));
    doc.status = status;
    doc.updatedAt = now();
    if (status === "sent" && !doc.sentAt) doc.sentAt = now();
    if (kind === "invoice" && status === "paid" && !doc.paidAt) {
      doc.paidAt = now();
      bookInvoicePayment(doc);
    }
    // Der Versand ist der Auslöser der Stufe 2: GENAU DER Kundenlink, den die
    // Kundschaft schon hat, trägt ab jetzt zusätzlich die Kachel „Offerte".
    // Ein Entwurf löst das nie aus — hierher kommt nur ein echter Versand.
    if (kind === "offer" && status === "sent" && doc.projectId) {
      if (window._ftRefreshCustomerArea(doc.projectId)) {
        notify("ok", "Kundenbereich", "Die Offerte steht jetzt im Kundenbereich — derselbe Link wie bisher.");
      }
    }
    if (kind === "offer" && status === "accepted") {
      if (!doc.acceptedAt) doc.acceptedAt = now();
      if (doc.projectId) {
        var project = projectById(doc.projectId);
        if (project && project.pipelineStage !== "won") { project.pipelineStage = "build"; project.updatedAt = now(); }
      }
    }
    save();
    rerender();
  };

  function bookInvoicePayment(invoice) {
    var ft = state();
    if (ft.finances.some(function (entry) { return entry.invoiceId === invoice.id; })) return;
    ft.finances.unshift({
      id: id(),
      invoiceId: invoice.id,
      title: "Rechnung " + (invoice.number || "") +
        ((invoice.client && invoice.client.company) ? " · " + invoice.client.company : ""),
      amount: docTotals(invoice).rounded,
      type: "income",
      date: today(),
      createdAt: now()
    });
    notify("ok", "FlowerTech", "Zahlung in den Finanzen verbucht");
  }

  window._ftItemSet = function (kind, docId, itemId, field, value) {
    var doc = docById(kind, docId);
    if (!doc) return;
    var item = (doc.items || []).find(function (entry) { return entry.id === itemId; });
    if (!item) return;
    item[field] = (field === "qty" || field === "price" || field === "discountPercent") ? num(value) : value;
    doc.updatedAt = now();
    save();
    var cell = document.getElementById("ftRow_" + itemId);
    if (cell) cell.textContent = money(itemAmount(item));
    refreshTotals(kind, docId);
  };

  window._ftAddItem = function (kind, docId) {
    var doc = docById(kind, docId);
    if (!doc) return;
    doc.items = doc.items || [];
    doc.items.push({ id: id(), description: "", detail: "", qty: 1, unit: "Std.", price: 0, discountPercent: 0 });
    doc.updatedAt = now();
    save();
    rerender();
  };

  window._ftRemoveItem = function (kind, docId, itemId) {
    var doc = docById(kind, docId);
    if (!doc) return;
    doc.items = (doc.items || []).filter(function (item) { return item.id !== itemId; });
    doc.updatedAt = now();
    save();
    rerender();
  };

  function refreshTotals(kind, docId) {
    var doc = docById(kind, docId);
    var host = document.getElementById("ftTotals_" + docId);
    if (!doc || !host) return;
    host.innerHTML = totalsHtml(doc);
  }

  window._ftOfferToInvoice = function (offerId) {
    var ft = state();
    var offer = docById("offer", offerId);
    if (!offer) return;
    if (offer.invoiceId && docById("invoice", offer.invoiceId)) {
      notify("warn", "FlowerTech", "Aus dieser Offerte wurde bereits eine Rechnung erstellt");
      setActiveTab("invoices");
      ft.ui.docId = offer.invoiceId;
      save();
      return rerender();
    }
    var invoice = JSON.parse(JSON.stringify(offer));
    invoice.id = id();
    invoice.kind = "invoice";
    invoice.number = nextNumber("invoice");
    invoice.status = "draft";
    invoice.issueDate = today();
    invoice.dueDate = addDays(today(), num(ft.company.paymentDays, 30));
    invoice.validUntil = null;
    invoice.qr = null;
    invoice.paidAt = null;
    invoice.invoiceId = null;
    invoice.fromOfferId = offer.id;
    invoice.intro = "Vielen Dank für Ihren Auftrag. Wir erlauben uns, folgende Leistungen in Rechnung zu stellen:";
    invoice.outro = "Zahlbar innert " + num(ft.company.paymentDays, 30) + " Tagen.";
    invoice.createdAt = now();
    invoice.updatedAt = now();
    ft.invoices.unshift(invoice);
    offer.invoiceId = invoice.id;
    if (offer.status === "draft" || offer.status === "sent") offer.status = "accepted";
    offer.updatedAt = now();
    setActiveTab("invoices");
    ft.ui.docId = invoice.id;
    ft.ui.docKind = "invoice";
    save();
    notify("ok", "FlowerTech", "Rechnung " + invoice.number + " aus Offerte erstellt");
    rerender();
  };

  // ── Planung: Meilensteine je Projekt ────────────────────────────────────
  // Ein Meilenstein ist bewusst KEINE Aufgabe: er markiert einen Termin im
  // Projektverlauf (Kickoff, Abnahme, Go-Live). Aufgaben bleiben Quantus-
  // Aufgaben — dieselbe Einheit wie überall sonst in der App.
  function milestonesOfProject(projectId) {
    return state().milestones
      .filter(function (entry) { return entry.projectId === projectId; })
      .sort(function (a, b) { return String(a.date || "9999").localeCompare(String(b.date || "9999")); });
  }

  window._ftAddMilestone = function (projectId) {
    var title = ((document.getElementById("ftMsTitle") || {}).value || "").trim();
    var date = ((document.getElementById("ftMsDate") || {}).value || "").trim();
    if (!title) return notify("warn", "Planung", "Bezeichnung erforderlich");
    state().milestones.push({
      id: id(), projectId: projectId || null, title: title, date: date || null,
      done: false, createdAt: now(), updatedAt: now()
    });
    save();
    rerender();
  };

  window._ftToggleMilestone = function (milestoneId) {
    var entry = state().milestones.find(function (m) { return m.id === milestoneId; });
    if (!entry) return;
    entry.done = !entry.done;
    entry.updatedAt = now();
    save();
    rerender();
  };

  window._ftSetMilestoneDate = function (milestoneId, value) {
    var entry = state().milestones.find(function (m) { return m.id === milestoneId; });
    if (!entry) return;
    entry.date = value || null;
    entry.updatedAt = now();
    save();
  };

  window._ftDeleteMilestone = function (milestoneId) {
    var ft = state();
    ft.milestones = ft.milestones.filter(function (m) { return m.id !== milestoneId; });
    save();
    rerender();
  };

  // ── Offerte → Arbeitspaket ──────────────────────────────────────────────
  // Aus jeder Offertposition wird eine echte Quantus-Aufgabe am Projekt. Der
  // geschätzte Aufwand wird aus Menge × Einheit übernommen, wenn die Einheit
  // nach Stunden aussieht. Bereits übertragene Positionen werden übersprungen.
  window._ftOfferToTasks = function (offerId) {
    var offer = docById("offer", offerId);
    if (!offer) return;
    if (!offer.projectId) return notify("warn", "FlowerTech", "Die Offerte ist keinem Projekt zugeordnet");
    var root = data();
    var existing = new Set(Object.values((root && root.entities && root.entities.tasks) || {})
      .map(function (task) { return task && task.sourceOfferItemId; }).filter(Boolean));
    var created = 0;
    (offer.items || []).forEach(function (item) {
      if (!item || existing.has(item.id)) return;
      var label = String(item.description || "").trim();
      if (!label) return;
      var hours = /std|stunde|h\b/i.test(String(item.unit || "")) ? num(item.qty) : 0;
      window.createEntity("task", {
        title: label.slice(0, 200),
        description: [item.detail || "", "Aus Offerte " + (offer.number || "") + " · " +
          num(item.qty) + " " + (item.unit || "") + " à " + money(item.price)].filter(Boolean).join("\n\n"),
        projectId: offer.projectId,
        status: "todo",
        priority: 2,
        category: "flowertech",
        estimatedMinutes: hours ? Math.round(hours * 60) : undefined,
        tags: ["flowertech", "offerte"],
        sourceOfferId: offer.id,
        sourceOfferItemId: item.id
      });
      created++;
    });
    save();
    notify(created ? "ok" : "info", "Arbeitspaket",
      created ? created + " Aufgabe(n) aus der Offerte erstellt" : "Alle Positionen wurden bereits übertragen");
    rerender();
  };

  // ── Offerte / Rechnung per Mail senden ──────────────────────────────────
  // Nutzt den bestehenden Gmail-Composer. Die Mail wird mit dem Projekt
  // verknüpft, damit der ganze Thread danach im Mail-Verlauf des Projekts
  // auftaucht. Gesendet wird weiterhin nur manuell im Composer.
  function docMailBody(kind, doc) {
    var ft = state();
    var isInvoice = kind === "invoice";
    var totals = docTotals(doc);
    var lines = [
      "Guten Tag " + (doc.contactPerson || (doc.client && doc.client.name) || "") + "",
      "",
      doc.intro || "",
      ""
    ];
    (doc.items || []).forEach(function (item) {
      if (!item.description) return;
      lines.push("• " + item.description + " — " + num(item.qty) + " " + (item.unit || "") + " · " + money(itemAmount(item)));
    });
    lines.push("");
    lines.push("Total inkl. " + num(doc.vatRate) + "% MwSt: " + money(totals.rounded));
    if (isInvoice && doc.dueDate) lines.push("Zahlbar bis " + dateOnly(doc.dueDate) + ".");
    if (!isInvoice && doc.validUntil) lines.push("Diese Offerte ist gültig bis " + dateOnly(doc.validUntil) + ".");
    if (doc.terms) { lines.push(""); lines.push(doc.terms); }
    // Beilage: der echte Link aus dem Dokument. Nie erfunden, nie geraten —
    // attachToOfferDoc() hat ihn vor dem Versand hier hineingeschrieben.
    if (doc.attachment && doc.attachment.url) {
      lines.push("");
      lines.push(doc.attachment.kind === "vision"
        ? "Ihr persönlicher Vision Room — stellen Sie Ihre Idee selbst zusammen:"
        : "Ein Beispiel, das zeigt, wie wir arbeiten:");
      lines.push(doc.attachment.url);
    }
    lines.push("");
    lines.push(doc.outro || "");
    lines.push("");
    lines.push("Freundliche Grüsse");
    lines.push((ft.company && ft.company.name) || "FlowerTech");
    return lines.join("\n");
  }

  window._ftMailDoc = function (kind, docId) {
    var doc = docById(kind, docId);
    if (!doc) return;
    if (typeof window.gmailCompose !== "function") {
      return notify("err", "Gmail", "Das Gmail-Modul ist nicht geladen.");
    }
    // „Per Mail senden" ist derselbe Versandweg wie der Statuswechsel und muss
    // durch dieselbe Schranke. Sonst liesse sich die verbindliche Beilage mit
    // einem Klick umgehen.
    if (kind === "offer") {
      var gate = offerReadyToSend(doc);
      if (!gate.ready) {
        notify("warn", "Offerte", gate.reason + " Der Mailversand ist bis dahin blockiert.");
        return;
      }
      // Die Beilage muss VOR dem Aufbau des Mailtexts im Dokument stehen —
      // sonst fehlt der Link im Text.
      attachToOfferDoc(doc);
      assignOfferNumber(doc);
    }
    var subject = (kind === "invoice" ? "Rechnung " : "Offerte ") + (doc.number || "") +
      (doc.title ? " — " + doc.title : "");
    window.gmailCompose({
      to: (doc.client && doc.client.email) || "",
      subject: subject,
      body: docMailBody(kind, doc),
      title: "✉️ " + subject,
      linkedEntity: doc.projectId ? { kind: "project", id: doc.projectId } : null
    });
    // Der Status wird erst gesetzt, wenn wirklich gesendet wurde — hier nur der
    // Verlaufseintrag, damit sichtbar bleibt, dass ein Versand vorbereitet wurde.
    pushHistory(doc, "mail", "Mail-Entwurf geöffnet an " + ((doc.client && doc.client.email) || "—"));
    doc.updatedAt = now();
    save();
  };

  // ── QR-Code (wird immer selbst hochgeladen) ─────────────────────────────
  window._ftUploadQr = async function (invoiceId, input) {
    var invoice = docById("invoice", invoiceId);
    var file = input && input.files && input.files[0];
    if (!invoice || !file) return;
    var statusEl = document.getElementById("ftQrStatus_" + invoiceId);
    var setStatus = function (text) { if (statusEl) statusEl.textContent = text; };
    setStatus("Lade hoch…");
    try {
      if (window.uploadToFirebase && window.firebaseStorage) {
        var path = "flowertech/qr/" + invoiceId + "-" + String(file.name).replace(/[^\w.\-]+/g, "_");
        var url = await window.uploadToFirebase(file, path, function (percent) { setStatus("Lade hoch… " + percent + "%"); });
        invoice.qr = { url: url, path: path, name: file.name, uploadedAt: now() };
      } else {
        if (file.size > QR_INLINE_LIMIT) throw new Error("Ohne Firebase max. 400 KB — bitte kleineres Bild wählen");
        var dataUrl = await new Promise(function (resolve, reject) {
          var reader = new window.FileReader();
          reader.onload = function () { resolve(reader.result); };
          reader.onerror = function () { reject(new Error("Datei konnte nicht gelesen werden")); };
          reader.readAsDataURL(file);
        });
        invoice.qr = { url: dataUrl, path: null, name: file.name, uploadedAt: now(), inline: true };
      }
      invoice.updatedAt = now();
      save();
      notify("ok", "FlowerTech", "QR-Code hinterlegt");
      rerender();
    } catch (error) {
      setStatus("Fehler: " + (error.message || error));
      notify("err", "QR-Code", error.message || String(error));
    }
  };

  window._ftRemoveQr = async function (invoiceId) {
    var invoice = docById("invoice", invoiceId);
    if (!invoice || !invoice.qr) return;
    var path = invoice.qr.path;
    invoice.qr = null;
    invoice.updatedAt = now();
    save();
    rerender();
    if (path && window.firebaseStorage) {
      try { await window.firebaseStorage.ref(path).delete(); } catch (error) { /* Datei evtl. schon entfernt */ }
    }
  };

  // ── Firmendaten ──────────────────────────────────────────────────────────
  window._ftCompanySet = function (field, value) {
    var ft = state();
    ft.company[field] = (field === "vatRate" || field === "paymentDays") ? num(value) : value;
    save();
  };

  // ── Druck / PDF ──────────────────────────────────────────────────────────
  window._ftPrintDoc = function (kind, docId) {
    var doc = docById(kind, docId);
    if (!doc) return;
    var win = window.open("", "_blank", "width=900,height=1200");
    if (!win) return notify("warn", "Druck", "Popup wurde blockiert — bitte Popups erlauben");
    win.document.open();
    win.document.write(printHtml(kind, doc));
    win.document.close();
  };

  function printHtml(kind, doc) {
    var ft = state();
    var company = ft.company || {};
    var totals = docTotals(doc);
    var isInvoice = kind === "invoice";
    var client = doc.client || {};
    var rows = (doc.items || []).map(function (item, index) {
      var discount = num(item.discountPercent);
      return "<tr><td>" + (index + 1) + "</td><td>" + esc(item.description || "") +
        (item.detail ? "<div class='detail'>" + esc(item.detail) + "</div>" : "") +
        (discount ? "<div class='detail'>abzüglich " + esc(String(discount)) + "% Rabatt</div>" : "") +
        "</td><td class='r'>" + esc(String(num(item.qty))) + "</td><td>" + esc(item.unit || "") +
        "</td><td class='r'>" + money(item.price) + "</td><td class='r'>" +
        money(itemAmount(item)) + "</td></tr>";
    }).join("");
    return "<!doctype html><html lang='de'><head><meta charset='utf-8'><title>" +
      esc((isInvoice ? "Rechnung " : "Offerte ") + docLabel(kind, doc)) + "</title><style>" +
      "*{box-sizing:border-box}body{font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1c1e;margin:0;padding:26mm 18mm}" +
      "h1{font-size:22px;margin:0 0 4px}" +
      ".head{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;border-bottom:2px solid #1c1c1e;padding-bottom:14px}" +
      ".brand strong{font-size:18px;display:block}.brand span{color:#666}" +
      ".meta{text-align:right;font-size:12px;color:#444}" +
      ".addr{margin:30px 0 22px;white-space:pre-line}" +
      "table{width:100%;border-collapse:collapse;margin-top:10px}" +
      "th,td{padding:7px 6px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}" +
      "th{background:#f4f4f5;font-size:11px;text-transform:uppercase;letter-spacing:.06em}" +
      ".r{text-align:right;white-space:nowrap}" +
      ".totals{margin-top:14px;margin-left:auto;width:270px}" +
      ".totals div{display:flex;justify-content:space-between;padding:4px 0}" +
      ".totals .sum{border-top:2px solid #1c1c1e;margin-top:6px;padding-top:8px;font-weight:700;font-size:15px}" +
      ".detail{color:#666;font-size:11px;margin-top:3px;white-space:pre-line}" +
      ".terms{margin-top:22px;clear:both;font-size:12px;white-space:pre-line;border:1px solid #ddd;border-radius:6px;padding:10px 12px}" +
      ".qr{margin-top:28px;border-top:1px dashed #999;padding-top:16px}" +
      ".qr img{max-width:210px;display:block;margin-top:8px}" +
      ".foot{margin-top:34px;font-size:11px;color:#666;border-top:1px solid #ddd;padding-top:10px;white-space:pre-line}" +
      "@media print{body{padding:18mm 16mm}}" +
      "</style></head><body>" +
      "<div class='head'><div class='brand'><strong>" + esc(company.name || "FlowerTech") + "</strong><span>" +
      esc(company.tagline || "") + "</span></div><div class='meta'>" +
      [company.street, [company.zip, company.city].filter(Boolean).join(" "), company.email, company.phone]
        .filter(Boolean).map(esc).join("<br>") +
      (company.vatNumber ? "<br>MwSt-Nr. " + esc(company.vatNumber) : "") + "</div></div>" +
      "<div class='addr'>" + ([client.company, client.name, client.street,
        [client.zip, client.city].filter(Boolean).join(" ")].filter(Boolean).map(esc).join("\n") || "—") + "</div>" +
      "<h1>" + esc((isInvoice ? "Rechnung " : "Offerte ") + docLabel(kind, doc)) + "</h1>" +
      "<div style='font-size:12px;color:#444'>" + esc(doc.title || "") +
      "<br>Datum: " + esc(dateOnly(doc.issueDate)) +
      (isInvoice ? "<br>Fällig: " + esc(dateOnly(doc.dueDate)) : "<br>Gültig bis: " + esc(dateOnly(doc.validUntil))) +
      (doc.reference ? "<br>Ihre Referenz: " + esc(doc.reference) : "") +
      (doc.contactPerson ? "<br>Ansprechperson: " + esc(doc.contactPerson) : "") +
      (doc.periodFrom || doc.periodTo
        ? "<br>Leistungszeitraum: " + esc(dateOnly(doc.periodFrom)) + " – " + esc(dateOnly(doc.periodTo))
        : "") +
      (doc.paymentTerms ? "<br>Konditionen: " + esc(doc.paymentTerms) : "") +
      "</div>" +
      (doc.intro ? "<p>" + esc(doc.intro) + "</p>" : "") +
      "<table><thead><tr><th>#</th><th>Leistung</th><th class='r'>Menge</th><th>Einheit</th><th class='r'>Ansatz</th><th class='r'>Betrag</th></tr></thead><tbody>" +
      (rows || "<tr><td colspan='6'>Keine Positionen</td></tr>") + "</tbody></table>" +
      "<div class='totals'><div><span>Zwischentotal</span><span>" + money(totals.subtotal) + "</span></div>" +
      (totals.discount ? "<div><span>Rabatt " + esc(String(num(doc.discountPercent))) + "%</span><span>−" + money(totals.discount) + "</span></div>" : "") +
      "<div><span>MwSt " + esc(String(num(doc.vatRate))) + "%</span><span>" + money(totals.vat) + "</span></div>" +
      "<div class='sum'><span>Total CHF</span><span>" + money(totals.rounded) + "</span></div></div>" +
      (doc.terms ? "<div class='terms'><strong>Konditionen</strong><br>" + esc(doc.terms) + "</div>" : "") +
      // Beilage steht IM Dokument — der Link kommt aus doc.attachment, nicht
      // aus einer Vermutung.
      (doc.attachment && doc.attachment.url
        ? "<div class='terms'><strong>Beilage: " + esc(doc.attachment.label || "") + "</strong><br>" +
          esc(doc.attachment.url) + "</div>"
        : "") +
      (isInvoice
        ? (doc.qr && doc.qr.url
            ? "<div class='qr'><strong>Zahlteil / QR-Rechnung</strong><img src='" + esc(doc.qr.url) + "' alt='QR-Einzahlungsschein'></div>"
            : "<div class='qr'><strong>Zahlteil</strong><br>QR-Code noch nicht hinterlegt." +
              (company.iban ? "<br>IBAN " + esc(company.iban) : "") + "</div>")
        : "") +
      (doc.outro ? "<div class='foot'>" + esc(doc.outro) + "</div>" : "") +
      "<scr" + "ipt>setTimeout(function(){window.print();},350);</scr" + "ipt></body></html>";
  }

  // ==========================================================================
  //  KI-Funktionen (nutzen window.callAI — kein neuer API-Pfad)
  // ==========================================================================
  function aiAvailable() { return typeof window.callAI === "function"; }

  function ftContext() {
    var ft = state();
    var company = ft.company || {};
    var openInvoices = ft.invoices.filter(function (invoice) {
      return invoice.status !== "paid" && invoice.status !== "cancelled";
    });
    return [
      "Firma: " + (company.name || "FlowerTech") + " — " + (company.tagline || ""),
      "Aktive Projekte: " + (projects().filter(function (p) { return p.status !== "done" && p.status !== "archived"; })
        .map(function (p) { return p.title + " (" + labelOf(STAGES, p.pipelineStage || "lead") + ")"; }).join(", ") || "keine"),
      "Offene Aufgaben: " + tasks().filter(function (t) { return t.status !== "done"; }).length,
      "Offene Rechnungen: " + openInvoices.length,
      "Neue Anfragen: " + inquiries().filter(function (i) { return !i.status || i.status === "new"; }).length
    ].join("\n");
  }

  function pushAi(title, text) {
    var ft = state();
    ft.aiLog.unshift({ id: id(), title: title, text: text, createdAt: now() });
    ft.aiLog = ft.aiLog.slice(0, 30);
    save();
  }

  function setAiBusy(busy, label) {
    var ft = state();
    ft.ui.aiBusy = busy ? (label || "KI arbeitet…") : null;
    rerender();
  }

  async function ask(prompt, systemPrompt, maxTokens) {
    if (!aiAvailable()) throw new Error("KI ist nicht verfügbar — hinterlege in den Quantus-Einstellungen einen API-Key.");
    var answer = await window.callAI(prompt, {
      systemPrompt: systemPrompt || ("Du bist die Assistenz von FlowerTech, einer Schweizer Web- und KI-Agentur. " +
        "Antworte auf Deutsch (Schweizer Schreibweise, kein Eszett), präzise und direkt verwendbar.\n\nKontext:\n" + ftContext()),
      maxTokens: maxTokens || 1200
    });
    if (!answer) throw new Error("Keine Antwort erhalten");
    return String(answer);
  }

  window._ftAskFree = async function () {
    var prompt = ((document.getElementById("ftAiPrompt") || {}).value || "").trim();
    if (!prompt) return notify("warn", "KI", "Bitte eine Frage eingeben");
    setAiBusy(true, "KI denkt nach…");
    try {
      pushAi(prompt.slice(0, 60), await ask(prompt));
    } catch (error) { notify("err", "KI", error.message || String(error)); }
    setAiBusy(false);
  };

  window._ftAiProjectReport = async function (projectId) {
    var project = projectById(projectId);
    if (!project) return;
    var list = tasksOfProject(projectId);
    setAiBusy(true, "Statusbericht wird erstellt…");
    try {
      var prompt = "Erstelle einen kurzen Statusbericht (max. 180 Wörter) für dieses FlowerTech-Projekt.\n\n" +
        "Projekt: " + project.title + "\nPhase: " + labelOf(STAGES, project.pipelineStage || "lead") +
        "\nBeschreibung: " + (project.description || "—") + "\n\nAufgaben:\n" +
        (list.map(function (task) { return "- [" + (task.status === "done" ? "x" : " ") + "] " + task.title; }).join("\n") || "- keine") +
        "\n\nGliedere in: Stand, Risiken, nächste Schritte.";
      pushAi("Statusbericht: " + project.title, await ask(prompt));
    } catch (error) { notify("err", "KI", error.message || String(error)); }
    setAiBusy(false);
  };

  window._ftAiReply = async function (inquiryId) {
    var inquiry = (state().inquiries || {})[inquiryId];
    if (!inquiry) return;
    setAiBusy(true, "Antwortentwurf wird geschrieben…");
    try {
      var prompt = "Schreibe eine freundliche, professionelle Antwort-E-Mail auf diese Anfrage. " +
        "Kurz halten, konkrete nächste Schritte (Kennenlerngespräch, Budgetrahmen erfragen), Schweizer Höflichkeitsform.\n\n" +
        "Name: " + (inquiry.name || "—") + "\nUnternehmen: " + (inquiry.company || "—") +
        "\nInteresse: " + (inquiry.service || "—") + "\nNachricht:\n" + (inquiry.message || "—");
      pushAi("Antwort an " + (inquiry.name || inquiry.email || "Anfrage"), await ask(prompt, null, 700));
      setActiveTab("ai");
    } catch (error) { notify("err", "KI", error.message || String(error)); }
    setAiBusy(false);
  };

  window._ftAiReminder = async function (invoiceId) {
    var invoice = docById("invoice", invoiceId);
    if (!invoice) return;
    setAiBusy(true, "Zahlungserinnerung wird geschrieben…");
    try {
      var prompt = "Schreibe eine höfliche, sachliche Zahlungserinnerung (erste Mahnung) auf Deutsch.\n\n" +
        "Rechnung: " + (invoice.number || "") +
        "\nKunde: " + [(invoice.client || {}).company, (invoice.client || {}).name].filter(Boolean).join(", ") +
        "\nBetrag: " + money(docTotals(invoice).rounded) + "\nFällig war: " + dateOnly(invoice.dueDate) +
        "\n\nKeine Drohungen, freundlicher Ton, Bitte um Zahlung innert 10 Tagen, Hinweis dass sich die Nachricht mit einer bereits erfolgten Zahlung überschneiden kann.";
      pushAi("Zahlungserinnerung " + (invoice.number || ""), await ask(prompt, null, 600));
      setActiveTab("ai");
    } catch (error) { notify("err", "KI", error.message || String(error)); }
    setAiBusy(false);
  };

  window._ftAiContent = async function () {
    setAiBusy(true, "Content-Ideen werden gesammelt…");
    try {
      var recent = videos().slice(0, 6).map(function (video) { return "- " + (video.title || video.hook || "Reel"); }).join("\n") || "- noch keine";
      pushAi("Content-Ideen Instagram", await ask(
        "Schlage 8 Instagram-Reel-Ideen für FlowerTech vor (Web-Apps & KI für Schweizer KMU). " +
        "Je Idee: Hook (1 Satz), Inhalt (1 Satz), Call-to-Action. Bereits produziert:\n" + recent, null, 900));
    } catch (error) { notify("err", "KI", error.message || String(error)); }
    setAiBusy(false);
  };

  function extractJson(text) {
    var raw = String(text || "");
    var fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
    if (fenced) raw = fenced[1];
    var start = raw.indexOf("{");
    var end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("Antwort enthielt kein verwertbares JSON");
    return JSON.parse(raw.slice(start, end + 1));
  }

  // Offerte/Rechnung aus Kurzbriefing: KI liefert Titel, Texte und Positionen.
  window._ftAiDraftOffer = async function (kind, docId) {
    var doc = docById(kind, docId);
    if (!doc) return;
    var brief = ((document.getElementById("ftAiBrief_" + docId) || {}).value || "").trim();
    if (!brief) return notify("warn", "KI", "Bitte kurz beschreiben, was offeriert werden soll");
    setAiBusy(true, "Positionen werden erstellt…");
    try {
      var prompt = "Erstelle aus diesem Briefing eine Schweizer " + (kind === "invoice" ? "Rechnung" : "Offerte") +
        " für FlowerTech (Web-Apps & KI).\n\nBriefing:\n" + brief +
        "\n\nAntworte AUSSCHLIESSLICH mit JSON in exakt dieser Form:\n" +
        '{"title":"…","intro":"…","outro":"…","items":[{"description":"…","qty":1,"unit":"Std.","price":150}]}\n' +
        "Preise in CHF, realistisch für den Schweizer Markt (Stundenansatz 120–180 CHF). 3–7 Positionen.";
      var parsed = extractJson(await ask(prompt, null, 1400));
      if (parsed.title) doc.title = String(parsed.title);
      if (parsed.intro) doc.intro = String(parsed.intro);
      if (parsed.outro) doc.outro = String(parsed.outro);
      if (Array.isArray(parsed.items) && parsed.items.length) {
        doc.items = parsed.items.slice(0, 20).map(function (item) {
          return {
            id: id(),
            description: String(item.description || item.title || ""),
            qty: num(item.qty, 1),
            unit: String(item.unit || "Std."),
            price: num(item.price)
          };
        });
      }
      doc.updatedAt = now();
      save();
      notify("ok", "KI", "Entwurf übernommen — bitte prüfen und anpassen");
    } catch (error) {
      notify("err", "KI", error.message || String(error));
    }
    setAiBusy(false);
  };

  window._ftDeleteAi = function (entryId) {
    var ft = state();
    ft.aiLog = ft.aiLog.filter(function (entry) { return entry.id !== entryId; });
    save();
    rerender();
  };

  window._ftCopyAi = function (entryId) {
    var entry = state().aiLog.find(function (item) { return item.id === entryId; });
    if (!entry) return;
    try {
      navigator.clipboard.writeText(entry.text);
      notify("ok", "Kopiert", "Text ist in der Zwischenablage");
    } catch (error) { notify("warn", "Kopieren", "Bitte manuell markieren"); }
  };

  window._ftAiToNote = function (entryId) {
    var ft = state();
    var entry = ft.aiLog.find(function (item) { return item.id === entryId; });
    if (!entry) return;
    ft.notes.unshift({
      id: id(), title: entry.title, content: entry.text,
      projectId: null, createdAt: now(), updatedAt: now()
    });
    save();
    notify("ok", "FlowerTech", "Als Notiz gespeichert");
    rerender();
  };

  window._ftSyncNow = async function () {
    var ft = state();
    if (!window.firebase || !firebase.auth().currentUser) {
      return notify("warn", "Firebase-Anmeldung", "Bitte zuerst in AI Sync mit Google anmelden");
    }
    ft.syncStatus = "syncing";
    rerender();
    try {
      var db = firebase.app().database(RTDB);
      var snapshots = await Promise.all([
        db.ref("flowertech/inquiries").once("value"),
        db.ref("flowertech/videos").once("value")
      ]);
      ft.inquiries = snapshots[0].val() || {};
      ft.videos = snapshots[1].val() || {};
      var list = Object.entries(ft.inquiries).map(function (entry) {
        return Object.assign({ id: entry[0] }, entry[1] || {});
      });
      var created = syncInquiryTasks(list);
      ft.lastSyncAt = now();
      ft.syncStatus = "connected";
      save();
      notify("ok", "FlowerTech synchronisiert", created ? created + " neue Aufgabe(n)" : "Keine Duplikate, alles aktuell");
      rerender();
    } catch (error) {
      ft.syncStatus = "error";
      notify("err", "FlowerTech", error.message);
      rerender();
    }
  };

  // ==========================================================================
  //  Bausteine
  // ==========================================================================
  function totalsHtml(doc) {
    var totals = docTotals(doc);
    return (totals.itemDiscount ? '<div class="ft-total-row"><span>Positionen brutto</span><strong>' + money(totals.listed) + "</strong></div>" +
        '<div class="ft-total-row"><span>Positionsrabatte</span><strong>−' + money(totals.itemDiscount) + "</strong></div>" : "") +
      '<div class="ft-total-row"><span>Zwischentotal</span><strong>' + money(totals.subtotal) + "</strong></div>" +
      (totals.discount ? '<div class="ft-total-row"><span>Rabatt ' + esc(String(num(doc.discountPercent))) +
        "%</span><strong>−" + money(totals.discount) + "</strong></div>" : "") +
      '<div class="ft-total-row"><span>Netto</span><strong>' + money(totals.net) + "</strong></div>" +
      '<div class="ft-total-row"><span>MwSt ' + esc(String(num(doc.vatRate))) + "%</span><strong>" + money(totals.vat) + "</strong></div>" +
      '<div class="ft-total-row sum"><span>Total CHF</span><strong>' + money(totals.rounded) + "</strong></div>" +
      (Math.abs(totals.rounded - totals.gross) > 0.001
        ? '<div class="ft-total-row mini"><span>Rappenrundung</span><span>' +
          (totals.rounded > totals.gross ? "+" : "−") + money(Math.abs(totals.rounded - totals.gross)) + "</span></div>"
        : "");
  }

  // Kurzer Kennzahlenstreifen über dem Dokument: Wert, Positionen, Alter und
  // die für den jeweiligen Typ wichtigste Frist.
  function docFactsHtml(kind, doc) {
    var totals = docTotals(doc);
    var isInvoice = kind === "invoice";
    var deadline = isInvoice ? doc.dueDate : doc.validUntil;
    var facts = [
      ["Total", money(totals.rounded)],
      ["Positionen", String((doc.items || []).length)],
      [isInvoice ? "Fällig" : "Gültig bis", deadline ? dateOnly(deadline) + " · " + dueLabel(deadline) : "—"],
      ["Erstellt", dateOnly(doc.issueDate)]
    ];
    if (isInvoice && doc.paidAt) facts.push(["Bezahlt", dateOnly(doc.paidAt)]);
    if (!isInvoice && doc.acceptedAt) facts.push(["Angenommen", dateOnly(doc.acceptedAt)]);
    if (doc.sentAt) facts.push(["Versendet", dateOnly(doc.sentAt)]);
    return '<div class="ft-facts">' + facts.map(function (fact) {
      return '<div class="ft-fact"><span>' + esc(fact[0]) + "</span><strong>" + esc(fact[1]) + "</strong></div>";
    }).join("") + "</div>";
  }

  function historyHtml(doc) {
    var entries = Array.isArray(doc.history) ? doc.history : [];
    if (!entries.length) return '<div class="mini">Noch keine Einträge.</div>';
    var icons = { created: "＋", status: "⇄", mail: "✉", payment: "💰", task: "☑" };
    return '<div class="ft-history">' + entries.slice(0, 20).map(function (entry) {
      return '<div class="ft-history-row"><span class="ft-history-icon">' + esc(icons[entry.event] || "•") +
        '</span><span>' + esc(entry.detail || entry.event) + '</span><small>' + esc(dateTime(entry.at)) + "</small></div>";
    }).join("") + "</div>";
  }

  function statusBadge(kind, doc) {
    var list = kind === "invoice" ? INVOICE_STATUSES : OFFER_STATUSES;
    var value = doc.status;
    if (kind === "invoice" && isOverdue(doc)) value = "overdue";
    else if (kind === "offer" && offerExpired(doc)) value = "expired";
    return '<span class="ft-status ' + esc(value) + '">' + esc(labelOf(list, value)) + "</span>";
  }

  function clientLabel(doc) {
    var client = doc.client || {};
    return [client.company, client.name].filter(Boolean).join(" · ") || "Ohne Kunde";
  }

  function docListItem(kind, doc) {
    var project = doc.projectId ? projectById(doc.projectId) : null;
    var deadline = kind === "invoice" ? doc.dueDate : doc.validUntil;
    var late = kind === "invoice" ? isOverdue(doc) : offerExpired(doc);
    var open = kind === "invoice"
      ? (doc.status !== "paid" && doc.status !== "cancelled")
      : (doc.status === "draft" || doc.status === "sent");
    var meta = [
      clientLabel(doc),
      project ? project.title : "",
      dateOnly(doc.issueDate),
      (doc.items || []).length + " Position(en)",
      deadline && open ? (kind === "invoice" ? "fällig " : "gültig bis ") + dateOnly(deadline) + " · " + dueLabel(deadline) : ""
    ].filter(Boolean);
    return '<div class="ft-doc-row' + (late ? " late" : "") + '" onclick="window._ftOpenDoc(\'' + kind + "','" + attr(doc.id) + '\')">' +
      '<div class="ft-doc-main"><strong>' + esc(docLabel(kind, doc)) + " · " + esc(doc.title || "Ohne Titel") + "</strong>" +
      '<div class="mini">' + esc(meta.join(" · ")) + "</div></div>" +
      '<div class="ft-doc-side">' + statusBadge(kind, doc) + "<strong>" + money(docTotals(doc).rounded) + "</strong></div></div>";
  }

  // Solange eine Offerte keine Nummer hat, ist sie ein Entwurf. Das steht so
  // da, statt als „—" geraten zu werden.
  function docLabel(kind, doc) {
    if (doc && doc.number) return doc.number;
    return kind === "invoice" ? "Entwurf" : "Entwurf (Offertenanfrage)";
  }

  /* ── Der Fragebogen-Link einer Offerte OHNE Projekt ──────────────────────
     Eine Offerte ohne Projekt ist ein vollwertiger Startpunkt. Hier steht
     deshalb kein Zwang zur Projektzuordnung, sondern ein klarer optionaler
     Knopf: „Fragebogen-Link erstellen“, danach „Fragebogen-Link kopieren“.
     Der Link gehört zu genau dieser Offerte, zeigt Kundendaten & Vision Room
     und — je nach Freigabe — Vorschau, AGB und Vertrag. Das getrennte
     Kundenportal ist Altbestand und bleibt der zweite Link der
     Phase 2 und entsteht erst mit der ausdrücklichen Veröffentlichung.
     ------------------------------------------------------------------- */
  function offerBriefingRowHtml(doc) {
    var core = W();
    if (!core || !doc) return "";
    var state = offerBriefingState(doc.id);
    if (!state) return "";
    var call = state.mode === "create" ? "_ftCreateOfferIntakeLink" : "_ftCopyOfferIntakeLink";
    var project = state.projectId ? projectById(state.projectId) : null;
    return '<div class="ft-linkbar"><div class="ft-link-row"><span>' + esc(core.LINK_LABELS.intake) + "</span>" +
      (state.url ? '<input readonly value="' + attr(state.url) + '" onclick="this.select()">' : "") +
      '<button class="btn sm primary" onclick="window.' + call + "('" + attr(doc.id) + '\')" ' +
        'title="' + attr(core.LINK_LABELS.intakeHint) + '">' + esc(state.label) + "</button>" +
      (state.url ? '<a class="btn sm ghost" href="' + attr(state.url) + '" target="_blank" rel="noopener">Öffnen</a>' : "") +
      "</div>" +
      '<div class="mini"><b>' + esc(state.hint) + "</b> — " + esc(state.explain) + "</div>" +
      (project
        ? '<div class="ft-ready">✓ Projekt „' + esc(project.title || "") + '“ entstanden — diese Offerte ist ihm zugeordnet.</div>'
        : "") +
      "</div>";
  }

  /* Nach der Antwort der Kundschaft stehen die strukturierten Angaben an der
     verknüpften Offerte — nicht nur im Projekt. Wer die Offerte fertigstellt,
     hat damit genau die Daten vor sich, für die der Fragebogen da war. Die
     Offerte selbst bleibt unverändert: Übernommen wird nur auf Klick, und nur
     in Felder, die noch leer sind. */
  function offerIntakeFactsHtml(doc) {
    if (!doc || !doc.projectId) return "";
    var project = projectById(doc.projectId) || {};
    var intakeDoc = project.ftIntakeDocument;
    var answers = ((intakeDoc || {}).answers || [])
      .filter(function (a) { return String(a.answer || "").trim(); });
    if (!answers.length) return "";
    return '<div class="card p-3 mt-2"><h4 class="ft-sub">Kundendaten aus dem Fragebogen</h4>' +
      '<div class="mini">Eingegangen ' + esc(dateTime(intakeDoc.submittedAt)) +
        " · unverändert festgehalten · stehen ebenso am Projekt „" + esc(project.title || "") + "“.</div>" +
      answers.map(function (a) {
        return '<div class="ft-answer"><strong>' + esc(a.label) + "</strong><p>" + esc(a.answer) + "</p></div>";
      }).join("") +
      '<div class="ft-quick mt-2"><button class="btn sm" onclick="window._ftOfferAdoptIntakeClient(\'' +
        attr(doc.id) + '\')" title="Füllt nur leere Felder — Bestehendes bleibt stehen">' +
        "Kundendaten in die Offerte übernehmen</button></div></div>";
  }

  function docEditor(kind, doc) {
    var isInvoice = kind === "invoice";
    var statuses = isInvoice ? INVOICE_STATUSES : OFFER_STATUSES;
    var client = doc.client || {};
    var allProjects = projects();
    var set = "window._ftDocSet('" + kind + "','" + attr(doc.id) + "'";
    var setClient = "window._ftDocClientSet('" + kind + "','" + attr(doc.id) + "'";

    var itemRows = (doc.items || []).map(function (item) {
      var setItem = "window._ftItemSet('" + kind + "','" + attr(doc.id) + "','" + attr(item.id) + "'";
      return '<div class="ft-item-block">' +
        '<div class="ft-item-row">' +
        '<input class="ft-item-desc" placeholder="Leistung" value="' + attr(item.description || "") +
          '" oninput="' + setItem + ",'description',this.value)\">" +
        '<input type="number" step="0.25" min="0" title="Menge" value="' + attr(String(num(item.qty))) +
          '" oninput="' + setItem + ",'qty',this.value)\">" +
        '<input class="ft-item-unit" title="Einheit" value="' + attr(item.unit || "") + '" oninput="' + setItem + ",'unit',this.value)\">" +
        '<input type="number" step="0.05" min="0" title="Ansatz" value="' + attr(String(num(item.price))) +
          '" oninput="' + setItem + ",'price',this.value)\">" +
        '<input type="number" step="1" min="0" max="100" title="Rabatt in %" value="' + attr(String(num(item.discountPercent))) +
          '" oninput="' + setItem + ",'discountPercent',this.value)\">" +
        '<span class="ft-item-total" id="ftRow_' + attr(item.id) + '">' + money(itemAmount(item)) + "</span>" +
        '<button class="btn sm ghost" onclick="window._ftRemoveItem(\'' + kind + "','" + attr(doc.id) + "','" +
          attr(item.id) + '\')">×</button></div>' +
        '<input class="ft-item-detail" placeholder="Beschreibung dieser Position (erscheint im Dokument)" value="' +
          attr(item.detail || "") + '" oninput="' + setItem + ",'detail',this.value)\"></div>";
    }).join("");

    var deadlineWarning = "";
    if (isInvoice && isOverdue(doc)) {
      deadlineWarning = '<div class="ft-alert warn"><span>Diese Rechnung ist seit ' +
        esc(dueLabel(doc.dueDate)) + ' offen.</span><button class="btn sm" onclick="window._ftAiReminder(\'' +
        attr(doc.id) + '\')">KI-Mahnung schreiben</button></div>';
    } else if (!isInvoice && offerExpired(doc)) {
      deadlineWarning = '<div class="ft-alert warn"><span>Die Gültigkeit ist am ' + esc(dateOnly(doc.validUntil)) +
        ' abgelaufen.</span><button class="btn sm" onclick="window._ftDocStatus(\'offer\',\'' + attr(doc.id) +
        '\',\'expired\')">Als abgelaufen markieren</button></div>';
    }

    // Unvollstaendige Offerte: klar benennen, was fehlt, und den Weg anbieten,
    // der die Luecke wirklich schliesst — die Kundschaft fragen. „Versendet"
    // bleibt bis dahin gesperrt (geprueft im Versandpfad, nicht nur hier).
    var completeness = "";
    if (!isInvoice) {
      var gate = offerReadyToSend(doc);
      if (!gate.ready) {
        // Ohne Projekt bleibt die Offerte eine Offerte: Der Hinweis benennt nur
        // die fehlenden Pflichtdaten und zeigt den freiwilligen Weg, sie zu
        // holen — den Fragebogen-Link GENAU DIESER Offerte. Mit Projekt führt
        // der Weg über den Fragebogen der Phase 1 — in beiden Fällen nie über
        // ein Kundenportal, das es an dieser Stelle noch gar nicht gibt.
        completeness = '<div class="ft-alert warn"><span><strong>Noch keine Offerte — Offertenanfrage.</strong> ' +
          "Es fehlt: " + esc((gate.missing || []).join(", ") || "Pflichtdaten") +
          ". Solange bleibt „Versendet\u201c gesperrt und es wird keine Offertennummer vergeben.</span>" +
          (doc.projectId
            ? '<span class="mini">Fehlende Angaben holst du über den Fragebogen-Link der Kundenanfrage ' +
              "(Reiter „Kundenanfragen\u201c) — das Kundenportal kommt erst danach.</span>"
            : '<span class="mini">Fehlen dir Kundendaten? Der Fragebogen-Link dieser Offerte holt sie ein — ' +
              "auch für eine noch unfertige Offerte. Er ist freiwillig und sperrt weder Speichern " +
              "noch Versenden.</span>") +
          "</div>";
      }
    }

    return '<div class="card p-4 ft-editor">' +
      '<div class="ft-editor-head"><div><h3 style="margin:0">' + esc(docLabel(kind, doc)) + " " + statusBadge(kind, doc) + "</h3>" +
      '<div class="mini">' + (isInvoice ? "Rechnung" : "Offerte") + " · zuletzt " + esc(dateTime(doc.updatedAt)) + "</div></div>" +
      '<div class="ft-editor-actions">' +
      "<select onchange=\"window._ftDocStatus('" + kind + "','" + attr(doc.id) + "',this.value)\">" +
      statuses.map(function (status) {
        return '<option value="' + status[0] + '"' + (doc.status === status[0] ? " selected" : "") + ">" + esc(status[1]) + "</option>";
      }).join("") + "</select>" +
      '<button class="btn sm primary" onclick="window._ftMailDoc(\'' + kind + "','" + attr(doc.id) + '\')" ' +
        'title="Per Gmail versenden — der Thread wird mit dem Projekt verknüpft">✉️ Per Mail senden</button>' +
      '<button class="btn sm" onclick="window._ftPrintDoc(\'' + kind + "','" + attr(doc.id) + '\')">Drucken / PDF</button>' +
      (doc.projectId && clientPortalLink(doc.projectId)
        ? '<button class="btn sm" onclick="window._ftCopyLink(\'' + attr(clientPortalLink(doc.projectId)) +
          '\')" title="Den Kundenportal-Link dieses Projekts kopieren">🔗 Kundenportal-Link</button>'
        : "") +
      (isInvoice
        ? '<button class="btn sm" onclick="window._ftAiReminder(\'' + attr(doc.id) + '\')">KI-Mahnung</button>'
        : '<button class="btn sm" onclick="window._ftOfferToInvoice(\'' + attr(doc.id) + '\')">In Rechnung umwandeln</button>' +
          '<button class="btn sm" onclick="window._ftOfferToTasks(\'' + attr(doc.id) + '\')" ' +
            'title="Jede Position wird zu einer Quantus-Aufgabe am Projekt">☑ In Arbeitspaket</button>') +
      '<button class="btn sm ghost" onclick="window._ftDeleteDoc(\'' + kind + "','" + attr(doc.id) + '\')">Löschen</button>' +
      "</div></div>" +

      deadlineWarning +
      completeness +
      // Der Stand des Kundenportals gehoert auch hierher: Wer an der Offerte
      // sitzt, will ihn sehen, ohne den Vorgang zu wechseln. Ohne Projekt steht
      // an derselben Stelle der freiwillige Fragebogen-Link DIESER Offerte —
      // und weiterhin kein Kundenportal.
      (doc.projectId
        ? '<div class="ft-linkbar">' + clientLinkRowHtml(doc.projectId, "Kundenportal-Link") + "</div>"
        : isInvoice
          ? '<div class="mini mt-2">Diese Rechnung gehört noch zu keinem Projekt — ' +
            "ordne sie unten einem zu, dann steht hier der Stand des Kundenportals.</div>"
          : offerBriefingRowHtml(doc)) +
      (isInvoice ? "" : offerIntakeFactsHtml(doc)) +
      docFactsHtml(kind, doc) +

      '<h4 class="ft-sub">Eckdaten</h4><div class="ft-field-grid">' +
      '<label>Titel<input value="' + attr(doc.title || "") + '" oninput="' + set + ",'title',this.value)\"></label>" +
      "<label>Projekt<select onchange=\"" + set + ",'projectId',this.value||null)\"><option value=\"\">Ohne Projekt</option>" +
      allProjects.map(function (project) {
        return '<option value="' + attr(project.id) + '"' + (doc.projectId === project.id ? " selected" : "") +
          ">" + esc(project.title) + "</option>";
      }).join("") + "</select></label>" +
      '<label>Ihre Referenz<input value="' + attr(doc.reference || "") + '" placeholder="Bestellnummer des Kunden" oninput="' +
        set + ",'reference',this.value)\"></label>" +
      '<label>Datum<input type="date" value="' + attr(doc.issueDate || "") + '" oninput="' + set + ",'issueDate',this.value)\"></label>" +
      (isInvoice
        ? '<label>Fällig am<input type="date" value="' + attr(doc.dueDate || "") + '" oninput="' + set + ",'dueDate',this.value)\"></label>"
        : '<label>Gültig bis<input type="date" value="' + attr(doc.validUntil || "") + '" oninput="' + set + ",'validUntil',this.value)\"></label>") +
      '<label>Leistung von<input type="date" value="' + attr(doc.periodFrom || "") + '" oninput="' + set + ",'periodFrom',this.value)\"></label>" +
      '<label>Leistung bis<input type="date" value="' + attr(doc.periodTo || "") + '" oninput="' + set + ",'periodTo',this.value)\"></label>" +
      '<label>Zahlungskonditionen<input value="' + attr(doc.paymentTerms || "") + '" oninput="' + set + ",'paymentTerms',this.value)\"></label>" +
      "</div>" +

      '<h4 class="ft-sub">Kunde</h4><div class="ft-field-grid">' +
      '<label>Firma<input value="' + attr(client.company || "") + '" oninput="' + setClient + ",'company',this.value)\"></label>" +
      '<label>Name<input value="' + attr(client.name || "") + '" oninput="' + setClient + ",'name',this.value)\"></label>" +
      '<label>Ansprechperson<input value="' + attr(doc.contactPerson || "") + '" oninput="' + set + ",'contactPerson',this.value)\"></label>" +
      '<label>E-Mail<input value="' + attr(client.email || "") + '" oninput="' + setClient + ",'email',this.value)\"></label>" +
      '<label>Telefon<input value="' + attr(client.phone || "") + '" oninput="' + setClient + ",'phone',this.value)\"></label>" +
      '<label>Strasse<input value="' + attr(client.street || "") + '" oninput="' + setClient + ",'street',this.value)\"></label>" +
      '<label>PLZ<input value="' + attr(client.zip || "") + '" oninput="' + setClient + ",'zip',this.value)\"></label>" +
      '<label>Ort<input value="' + attr(client.city || "") + '" oninput="' + setClient + ",'city',this.value)\"></label>" +
      "</div>" +

      '<h4 class="ft-sub">Positionen</h4>' +
      '<div class="ft-item-head"><span>Leistung</span><span>Menge</span><span>Einheit</span><span>Ansatz</span><span>Rabatt %</span><span>Betrag</span><span></span></div>' +
      '<div class="ft-items">' + (itemRows || '<div class="mini">Noch keine Positionen</div>') + "</div>" +
      '<button class="btn sm mt-2" onclick="window._ftAddItem(\'' + kind + "','" + attr(doc.id) + '\')">＋ Position</button>' +

      '<div class="ft-field-grid mt-3">' +
      '<label>MwSt %<input type="number" step="0.1" min="0" value="' + attr(String(num(doc.vatRate))) +
        '" oninput="' + set + ",'vatRate',this.value)\"></label>" +
      '<label>Gesamtrabatt %<input type="number" step="1" min="0" value="' + attr(String(num(doc.discountPercent))) +
        '" oninput="' + set + ",'discountPercent',this.value)\"></label>" +
      "</div>" +
      '<div class="ft-totals" id="ftTotals_' + attr(doc.id) + '">' + totalsHtml(doc) + "</div>" +

      '<h4 class="ft-sub">Texte</h4>' +
      '<textarea rows="2" placeholder="Einleitung" oninput="' + set + ",'intro',this.value)\">" + esc(doc.intro || "") + "</textarea>" +
      '<textarea rows="3" placeholder="Konditionen, Vorbehalte, Vertragliches (erscheint im Dokument)" oninput="' +
        set + ",'terms',this.value)\">" + esc(doc.terms || "") + "</textarea>" +
      '<textarea rows="2" placeholder="Schlusstext" oninput="' + set + ",'outro',this.value)\">" + esc(doc.outro || "") + "</textarea>" +
      '<textarea rows="2" placeholder="Interne Notiz — erscheint NIE im gedruckten Dokument" oninput="' +
        set + ",'notesInternal',this.value)\">" + esc(doc.notesInternal || "") + "</textarea>" +

      (isInvoice ? qrBlock(doc) : "") +

      '<h4 class="ft-sub">KI-Entwurf</h4>' +
      '<div class="ft-inline-form"><input id="ftAiBrief_' + attr(doc.id) +
      '" placeholder="Kurzbriefing, z. B. Website mit Shop für Blumenladen, 5 Seiten, SEO">' +
      '<button class="btn primary" onclick="window._ftAiDraftOffer(\'' + kind + "','" + attr(doc.id) +
      '\')">Positionen von der KI</button></div>' +

      '<h4 class="ft-sub">Verlauf</h4>' + historyHtml(doc) +
      "</div>";
  }

  function qrBlock(invoice) {
    var qr = invoice.qr;
    return '<h4 class="ft-sub">QR-Einzahlungsschein</h4><div class="ft-qr">' +
      (qr && qr.url
        ? '<img src="' + esc(qr.url) + '" alt="QR-Code"><div><div class="mini">' + esc(qr.name || "QR-Code") +
          " · " + esc(dateTime(qr.uploadedAt)) + '</div><button class="btn sm ghost mt-2" onclick="window._ftRemoveQr(\'' +
          attr(invoice.id) + '\')">Entfernen</button></div>'
        : '<div class="ft-qr-drop"><strong>QR-Code hochladen</strong>' +
          '<div class="mini">Der Schweizer QR-Einzahlungsschein wird selbst hochgeladen — er erscheint danach automatisch auf der gedruckten Rechnung.</div>' +
          '<input type="file" accept="image/*" onchange="window._ftUploadQr(\'' + attr(invoice.id) + '\',this)">' +
          '<div class="mini" id="ftQrStatus_' + attr(invoice.id) + '"></div></div>') +
      "</div>";
  }

  function noteCard(note) {
    return '<div class="card p-4"><div class="flex justify-between"><h3>' + esc(note.title) +
      '</h3><button class="btn sm ghost" onclick="window._ftDeleteNote(\'' + attr(note.id) + '\')">×</button></div>' +
      '<p style="white-space:pre-wrap">' + esc(note.content || "") + '</p><div class="mini">' + dateTime(note.createdAt) + "</div></div>";
  }

  function linkRow(link) {
    return '<div class="ft-row"><a href="' + esc(safeUrl(link.url)) + '" target="_blank" rel="noopener noreferrer">' +
      esc(link.title) + '</a><span class="mini">' + esc(link.url) +
      '</span><button class="btn sm ghost" onclick="window._ftDeleteLink(\'' + attr(link.id) + '\')">×</button></div>';
  }

  // ==========================================================================
  //  FlowerTech-Block auf der normalen Quantus-Projektseite
  //  ------------------------------------------------------------------------
  //  Ein FlowerTech-Projekt hat keine eigene, abgespeckte Ansicht mehr. Es wird
  //  unter #/projects/<id> geöffnet und ist dort genau so ausführlich wie jedes
  //  andere Projekt. Dieser Block ergänzt nur, was FlowerTech zusätzlich kann:
  //  Vertriebsphase, Planung mit Meilensteinen, Offerten und Rechnungen.
  //  Den Mailverlauf steuert die bestehende Element-Inbox von Quantus bei — sie
  //  hängt sich auf Projektseiten ohnehin selbst ein.
  // ==========================================================================
  function ftProjectPanel(projectId) {
    var ft = state();
    var project = projectById(projectId);
    if (!ft || !project || project.projectType !== "flowertech") return "";

    var list = tasksOfProject(project.id);
    var open = list.filter(function (task) { return task.status !== "done"; });
    var projectOffers = docsOfProject("offer", project.id).slice().sort(function (a, b) {
      return String(b.issueDate || "").localeCompare(String(a.issueDate || ""));
    });
    var projectInvoices = docsOfProject("invoice", project.id).slice().sort(function (a, b) {
      return String(b.issueDate || "").localeCompare(String(a.issueDate || ""));
    });
    var paid = projectInvoices.filter(function (invoice) { return invoice.status === "paid"; })
      .reduce(function (sum, invoice) { return sum + docTotals(invoice).rounded; }, 0);
    var openAmount = projectInvoices.filter(function (invoice) {
      return invoice.status !== "paid" && invoice.status !== "cancelled";
    }).reduce(function (sum, invoice) { return sum + docTotals(invoice).rounded; }, 0);
    var offered = projectOffers.filter(function (offer) { return offer.status !== "declined"; })
      .reduce(function (sum, offer) { return sum + docTotals(offer).rounded; }, 0);
    var milestones = milestonesOfProject(project.id);
    // Welches Dokument gerade offen ist, ergibt sich daraus, in welcher Liste es
    // gefunden wurde — nicht aus doc.kind: sehr alte Dokumente haben das Feld
    // noch nicht und würden sonst als Offerte gerendert.
    var openDoc = null, openKind = "offer";
    if (ft.ui.docId) {
      openDoc = docById("offer", ft.ui.docId);
      if (!openDoc) { openDoc = docById("invoice", ft.ui.docId); openKind = "invoice"; }
    }
    if (openDoc && openDoc.projectId !== project.id) openDoc = null;

    var head = '<div class="ft-panel-head"><div class="ft-brand"><div class="ft-mark">🌸</div>' +
      '<div><h3 style="margin:0">FlowerTech</h3><div class="mini">Vertrieb, Planung und Fakturierung zu diesem Projekt</div></div></div>' +
      '<div class="ft-quick">' +
      '<button class="btn sm" onclick="window._ftNewDoc(\'offer\',\'' + attr(project.id) + '\')">＋ Offerte</button>' +
      '<button class="btn sm" onclick="window._ftNewDoc(\'invoice\',\'' + attr(project.id) + '\')">＋ Rechnung</button>' +
      '<button class="btn sm" onclick="window.gmailComposeToEntity(\'project\',\'' + attr(project.id) + '\')">✉️ Mail an Kunde</button>' +
      '<button class="btn sm" onclick="window._ftAiProjectReport(\'' + attr(project.id) + '\')">✨ KI-Statusbericht</button>' +
      '<button class="btn sm ghost" onclick="location.hash=\'#/flowertech\'">FlowerTech öffnen</button>' +
      "</div></div>" +
      // Direkt unter dem Kopf, auf jedem Reiter: die zwei Links der zwei
      // Phasen — getrennt beschriftet, in der richtigen Reihenfolge.
      //
      //   Phase 1: der Fragebogen-Link. Er steht IMMER da, auch ohne
      //            Kundenportal — er ist der Weg, Kundendaten einzuholen.
      //   Phase 2: der Kundenportal-Link. Er erscheint weiterhin erst nach
      //            der ausdrücklichen Veröffentlichung.
      '<div class="ft-linkbar ft-linkbar-intake"><div class="ft-phase">Phase 1 · Fragebogen</div>' +
      projectIntakeRowHtml(project.id) + "</div>" +
      '<div class="ft-linkbar"><div class="ft-phase">Phase 2 · Kundenportal</div>' +
      clientLinkRowHtml(project.id, "Kundenportal-Link") +
      '<div class="mini">Zeigt der Kundschaft Vorschau, Änderungswünsche, AGB und Rückfragen. ' +
      "Wird nie automatisch verschickt — du entscheidest, wann sie ihn bekommt. " +
      "Das ist NICHT der Fragebogen-Link darüber.</div></div>";

    var kpis = '<div class="ft-kpis">' +
      '<div class="ft-kpi"><span>Offene Aufgaben</span><strong>' + open.length + "</strong></div>" +
      '<div class="ft-kpi"><span>Offeriert</span><strong>' + money(offered) + "</strong></div>" +
      '<div class="ft-kpi"><span>Bezahlt</span><strong>' + money(paid) + "</strong></div>" +
      '<div class="ft-kpi"><span>Offen</span><strong>' + money(openAmount) + "</strong></div>" +
      "</div>";

    var client = project.client || {};
    var sales = '<div class="ft-grid-2"><div class="card p-4"><h3>Vertrieb</h3><div class="sep"></div>' +
      '<div class="ft-field-grid">' +
      "<label>Phase<select onchange=\"window._ftSetProjectStage('" + attr(project.id) + "',this.value)\">" +
      STAGES.map(function (stage) {
        return '<option value="' + stage[0] + '"' + ((project.pipelineStage || "lead") === stage[0] ? " selected" : "") +
          ">" + esc(stage[1]) + "</option>";
      }).join("") + "</select></label>" +
      '<label>Kunde / Firma<input value="' + attr(client.company || "") +
        "\" oninput=\"window._ftSetClientField('" + attr(project.id) + "','company',this.value)\"></label>" +
      '<label>Ansprechperson<input value="' + attr(client.name || "") +
        "\" oninput=\"window._ftSetClientField('" + attr(project.id) + "','name',this.value)\"></label>" +
      '<label>E-Mail<input value="' + attr(client.email || "") +
        "\" oninput=\"window._ftSetClientField('" + attr(project.id) + "','email',this.value)\"></label>" +
      '<label>Telefon<input value="' + attr(client.phone || "") +
        "\" oninput=\"window._ftSetClientField('" + attr(project.id) + "','phone',this.value)\"></label>" +
      "</div>" +
      '<div class="mini mt-2">Diese Kundendaten werden in neue Offerten und Rechnungen übernommen.</div></div>' +

      // ── Planung ──
      '<div class="card p-4"><h3>Planung</h3><div class="sep"></div>' +
      '<div class="ft-inline-form"><input id="ftMsTitle" placeholder="Meilenstein, z. B. Abnahme Design">' +
      '<input id="ftMsDate" type="date">' +
      '<button class="btn primary" onclick="window._ftAddMilestone(\'' + attr(project.id) + '\')">Setzen</button></div>' +
      (milestones.length ? milestones.map(milestoneRow).join("") : empty("Noch keine Meilensteine")) +
      '<div class="mini mt-2">Meilensteine sind Termine im Projektverlauf. Alles, was erledigt werden muss, ' +
      "bleibt eine normale Quantus-Aufgabe weiter oben auf dieser Seite.</div></div></div>";

    function docSection(kind, items) {
      var label = kind === "invoice" ? "Rechnungen" : "Offerten";
      return '<div class="card p-4"><h3>' + label + " <span class=\"mini\">(" + items.length + ")</span></h3><div class=\"sep\"></div>" +
        (items.length ? items.map(function (doc) { return docListItem(kind, doc); }).join("") : empty("Noch keine " + label)) +
        '<button class="btn sm mt-2" onclick="window._ftNewDoc(\'' + kind + "','" + attr(project.id) + '\')">＋ Neue ' +
        (kind === "invoice" ? "Rechnung" : "Offerte") + "</button></div>";
    }

    return '<div class="ft-panel"><style>' + STYLES + "</style>" +
      head + kpis +
      // Der Kundenworkflow steht zuoberst: Er ist der rote Faden des Projekts.
      (typeof window.ftWorkflowPanel === "function" ? window.ftWorkflowPanel(project.id) : "") +
      sales +
      '<div class="ft-grid-2 mt-3">' + docSection("offer", projectOffers) + docSection("invoice", projectInvoices) + "</div>" +
      (openDoc ? docEditor(openKind, openDoc) : "") +
      "</div>";
  }

  function milestoneRow(entry) {
    var late = !entry.done && entry.date && entry.date < today();
    return '<div class="ft-ms' + (entry.done ? " done" : "") + (late ? " late" : "") + '">' +
      '<button class="ft-check' + (entry.done ? " on" : "") + '" onclick="window._ftToggleMilestone(\'' +
        attr(entry.id) + '\')">' + (entry.done ? "✓" : "") + "</button>" +
      '<span class="ft-ms-title">' + esc(entry.title) + "</span>" +
      '<input type="date" value="' + attr(entry.date || "") + '" onchange="window._ftSetMilestoneDate(\'' +
        attr(entry.id) + '\',this.value)">' +
      '<small>' + esc(entry.date ? dueLabel(entry.date) : "ohne Termin") + "</small>" +
      '<button class="btn sm ghost" onclick="window._ftDeleteMilestone(\'' + attr(entry.id) + '\')">×</button></div>';
  }

  window._ftSetClientField = function (projectId, field, value) {
    var project = projectById(projectId);
    if (!project) return;
    project.client = project.client || {};
    project.client[field] = value;
    project.updatedAt = now();
    save();
  };

  // ── Projektliste (ersetzt die frühere Kachelansicht) ────────────────────
  function projectRow(project) {
    var list = tasksOfProject(project.id);
    var openCount = list.filter(function (task) { return task.status !== "done"; }).length;
    var invoiced = docsOfProject("invoice", project.id)
      .reduce(function (sum, invoice) { return sum + docTotals(invoice).rounded; }, 0);
    var offered = docsOfProject("offer", project.id)
      .filter(function (offer) { return offer.status !== "declined"; })
      .reduce(function (sum, offer) { return sum + docTotals(offer).rounded; }, 0);
    // Nächster Termin: der früheste offene Meilenstein, die Projekt-Deadline
    // oder das früheste Fälligkeitsdatum einer offenen Aufgabe — was zuerst kommt.
    var dates = milestonesOfProject(project.id).filter(function (m) { return !m.done && m.date; })
      .map(function (m) { return m.date; });
    if (project.dueDate) dates.push(project.dueDate);
    list.forEach(function (task) { if (task.status !== "done" && task.dueDate) dates.push(String(task.dueDate).slice(0, 10)); });
    dates.sort();
    var next = dates[0] || "";
    var late = next && next < today();
    return '<div class="ft-prow' + (late ? " late" : "") + '" onclick="window._ftOpenProject(\'' + attr(project.id) + '\')">' +
      '<span class="ft-prow-main"><strong>' + esc(project.title || "Projekt") +
      '<button class="btn sm ghost ft-prow-link" title="Kundenportal-Link kopieren" ' +
        'onclick="event.stopPropagation();window._ftCopyProjectLink(\'' + attr(project.id) + '\')">🔗</button>' +
      "</strong>" +
      '<small>' + esc(String(project.description || "Keine Beschreibung").slice(0, 120)) + "</small></span>" +
      '<span class="badge">' + esc(labelOf(STAGES, project.pipelineStage || "lead")) + "</span>" +
      "<span>" + (list.length - openCount) + " / " + list.length + "</span>" +
      "<span>" + money(offered) + "</span>" +
      "<span>" + money(invoiced) + "</span>" +
      "<span>" + (next ? esc(dateOnly(next)) + ' <small>' + esc(dueLabel(next)) + "</small>" : "—") + "</span></div>";
  }

  // ── Planung über alle Projekte ──────────────────────────────────────────
  // Sammelt alles mit Datum — offene Aufgaben, Meilensteine, Rechnungsfristen,
  // Offert-Gültigkeiten — und gruppiert es nach Dringlichkeit.
  function planningEntries(allProjects) {
    var ft = state();
    var byProject = {};
    allProjects.forEach(function (p) { byProject[p.id] = p; });
    var out = [];
    tasks().forEach(function (task) {
      if (task.status === "done" || !task.dueDate) return;
      out.push({ date: String(task.dueDate).slice(0, 10), kind: "Aufgabe", icon: "☑",
        title: task.title || "Aufgabe", projectId: task.projectId });
    });
    ft.milestones.forEach(function (entry) {
      if (entry.done || !entry.date) return;
      out.push({ date: entry.date, kind: "Meilenstein", icon: "◆", title: entry.title, projectId: entry.projectId });
    });
    ft.invoices.forEach(function (invoice) {
      if (invoice.status === "paid" || invoice.status === "cancelled" || !invoice.dueDate) return;
      out.push({ date: invoice.dueDate, kind: "Rechnung fällig", icon: "💰",
        title: (invoice.number || "") + " · " + money(docTotals(invoice).rounded), projectId: invoice.projectId });
    });
    ft.offers.forEach(function (offer) {
      if (offer.status !== "sent" || !offer.validUntil) return;
      out.push({ date: offer.validUntil, kind: "Offerte läuft ab", icon: "◷",
        title: (offer.number || "") + " · " + money(docTotals(offer).rounded), projectId: offer.projectId });
    });
    return out.sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); })
      .map(function (entry) {
        entry.project = byProject[entry.projectId] || projectById(entry.projectId);
        return entry;
      });
  }

  function renderPlanning(allProjects) {
    var entries = planningEntries(allProjects);
    var t = today();
    var weekEnd = addDays(t, 7);
    var monthEnd = addDays(t, 30);
    var groups = [
      ["Überfällig", entries.filter(function (e) { return e.date < t; })],
      ["Heute", entries.filter(function (e) { return e.date === t; })],
      ["Diese Woche", entries.filter(function (e) { return e.date > t && e.date <= weekEnd; })],
      ["Nächste 30 Tage", entries.filter(function (e) { return e.date > weekEnd && e.date <= monthEnd; })],
      ["Später", entries.filter(function (e) { return e.date > monthEnd; })]
    ];
    var kpis = '<div class="ft-kpis">' +
      '<div class="ft-kpi"><span>Überfällig</span><strong>' + groups[0][1].length + "</strong></div>" +
      '<div class="ft-kpi"><span>Diese Woche</span><strong>' + (groups[1][1].length + groups[2][1].length) + "</strong></div>" +
      '<div class="ft-kpi"><span>Termine gesamt</span><strong>' + entries.length + "</strong></div>" +
      '<div class="ft-kpi"><span>Aktive Projekte</span><strong>' +
        allProjects.filter(function (p) { return p.status !== "done" && p.status !== "archived"; }).length + "</strong></div>" +
      "</div>";
    if (!entries.length) {
      return kpis + empty("Nichts geplant. Termine entstehen aus Aufgaben mit Fälligkeitsdatum, " +
        "Meilensteinen auf der Projektseite sowie Fristen von Rechnungen und Offerten.");
    }
    return kpis + groups.map(function (group) {
      if (!group[1].length) return "";
      return '<div class="card p-4 mb-3"><h3>' + esc(group[0]) + ' <span class="mini">(' + group[1].length + ")</span></h3>" +
        '<div class="sep"></div>' + group[1].map(function (entry) {
          return '<div class="ft-plan-row' + (entry.date < t ? " late" : "") + '"' +
            (entry.project ? ' onclick="window._ftOpenProject(\'' + attr(entry.project.id) + '\')"' : "") + ">" +
            '<span class="ft-plan-icon">' + esc(entry.icon) + "</span>" +
            '<span class="ft-plan-title"><strong>' + esc(entry.title) + "</strong><small>" + esc(entry.kind) +
            (entry.project ? " · " + esc(entry.project.title) : "") + "</small></span>" +
            '<span class="ft-plan-date">' + esc(dateOnly(entry.date)) + "<small>" + esc(dueLabel(entry.date)) + "</small></span></div>";
        }).join("") + "</div>";
    }).join("");
  }

  /* ── Kundenanfragen: Fragebogen anlegen, Link geben, Antwort sehen ─────── */
  function intakeStatusBadge(intake) {
    if (intake.projectId) return '<span class="badge ok">Beantwortet</span>';
    if (intake.status === "closed") return '<span class="badge">Geschlossen</span>';
    return '<span class="badge">Wartet auf Antwort</span>';
  }

  function intakeQuestionRow(intakeId, q, index, total) {
    var core = W();
    var set = "window._ftSetIntakeQuestion('" + attr(intakeId) + "'," + index + ",";
    return '<div class="ft-q-row">' +
      '<div class="ft-q-head"><span class="mini">Frage ' + (index + 1) + " von " + total + "</span>" +
        '<div class="ft-q-actions">' +
          '<button class="btn sm ghost" onclick="window._ftMoveIntakeQuestion(\'' + attr(intakeId) + "'," + index + ',-1)" title="Nach oben">↑</button>' +
          '<button class="btn sm ghost" onclick="window._ftMoveIntakeQuestion(\'' + attr(intakeId) + "'," + index + ',1)" title="Nach unten">↓</button>' +
          '<button class="btn sm ghost" onclick="window._ftRemoveIntakeQuestion(\'' + attr(intakeId) + "'," + index + ')" title="Frage entfernen">×</button>' +
        "</div></div>" +
      '<input class="ft-q-label" value="' + attr(q.label) + '" placeholder="Frage" oninput="' + set + "'label',this.value)\">" +
      '<div class="ft-q-meta">' +
        "<select onchange=\"" + set + "'type',this.value)\">" +
          core.INTAKE_QUESTION_TYPES.map(function (t) {
            return '<option value="' + t.key + '"' + (q.type === t.key ? " selected" : "") + ">" + esc(t.label) + "</option>";
          }).join("") + "</select>" +
        "<select onchange=\"" + set + "'role',this.value)\" title=\"Wohin die Antwort im Projekt gehört\">" +
          core.INTAKE_ROLES.map(function (r) {
            return '<option value="' + r.key + '"' + ((q.role || "") === r.key ? " selected" : "") + ">" + esc(r.label) + "</option>";
          }).join("") + "</select>" +
        '<label class="ft-q-req"><input type="checkbox"' + (q.required ? " checked" : "") +
          ' onchange="' + set + "'required',this.checked)\"> Pflicht</label>" +
      "</div>" +
      '<input class="ft-q-hint" value="' + attr(q.hint || "") + '" placeholder="Hinweis unter der Frage (optional)" oninput="' + set + "'hint',this.value)\">" +
      (q.type === "select"
        ? '<textarea class="ft-q-opts" rows="2" placeholder="Auswahlmöglichkeiten — eine pro Zeile" oninput="' + set +
          "'options',this.value)\">" + esc((q.options || []).join("\n")) + "</textarea>"
        : "") +
      "</div>";
  }

  function intakeEditor(intake) {
    var core = W();
    var link = intakeLink(intake.id);
    var coverage = core.intakeCoverage(intake.questions || []);
    // Der Vorgang dieses Fragebogens: entweder der daraus ENTSTANDENE oder der,
    // an den er von Anfang an GEBUNDEN ist.
    var binding = core.intakeBinding(intake);
    var project = binding.projectId ? projectById(binding.projectId) : null;
    var doc = project && project.ftIntakeDocument;
    var set = "window._ftSetIntakeField('" + attr(intake.id) + "',";

    var answers = doc
      ? '<div class="card p-4 mt-3"><h3>Erstes Dokument — die Antworten</h3><div class="sep"></div>' +
        '<div class="mini">Eingegangen ' + esc(dateTime(doc.submittedAt)) + " · unverändert festgehalten.</div>" +
        (doc.answers || []).filter(function (a) { return String(a.answer || "").trim(); }).map(function (a) {
          return '<div class="ft-answer"><strong>' + esc(a.label) + "</strong><p>" + esc(a.answer) + "</p></div>";
        }).join("") +
        '<div class="ft-quick mt-2"><button class="btn sm primary" onclick="window._ftOpenProjectAt(\'' +
          attr(binding.projectId) + '\',\'vorschau\')">→ Projekt öffnen: ' + esc(project.title) + "</button></div></div>"
      : "";

    return '<div class="card p-4 mb-3">' +
      '<div class="ft-editor-head"><div><h3 style="margin:0">' + esc(intake.title || "Kundenanfrage") + " " +
        intakeStatusBadge(intake) + "</h3>" +
        '<div class="mini">Fragebogen · zuletzt ' + esc(dateTime(intake.updatedAt)) + "</div></div>" +
        '<div class="ft-editor-actions">' +
          '<button class="btn sm" onclick="window._ftCloseIntake(\'' + attr(intake.id) + '\')">' +
            (intake.status === "closed" ? "Wieder öffnen" : "Schliessen") + "</button>" +
          '<button class="btn sm ghost" onclick="window._ftOpenIntake(\'' + attr(intake.id) + '\')">Zuklappen</button>' +
        "</div></div>" +

      '<div class="ft-link-row mt-2"><span>' + esc(core.LINK_LABELS.intake) + "</span>" +
        '<input readonly value="' + attr(link) + '" onclick="this.select()">' +
        '<button class="btn sm primary" onclick="window._ftCopyLink(\'' + attr(link) +
          '\')" title="' + attr(core.LINK_LABELS.intakeHint) + '">Fragebogen-Link kopieren</button>' +
        (link ? '<a class="btn sm ghost" href="' + attr(link) + '" target="_blank" rel="noopener">Öffnen</a>' : "") +
        '<button class="btn sm ghost" onclick="window._ftRotateIntakeToken(\'' + attr(intake.id) +
          '\')" title="Alten Link widerrufen">Neu</button></div>' +
      '<div class="mini"><b>' + esc(core.LINK_LABELS.intakeHint) + "</b> — dieser Link zeigt der Kundschaft " +
        "ausschliesslich den Fragebogen samt Vision Room. Nie Vorschau, Angebot, Vertrag oder AGB; " +
        "die stehen erst im Kundenportal der Phase 2.</div>" +
      (intake.publishError
        ? '<div class="ft-legal-note">⚠ ' + esc(intake.publishError) + "</div>"
        : intake.publishedAt
          ? '<div class="ft-ready">✓ Fragebogen ist online · Stand ' + esc(dateTime(intake.publishedAt)) + "</div>"
          : '<div class="mini">Wird beim nächsten Speichern veröffentlicht.</div>') +
      (binding.mode === "bound"
        ? '<div class="mini mt-2">Dieser Fragebogen gehört zum Projekt <b>' +
          esc((project && project.title) || binding.projectId) + "</b>. Die Antwort erzeugt " +
          "ausdrücklich KEIN zweites Projekt: Sie aktualisiert dieses Projekt und sorgt für " +
          "höchstens eine Aufgabe \u201eOffertenanfrage\u201c.</div>"
        : '<div class="mini mt-2">Der Link erzeugt noch nichts. Erst wenn die Kundschaft absendet, ' +
          "entsteht genau ein Projekt mit Anfrage-Dokument und genau einer Aufgabe " +
          "\u201eOffertenanfrage\u201c.</div>") +
      (coverage.complete
        ? '<div class="ft-ready">✓ Der Fragebogen deckt alle Pflichtangaben ab.</div>'
        : '<div class="ft-legal-note">⚠ Es fehlen noch Fragen zu: ' + esc(coverage.missing.join(", ")) +
          ". Ohne sie fehlen die Angaben später in Offerte, Vertrag und Code-Prompt.</div>") +

      '<div class="sep"></div>' +
      '<label class="ft-inline-label">Titel<input value="' + attr(intake.title || "") +
        '" oninput="' + set + "'title',this.value)\"></label>" +
      '<label class="ft-inline-label">Einleitung<textarea rows="2" oninput="' + set + "'intro',this.value)\">" +
        esc(intake.intro || "") + "</textarea></label>" +
      '<label class="ft-inline-label">Art des Vorhabens<select onchange="' + set + "'deliveryType',this.value)\">" +
        core.DELIVERY_TYPES.map(function (t) {
          return '<option value="' + t.key + '"' + ((intake.deliveryType || "website") === t.key ? " selected" : "") +
            ">" + esc(t.label) + "</option>";
        }).join("") + "</select></label>" +

      '<div class="sep"></div><h4 class="ft-sub">Fragen</h4>' +
      (intake.questions || []).map(function (q, i) {
        return intakeQuestionRow(intake.id, q, i, (intake.questions || []).length);
      }).join("") +
      '<div class="ft-quick mt-2"><button class="btn sm" onclick="window._ftAddIntakeQuestion(\'' +
        attr(intake.id) + '\')">＋ Frage</button></div>' +
      "</div>" + answers;
  }

  function intakesHtml() {
    var ft = wf();
    if (!ft) return "";
    var list = Object.keys(ft.intakes || {}).map(function (k) { return ft.intakes[k]; })
      .sort(function (a, b) { return String(b.createdAt || "").localeCompare(String(a.createdAt || "")); });
    var openId = ft.ui.intakeId;

    var head = '<div class="card p-4 mb-3"><h3>Kundenanfragen — Phase 1</h3><div class="sep"></div>' +
      '<div class="mini">So beginnt eine Zusammenarbeit: Fragebogen anlegen, Fragen anpassen, ' +
      "<b>die eine Kundenadresse</b> an die Kundschaft geben. Sie zeigt Fragebogen, Vision Room " +
      "und die Standard-AGB und waechst mit jeder Freigabe — " +
      "Die eine Kundenadresse: Sie beginnt beim Fragebogen und waechst mit " +
      "Vorschau, Offerte, AGB und Vertrag. Die Antwort erzeugt das Projekt, nicht umgekehrt.</div>" +
      '<div class="ft-quick mt-2"><button class="btn primary" onclick="window._ftNewIntake()">' +
      "＋ Neue Kundenanfrage</button></div></div>";

    if (!list.length) {
      return head + '<div class="card p-4">' + empty("Noch keine Kundenanfrage. Lege eine an und gib den Link weiter.") + "</div>";
    }

    return head + list.map(function (intake) {
      if (intake.id === openId) return intakeEditor(intake);
      var project = intake.projectId ? projectById(intake.projectId) : null;
      return '<div class="ft-doc-row" onclick="window._ftOpenIntake(\'' + attr(intake.id) + '\')">' +
        '<div class="ft-doc-main"><strong>' + esc(intake.title || "Kundenanfrage") + "</strong>" +
        '<div class="mini">' + esc([
          (intake.questions || []).length + " Fragen",
          intake.offerId ? "zur Offerte " + (intake.offerLabel || "") : "",
          project ? "Projekt: " + project.title : "noch keine Antwort",
          dateTime(intake.updatedAt),
        ].filter(Boolean).join(" · ")) + "</div></div>" +
        '<div class="ft-doc-side">' + intakeStatusBadge(intake) + "</div></div>";
    }).join("");
  }

  /* ── Vorschau & Prompt am Projekt ───────────────────────────────────────
     Beides sind Dateien, die ich herunterlade, ändere und wieder hochlade.
     Die Vorschau läuft in einem sandboxed iframe — die Vorlage ist HTML, das
     nicht im Quantus-Kontext laufen darf.
     ------------------------------------------------------------------- */
  function previewPromptHtml(projectId) {
    var core = W();
    var project = projectById(projectId) || {};
    var template = project.ftTemplate || {};
    var prompt = project.ftPrompt || {};
    var promptText = prompt.text || buildPromptFor(projectId);
    var clean = core ? core.sanitizeTemplateHtml(template.html || "") : { html: "", removed: [] };
    var doc = project.ftIntakeDocument;

    return '<div class="card p-4"><h3>Vorschau</h3><div class="sep"></div>' +
      '<div class="mini">' + (template.name
        ? esc(template.name) + " · " + esc(template.source === "hochgeladen" ? "hochgeladen" : "Standardvorlage") +
          " · " + esc(dateTime(template.updatedAt))
        : "Noch keine Vorlage — die Standardvorlage entsteht mit der ersten Antwort.") + "</div>" +
      (clean.removed.length
        ? '<div class="ft-legal-note">⚠ Aus der Vorlage entfernt: ' + esc(clean.removed.join(", ")) +
          ". Die Vorschau läuft zusätzlich abgeschottet.</div>"
        : "") +
      (clean.html.trim()
        ? '<iframe class="ft-preview" title="Vorschau der Website" sandbox srcdoc="' + attr(clean.html) + '"></iframe>'
        : '<div class="ft-empty">Noch keine Vorschau.</div>') +
      '<div class="ft-quick mt-2">' +
        '<button class="btn sm" onclick="window._ftDownloadTemplate(\'' + attr(projectId) + '\')">⭳ Vorlage (.html)</button>' +
        '<label class="btn sm ghost ft-upload">⭱ Vorlage ersetzen' +
          '<input type="file" accept=".html,.htm,text/html" onchange="window._ftUploadTemplate(\'' +
            attr(projectId) + '\',this)"></label>' +
        '<button class="btn sm ghost" onclick="window._ftResetTemplate(\'' + attr(projectId) +
          '\')">Standardvorlage</button>' +
      "</div>" +
      '<div class="mini mt-2">Erlaubt sind .html-Dateien bis ' +
        (core ? Math.round(core.MAX_TEMPLATE_BYTES / 1024) : 400) + " KB. Skripte, eingebettete Seiten und " +
        "Ereignis-Attribute werden vor der Veröffentlichung entfernt.</div></div>" +

      '<div class="card p-4 mt-3"><h3>Claude-Code-Prompt</h3><div class="sep"></div>' +
      '<div class="mini">' + esc(prompt.name || "prompt.md") + " · " +
        esc(prompt.source === "hochgeladen" ? "hochgeladen" : "aus dem aktuellen Stand erzeugt") +
        (prompt.updatedAt ? " · " + esc(dateTime(prompt.updatedAt)) : "") + "</div>" +
      (doc ? "" : '<div class="ft-legal-note">Noch kein Anfrage-Dokument: Der Prompt enthält erst dann alle ' +
        "Antworten, wenn die Kundschaft den Fragebogen ausgefüllt hat.</div>") +
      '<pre class="ft-prompt">' + esc(promptText) + "</pre>" +
      '<div class="ft-quick mt-2">' +
        '<button class="btn sm primary" onclick="window._ftCopyPrompt(\'' + attr(projectId) + '\')">Kopieren</button>' +
        '<button class="btn sm" onclick="window._ftDownloadPrompt(\'' + attr(projectId) + '\')">⭳ Prompt (.md)</button>' +
        '<label class="btn sm ghost ft-upload">⭱ Prompt ersetzen' +
          '<input type="file" accept=".md,.markdown,.txt,text/markdown" onchange="window._ftUploadPrompt(\'' +
            attr(projectId) + '\',this)"></label>' +
        '<button class="btn sm ghost" onclick="window._ftRegeneratePrompt(\'' + attr(projectId) +
          '\')">Neu erzeugen</button>' +
      "</div>" +
      '<div class="mini mt-2">Der Prompt ist die Eingabe für die spätere HTML-Erstellung. Er enthält ' +
        "die Antworten aus dem Fragebogen, die Änderungswünsche, die Rückfragen und den Projektkontext. " +
        "Ein Upload ersetzt ihn bewusst.</div></div>";
  }

  // ==========================================================================
  //  Hauptansicht
  // ==========================================================================
  // Kontextzugang zu den Bereichen: ruhige Karten am Fuss der Uebersicht,
  // jede mit einem echten Deep Link. Ersetzt die frueher immer sichtbare
  // Bereichsleiste.
  // Der Prozess als Arbeitsliste: was jetzt ansteht, direkt aus dem Datenstand.
  // Steht ganz oben auf der Uebersicht — vor Kennzahlen und Bereichen.
  // Der eindeutige Einstieg: genau zwei Wege, keine dritte Route.
  function startHtml() {
    var core = W();
    var ft = wf();
    if (!core || !ft) return "";
    var choice = ft.ui.routeChoice;
    var inquiry = choice && (ft.inquiries || {})[choice.inquiryId];
    var head = choice
      ? '<h3>Weg wählen für „' + esc((inquiry && (inquiry.company || inquiry.name || inquiry.email)) || "Anfrage") + "\u201c</h3>"
      : "<h3>Neue Zusammenarbeit starten</h3>";
    var hint = choice
      ? '<div class="mini">Diese Anfrage wird zum Vorgang. Der Weg wird festgehalten und bestimmt die nächsten Schritte.</div>'
      : '<div class="mini">Jeder Vorgang startet auf genau einem Weg. Die Entscheidung wird gespeichert.</div>';
    var onclick = function (routeKey) {
      return choice
        ? "window._ftInquiryToProject('" + attr(choice.inquiryId) + "','" + routeKey + "')"
        : "window._ftPickNewRoute('" + routeKey + "')";
    };
    return '<div class="card p-4 mb-3 ft-start">' + head + '<div class="sep"></div>' + hint +
      '<div class="ft-routes mt-2">' + core.ROUTES.map(function (r) {
        return '<button class="ft-route" onclick="' + onclick(r.key) + '">' +
          '<strong>' + esc(r.label) + "</strong><small>" + esc(r.hint) + "</small></button>";
      }).join("") + "</div>" +
      (choice ? '<button class="btn sm ghost mt-2" onclick="window._ftCancelRouteChoice()">Abbrechen</button>' : "") +
      "</div>";
  }

  window._ftCancelRouteChoice = function () {
    var ft = wf();
    if (!ft) return;
    ft.ui.routeChoice = null;
    save();
    rerender();
  };

  function processHtml() {
    var core = W();
    var ft = wf();
    if (!core || !ft) return "";
    var steps = core.nextProcessSteps({
      inquiries: inquiries(),
      projects: projects(),
      briefings: ft.briefings,
      offers: ft.offers,
      changeRequests: ft.changeRequests,
    });
    if (!steps.length) {
      return '<div class="card p-4 mb-3"><h3>Nächster Schritt</h3><div class="sep"></div>' +
        '<div class="ft-empty">Nichts offen — alle Anfragen sind Projekte, jeder Bedarf ist aufgenommen ' +
        "und es warten keine Änderungswünsche.</div></div>";
    }
    return '<div class="card p-4 mb-3"><h3>Nächster Schritt</h3><div class="sep"></div>' +
      steps.map(function (step) {
        return '<div class="ft-step-row">' +
          '<div class="ft-step-head"><strong>' + esc(step.label) + "</strong>" +
          '<span class="badge">' + step.count + "</span></div>" +
          '<div class="mini">' + esc(step.hint) + "</div>" +
          '<div class="ft-step-items">' + step.items.slice(0, 6).map(function (item) {
            return stepItemHtml(step.key, item);
          }).join("") +
          (step.items.length > 6 ? '<span class="mini">+ ' + (step.items.length - 6) + " weitere</span>" : "") +
          "</div></div>";
      }).join("") + "</div>";
  }

  function stepItemHtml(stepKey, item) {
    var label = esc(item.title) + (item.sub ? ' <small>' + esc(item.sub) + "</small>" : "");
    if (stepKey === "inquiry") {
      // Der nächste Schritt an einer Anfrage ist der Fragebogen-Link — nicht
      // ein Projekt. Das Projekt entsteht erst mit dem Absenden.
      return '<button class="ft-step-item" onclick="window._ftCopyInquiryIntakeLink(\'' + attr(item.id) +
        '\')" title="Die eine Kundenadresse – waechst mit dem Projekt">🔗 ' + label + "</button>";
    }
    var tab = stepKey === "briefing" ? "bedarf" : stepKey === "offer" ? "angebot"
      : stepKey === "changes" ? "aenderungen" : stepKey === "quote" ? "kunde" : "workflow";
    return '<button class="ft-step-item" onclick="window._ftOpenProjectAt(\'' + attr(item.id) + "','" +
      tab + '\')">→ ' + label + "</button>";
  }

  // Projekt oeffnen und dabei gleich im richtigen Bereich landen.
  window._ftOpenProjectAt = function (projectId, tab) {
    var ft = wf();
    if (ft) { ft.ui.projectTab = tab; save(); }
    window._ftOpenProject(projectId);
  };

  function sectionEntriesHtml() {
    return '<div class="card p-4 mt-3"><h3>Bereiche</h3><div class="sep"></div>' +
      '<div class="ft-entries">' + SECTIONS.filter(function (s) { return s[0] !== "dashboard"; })
        .map(function (s) {
          return '<a class="ft-entry" href="#/flowertech/' + s[0] + '">' +
            '<span class="ft-entry-icon" aria-hidden="true">' + esc(s[2]) + "</span>" +
            '<span class="ft-entry-text"><strong>' + esc(s[1]) + "</strong><small>" + esc(s[3]) + "</small></span></a>";
        }).join("") + "</div>" +
      '<div class="mini mt-2">Jeder Bereich hat einen eigenen Link (z. B. <code>#/flowertech/offers</code>) ' +
      "und ist über die globale Suche mit ⌘K / Strg+K erreichbar.</div></div>";
  }

  function renderFlowerTech() {
    var ft = state();
    if (!ft) return '<div class="card p-4">FlowerTech wird geladen…</div>';
    initializeSync();

    var allProjects = projects();
    var allTasks = tasks();
    var allInquiries = inquiries();
    var allVideos = videos();
    var activeTab = sectionFromHash() || ft.activeTab || "dashboard";

    var syncLabels = {
      connected: "Firebase verbunden", syncing: "Synchronisiert…",
      login_required: "Anmeldung erforderlich", error: "Synchronisationsfehler",
      unavailable: "Firebase nicht verfügbar", idle: "Bereit"
    };

    var content = "";

    if (activeTab === "dashboard") {
      var openTasks = allTasks.filter(function (task) { return task.status !== "done"; }).length;
      var income = ft.finances.filter(function (entry) { return entry.type === "income"; })
        .reduce(function (sum, entry) { return sum + num(entry.amount); }, 0);
      var expense = ft.finances.filter(function (entry) { return entry.type === "expense"; })
        .reduce(function (sum, entry) { return sum + num(entry.amount); }, 0);
      var openInvoices = ft.invoices.filter(function (invoice) {
        return invoice.status !== "paid" && invoice.status !== "cancelled";
      });
      var openInvoiceSum = openInvoices.reduce(function (sum, invoice) { return sum + docTotals(invoice).rounded; }, 0);
      var overdue = ft.invoices.filter(isOverdue);
      content =
        startHtml() +
        processHtml() +
        '<div class="ft-kpis">' +
          '<div class="ft-kpi"><span>Aktive Projekte</span><strong>' +
          allProjects.filter(function (p) { return p.status !== "done" && p.status !== "archived"; }).length + "</strong></div>" +
          '<div class="ft-kpi"><span>Offene Aufgaben</span><strong>' + openTasks + "</strong></div>" +
          '<div class="ft-kpi"><span>Offene Rechnungen</span><strong>' + money(openInvoiceSum) + "</strong></div>" +
          '<div class="ft-kpi"><span>Netto</span><strong>' + money(income - expense) + "</strong></div>" +
        "</div>" +
        (overdue.length ? '<div class="ft-alert"><span>' + overdue.length + " überfällige Rechnung(en) · " +
          money(overdue.reduce(function (sum, invoice) { return sum + docTotals(invoice).rounded; }, 0)) +
          '</span><button class="btn sm" onclick="window._ftSetTab(\'invoices\')">Ansehen</button></div>' : "") +
        '<div class="ft-quick mb-3">' +
          '<button class="btn primary" onclick="window._ftNewDoc(\'offer\')">＋ Offerte</button>' +
          '<button class="btn primary" onclick="window._ftNewDoc(\'invoice\')">＋ Rechnung</button>' +
          '<button class="btn" onclick="window._ftSetTab(\'projects\')">Projekte öffnen</button>' +
          '<button class="btn" onclick="window._ftSetTab(\'ai\')">KI-Assistenz</button>' +
        "</div>" +
        '<div class="ft-grid-2"><div class="card p-4"><h3>Projekte</h3><div class="sep"></div>' +
          (allProjects.length ? allProjects.slice(0, 6).map(function (project) {
            var openCount = tasksOfProject(project.id).filter(function (task) { return task.status !== "done"; }).length;
            return '<div class="ft-row" onclick="window._ftOpenProject(\'' + attr(project.id) + '\')" style="cursor:pointer">' +
              "<span>" + esc(project.title || "Projekt") + "<small> · " +
              esc(labelOf(STAGES, project.pipelineStage || "lead")) + "</small></span><strong>" + openCount + " offen</strong></div>";
          }).join("") : empty("Noch keine FlowerTech-Projekte")) +
        '</div><div class="card p-4"><h3>Letzte Anfragen</h3><div class="sep"></div>' +
          (allInquiries.length ? allInquiries.slice(0, 5).map(function (inquiry) {
            return '<div class="ft-list-item"><strong>' + esc(inquiry.name || inquiry.email || "Anfrage") +
              "</strong><span>" + esc(inquiry.company || inquiry.service || inquiry.status || "neu") + "</span></div>";
          }).join("") : empty("Noch keine Website-Anfragen")) +
        "</div></div>";

    } else if (activeTab === "intakes") {
      content = intakesHtml();
    } else if (activeTab === "projects") {
      // Keine Kacheln mehr: eine ruhige Liste mit allen Zahlen, die man zum
      // Sortieren braucht. Ein Klick öffnet die vollwertige Projektseite.
      content =
        // Beim Interesse: Projekt mit Typ, Kundendaten und Preisrahmen anlegen.
        // Der Kundenprozess startet damit sofort bei „Lead".
        '<div class="card p-4 ft-form"><h3>Interesse erfassen — FlowerTech-Projekt anlegen</h3>' +
          '<div class="ft-brief-grid">' +
            '<label>Projektname *<input id="ftWfTitle" type="text" placeholder="z. B. Website Gärtnerei Muster"></label>' +
            '<label>Typ<select id="ftWfType"><option value="website">Website</option>' +
              '<option value="program">Programm / Anwendung</option></select></label>' +
            '<label>Firma / Organisation<input id="ftWfCompany" type="text"></label>' +
            '<label>Ansprechperson<input id="ftWfContact" type="text"></label>' +
            '<label>E-Mail<input id="ftWfEmail" type="email"></label>' +
            '<label>Telefon<input id="ftWfPhone" type="text"></label>' +
            '<label>Budget / Preisvorstellung (CHF)<input id="ftWfBudget" type="number" step="0.05"></label>' +
            '<label>Bisheriger Anbieterpreis (CHF)<input id="ftWfCurrent" type="number" step="0.05"></label>' +
          "</div>" +
          '<textarea id="ftWfDescription" rows="3" placeholder="Worum geht es? (Kurzbeschreibung)"></textarea>' +
          '<button class="btn primary" onclick="window._ftCreateWorkflowProject()">Projekt anlegen</button>' +
          '<div class="mini mt-2">' + routeNoticeHtml() + "</div></div>" +
        (allProjects.length
          ? '<div class="card p-4"><div class="ft-plist-head"><span>Projekt</span><span>Phase</span><span>Aufgaben</span>' +
            "<span>Offeriert</span><span>Fakturiert</span><span>Nächster Termin</span></div>" +
            allProjects.slice().sort(function (a, b) {
              return String(a.title || "").localeCompare(String(b.title || ""), "de");
            }).map(projectRow).join("") + "</div>"
          : empty("Noch keine FlowerTech-Projekte"));

    } else if (activeTab === "planung") {
      content = renderPlanning(allProjects);

    } else if (activeTab === "tasks") {
      content =
        '<div class="card p-4 ft-inline-form"><input id="ftTaskTitle" type="text" placeholder="Neue Aufgabe">' +
        '<select id="ftTaskProject"><option value="">Ohne Projekt</option>' + allProjects.map(function (p) {
          return '<option value="' + attr(p.id) + '">' + esc(p.title) + "</option>";
        }).join("") + '</select><button class="btn primary" onclick="window._ftCreateTask()">Hinzufügen</button></div>' +
        '<div class="card p-4">' + (allTasks.length ? allTasks.map(function (task) {
          var project = allProjects.find(function (p) { return p.id === task.projectId; });
          return '<div class="ft-task"><button class="ft-check' + (task.status === "done" ? " on" : "") +
            '" onclick="window._ftToggleTask(\'' + attr(task.id) + '\')">' + (task.status === "done" ? "✓" : "") + "</button>" +
            '<span class="' + (task.status === "done" ? "ft-done" : "") + '">' + esc(task.title || "Aufgabe") + "</span>" +
            "<small>" + esc((project && project.title) || (task.sourceInquiryId ? "Website-Anfrage" : "FlowerTech")) + "</small>" +
            (project ? '<button class="btn sm" onclick="event.stopPropagation();window._ftOpenProject(\'' +
              attr(project.id) + '\')">Projekt</button>' : "") + "</div>";
        }).join("") : empty("Keine FlowerTech-Aufgaben")) + "</div>";

    } else if (activeTab === "offers" || activeTab === "invoices") {
      var kind2 = activeTab === "invoices" ? "invoice" : "offer";
      var list2 = docs(kind2).slice().sort(function (a, b) {
        return String(b.issueDate || "").localeCompare(String(a.issueDate || ""));
      });
      var totalOpen = list2.filter(function (doc) {
        return kind2 === "invoice" ? (doc.status !== "paid" && doc.status !== "cancelled")
          : (doc.status === "draft" || doc.status === "sent");
      }).reduce(function (sum, doc) { return sum + docTotals(doc).rounded; }, 0);
      var volume2 = list2.reduce(function (sum, doc) { return sum + docTotals(doc).rounded; }, 0);
      var decided2 = list2.filter(function (doc) { return doc.status === "accepted" || doc.status === "declined"; });
      var accepted2 = list2.filter(function (doc) { return doc.status === "accepted"; });
      var late2 = kind2 === "invoice" ? list2.filter(isOverdue) : list2.filter(offerExpired);
      content =
        '<div class="ft-kpis"><div class="ft-kpi"><span>Anzahl</span><strong>' + list2.length + "</strong></div>" +
        '<div class="ft-kpi"><span>' + (kind2 === "invoice" ? "Offen" : "Pendent") + "</span><strong>" + money(totalOpen) + "</strong></div>" +
        (kind2 === "invoice"
          ? '<div class="ft-kpi"><span>Bezahlt</span><strong>' + money(list2.filter(function (doc) { return doc.status === "paid"; })
              .reduce(function (sum, doc) { return sum + docTotals(doc).rounded; }, 0)) + "</strong></div>"
          : '<div class="ft-kpi"><span>Abschlussquote</span><strong>' +
              (decided2.length ? Math.round(accepted2.length / decided2.length * 100) + " %" : "—") + "</strong></div>") +
        '<div class="ft-kpi"><span>Ø Betrag</span><strong>' +
          money(list2.length ? volume2 / list2.length : 0) + "</strong></div>" +
        "</div>" +
        (late2.length ? '<div class="ft-alert warn"><span>' + late2.length +
          (kind2 === "invoice" ? " überfällige Rechnung(en) · " + money(late2.reduce(function (sum, doc) {
            return sum + docTotals(doc).rounded; }, 0)) : " Offerte(n) über die Gültigkeit hinaus") +
          "</span></div>" : "") +
        '<button class="btn primary mb-2" onclick="window._ftNewDoc(\'' + kind2 + '\')">＋ Neue ' +
        (kind2 === "invoice" ? "Rechnung" : "Offerte") + "</button>" +
        '<div class="card p-4">' + (list2.length ? list2.map(function (doc) { return docListItem(kind2, doc); }).join("")
          : empty("Noch keine Dokumente")) + "</div>" +
        (ft.ui.docId && docById(kind2, ft.ui.docId) ? docEditor(kind2, docById(kind2, ft.ui.docId)) : "");

    } else if (activeTab === "ai") {
      content =
        '<div class="card p-4"><h3>KI-Assistenz</h3><div class="sep"></div>' +
        '<div class="ft-quick">' +
        '<button class="btn" onclick="window._ftAiContent()">Content-Ideen Instagram</button>' +
        (allProjects.length ? '<button class="btn" onclick="window._ftAiProjectReport(\'' + attr(allProjects[0].id) +
          '\')">Statusbericht: ' + esc(allProjects[0].title) + "</button>" : "") +
        "</div>" +
        '<div class="ft-inline-form mt-3"><input id="ftAiPrompt" placeholder="Frage oder Auftrag, z. B. Preisstrategie für Wartungsabos">' +
        '<button class="btn primary" onclick="window._ftAskFree()">Fragen</button></div>' +
        (ft.ui.aiBusy ? '<div class="mini mt-2">' + esc(ft.ui.aiBusy) + "</div>" : "") +
        (aiAvailable() ? "" : '<div class="mini mt-2">Hinweis: In den Quantus-Einstellungen ist noch kein KI-Key hinterlegt.</div>') +
        "</div>" +
        '<div class="ft-card-grid mt-3">' + (ft.aiLog.length ? ft.aiLog.map(function (entry) {
          return '<div class="card p-4"><div class="flex justify-between gap-2"><h3>' + esc(entry.title) + "</h3>" +
            '<span class="mini">' + esc(dateTime(entry.createdAt)) + "</span></div>" +
            '<p style="white-space:pre-wrap">' + esc(entry.text) + "</p>" +
            '<div class="ft-quick mt-2"><button class="btn sm" onclick="window._ftCopyAi(\'' + attr(entry.id) + '\')">Kopieren</button>' +
            '<button class="btn sm" onclick="window._ftAiToNote(\'' + attr(entry.id) + '\')">Als Notiz</button>' +
            '<button class="btn sm ghost" onclick="window._ftDeleteAi(\'' + attr(entry.id) + '\')">×</button></div></div>';
        }).join("") : empty("Noch keine KI-Ergebnisse")) + "</div>";

    } else if (activeTab === "leads") {
      content = '<div class="card p-4">' + (allInquiries.length ? allInquiries.map(function (inquiry) {
        return '<div class="ft-lead"><div><strong>' + esc(inquiry.name || "Unbekannt") + '</strong><div class="mini">' +
          esc(inquiry.company || "") + (inquiry.email ? " · " + esc(inquiry.email) : "") + "</div><p>" +
          esc(inquiry.message || "") + "</p></div><div><select onchange=\"window._ftSetInquiryStatus('" +
          attr(inquiry.id) + "',this.value)\">" +
          INQUIRY_STATUSES.map(function (status) {
            return '<option value="' + status[0] + '"' + ((inquiry.status || "new") === status[0] ? " selected" : "") +
              ">" + esc(status[1]) + "</option>";
          }).join("") + "</select>" +
          '<button class="btn sm mt-2 primary" onclick="window._ftCopyInquiryIntakeLink(\'' + attr(inquiry.id) +
            '\')" title="Die eine Kundenadresse – waechst mit dem Projekt">🔗 Fragebogen-Link kopieren</button>' +
          '<button class="btn sm mt-2" onclick="window._ftOpenIntakeForInquiry(\'' + attr(inquiry.id) +
            '\')">Fragebogen bearbeiten</button>' +
          '<button class="btn sm mt-2" onclick="window._ftAiReply(\'' + attr(inquiry.id) + '\')">KI-Antwort</button>' +
          '<div class="mini mt-2">Die eine Kundenadresse – sie waechst mit dem Projekt. ' +
            "Erst das Absenden erzeugt ein Projekt.</div></div></div>";
      }).join("") : empty("Noch keine Anfragen unter flowertech/inquiries")) + "</div>";

    } else if (activeTab === "pipeline") {
      content = '<div class="ft-pipeline">' + STAGES.map(function (stage) {
        var items = allProjects.filter(function (p) { return (p.pipelineStage || "lead") === stage[0]; });
        return '<div class="ft-column"><h3>' + esc(stage[1]) + " <span>" + items.length + "</span></h3>" +
          (items.length ? items.map(function (project) {
            return '<div class="ft-pipeline-card"><strong onclick="window._ftOpenProject(\'' + attr(project.id) +
              '\')" style="cursor:pointer">' + esc(project.title || "Projekt") +
              "</strong><select onchange=\"window._ftSetProjectStage('" + attr(project.id) + "',this.value)\">" +
              STAGES.map(function (option) {
                return '<option value="' + option[0] + '"' + (option[0] === stage[0] ? " selected" : "") +
                  ">" + esc(option[1]) + "</option>";
              }).join("") + "</select></div>";
          }).join("") : '<div class="mini">Leer</div>') + "</div>";
      }).join("") + "</div>";

    } else if (activeTab === "finances") {
      var totalIncome = ft.finances.filter(function (entry) { return entry.type === "income"; })
        .reduce(function (sum, entry) { return sum + num(entry.amount); }, 0);
      var totalExpense = ft.finances.filter(function (entry) { return entry.type === "expense"; })
        .reduce(function (sum, entry) { return sum + num(entry.amount); }, 0);
      content =
        '<div class="ft-kpis"><div class="ft-kpi"><span>Einnahmen</span><strong>' + money(totalIncome) +
        '</strong></div><div class="ft-kpi"><span>Ausgaben</span><strong>' + money(totalExpense) +
        '</strong></div><div class="ft-kpi"><span>Netto</span><strong>' + money(totalIncome - totalExpense) + "</strong></div></div>" +
        '<div class="card p-4 ft-inline-form"><input id="ftFinanceTitle" placeholder="Bezeichnung">' +
        '<input id="ftFinanceAmount" type="number" min="0" step="0.05" placeholder="CHF">' +
        '<select id="ftFinanceType"><option value="income">Einnahme</option><option value="expense">Ausgabe</option></select>' +
        '<button class="btn primary" onclick="window._ftAddFinance()">Buchen</button></div>' +
        '<div class="card p-4">' + (ft.finances.length ? ft.finances.map(function (entry) {
          return '<div class="ft-row"><span>' + esc(entry.title) + " <small>" + esc(entry.date || "") +
            '</small></span><strong style="color:' + (entry.type === "income" ? "var(--ok)" : "var(--danger)") + '">' +
            (entry.type === "income" ? "+" : "−") + " " + money(entry.amount) +
            '</strong><button class="btn sm ghost" onclick="window._ftDeleteFinance(\'' + attr(entry.id) + '\')">×</button></div>';
        }).join("") : empty("Noch keine Finanzbuchungen")) + "</div>";

    } else if (activeTab === "notes") {
      content =
        '<div class="card p-4 ft-form"><input id="ftNoteTitle" placeholder="Titel">' +
        '<textarea id="ftNoteContent" rows="4" placeholder="Notiz"></textarea>' +
        '<button class="btn primary" onclick="window._ftAddNote()">Notiz speichern</button></div>' +
        '<div class="ft-card-grid">' + (ft.notes.length ? ft.notes.map(noteCard).join("") : empty("Noch keine FlowerTech-Notizen")) + "</div>";

    } else if (activeTab === "links") {
      content =
        '<div class="card p-4 ft-inline-form"><input id="ftLinkTitle" placeholder="Bezeichnung">' +
        '<input id="ftLinkUrl" type="url" placeholder="https://…">' +
        '<button class="btn primary" onclick="window._ftAddLink()">Link speichern</button></div>' +
        '<div class="card p-4">' + (ft.links.length ? ft.links.map(linkRow).join("") : empty("Noch keine Links")) + "</div>";

    } else if (activeTab === "videos") {
      content = '<div class="ft-quick mb-2"><button class="btn" onclick="window._ftAiContent()">KI: Content-Ideen</button></div>' +
        '<div class="ft-card-grid">' + (allVideos.length ? allVideos.map(function (video) {
        var url = safeUrl(video.url || video.instagramUrl);
        return '<div class="card p-4"><div class="flex justify-between gap-2"><h3>' +
          esc(video.title || video.hook || "Instagram Reel") + '</h3><span class="badge">' +
          esc(video.status || "draft") + "</span></div><p>" + esc(video.caption || "") + '</p><div class="mini">' +
          dateTime(video.publishedAt || video.createdAt) + " · " + num(video.views).toLocaleString("de-CH") +
          " Views · " + num(video.likes).toLocaleString("de-CH") + " Likes</div>" +
          (url !== "#" ? '<a class="btn sm mt-3" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Reel öffnen</a>' : "") +
          "</div>";
      }).join("") : empty("Noch keine Videos unter flowertech/videos")) + "</div>";

    } else if (activeTab === "settings") {
      var company = ft.company;
      content = '<div class="card p-4"><h3>Firmendaten für Offerten & Rechnungen</h3><div class="sep"></div>' +
        '<div class="ft-field-grid">' +
        [["name", "Firma"], ["tagline", "Untertitel"], ["street", "Strasse"], ["zip", "PLZ"], ["city", "Ort"],
         ["email", "E-Mail"], ["phone", "Telefon"], ["iban", "IBAN"], ["vatNumber", "MwSt-Nummer"]].map(function (field) {
          return "<label>" + esc(field[1]) + '<input value="' + attr(company[field[0]] || "") +
            "\" oninput=\"window._ftCompanySet('" + field[0] + "',this.value)\"></label>";
        }).join("") +
        '<label>MwSt-Satz %<input type="number" step="0.1" value="' + attr(String(num(company.vatRate, VAT_DEFAULT))) +
        "\" oninput=\"window._ftCompanySet('vatRate',this.value)\"></label>" +
        '<label>Zahlungsfrist (Tage)<input type="number" step="1" value="' + attr(String(num(company.paymentDays, 30))) +
        "\" oninput=\"window._ftCompanySet('paymentDays',this.value)\"></label>" +
        "</div>" +
        '<div class="mini mt-3">Diese Angaben erscheinen im Kopf jeder gedruckten Offerte und Rechnung. ' +
        "Der QR-Einzahlungsschein wird pro Rechnung selbst hochgeladen.</div></div>";
    }

    return "<style>" + STYLES + "</style>" +
      '<div class="ft-shell"><div class="ft-head"><div class="ft-brand"><div class="ft-mark">🌸</div>' +
      '<div><h1 style="margin:0">FlowerTech</h1><div class="mini">' + esc(ft.company.tagline || "") + "</div></div></div>" +
      '<div class="ft-sync"><div>' + esc(syncLabels[ft.syncStatus] || ft.syncStatus) + "</div><div>" +
      (ft.lastSyncAt ? "Zuletzt " + dateTime(ft.lastSyncAt) : "Noch nicht synchronisiert") +
      '</div><button class="btn sm mt-2" onclick="window._ftSyncNow()">Jetzt synchronisieren</button></div></div>' +
      (ft.ui.aiBusy ? '<div class="ft-alert"><span>' + esc(ft.ui.aiBusy) + "</span></div>" : "") +
      // KEINE Bereichsleiste mehr. Ist ein Bereich geoeffnet, steht nur eine
      // schmale Kontextzeile mit dem Rueckweg darueber — der Bereich selbst
      // bekommt den Platz.
      (activeTab === "dashboard" ? "" :
        '<div class="ft-context"><button class="ft-context-back" onclick="window._ftSetTab(\'dashboard\')">' +
        '<span aria-hidden="true">←</span> FlowerTech-Übersicht</button>' +
        '<span class="ft-context-sep" aria-hidden="true">›</span>' +
        '<h2 class="ft-context-title">' + esc(sectionOf(activeTab)[2]) + " " + esc(sectionOf(activeTab)[1]) + "</h2></div>") +
      content +
      // Einstiegskarten stehen NUR auf der Uebersicht und unter dem Inhalt —
      // sie sind Inhalt, keine Navigationsleiste ueber dem Arbeitsbereich.
      (activeTab === "dashboard" ? sectionEntriesHtml() : "") +
      "</div>";
  }

  // ==========================================================================
  //  Kundenworkflow: Lead → Bestandesaufnahme → Angebot/Vertrag → Umsetzung →
  //  Änderungsrunde → Freigabe/Abschluss.
  //  Die Logik (Phasen, Vorlagen, Vertrag, Prompt) liegt im geteilten Modul
  //  flowertech-workflow-core.js — hier ist nur die Darstellung.
  // ==========================================================================
  function W() { return window.FlowerTechWorkflow || null; }

  // ── Zustand für den Workflow ────────────────────────────────────────────
  function wf() {
    var ft = state();
    if (!ft) return null;
    ft.briefings = ft.briefings && typeof ft.briefings === "object" ? ft.briefings : {};
    ft.changeRequests = Array.isArray(ft.changeRequests) ? ft.changeRequests : [];
    ft.contentDocs = ft.contentDocs && typeof ft.contentDocs === "object" ? ft.contentDocs : {};
    ft.contracts = ft.contracts && typeof ft.contracts === "object" ? ft.contracts : {};
    ft.legalDocs = ft.legalDocs && typeof ft.legalDocs === "object" ? ft.legalDocs : {};
    ft.shares = ft.shares && typeof ft.shares === "object" ? ft.shares : {};
    ft.promptPrefs = ft.promptPrefs && typeof ft.promptPrefs === "object" ? ft.promptPrefs : {};
    ft.promptModes = ft.promptModes && typeof ft.promptModes === "object" ? ft.promptModes : {};
    return ft;
  }

  function briefingOf(projectId) { var ft = wf(); return (ft && ft.briefings[projectId]) || null; }
  function contentOf(projectId) { var ft = wf(); return (ft && ft.contentDocs[projectId]) || null; }
  function contractOf(projectId) { var ft = wf(); return (ft && ft.contracts[projectId]) || null; }
  function legalOf(projectId, kind) {
    var ft = wf();
    return (ft && ft.legalDocs[projectId] && ft.legalDocs[projectId][kind]) || null;
  }
  // Die AGB fuers Kundenportal: IMMER die zentrale Fassung aus dem Kern.
  // Frueher stand hier der pro Projekt bearbeitete Entwurf — damit gab es so
  // viele AGB wie Projekte, und niemand konnte sagen, welchem Text eine
  // Kundin zugestimmt hat. Der projectId-Parameter bleibt fuer die Aufrufer
  // stehen, wird aber bewusst nicht mehr gelesen.
  function termsForProject() {
    var core = W();
    if (!core) return { title: "", body: "", version: "" };
    return {
      title: core.STANDARD_TERMS.title,
      body: core.standardTermsText(),
      version: core.STANDARD_TERMS.version,
      editable: false,
    };
  }
  window._ftTermsForProject = termsForProject;

  function changesOf(projectId) {
    var ft = wf();
    return (ft ? ft.changeRequests : []).filter(function (c) { return c.projectId === projectId; })
      .sort(function (a, b) { return String(b.createdAt || "").localeCompare(String(a.createdAt || "")); });
  }
  function sharesOf(projectId) {
    var ft = wf();
    if (!ft) return {};
    ft.shares[projectId] = ft.shares[projectId] || {};
    return ft.shares[projectId];
  }

  // Freigabe-Token: langes Zufallsgeheimnis, das nur ein Projekt freigibt.
  // Kein API-Schlüssel — deshalb darf es im Link stehen.
  function makeToken() {
    var bytes = new Uint8Array(24);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    var chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
    var out = "";
    for (var j = 0; j < bytes.length; j++) out += chars[bytes[j] % chars.length];
    return out;
  }

  function ensureToken(projectId, key) {
    var share = sharesOf(projectId);
    if (!share[key]) { share[key] = makeToken(); share.createdAt = share.createdAt || now(); save(); }
    return share[key];
  }

  function shareLinks(projectId) {
    var core = W();
    var origin = location.origin + location.pathname.replace(/\/[^/]*$/, "");
    var share = sharesOf(projectId);
    if (!core) return { form: "", portal: "" };
    return {
      form: share.formToken ? core.formUrl(origin, share.formToken) : "",
      portal: share.portalToken ? core.portalUrl(origin, share.portalToken) : "",
      // Der EINE Kundenlink. Er steht in jeder Vorlage, die nach aussen geht —
      // damit die Kundschaft nie eine zweite Adresse lernen muss.
      customer: projectIntakeLink(projectId),
    };
  }

  function companyContext(projectId, amount) {
    var ft = wf();
    var project = projectById(projectId) || {};
    return {
      project: project,
      company: (ft && ft.company) || {},
      briefing: briefingOf(projectId) || {},
      milestones: milestonesOfProject(projectId),
      amount: amount == null ? null : amount,
      links: shareLinks(projectId),
    };
  }

  function wfVars(projectId, amount) {
    var core = W();
    return core ? core.contractVariables(companyContext(projectId, amount)) : {};
  }

  // ── Projekt anlegen mit Typ, Kundendaten und Preisrahmen ────────────────
  // Der Hinweis unter dem Formular nennt den wirklich gewaehlten Weg — vorher
  // stand dort pauschal "Phase Lead", was seit der Weggabelung falsch war.
  function routeNoticeHtml() {
    var core = W();
    var ft = wf();
    var chosen = ft && ft.ui.newRoute;
    if (!core || !core.ROUTES.some(function (r) { return r.key === chosen; })) {
      return "Wähle zuerst oben den Weg — <b>Offerte zuerst</b> oder <b>Direktprojekt</b>. " +
        "Ohne Wahl wird kein Projekt angelegt.";
    }
    var route = core.ROUTES.find(function (r) { return r.key === chosen; });
    return "Weg: <b>" + esc(route.label) + "</b> — " + esc(route.hint) +
      " Das Projekt startet in der Phase <b>Bestandesaufnahme</b> und bekommt sofort einen teilbaren " +
      "Link zum Bedarfsformular.";
  }

  window._ftPickNewRoute = function (route) {
    var ft = wf();
    if (!ft) return;
    ft.ui.newRoute = route;
    ft.ui.routeChoice = null;
    save();
    window._ftSetTab("projects");
  };

  window._ftCreateWorkflowProject = function () {
    var core = W();
    var ft = wf();
    var val = function (id) { return ((document.getElementById(id) || {}).value || "").trim(); };
    var title = val("ftWfTitle");
    // Ohne ausdrueckliche Wahl entsteht KEIN Projekt — es gibt keinen
    // stillschweigenden Standardweg.
    var chosenRoute = ft && ft.ui.newRoute;
    if (!core || !core.ROUTES.some(function (r) { return r.key === chosenRoute; })) {
      return notify("warn", "FlowerTech", "Bitte zuerst den Weg wählen: Offerte zuerst oder Direktprojekt");
    }
    if (!title) return notify("warn", "FlowerTech", "Projektname erforderlich");
    var projectId = window.createEntity("project", {
      title: title,
      description: val("ftWfDescription"),
      status: "active",
      projectType: "flowertech",
      pipelineStage: "intake",
      ftRoute: chosenRoute,
      ftRouteDecidedAt: now(),
      ftRouteSource: "manuell",
      deliveryType: val("ftWfType") === "program" ? "program" : "website",
      budget: val("ftWfBudget") ? num(val("ftWfBudget")) : null,
      currentProviderPrice: val("ftWfCurrent") ? num(val("ftWfCurrent")) : null,
      client: {
        company: val("ftWfCompany"),
        name: val("ftWfContact"),
        email: val("ftWfEmail"),
        phone: val("ftWfPhone"),
      },
      tags: ["flowertech"],
    });
    if (!projectId) return rerender();
    var project = projectById(projectId);
    if (project) {
      project.ftContactLog = [{
        id: id(), at: now(), channel: "note",
        text: "Interesse erfasst — FlowerTech-Projekt angelegt.",
      }];
    }
    // Freigabe-Links direkt bereitstellen, damit der Formularlink sofort teilbar ist.
    ensureToken(projectId, "formToken");
    // Kein Kundenportal an dieser Stelle: Es entsteht erst, wenn Vorschau,
    // Leistungsbeschreibung, Offerte, Vertrag und AGB stehen — und ich es
    // bewusst veröffentliche.
    // Die Wahl gilt fuer genau diesen Vorgang und wird danach zurueckgesetzt,
    // damit der naechste Start wieder bewusst entscheidet.
    if (ft) ft.ui.newRoute = null;
    save();
    notify("ok", "FlowerTech", "Projekt angelegt (" + core.routeLabel(chosenRoute) + ")");
    window._ftOpenProject(projectId);
  };

  window._ftSetProjectNumber = function (projectId, field, value) {
    var project = projectById(projectId);
    if (!project) return;
    var raw = String(value == null ? "" : value).trim();
    project[field] = raw === "" ? null : num(raw);
    project.updatedAt = now();
    save();
    refreshClientPortal(projectId);
  };

  window._ftSetDeliveryType = function (projectId, value) {
    var project = projectById(projectId);
    if (!project) return;
    project.deliveryType = value === "program" ? "program" : "website";
    project.updatedAt = now();
    save();
    rerender();
  };

  window._ftAdvanceStage = function (projectId, direction) {
    var core = W();
    var project = projectById(projectId);
    if (!core || !project) return;
    project.pipelineStage = direction === "back"
      ? core.previousStage(project.pipelineStage)
      : core.nextStage(project.pipelineStage);
    project.updatedAt = now();
    save();
    refreshClientPortal(projectId);
    rerender();
  };

  window._ftSetProjectTab = function (projectId, tab) {
    var ft = wf();
    if (!ft) return;
    ft.ui.projectTab = tab;
    save();
    rerender();
  };

  // ── Kontaktverlauf ──────────────────────────────────────────────────────
  window._ftAddContactEntry = function (projectId) {
    var project = projectById(projectId);
    var input = document.getElementById("ftContactText");
    var channel = (document.getElementById("ftContactChannel") || {}).value || "note";
    var value = ((input || {}).value || "").trim();
    if (!project || !value) return notify("warn", "FlowerTech", "Bitte kurz notieren, was besprochen wurde");
    project.ftContactLog = Array.isArray(project.ftContactLog) ? project.ftContactLog : [];
    project.ftContactLog.unshift({ id: id(), at: now(), channel: channel, text: value });
    project.updatedAt = now();
    if (input) input.value = "";
    save();
    rerender();
  };

  window._ftDeleteContactEntry = function (projectId, entryId) {
    var project = projectById(projectId);
    if (!project || !Array.isArray(project.ftContactLog)) return;
    project.ftContactLog = project.ftContactLog.filter(function (e) { return e.id !== entryId; });
    save();
    rerender();
  };

  // ── Bedarfsformular ─────────────────────────────────────────────────────
  // Dasselbe Feldset wie das geteilte HTML-Formular — intern direkt ausfüllbar.
  window._ftSaveBriefing = function (projectId) {
    var core = W();
    var ft = wf();
    if (!core || !ft) return;
    var raw = {};
    core.BRIEFING_FIELDS.forEach(function (field) {
      var el = document.getElementById("ftBrief_" + field.key);
      if (el) raw[field.key] = el.value;
    });
    raw.source = "intern";
    applyBriefing(projectId, raw, { createTasks: true });
  };

  // Aus einer Antwort werden strukturierte Projektfelder UND normale
  // Quantus-Aufgaben. Keine eigene Aufgabenart — deshalb erscheinen sie
  // automatisch in der zentralen Aufgaben-App.
  function applyBriefing(projectId, raw, options) {
    var core = W();
    var ft = wf();
    var project = projectById(projectId);
    if (!core || !ft || !project) return 0;
    var briefing = core.normalizeBriefing(raw, { now: now() });
    if (!core.briefingIsUsable(briefing)) {
      notify("warn", "Bedarf", "E-Mail und Ziel werden benötigt");
      return 0;
    }
    ft.briefings[projectId] = briefing;

    var patch = core.projectFieldsFromBriefing(briefing, project);
    Object.keys(patch).forEach(function (key) { project[key] = patch[key]; });
    project.updatedAt = now();

    var created = 0;
    if (options && options.createTasks) created = createBriefingTasks(projectId, briefing);

    // Leistungsbeschreibung als Startvorlage erzeugen, sofern noch keine da ist.
    if (!ft.contentDocs[projectId]) {
      ft.contentDocs[projectId] = core.buildServiceDescription(project, briefing, companyContext(projectId));
    }
    if (core.stageIndex(project.pipelineStage) < core.stageIndex("intake")) {
      project.pipelineStage = "intake";
    }
    save();
    refreshClientPortal(projectId);
    notify("ok", "Bedarf", created ? ("Übernommen · " + created + " Aufgaben erstellt") : "Bedarf übernommen");
    rerender();
    return created;
  }
  window._ftApplyBriefing = applyBriefing;

  function createBriefingTasks(projectId, briefing) {
    var core = W();
    var root = data();
    if (!core || !root) return 0;
    var existing = new Set(Object.values(root.entities.tasks || {})
      .map(function (t) { return t && t.sourceBriefingKey; }).filter(Boolean));
    var drafts = core.buildBriefingTasks(briefing, projectId, { now: now() });
    var created = 0;
    drafts.forEach(function (draft) {
      var key = projectId + ":" + draft.key;
      if (existing.has(key)) return;
      var payload = Object.assign({}, draft);
      delete payload.key;
      payload.sourceBriefingKey = key;
      window.createEntity("task", payload);
      existing.add(key);
      created++;
    });
    return created;
  }

  // ── Änderungswünsche ────────────────────────────────────────────────────
  window._ftAddChangeRequest = function (projectId) {
    var core = W();
    var ft = wf();
    if (!core || !ft) return;
    var titleEl = document.getElementById("ftCrTitle");
    var detailEl = document.getElementById("ftCrDetail");
    var raw = {
      title: (titleEl || {}).value || "",
      detail: (detailEl || {}).value || "",
      area: ((document.getElementById("ftCrArea") || {}).value || ""),
      priority: Number((document.getElementById("ftCrPriority") || {}).value || 2),
      origin: "internal",
      requestedBy: "intern",
    };
    var cr = core.normalizeChangeRequest(raw, { now: now() });
    if (!core.changeRequestIsUsable(cr)) return notify("warn", "Änderung", "Bitte einen Titel angeben");
    addChangeRequest(projectId, cr);
    if (titleEl) titleEl.value = "";
    if (detailEl) detailEl.value = "";
    rerender();
  };

  // Ein Änderungswunsch erzeugt IMMER eine normale Quantus-Aufgabe.
  function addChangeRequest(projectId, normalized) {
    var core = W();
    var ft = wf();
    if (!core || !ft) return null;
    var entry = Object.assign({ id: id(), projectId: projectId }, normalized);
    var taskId = window.createEntity("task", core.buildChangeRequestTask(entry, projectId, { now: now() }));
    entry.taskId = taskId || null;
    ft.changeRequests.unshift(entry);
    refreshClientPortal(projectId);
    var project = projectById(projectId);
    if (project && core.stageIndex(project.pipelineStage) < core.stageIndex("revision")
      && core.stageIndex(project.pipelineStage) >= core.stageIndex("build")) {
      project.pipelineStage = "revision";
    }
    save();
    notify("ok", "Änderung", "Erfasst und als Aufgabe angelegt");
    return entry;
  }
  window._ftAddChangeRequestData = addChangeRequest;

  window._ftSetChangeStatus = function (changeId, status) {
    var ft = wf();
    if (!ft) return;
    var entry = ft.changeRequests.find(function (c) { return c.id === changeId; });
    if (!entry) return;
    entry.status = status;
    entry.updatedAt = now();
    refreshClientPortal(entry.projectId);
    // Die Aufgabe bleibt führend: Status „erledigt" schliesst sie mit.
    var root = data();
    var task = entry.taskId && root && root.entities.tasks[entry.taskId];
    if (task) {
      if (status === "done" && task.status !== "done") { task.status = "done"; task.completedAt = now(); }
      if (status === "in_progress") task.status = "in_progress";
      if (status === "rejected" && task.status !== "done") { task.status = "cancelled"; }
      task.updatedAt = now();
    }
    save();
    rerender();
  };

  window._ftDeleteChangeRequest = function (changeId) {
    var ft = wf();
    if (!ft) return;
    ft.changeRequests = ft.changeRequests.filter(function (c) { return c.id !== changeId; });
    save();
    rerender();
  };

  // Der Status folgt der Aufgabe, damit die zentrale Aufgaben-App führend bleibt.
  function syncChangeStatusFromTasks() {
    var core = W();
    var ft = wf();
    var root = data();
    if (!core || !ft || !root) return;
    ft.changeRequests.forEach(function (entry) {
      var task = entry.taskId && root.entities.tasks[entry.taskId];
      if (!task) return;
      var next = core.changeStatusFromTask(task, entry.status);
      if (next !== entry.status) { entry.status = next; entry.updatedAt = now(); }
    });
  }

  // ── Leistungsbeschreibung / Angebot ─────────────────────────────────────
  window._ftBuildContent = function (projectId, force) {
    var core = W();
    var ft = wf();
    var project = projectById(projectId);
    if (!core || !ft || !project) return;
    if (ft.contentDocs[projectId] && !force
      && !window.confirm("Leistungsbeschreibung neu aus den Vorlagen aufbauen? Eigene Änderungen gehen verloren.")) return;
    ft.contentDocs[projectId] = core.buildServiceDescription(project, briefingOf(projectId) || {}, companyContext(projectId));
    save();
    notify("ok", "Angebot", "Leistungsbeschreibung erstellt — jeder Block ist editierbar");
    rerender();
  };

  // KI-Unterstützung: schreibt die Blöcke um, ersetzt sie aber nie ungefragt.
  window._ftAiContentDraft = async function (projectId) {
    var ft = wf();
    var doc = contentOf(projectId);
    if (!doc) return notify("warn", "Angebot", "Zuerst die Leistungsbeschreibung erstellen");
    if (!aiAvailable()) return notify("warn", "KI", "Keine KI verfügbar");
    var briefing = briefingOf(projectId) || {};
    setAiBusy(true, "Leistungsbeschreibung");
    try {
      var answer = await window.callAI(
        "Du schreibst für ein Schweizer KMU eine kundenfreundliche Leistungsbeschreibung auf Deutsch. " +
        "Kurze Sätze, kein Fachjargon, per Sie. Gib NUR den überarbeiteten Text der Blöcke zurück, " +
        "jeden Block eingeleitet mit '## ' und dem unveränderten Blocktitel.\n\n" +
        "Briefing:\n" + JSON.stringify({
          ziel: briefing.goal, zielgruppe: briefing.audience,
          funktionen: briefing.features, seiten: briefing.pages, design: briefing.designWishes,
        }) + "\n\nAktuelle Blöcke:\n" +
        doc.blocks.map(function (b) { return "## " + b.title + "\n" + b.body; }).join("\n\n")
      );
      var parts = String(answer || "").split(/^##\s+/m).filter(Boolean);
      var changed = 0;
      parts.forEach(function (part) {
        var nl = part.indexOf("\n");
        if (nl < 0) return;
        var title = part.slice(0, nl).trim();
        var body = part.slice(nl + 1).trim();
        var block = doc.blocks.find(function (b) { return b.title.trim() === title; });
        if (block && body) { block.body = body; changed++; }
      });
      doc.updatedAt = now();
      pushAi("Leistungsbeschreibung überarbeitet", answer);
      save();
      notify(changed ? "ok" : "warn", "KI", changed ? (changed + " Blöcke überarbeitet") : "Keine Blöcke erkannt — Text im KI-Log");
    } catch (error) {
      notify("err", "KI", error.message);
    }
    setAiBusy(false);
    rerender();
  };

  // ── Vertrag ─────────────────────────────────────────────────────────────
  window._ftBuildContract = function (projectId, force) {
    var core = W();
    var ft = wf();
    if (!core || !ft) return;
    if (ft.contracts[projectId] && !force
      && !window.confirm("Vertrag neu aus der Vorlage aufbauen? Eigene Änderungen gehen verloren.")) return;
    var accepted = docsOfProject("offer", projectId).find(function (o) { return o.status === "accepted"; });
    var amount = accepted ? docTotals(accepted).rounded : null;
    ft.contracts[projectId] = core.buildContractDraft(companyContext(projectId, amount));
    save();
    notify("ok", "Vertrag", "Entwurf erstellt — jede Klausel ist einzeln editierbar");
    rerender();
  };

  // ── Rechtstexte ─────────────────────────────────────────────────────────
  window._ftBuildLegal = function (projectId, kind, force) {
    var core = W();
    var ft = wf();
    if (!core || !ft) return;
    // Die AGB sind zentral: Es gibt nichts aufzubauen und nichts zu erneuern.
    if (kind === "agb") {
      notify("warn", "AGB", "Die Standard-AGB gelten zentral für alle Projekte und werden hier nicht bearbeitet.");
      return;
    }
    ft.legalDocs[projectId] = ft.legalDocs[projectId] || {};
    if (ft.legalDocs[projectId][kind] && !force
      && !window.confirm("Vorlage neu aufbauen? Eigene Änderungen gehen verloren.")) return;
    ft.legalDocs[projectId][kind] = core.buildLegalDraft(kind, companyContext(projectId));
    save();
    if (kind === "agb") refreshClientPortal(projectId);
    notify("ok", "Rechtstext", "Entwurf erstellt — vor Verwendung rechtlich prüfen");
    rerender();
  };

  // ── Gemeinsame Block-Bearbeitung (Angebot / Vertrag / AGB / Datenschutz) ─
  function docOfScope(projectId, scope) {
    if (scope === "content") return contentOf(projectId);
    if (scope === "contract") return contractOf(projectId);
    if (scope === "agb") return legalOf(projectId, "agb");
    if (scope === "privacy") return legalOf(projectId, "privacy");
    return null;
  }
  function blocksOf(doc) { return (doc && (doc.sections || doc.blocks)) || []; }

  window._ftBlockSet = function (projectId, scope, blockKey, field, value) {
    // Zweite Schicht: Selbst ein direkter Aufruf aus der Konsole ändert an den
    // AGB nichts. Die Oberfläche zeigt dafür gar keine Felder mehr.
    if (scope === "agb") return;
    var doc = docOfScope(projectId, scope);
    var block = blocksOf(doc).find(function (b) { return b.key === blockKey; });
    if (!block) return;
    block[field] = field === "enabled" ? !!value : value;
    doc.updatedAt = now();
    save();
    // Leistungsbeschreibung UND AGB stehen im Kundenportal — beide muessen
    // dort nachgezogen werden. Sonst stimmte die Kundschaft einem Text zu,
    // den sie so nie gesehen hat.
    if (scope === "content" || scope === "agb") refreshClientPortal(projectId);
  };

  window._ftBlockToggle = function (projectId, scope, blockKey, enabled) {
    window._ftBlockSet(projectId, scope, blockKey, "enabled", enabled);
    rerender();
  };

  window._ftBlockMove = function (projectId, scope, blockKey, delta) {
    var doc = docOfScope(projectId, scope);
    var list = blocksOf(doc);
    var i = list.findIndex(function (b) { return b.key === blockKey; });
    var target = i + delta;
    if (i < 0 || target < 0 || target >= list.length) return;
    var moved = list.splice(i, 1)[0];
    list.splice(target, 0, moved);
    doc.updatedAt = now();
    save();
    rerender();
  };

  window._ftBlockAdd = function (projectId, scope) {
    var doc = docOfScope(projectId, scope);
    if (!doc) return;
    var title = window.prompt("Titel des neuen Abschnitts:", "Zusätzliche Vereinbarung");
    if (!title) return;
    blocksOf(doc).push({ key: "custom_" + id(), title: title, body: "", enabled: true, variables: [] });
    doc.updatedAt = now();
    save();
    rerender();
  };

  window._ftBlockDelete = function (projectId, scope, blockKey) {
    var doc = docOfScope(projectId, scope);
    var list = blocksOf(doc);
    var i = list.findIndex(function (b) { return b.key === blockKey; });
    if (i < 0) return;
    if (!window.confirm("Abschnitt entfernen?")) return;
    list.splice(i, 1);
    doc.updatedAt = now();
    save();
    rerender();
  };

  window._ftDocMetaSet = function (projectId, scope, field, value) {
    var doc = docOfScope(projectId, scope);
    if (!doc) return;
    doc[field] = value;
    doc.updatedAt = now();
    save();
  };

  window._ftDocStatusSet = function (projectId, scope, status) {
    var doc = docOfScope(projectId, scope);
    if (!doc) return;
    if (status === "released" && doc.status !== "released") doc.version = num(doc.version, 1) + 1;
    doc.status = status;
    doc.updatedAt = now();
    save();
    rerender();
  };

  function docPlainText(projectId, scope) {
    var core = W();
    var doc = docOfScope(projectId, scope);
    if (!core || !doc) return "";
    if (scope === "contract") return core.contractToText(doc, wfVars(projectId));
    var head = (doc.title || "") + "\n";
    if (doc.intro) head += "⚠ " + doc.intro + "\n";
    if (doc.legalNotice) head += "⚠ " + doc.legalNotice + "\n";
    return head + "\n" + blocksOf(doc).filter(function (b) { return b.enabled !== false; })
      .map(function (b) { return b.title + "\n" + core.renderTemplate(b.body, wfVars(projectId)); }).join("\n\n") + "\n";
  }

  window._ftCopyDoc = function (projectId, scope) {
    var text = docPlainText(projectId, scope);
    if (!text) return notify("warn", "Kopieren", "Noch kein Inhalt");
    copyText(text, "Text kopiert");
  };

  window._ftPrintDocText = function (projectId, scope) {
    var text = docPlainText(projectId, scope);
    if (!text) return notify("warn", "Export", "Noch kein Inhalt");
    var win = window.open("", "_blank");
    if (!win) return notify("warn", "Export", "Pop-up wurde blockiert");
    win.document.write('<!doctype html><html lang="de"><head><meta charset="utf-8"><title>' +
      esc(text.split("\n")[0]) + '</title><style>@page{size:A4;margin:20mm}' +
      "body{font:13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;white-space:pre-wrap}" +
      "</style></head><body>" + esc(text) + "<" + "/body></html>");
    win.document.close();
    setTimeout(function () { try { win.print(); } catch (e) {} }, 300);
  };

  function copyText(text, message) {
    var done = function () { notify("ok", "FlowerTech", message || "Kopiert"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    var area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try { document.execCommand("copy"); done(); } catch (e) { notify("warn", "Kopieren", "Bitte manuell kopieren"); }
    area.remove();
  }
  window._ftCopyText = copyText;

  // ── Claude-Code-Prompt ──────────────────────────────────────────────────
  window._ftTogglePromptData = function (projectId, key, on) {
    var ft = wf();
    if (!ft) return;
    ft.promptPrefs[projectId] = ft.promptPrefs[projectId] || {};
    ft.promptPrefs[projectId][key] = !!on;
    // Der Projekt-Prompt folgt der Wahl sofort. Sonst stünde im Projekt eine
    // Fassung, die etwas anderes enthält als die Häkchen versprechen — und
    // gerade bei den Kontaktdaten wäre das die falsche Richtung.
    var project = projectById(projectId);
    if (project && project.ftPrompt && project.ftPrompt.source === "generiert") {
      regeneratePrompt(projectId);
    }
    save();
    rerender();
  };

  function promptInclude(projectId) {
    var core = W();
    var ft = wf();
    var stored = (ft && ft.promptPrefs[projectId]) || null;
    var include = {};
    (core ? core.PROMPT_DATA_OPTIONS : []).forEach(function (opt) {
      include[opt.key] = stored && Object.prototype.hasOwnProperty.call(stored, opt.key)
        ? !!stored[opt.key] : !!opt.default;
    });
    return include;
  }

  window._ftSetPromptMode = function (projectId, mode) {
    var ft = wf();
    if (!ft) return;
    ft.promptModes[projectId] = mode;
    save();
    rerender();
  };

  function promptMode(projectId) {
    var ft = wf();
    var stored = ft && ft.promptModes[projectId];
    var core = W();
    var known = core && core.PROMPT_MODES.some(function (m) { return m.key === stored; });
    if (known) return stored;
    // Ohne Wahl: Ist noch nichts gebaut, ist "Beispiel bauen" der sinnvolle
    // Start — sonst das Umsetzen.
    var hasChanges = changesOf(projectId).some(function (c) {
      return c.status !== "done" && c.status !== "rejected";
    });
    return hasChanges ? "implement" : "demo";
  }

  function claudePromptText(projectId) {
    var core = W();
    if (!core) return "";
    return core.buildClaudePrompt({
      project: projectById(projectId) || {},
      briefing: briefingOf(projectId) || {},
      changeRequests: changesOf(projectId),
      notes: (wf() ? wf().notes : []).filter(function (n) { return n.projectId === projectId; }),
    }, promptInclude(projectId), { mode: promptMode(projectId) });
  }
  window._ftClaudePrompt = claudePromptText;

  window._ftCopyClaudePrompt = function (projectId) {
    var text = claudePromptText(projectId);
    if (!text) return notify("warn", "Prompt", "Kein Inhalt");
    copyText(text, "Claude-Code-Prompt kopiert");
  };

  /* ── Kundenanfragen (Fragebögen) ─────────────────────────────────────────
     Der Einstieg: Ich lege einen Fragebogen an, bearbeite die Fragen, kopiere
     den öffentlichen Link. Erst die Antwort der Kundschaft erzeugt — genau
     einmal — ein Projekt. Vorher gibt es kein Projekt und keine Offerte.
     ------------------------------------------------------------------- */
  function intakes() {
    var ft = wf();
    return ft ? ft.intakes : {};
  }
  function intakeById(intakeId) { return intakes()[intakeId] || null; }

  function intakeRef(token) {
    if (!token || typeof firebase === "undefined" || !firebase.app) return null;
    try { return firebase.app().database(RTDB).ref("flowertech/intakeForms/" + token); }
    catch (e) { return null; }
  }

  /* ── Der Kundenbereich hinter dem einen Link ───────────────────────────
     Der Fragebogen-Link ist nicht nur ein Formular: Er ist die EINE Adresse,
     die die Kundschaft bekommt, und er wächst mit dem Vorgang. Was auf welcher
     Stufe sichtbar ist, entscheidet der Kern (customerAreaState) — hier wird
     nur zusammengetragen, was er dafür braucht.
     ------------------------------------------------------------------- */
  function projectOfIntake(intake) {
    var core = W();
    if (!core || !intake) return null;
    var binding = core.intakeBinding(intake);
    return binding.projectId ? projectById(binding.projectId) : null;
  }

  function customerAreaInput(intake, project) {
    var core = W();
    var offers = project ? docsOfProject("offer", project.id) : [];
    var offer = core ? core.customerAreaOffer(offers) : null;
    return {
      project: project || null,
      intake: intake || null,
      offers: offers,
      offerAmount: offer ? docTotals(offer).rounded : null,
      // Das Dokument ist dasselbe, das ich drucke — im Kern zusätzlich
      // entschärft, bevor es hinausgeht.
      offerDocumentHtml: offer ? printHtml("offer", offer) : "",
      prompt: project ? (project.ftPrompt || null) : null,
      today: today(),
    };
  }

  function customerArea(projectId) {
    var core = W();
    var project = projectById(projectId);
    if (!core || !project) return null;
    return core.customerAreaState(customerAreaInput(intakeOfProject(projectId), project));
  }
  window._ftCustomerArea = customerArea;

  // Nach jeder Entscheidung, die den Kundenbereich verändert (Offerte
  // versendet, Vorschau oder Verwaltung freigegeben), wird genau dieser eine
  // Link neu veröffentlicht — nie ein zweiter erzeugt.
  function refreshCustomerArea(projectId) {
    var intake = intakeOfProject(projectId);
    if (!intake) return false;
    publishIntakeForm(intake.id);
    return true;
  }
  window._ftRefreshCustomerArea = refreshCustomerArea;

  // Der veröffentlichte Kundenbereich trägt nur, was die Kundschaft sehen soll:
  // Titel, Einleitung, Fragen, Status — und die freigegebenen Kacheln. Keine
  // internen IDs, keine Entwürfe, keine Kontaktangaben anderer Vorgänge.
  function publishIntakeForm(intakeId) {
    var core = W();
    var ft = wf();
    var intake = intakeById(intakeId);
    if (!core || !ft || !intake) return "";
    if (!intake.inviteToken) { intake.inviteToken = makeToken(); intake.updatedAt = now(); }
    var ref = intakeRef(intake.inviteToken);
    if (!ref) {
      intake.publishError = "Kein Firebase-Zugang — der Fragebogen ist noch nicht online.";
      return intake.inviteToken;
    }
    ref.set(core.customerAreaSnapshot(Object.assign(
      customerAreaInput(intake, projectOfIntake(intake)),
      { company: ft.company || {}, now: now() }
    ))).then(function () {
      intake.publishedAt = now();
      intake.publishError = "";
      save();
    }).catch(function (e) {
      intake.publishError = (e && e.message) || "Der Fragebogen konnte nicht veröffentlicht werden.";
      save();
    });
    return intake.inviteToken;
  }
  window._ftPublishIntakeForm = publishIntakeForm;

  function intakeLink(intakeId) {
    var core = W();
    var intake = intakeById(intakeId);
    return core && intake && intake.inviteToken ? core.intakeFormUrl(intake.inviteToken) : "";
  }
  window._ftIntakeLink = intakeLink;

  window._ftNewIntake = function () {
    var core = W();
    var ft = wf();
    if (!core || !ft) return;
    var intakeId = id();
    ft.intakes[intakeId] = {
      id: intakeId,
      title: core.DEFAULT_INTAKE_TITLE,
      intro: core.DEFAULT_INTAKE_INTRO,
      deliveryType: "website",
      questions: core.normalizeIntakeQuestions(core.DEFAULT_INTAKE_QUESTIONS),
      inviteToken: makeToken(),
      status: "open",
      createdAt: now(),
      updatedAt: now(),
    };
    ft.ui.intakeId = intakeId;
    setActiveTab("intakes");
    publishIntakeForm(intakeId);
    save();
    rerender();
  };

  /* ── Fragebogen-Link an einer Anfrage ────────────────────────────────────
     Der schnelle Weg: Anfrage anschauen → Fragebogen-Link kopieren → schicken.
     Es entsteht KEIN Projekt. Der Fragebogen gehört zur Anfrage; ein zweiter
     Klick erzeugt keinen zweiten Fragebogen, sondern liefert denselben Link.
     ------------------------------------------------------------------- */
  function intakeForInquiry(inquiryId) {
    var core = W();
    var ft = wf();
    var inquiry = (state().inquiries || {})[inquiryId];
    if (!core || !ft || !inquiry) return null;
    var existing = Object.keys(ft.intakes || {}).map(function (k) { return ft.intakes[k]; })
      .find(function (i) { return i && i.inquiryId === inquiryId; });
    if (existing) return existing;

    var intakeId = id();
    var intake = {
      id: intakeId,
      inquiryId: inquiryId,
      title: core.DEFAULT_INTAKE_TITLE,
      intro: core.DEFAULT_INTAKE_INTRO,
      deliveryType: /programm|program|app|software|tool/i.test(inquiry.service || "") ? "program" : "website",
      questions: core.normalizeIntakeQuestions(core.DEFAULT_INTAKE_QUESTIONS),
      inviteToken: makeToken(),
      status: "open",
      createdAt: now(),
      updatedAt: now(),
    };
    ft.intakes[intakeId] = intake;
    inquiry.intakeId = intakeId;
    inquiry.updatedAt = now();
    publishIntakeForm(intakeId);
    save();
    return intake;
  }
  window._ftIntakeForInquiry = intakeForInquiry;

  window._ftCopyInquiryIntakeLink = function (inquiryId) {
    var core = W();
    var intake = intakeForInquiry(inquiryId);
    if (!intake) return notify("warn", "Fragebogen", "Diese Anfrage ist nicht mehr da.");
    var link = intakeLink(intake.id);
    if (!link) return notify("warn", "Fragebogen", "Ohne Firebase-Zugang gibt es keinen Fragebogen-Link.");
    copyText(link, (core ? core.LINK_LABELS.intake : "Fragebogen-Link") + " kopiert — " +
      (core ? core.LINK_LABELS.intakeHint : ""));
    rerender();
  };

  /* ── Fragebogen-Link an einer Offerte OHNE Projekt ───────────────────────
     Eine Offerte ohne Projekt ist ein vollwertiger Startpunkt: erstellen,
     speichern, versenden — ohne vorher ein Projekt anzulegen und ohne ein
     fremdes Projekt auszuwählen. Fehlen Kundendaten, gibt es dafür diesen
     freiwilligen Weg: den Fragebogen-Link GENAU DIESER Offerte.

     Er zeigt ausschliesslich das Briefing samt Vision Room — nie eine
     Vorschau, nie das Kundenportal. Ein zweiter Klick erzeugt keinen zweiten
     Fragebogen, sondern liefert denselben Link (Zuordnung über offerId).
     ------------------------------------------------------------------- */
  function intakeForOffer(offerId) {
    var core = W();
    var ft = wf();
    var doc = docById("offer", offerId);
    if (!core || !ft || !doc) return null;
    var existing = Object.keys(ft.intakes || {}).map(function (k) { return ft.intakes[k]; })
      .find(function (i) { return i && i.offerId === offerId; });
    if (existing) return existing;

    var intakeId = id();
    var client = doc.client || {};
    var intake = {
      id: intakeId,
      // Die Zuordnung hängt an der Offerte, nicht am Inhalt: Reload und
      // Doppelklick treffen denselben Fragebogen.
      offerId: offerId,
      title: core.DEFAULT_INTAKE_TITLE,
      intro: core.DEFAULT_INTAKE_INTRO,
      deliveryType: "website",
      questions: core.normalizeIntakeQuestions(core.DEFAULT_INTAKE_QUESTIONS),
      inviteToken: makeToken(),
      status: "open",
      // Nur als interner Hinweis in der Liste — der veröffentlichte Fragebogen
      // trägt davon nichts (publishIntakeForm ist eine Positivliste).
      offerLabel: doc.number || doc.title || client.company || client.name || "",
      createdAt: now(),
      updatedAt: now(),
    };
    ft.intakes[intakeId] = intake;
    doc.updatedAt = now();
    pushHistory(doc, "briefing", "Fragebogen-Link erstellt — " + core.LINK_LABELS.intakeHint);
    publishIntakeForm(intakeId);
    save();
    return intake;
  }
  window._ftIntakeForOffer = intakeForOffer;

  // Der Zustand, den die Offerte anzeigt: erstellen, kopieren, beantwortet.
  function offerBriefingState(offerId) {
    var core = W();
    var ft = wf();
    var doc = docById("offer", offerId);
    if (!core || !ft || !doc) return null;
    var intake = Object.keys(ft.intakes || {}).map(function (k) { return ft.intakes[k]; })
      .find(function (i) { return i && i.offerId === offerId; }) || null;
    return core.offerBriefingLinkState({ offer: doc, intake: intake });
  }
  window._ftOfferBriefingState = offerBriefingState;

  window._ftCreateOfferIntakeLink = function (offerId) {
    var core = W();
    var intake = intakeForOffer(offerId);
    if (!intake) return notify("warn", "Fragebogen", "Diese Offerte ist nicht mehr da.");
    rerender();
    var link = intakeLink(intake.id);
    notify("ok", "Fragebogen", link
      ? "Fragebogen-Link für diese Offerte erstellt — " + (core ? core.LINK_LABELS.intakeHint : "")
      : "Ohne Firebase-Zugang gibt es noch keinen Fragebogen-Link.");
  };

  window._ftCopyOfferIntakeLink = function (offerId) {
    var core = W();
    var intake = intakeForOffer(offerId);
    if (!intake) return notify("warn", "Fragebogen", "Diese Offerte ist nicht mehr da.");
    var link = intakeLink(intake.id);
    if (!link) return notify("warn", "Fragebogen", "Ohne Firebase-Zugang gibt es keinen Fragebogen-Link.");
    copyText(link, (core ? core.LINK_LABELS.intake : "Fragebogen-Link") + " kopiert — " +
      (core ? core.LINK_LABELS.intakeHint : ""));
    rerender();
  };

  /* ── Fragebogen-Link eines BESTEHENDEN Projekts ─────────────────────────
     Der Link der Phase 1, jetzt auch dort, wo das Projekt schon da ist. Er
     hängt über `boundProjectId` an genau diesem Projekt: Reload, Doppelklick
     und ein zweiter Aufruf treffen denselben Fragebogen und denselben Token,
     damit ein bereits verschickter Link gültig bleibt.

     Er zeigt ausschliesslich Kundendaten, Bestandesaufnahme und Vision Room —
     nie Vorschau, Vertrag, AGB, Kosten oder Kundenportal. Der Kundenportal-
     Link bleibt der zweite Link und erscheint weiterhin erst nach der
     ausdrücklichen Veröffentlichung.
     ------------------------------------------------------------------- */
  function intakeOfProject(projectId) {
    var ft = wf();
    if (!ft || !projectId) return null;
    var list = Object.keys(ft.intakes || {}).map(function (key) { return ft.intakes[key]; });
    // Zuerst der ausdrücklich gebundene Fragebogen. Ist keiner da, zählt auch
    // der Fragebogen, AUS DEM dieses Projekt entstanden ist — sonst stünde an
    // einem so entstandenen Projekt ein zweiter Link derselben Phase.
    return list.find(function (i) { return i && i.boundProjectId === projectId; })
      || list.find(function (i) { return i && i.projectId === projectId; })
      || null;
  }
  window._ftIntakeOfProject = intakeOfProject;

  function intakeForProject(projectId) {
    var core = W();
    var ft = wf();
    var project = projectById(projectId);
    if (!core || !ft || !project) return null;
    var existing = intakeOfProject(projectId);
    if (existing) {
      // Ein bestehender Fragebogen wird gebunden, nicht ersetzt: derselbe
      // Token, derselbe verschickte Link.
      if (!existing.boundProjectId) {
        existing.boundProjectId = projectId;
        existing.updatedAt = now();
        save();
      }
      return existing;
    }

    var intakeId = id();
    var intake = {
      id: intakeId,
      // Die Bindung an das Projekt. NICHT projectId: das hiesse „aus diesem
      // Fragebogen ist ein Projekt entstanden" und würde den öffentlichen
      // Fragebogen sofort als beantwortet schliessen.
      boundProjectId: projectId,
      title: core.DEFAULT_INTAKE_TITLE,
      intro: core.DEFAULT_INTAKE_INTRO,
      deliveryType: project.deliveryType === "program" ? "program" : "website",
      questions: core.normalizeIntakeQuestions(core.DEFAULT_INTAKE_QUESTIONS),
      inviteToken: makeToken(),
      status: "open",
      // Nur intern, damit die Liste der Kundenanfragen lesbar bleibt — der
      // veröffentlichte Fragebogen trägt davon nichts (Positivliste).
      projectLabel: project.title || "",
      createdAt: now(),
      updatedAt: now(),
    };
    ft.intakes[intakeId] = intake;
    project.ftContactLog = Array.isArray(project.ftContactLog) ? project.ftContactLog : [];
    project.ftContactLog.unshift({
      id: id(), at: now(), channel: "note",
      text: "Fragebogen-Link dieses Projekts erstellt — " + core.LINK_LABELS.intakeHint + ".",
    });
    project.updatedAt = now();
    publishIntakeForm(intakeId);
    save();
    return intake;
  }
  window._ftIntakeForProject = intakeForProject;

  // Der Zustand, den die FlowerTech-Karte anzeigt: erstellen, kopieren,
  // beantwortet. Ohne Seiteneffekt — er legt nichts an.
  function projectIntakeState(projectId) {
    var core = W();
    var project = projectById(projectId);
    if (!core || !project) return null;
    // Der Stand entscheidet ueber die Beschriftung: Ist die Vorschau
    // freigegeben, darf oben nicht "keine Vorschau" stehen.
    var area = customerArea(projectId);
    return core.projectIntakeLinkState({
      project: project, intake: intakeOfProject(projectId),
      previewVisible: !!(area && area.tiles && area.tiles.preview),
      testServiceVisible: !!(area && area.tiles && area.tiles.testService),
      contractVisible: !!(area && area.tiles && area.tiles.contract),
    });
  }
  window._ftProjectIntakeState = projectIntakeState;

  function projectIntakeLink(projectId) {
    var intake = intakeOfProject(projectId);
    return intake ? intakeLink(intake.id) : "";
  }
  window._ftProjectIntakeLink = projectIntakeLink;

  window._ftCreateProjectIntakeLink = function (projectId) {
    var core = W();
    var intake = intakeForProject(projectId);
    if (!intake) return notify("warn", "Fragebogen", "Dieses Projekt ist nicht mehr da.");
    rerender();
    var link = intakeLink(intake.id);
    notify(link ? "ok" : "warn", "Fragebogen", link
      ? "Fragebogen-Link für dieses Projekt erstellt — " + (core ? core.LINK_LABELS.intakeHint : "")
      : "Ohne Firebase-Zugang gibt es noch keinen Fragebogen-Link.");
  };

  window._ftCopyProjectIntakeLink = function (projectId) {
    var core = W();
    var intake = intakeForProject(projectId);
    if (!intake) return notify("warn", "Fragebogen", "Dieses Projekt ist nicht mehr da.");
    var link = intakeLink(intake.id);
    if (!link) return notify("warn", "Fragebogen", "Ohne Firebase-Zugang gibt es keinen Fragebogen-Link.");
    // Der Erfolgshinweis nennt ausdrücklich, WELCHER Link kopiert wurde — die
    // Verwechslung mit dem Kundenportal-Link entstand genau hier.
    var st = projectIntakeState(projectId);
    copyText(link, core
      ? core.intakeLinkLabel({ previewVisible: !!(st && st.previewVisible), copied: true })
      : "Kundenadresse kopiert");
    rerender();
  };

  /* Die Zeile, die der Fragebogen-Link auf der Projektseite bekommt. Sie ist
     bewusst NICHT clientLinkRowHtml: andere Beschriftung, andere Phase,
     anderer Empfängerkreis — und sie steht auch dann da, wenn es noch gar
     kein Kundenportal gibt. */
  function projectIntakeRowHtml(projectId) {
    var core = W();
    var state = projectIntakeState(projectId);
    if (!core || !state || state.mode === "none") return "";
    // Die Zeile trägt IMMER dieselbe vollständige Beschriftung — auch dann,
    // wenn es den Link noch gar nicht gibt. Nur so ist von Anfang an klar,
    // welcher der beiden Links hier entsteht.
    var head = '<div class="ft-link-row ft-link-intake"><span>' + esc(state.label || core.LINK_LABELS.intakeFull) + "</span>";
    if (state.mode === "create") {
      return head +
        '<button class="btn sm primary" onclick="window._ftCreateProjectIntakeLink(\'' + attr(projectId) +
          '\')" title="' + attr(core.LINK_LABELS.intakeHint) + '">' + esc(core.LINK_LABELS.intakeCreate) +
          "</button></div>" +
        '<div class="mini">' + esc(state.explain) + "</div>";
    }
    return '<div class="ft-link-row ft-link-intake"><span>' + esc(state.label || core.LINK_LABELS.intakeFull) + "</span>" +
      '<input readonly value="' + attr(state.url) + '" onclick="this.select()">' +
      '<button class="btn sm primary" onclick="window._ftCopyProjectIntakeLink(\'' + attr(projectId) +
        '\')" title="' + attr(core.LINK_LABELS.intakeHint) + '">' + esc(core.LINK_LABELS.intakeCopy) + "</button>" +
      '<a class="btn sm ghost" href="' + attr(state.url) + '" target="_blank" rel="noopener">' +
        esc(core.LINK_LABELS.intakeOpen) + "</a></div>" +
      (state.canReset
        ? '<div class="ft-ready">✓ Fragebogen beantwortet · Stand ' + esc(dateTime(state.answeredAt)) +
          " — die Angaben stehen an diesem Projekt, ein zweites Projekt entstand nicht.</div>" +
          // Der Rückweg nach einer Test- oder Fehleingabe. Er steht NUR hier,
          // an einem bereits beantworteten Fragebogen, und nur in der App —
          // die Kundenseite kennt ihn nicht.
          '<div class="ft-link-row ft-intake-reset">' +
          '<button class="btn sm ghost ft-danger" onclick="window._ftResetProjectIntake(\'' + attr(projectId) +
            '\')" title="' + attr(core.LINK_LABELS.intakeResetDone) + '">↺ ' +
            esc(core.LINK_LABELS.intakeReset) + "</button>" +
          '<span class="mini">Setzt ausschliesslich Antwortstatus, Antwortzeitpunkt und ' +
            "Fragebogen-Payload zurück. Link, Projekt, Kundendaten, Budget, Offerten, Kundenportal " +
            "und Aufgaben bleiben unverändert.</span></div>"
        : "") +
      '<div class="mini">' + esc(state.explain) + "</div>" +
      customerStagesHtml(projectId);
  }
  window._ftProjectIntakeRow = projectIntakeRowHtml;

  /* Was die Kundschaft hinter diesem einen Link JETZT sieht — und was nicht.
     Beides steht da, Zeile für Zeile: Die Stufen sind der Grund, warum es nur
     eine Adresse gibt, und ohne diese Liste wüsste ich nie, was gerade
     draussen ist. */
  function customerStagesHtml(projectId) {
    var area = customerArea(projectId);
    if (!area || !area.hasLink) return "";
    return '<div class="ft-stages">' +
      '<div class="ft-stages-head">Hinter diesem Link sichtbar</div>' +
      area.stages.map(function (stage) {
        return '<div class="ft-stage' + (stage.visible ? " on" : "") + '">' +
          '<span class="ft-stage-dot">' + (stage.visible ? "✓" : "○") + "</span>" +
          '<span class="ft-stage-body"><b>' + esc(stage.label) + "</b> — " +
          esc(stage.visible ? stage.shows : (stage.reason || stage.hides)) + "</span></div>";
      }).join("") +
      '<div class="mini">Eine Adresse für alles: Die Standard-AGB stehen immer da ' +
        "(zentral, ohne Freigabe), Vorschau, Vertrag und die TEST-Übersicht jeweils nach " +
        "eigener, widerrufbarer Freigabe. Ein zweiter Link entsteht nie.</div></div>";
  }
  window._ftCustomerStagesHtml = customerStagesHtml;

  /* ── Fragebogen zurücksetzen ───────────────────────────────────────────
     Nach einer Test- oder Fehleingabe soll DERSELBE, bereits verschickte Link
     wieder als unbeantwortet gelten. „Neu" kann das nicht: Es tauscht den
     Token und macht genau diesen Link ungültig.

     Zurückgesetzt wird deshalb ausschliesslich die Antwort — Antwortstatus,
     Antwortzeitpunkt, Einreichungsvermerk und der Fragebogen-Payload am
     Projekt. Nicht angefasst werden Token und Link, Projekt und Kundendaten,
     Budget und Preise, Offerten, Verträge, Kundenportal und sämtliche
     Aufgaben — allen voran die bestehende „Offertenanfrage". Sie bleibt
     stehen, und weil der Aufgabenschlüssel (`<projektId>:intake`) unverändert
     ist, legt auch eine erneute Einreichung keine zweite an.

     Was zurückgesetzt wird, entscheidet der Kern (intakeResetPlan) — samt der
     Bestätigung, die genau diese Folgen benennt.
     ------------------------------------------------------------------- */
  function resetProjectIntake(projectId) {
    var core = W();
    var project = projectById(projectId);
    if (!core || !project) {
      notify("warn", "Fragebogen", "Dieses Projekt ist nicht mehr da.");
      return false;
    }
    var intake = intakeOfProject(projectId);
    var plan = core.intakeResetPlan({ project: project, intake: intake, now: now() });
    if (!plan.allowed) {
      notify("warn", core.LINK_LABELS.intakeReset, plan.reason);
      return false;
    }
    // Ohne ausdrückliche Bestätigung geschieht nichts. Der Text nennt beide
    // Seiten: was verschwindet und was ausdrücklich bleibt.
    if (typeof confirm === "function" && !confirm(plan.confirmText)) return false;

    Object.keys(plan.intakePatch).forEach(function (key) { intake[key] = plan.intakePatch[key]; });
    plan.projectClears.forEach(function (key) { delete project[key]; });
    project.ftContactLog = Array.isArray(project.ftContactLog) ? project.ftContactLog : [];
    project.ftContactLog.unshift({ id: id(), at: now(), channel: "note", text: plan.logText });
    project.updatedAt = now();
    // Der Prompt beschreibt den aktuellen Stand — ohne Fragebogen-Payload also
    // auch ohne dessen Angaben. Er wird neu erzeugt, nicht stehen gelassen.
    regeneratePrompt(projectId);
    // Und der öffentliche Link zeigt wieder eine leere Form: Der
    // veröffentlichte Fragebogen steht sofort wieder auf „open".
    publishIntakeForm(intake.id);
    save();
    rerender();
    notify("ok", core.LINK_LABELS.intakeReset, core.LINK_LABELS.intakeResetDone);
    return true;
  }
  window._ftResetProjectIntake = resetProjectIntake;

  /* ── Stufe 3: Vorschau und Verwaltung ausdrücklich freigeben ───────────
     Eine Adresse einzutragen heisst nicht, sie zu zeigen. An einer halben
     Vorschau wird tagelang gearbeitet — sie geht erst mit einer ausdrücklichen
     Entscheidung an die Kundschaft, und die Verwaltung noch einmal mit einer
     eigenen. Beides ist jederzeit widerrufbar; der Link bleibt derselbe.
     ------------------------------------------------------------------- */
  function setCustomerRelease(projectId, field, on, label) {
    var core = W();
    var project = projectById(projectId);
    if (!core || !project) return false;
    var area = customerArea(projectId);
    var gate = field === "ftCustomerPreview" ? area.preview : area.admin;
    if (on && !gate.url) {
      notify("warn", label, gate.reason);
      return false;
    }
    if (on && field === "ftCustomerPreview" && !gate.promptReady) {
      notify("warn", label, gate.reason);
      return false;
    }
    if (on && field === "ftCustomerAdmin" && !area.preview.visible) {
      notify("warn", label, "Die Verwaltung erscheint erst mit der freigegebenen Vorschau.");
      return false;
    }
    project[field] = { released: !!on, releasedAt: on ? now() : "" };
    project.updatedAt = now();
    project.ftContactLog = Array.isArray(project.ftContactLog) ? project.ftContactLog : [];
    project.ftContactLog.unshift({
      id: id(), at: now(), channel: "note",
      text: label + (on ? " im Kundenbereich freigegeben." : " aus dem Kundenbereich zurückgezogen."),
    });
    // Widerruf wirkt sofort: Die Kachel verschwindet mit dieser Veröffentlichung.
    refreshCustomerArea(projectId);
    save();
    rerender();
    notify("ok", label, on
      ? label + " ist jetzt im Kundenbereich sichtbar — derselbe Link wie bisher."
      : label + " ist nicht mehr sichtbar. Der Link bleibt gültig.");
    return true;
  }

  /* ── Unverbindliche Test-Leistungskachel ────────────────────────────────
     Eine ausdrueckliche Ausnahme vom normalen Weg — und sie bleibt eine:
     Der Offertenweg (Entwurf → Versand → sichtbar) ist unveraendert. Diese
     Kachel versendet nichts, legt keine Rechnung an und traegt keinen Betrag.
     Sie erscheint nur nach eigener Freigabe und verschwindet mit dem Widerruf.
     ------------------------------------------------------------------- */
  var TEST_TILE_FIELDS = ["title", "summary", "currentUrl", "previewUrl"];

  window._ftSetTestServiceTile = function (projectId, field, value) {
    var project = projectById(projectId);
    if (!project || TEST_TILE_FIELDS.indexOf(field) < 0) return;
    var tile = project.ftTestServiceTile && typeof project.ftTestServiceTile === "object"
      ? project.ftTestServiceTile : {};
    tile[field] = String(value == null ? "" : value);
    project.ftTestServiceTile = tile;
    project.updatedAt = now();
    save();
    // Nur nachziehen, wenn die Kachel wirklich draussen ist — sonst
    // veroeffentlicht jedes Tippen einen Zwischenstand.
    if (tile.released === true) refreshCustomerArea(projectId);
  };

  window._ftReleaseTestService = function (projectId, on) {
    var core = W();
    var project = projectById(projectId);
    if (!core || !project) return false;
    var tile = project.ftTestServiceTile && typeof project.ftTestServiceTile === "object"
      ? project.ftTestServiceTile : {};
    if (on && !String(tile.title || "").trim()) {
      notify("warn", "Test-Kachel", "Ohne Titel gibt es nichts zu zeigen.");
      return false;
    }
    tile.released = !!on;
    tile.releasedAt = on ? now() : "";
    project.ftTestServiceTile = tile;
    project.updatedAt = now();
    project.ftContactLog = Array.isArray(project.ftContactLog) ? project.ftContactLog : [];
    project.ftContactLog.unshift({
      id: id(), at: now(), channel: "note",
      text: on
        ? "TEST-Leistungskachel im Kundenbereich freigegeben (unverbindlich, ohne Preis, ohne Versand)."
        : "TEST-Leistungskachel aus dem Kundenbereich zurueckgezogen.",
    });
    refreshCustomerArea(projectId);
    save();
    rerender();
    notify("ok", "Test-Kachel", on
      ? "Sichtbar auf dem bestehenden Kundenlink — als TEST gekennzeichnet, ohne Preis. Es wurde nichts versendet."
      : "Nicht mehr sichtbar. Der Link bleibt gueltig.");
    return true;
  };

  window._ftReleaseCustomerPreview = function (projectId, on) {
    return setCustomerRelease(projectId, "ftCustomerPreview", on, "Website-Vorschau");
  };
  window._ftReleaseCustomerAdmin = function (projectId, on) {
    return setCustomerRelease(projectId, "ftCustomerAdmin", on, "Verwaltung");
  };

  /* Ein Änderungswunsch aus dem Kundenbereich. Er kommt mit dem Einladungs-
     token — also über denselben Link, den die Kundschaft ohnehin hat. Er wird
     nur angenommen, wenn die Vorschau-Kachel wirklich freigegeben ist: Vorher
     gibt es dort nichts zu kommentieren, und ein Token soll nie mehr öffnen,
     als die Stufe hergibt. */
  function applyCustomerAreaChange(intakeId, entry) {
    var core = W();
    var intake = intakeById(intakeId);
    if (!core || !intake) return false;
    var project = projectOfIntake(intake);
    if (!project) return false;
    var area = customerArea(project.id);
    if (!area || !area.tiles.preview) return false;
    var cr = core.normalizeChangeRequest(
      Object.assign({}, entry.payload || {}, { origin: "client" }), { now: now() });
    if (!core.changeRequestIsUsable(cr)) return false;
    addChangeRequest(project.id, cr);
    return true;
  }
  window._ftApplyCustomerAreaChange = applyCustomerAreaChange;

  /* Die Antwort auf einen projektgebundenen Fragebogen. Sie erzeugt KEIN
     zweites Projekt: Sie ergänzt dieses Projekt (Gepflegtes bleibt stehen),
     legt das Anfrage-Dokument ab, führt den Vision Room nach und sorgt über
     denselben Schlüssel wie der Erstweg für HÖCHSTENS EINE Aufgabe
     „Offertenanfrage". */
  function applyIntakeToProject(projectId, intake, answers, opts) {
    var core = W();
    var project = projectById(projectId);
    if (!core || !project) return false;
    var options = opts || {};
    var doc = core.buildIntakeDocument({
      intake: intake, answers: answers, now: options.submittedAt || now(),
    });
    var update = core.intakeUpdateForProject({ project: project, answers: answers, now: now() });

    project.ftIntakeDocument = doc;
    Object.keys(update.patch).forEach(function (key) { project[key] = update.patch[key]; });
    project.client = project.client || {};
    Object.keys(update.client).forEach(function (key) { project.client[key] = update.client[key]; });
    project.sourceIntakeId = project.sourceIntakeId || (intake && intake.id) || null;

    project.ftContactLog = Array.isArray(project.ftContactLog) ? project.ftContactLog : [];
    project.ftContactLog.unshift({
      id: id(), at: now(), channel: "note",
      text: options.logText || "Fragebogen dieses Projekts ausgefüllt eingegangen.",
    });
    // Genau eine Aufgabe: derselbe Schlüssel wie beim Erstweg (projektId +
    // ":intake"). Ein zweiter Eingang findet sie und legt nichts nach.
    createIntakeTask(projectId, project, doc);
    regeneratePrompt(projectId);
    return true;
  }
  window._ftApplyIntakeToProject = applyIntakeToProject;

  /* Die Offerte wird dem neuen Projekt ZUGEORDNET — unverändert und ohne
     zweite Kopie. Die Entscheidung liegt im Kern (offerProjectLinkPlan),
     damit sie idempotent bleibt: ein zweiter Durchlauf ordnet nicht erneut
     zu, und eine Offerte eines anderen Vorgangs wird nicht umgehängt. */
  function linkOfferToProject(offerId, projectId) {
    var core = W();
    var doc = docById("offer", offerId);
    if (!core || !doc) return false;
    var plan = core.offerProjectLinkPlan({ offer: doc, projectId: projectId });
    if (!plan.link) return false;
    doc.projectId = projectId;
    doc.updatedAt = now();
    pushHistory(doc, "linked", "Dem Projekt aus dem Fragebogen zugeordnet — Inhalt unverändert.");
    return true;
  }
  window._ftLinkOfferToProject = linkOfferToProject;

  /* Die Antworten der Kundschaft in die Offerte übernehmen — auf Klick und
     nur in leere Felder. Automatisch geschieht das bewusst nicht: Die Offerte
     wird dem Projekt zugeordnet, nicht überschrieben. */
  window._ftOfferAdoptIntakeClient = function (offerId) {
    var doc = docById("offer", offerId);
    if (!doc || !doc.projectId) return;
    var project = projectById(doc.projectId) || {};
    var from = project.client || {};
    doc.client = doc.client || {};
    var taken = [];
    [["company", "Firma"], ["name", "Name"], ["email", "E-Mail"], ["phone", "Telefon"],
      ["street", "Adresse"]].forEach(function (field) {
      var value = String(from[field[0]] || "").trim();
      if (value && !String(doc.client[field[0]] || "").trim()) {
        doc.client[field[0]] = value;
        taken.push(field[1]);
      }
    });
    if (!taken.length) {
      return notify("ok", "Kundendaten", "Alles schon eingetragen — es wurde nichts überschrieben.");
    }
    doc.updatedAt = now();
    pushHistory(doc, "client", "Kundendaten aus dem Fragebogen übernommen: " + taken.join(", "));
    save();
    rerender();
    notify("ok", "Kundendaten", "Übernommen: " + taken.join(", ") + ". Bestehendes blieb unverändert.");
  };

  window._ftOpenIntakeForInquiry = function (inquiryId) {
    var ft = wf();
    var intake = intakeForInquiry(inquiryId);
    if (!ft || !intake) return;
    ft.ui.intakeId = intake.id;
    setActiveTab("intakes");
    save();
    rerender();
  };

  window._ftOpenIntake = function (intakeId) {
    var ft = wf();
    if (!ft) return;
    ft.ui.intakeId = ft.ui.intakeId === intakeId ? null : intakeId;
    save();
    rerender();
  };

  window._ftSetIntakeField = function (intakeId, field, value) {
    var intake = intakeById(intakeId);
    if (!intake) return;
    intake[field] = value;
    intake.updatedAt = now();
    save();
    publishIntakeForm(intakeId);
  };

  window._ftSetIntakeQuestion = function (intakeId, index, field, value) {
    var core = W();
    var intake = intakeById(intakeId);
    if (!core || !intake) return;
    var q = (intake.questions || [])[index];
    if (!q) return;
    if (field === "required") q.required = !!value;
    else if (field === "options") q.options = String(value || "").split("\n").map(function (v) { return v.trim(); }).filter(Boolean);
    else q[field] = value;
    intake.questions = core.normalizeIntakeQuestions(intake.questions);
    intake.updatedAt = now();
    save();
    publishIntakeForm(intakeId);
    rerender();
  };

  window._ftAddIntakeQuestion = function (intakeId) {
    var core = W();
    var intake = intakeById(intakeId);
    if (!core || !intake) return;
    intake.questions = (intake.questions || []).concat([
      { key: "frage-" + ((intake.questions || []).length + 1), label: "Neue Frage", type: "text", role: "", required: false },
    ]);
    intake.questions = core.normalizeIntakeQuestions(intake.questions);
    intake.updatedAt = now();
    save();
    publishIntakeForm(intakeId);
    rerender();
  };

  window._ftMoveIntakeQuestion = function (intakeId, index, delta) {
    var intake = intakeById(intakeId);
    if (!intake) return;
    var list = intake.questions || [];
    var to = index + delta;
    if (to < 0 || to >= list.length) return;
    var moved = list.splice(index, 1)[0];
    list.splice(to, 0, moved);
    intake.updatedAt = now();
    save();
    publishIntakeForm(intakeId);
    rerender();
  };

  window._ftRemoveIntakeQuestion = function (intakeId, index) {
    var intake = intakeById(intakeId);
    if (!intake) return;
    (intake.questions || []).splice(index, 1);
    intake.updatedAt = now();
    save();
    publishIntakeForm(intakeId);
    rerender();
  };

  // „Neu" widerruft die alte Einladung samt veröffentlichtem Fragebogen.
  window._ftRotateIntakeToken = function (intakeId) {
    var intake = intakeById(intakeId);
    if (!intake) return;
    if (!confirm("Der bisherige Link wird ungültig. Fortfahren?")) return;
    var old = intakeRef(intake.inviteToken);
    if (old) old.remove().catch(function () {});
    intake.inviteToken = makeToken();
    intake.updatedAt = now();
    save();
    publishIntakeForm(intakeId);
    rerender();
  };

  window._ftCloseIntake = function (intakeId) {
    var intake = intakeById(intakeId);
    if (!intake) return;
    intake.status = intake.status === "closed" ? "open" : "closed";
    intake.updatedAt = now();
    save();
    publishIntakeForm(intakeId);
    rerender();
  };

  // Aus der Antwort entsteht der Vorgang — genau einmal. Zwei Sperren: die
  // Einreichung ist am Fragebogen vermerkt, und der Fragebogen kennt sein
  // Projekt. Ein Reload oder ein zweites Absenden ändert deshalb nichts.
  function applyIntakeSubmission(intakeId, entry) {
    var core = W();
    var ft = wf();
    var intake = intakeById(intakeId);
    if (!core || !ft || !intake) return false;
    var submissionId = entry.id || null;
    var binding = core.intakeBinding(intake);
    // Gebundener Fragebogen: Das Projekt gibt es bereits. Es darf kein zweites
    // entstehen — die Antwort aktualisiert genau dieses eine.
    var bound = binding.mode === "bound" ? projectById(binding.projectId) : null;
    if (!bound && intake.projectId && projectById(intake.projectId)) return false;
    if (submissionId && intake.submissionId === submissionId) return false;

    var payload = entry.payload || {};
    var normalized = core.normalizeIntakeAnswers(intake.questions || [], answersToMap(payload.answers), { now: now() });
    var check = core.intakeAnswersUsable(intake.questions || [], normalized.answers);
    if (!check.usable) return false;

    if (bound) {
      if (!applyIntakeToProject(bound.id, intake, normalized.answers, {
        submittedAt: entry.createdAt || now(),
        logText: "Fragebogen „" + (intake.title || "") + "“ ausgefüllt eingegangen.",
      })) return false;
      intake.projectId = bound.id;
      intake.submissionId = submissionId;
      intake.answeredAt = entry.createdAt || now();
      intake.status = "answered";
      intake.updatedAt = now();
      publishIntakeForm(intake.id);
      save();
      notify("ok", "Kundenanfrage", "Fragebogen beantwortet — Projekt aktualisiert: " + (bound.title || ""));
      return true;
    }

    var projectId = createProjectForIntake(intake, normalized.answers, {
      submittedAt: entry.createdAt || now(),
      logText: "Fragebogen „" + (intake.title || "") + "“ ausgefüllt eingegangen.",
    });
    if (!projectId) return false;

    intake.projectId = projectId;
    intake.submissionId = submissionId;
    intake.answeredAt = entry.createdAt || now();
    intake.status = "answered";
    intake.updatedAt = now();
    publishIntakeForm(intakeId);
    save();
    notify("ok", "Kundenanfrage", "Fragebogen beantwortet — Projekt angelegt: " +
      ((projectById(projectId) || {}).title || ""));
    return true;
  }

  /* Der gemeinsame Weg vom beantworteten Fragebogen zum Vorgang. Er wird von
     zwei Stellen benutzt: vom oeffentlichen Fragebogen und vom Vision Room.
     Beide erzeugen dieselben Artefakte — Anfrage-Dokument, Vorlage, Prompt,
     Kundenportal und GENAU EINE Aufgabe. */
  function createProjectForIntake(intake, answers, opts) {
    var core = W();
    var ft = wf();
    if (!core || !ft) return "";
    var options = opts || {};
    var doc = core.buildIntakeDocument({
      intake: intake, answers: answers, now: options.submittedAt || now(),
    });
    var built = core.projectFromIntake({ intake: intake, answers: answers, now: now() });
    built.sourceIntakeId = intake.id || null;
    if (options.tags) built.tags = built.tags.concat(options.tags);
    if (options.routeSource) built.ftRouteSource = options.routeSource;
    var projectId = window.createEntity("project", built);
    if (!projectId) return "";

    var project = projectById(projectId);
    if (project) {
      project.ftIntakeDocument = doc;
      project.ftContactLog = [{
        id: id(), at: now(), channel: "note",
        text: options.logText || "Kundenanfrage eingegangen.",
      }];
      // Sofort eine echte Vorschau: die Standardvorlage, aus den Antworten
      // gefüllt. Sie lässt sich danach herunterladen, ändern und ersetzen.
      project.ftTemplate = {
        name: "flowertech-standard.html",
        html: core.defaultTemplateHtml({ project: built, document: doc, company: ft.company || {} }),
        source: "standard",
        updatedAt: now(),
      };
      project.ftPrompt = {
        name: "prompt.md", text: buildPromptFor(projectId), source: "generiert", updatedAt: now(),
      };
    }
    createIntakeTask(projectId, built, doc);
    // Kam der Fragebogen von einer Offerte ohne Projekt, wird GENAU DIESE
    // Offerte dem neuen Projekt zugeordnet — unverändert und ohne zweite
    // Kopie. Die Zuordnung ist idempotent: ein zweiter Durchlauf tut nichts.
    if (intake.offerId) linkOfferToProject(intake.offerId, projectId);
    ensureToken(projectId, "formToken");
    // BEWUSST kein Kundenportal an dieser Stelle. Phase 1 endet hier: Es gibt
    // ein Projekt, den vollständigen Prompt und eine Aufgabe. Der zweite Link
    // entsteht erst in Phase 2 — nach Vorschau, Leistungsbeschreibung,
    // Offerte, Vertrag, AGB und einer ausdrücklichen Veröffentlichung.
    return projectId;
  }
  window._ftApplyIntakeSubmission = applyIntakeSubmission;

  // Der Eingang liefert die Antworten als Liste; normalizeIntakeAnswers
  // erwartet eine Zuordnung Schlüssel → Wert.
  function answersToMap(answers) {
    var map = {};
    (Array.isArray(answers) ? answers : []).forEach(function (a) {
      if (a && a.key) map[a.key] = a.answer;
    });
    return map;
  }

  function createIntakeTask(projectId, project, doc) {
    var core = W();
    var root = data();
    if (!core || !root) return "";
    var key = projectId + ":intake";
    var existing = Object.keys(root.entities.tasks || {}).find(function (taskId) {
      var task = root.entities.tasks[taskId];
      return task && task.sourceIntakeKey === key;
    });
    if (existing) return existing;
    var draft = core.buildIntakeTask({ project: project, document: doc, projectId: projectId, now: now() });
    var payload = Object.assign({}, draft);
    delete payload.key;
    payload.sourceIntakeKey = key;
    return window.createEntity("task", payload) || "";
  }

  /* ── Vorlage und Prompt ──────────────────────────────────────────────────
     Beide gehören dem Projekt und sind Dateien: herunterladen, ändern, wieder
     hochladen. Der Upload ersetzt bewusst — sonst wüsste niemand, welche
     Fassung gerade gilt.
     ------------------------------------------------------------------- */
  /* Alles, woraus der projektspezifische Prompt gebaut wird — an einer Stelle,
     damit Prompt, Quellenliste und die Liste der fehlenden Angaben dieselbe
     Wahrheit benutzen. Wächst der Vorgang, wächst der Prompt mit. */
  function promptContext(projectId) {
    var core = W();
    var ft = wf();
    var project = projectById(projectId);
    if (!core || !ft || !project) return { project: {} };
    var offers = docsOfProject("offer", projectId);
    var offer = core.customerAreaOffer(offers);
    var content = contentOf(projectId);
    return {
      project: project,
      document: project.ftIntakeDocument || {},
      changes: changesOf(projectId),
      questions: project.ftPortalQuestions || [],
      templateName: (project.ftTemplate && project.ftTemplate.name) || "",
      company: ft.company || {},
      // Kontakt- und Adressdaten bleiben intern. Sie gehen NUR mit, wenn ich
      // das am Projekt ausdrücklich wähle — Standard ist aus.
      includeContact: promptInclude(projectId).client === true,
      briefing: briefingOf(projectId) || null,
      content: (content && content.sections) || [],
      // Nur eine WIRKLICH versendete Offerte ist verbindlicher Lieferumfang.
      offer: offer,
      offerAmount: offer ? docTotals(offer).rounded : null,
      now: now(),
    };
  }
  window._ftPromptContext = promptContext;

  function buildPromptFor(projectId) {
    var core = W();
    var project = projectById(projectId);
    if (!core || !project) return "";
    return core.buildProjectPrompt(promptContext(projectId));
  }
  window._ftBuildPrompt = buildPromptFor;

  // Der Prompt gehört zum Projekt und muss dem Datenstand folgen. Jede Stelle,
  // die Antworten ergänzt, ruft das hier auf — sonst veraltet er still.
  function regeneratePrompt(projectId) {
    var project = projectById(projectId);
    if (!project) return;
    project.ftPrompt = { name: "prompt.md", text: buildPromptFor(projectId), source: "generiert", updatedAt: now() };
    project.updatedAt = now();
  }
  window._ftRegeneratePromptFor = regeneratePrompt;

  window._ftRegeneratePrompt = function (projectId) {
    if (!projectById(projectId)) return;
    regeneratePrompt(projectId);
    save();
    rerender();
    notify("ok", "Prompt", "Prompt neu aus dem aktuellen Stand erzeugt");
  };

  function download(name, text, type) {
    try {
      var blob = new window.Blob([text], { type: type + ";charset=utf-8" });
      var url = window.URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { window.URL.revokeObjectURL(url); }, 2000);
    } catch (e) {
      notify("err", "Download", "Die Datei konnte nicht erzeugt werden.");
    }
  }

  window._ftDownloadPrompt = function (projectId) {
    var project = projectById(projectId);
    if (!project) return;
    var text = (project.ftPrompt && project.ftPrompt.text) || buildPromptFor(projectId);
    download(slugName(project.title) + "-prompt.md", text, "text/markdown");
  };

  window._ftDownloadTemplate = function (projectId) {
    var project = projectById(projectId);
    if (!project) return;
    var html = (project.ftTemplate && project.ftTemplate.html) || "";
    download(slugName(project.title) + "-vorlage.html", html, "text/html");
  };

  window._ftCopyPrompt = function (projectId) {
    var project = projectById(projectId);
    if (!project) return;
    var text = (project.ftPrompt && project.ftPrompt.text) || buildPromptFor(projectId);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        notify("ok", "Prompt", "In die Zwischenablage kopiert");
      }).catch(function () { notify("warn", "Prompt", "Kopieren nicht möglich"); });
    } else notify("warn", "Prompt", "Kopieren nicht möglich");
  };

  function slugName(value) {
    return String(value || "projekt").toLowerCase()
      .replace(/[äàâ]/g, "a").replace(/[öô]/g, "o").replace(/[üû]/g, "u").replace(/ß/g, "ss")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "projekt";
  }

  // Upload: nur die erwartete Art, nur bis zur Grenze, und beim HTML zusätzlich
  // entschärft. Was entfernt wurde, wird benannt statt stillschweigend gelöscht.
  window._ftUploadTemplate = function (projectId, input) {
    var core = W();
    var project = projectById(projectId);
    var file = input && input.files && input.files[0];
    if (!core || !project || !file) return;
    if (!/\.html?$/i.test(file.name)) {
      return notify("warn", "Vorlage", "Bitte eine .html-Datei wählen.");
    }
    if (file.size > core.MAX_TEMPLATE_BYTES) {
      return notify("warn", "Vorlage", "Die Datei ist zu gross (max. " +
        Math.round(core.MAX_TEMPLATE_BYTES / 1024) + " KB).");
    }
    var reader = new window.FileReader();
    reader.onload = function () {
      var clean = core.sanitizeTemplateHtml(String(reader.result || ""));
      project.ftTemplate = {
        name: String(file.name).slice(0, 120), html: clean.html,
        source: "hochgeladen", updatedAt: now(),
      };
      project.updatedAt = now();
      save();
      refreshClientPortal(projectId);
      rerender();
      notify("ok", "Vorlage", clean.removed.length
        ? "Ersetzt. Entfernt wurden: " + clean.removed.join(", ") + "."
        : "Vorlage ersetzt — die Vorschau ist aktualisiert.");
    };
    reader.onerror = function () { notify("err", "Vorlage", "Die Datei liess sich nicht lesen."); };
    reader.readAsText(file);
  };

  window._ftUploadPrompt = function (projectId, input) {
    var core = W();
    var project = projectById(projectId);
    var file = input && input.files && input.files[0];
    if (!core || !project || !file) return;
    if (!/\.(md|markdown|txt)$/i.test(file.name)) {
      return notify("warn", "Prompt", "Bitte eine .md-Datei wählen.");
    }
    if (file.size > core.MAX_PROMPT_BYTES) {
      return notify("warn", "Prompt", "Die Datei ist zu gross (max. " +
        Math.round(core.MAX_PROMPT_BYTES / 1024) + " KB).");
    }
    var reader = new window.FileReader();
    reader.onload = function () {
      project.ftPrompt = {
        name: String(file.name).slice(0, 120), text: String(reader.result || "").slice(0, core.MAX_PROMPT_BYTES),
        source: "hochgeladen", updatedAt: now(),
      };
      project.updatedAt = now();
      save();
      rerender();
      notify("ok", "Prompt", "Prompt ersetzt.");
    };
    reader.onerror = function () { notify("err", "Prompt", "Die Datei liess sich nicht lesen."); };
    reader.readAsText(file);
  };

  window._ftResetTemplate = function (projectId) {
    var core = W();
    var ft = wf();
    var project = projectById(projectId);
    if (!core || !ft || !project) return;
    project.ftTemplate = {
      name: "flowertech-standard.html",
      html: core.defaultTemplateHtml({
        project: project, document: project.ftIntakeDocument || {}, company: ft.company || {},
      }),
      source: "standard", updatedAt: now(),
    };
    project.updatedAt = now();
    save();
    refreshClientPortal(projectId);
    rerender();
  };

  /* ── Rückfragen im Portal ────────────────────────────────────────────── */
  window._ftAskPortalQuestion = function (projectId) {
    var core = W();
    var project = projectById(projectId);
    var input = document.getElementById("ftPortalQuestion");
    if (!core || !project || !input) return;
    var q = core.normalizePortalQuestion({ question: input.value, askedAt: now() }, { now: now() });
    if (!q.question) return notify("warn", "Frage", "Bitte eine Frage eintragen.");
    q.id = id();
    project.ftPortalQuestions = Array.isArray(project.ftPortalQuestions) ? project.ftPortalQuestions : [];
    project.ftPortalQuestions.push(q);
    project.updatedAt = now();
    input.value = "";
    save();
    refreshClientPortal(projectId);
    rerender();
  };

  window._ftRemovePortalQuestion = function (projectId, questionId) {
    var project = projectById(projectId);
    if (!project) return;
    project.ftPortalQuestions = (project.ftPortalQuestions || []).filter(function (q) { return q.id !== questionId; });
    project.updatedAt = now();
    save();
    refreshClientPortal(projectId);
    rerender();
  };

  // ── Kundenansicht veröffentlichen ───────────────────────────────────────
  // Datensparsam: nur das, was der Kunde sehen soll. Kein Zugriff auf Quantus.
  // Der Snapshot kommt aus dem Kern (Positivliste). Hier wird nur eingesammelt,
  // was er braucht — nichts wird direkt durchgereicht.
  function clientSnapshot(projectId) {
    var core = W();
    var ft = wf();
    var project = projectById(projectId);
    if (!core || !ft || !project) return null;
    var content = contentOf(projectId);
    return core.buildClientSnapshot({
      project: project,
      company: ft.company || {},
      content: content ? blocksOf(content).filter(function (b) { return b.enabled !== false; })
        .map(function (b) { return { title: b.title, body: core.renderTemplate(b.body, wfVars(projectId)) }; }) : [],
      milestones: milestonesOfProject(projectId),
      changes: changesOf(projectId),
      versions: project.ftVersions || [],
      costs: core.costOverview({
        offers: docsOfProject("offer", projectId),
        invoices: docsOfProject("invoice", projectId),
        totals: function (doc) { return docTotals(doc).rounded; },
      }),
      quote: project.ftQuoteRequest || null,
      previewHtml: (project.ftTemplate && project.ftTemplate.html) || "",
      previewUpdatedAt: (project.ftTemplate && project.ftTemplate.updatedAt) || "",
      terms: termsForProject(projectId),
      consent: project.ftTermsConsent || null,
      questions: project.ftPortalQuestions || [],
      intakeDocument: project.ftIntakeDocument || null,
      release: portalRelease(projectId),
      // Vorbelegung bewusst nur inhaltlich: Bedarf, Art, Budget, Wunschdatum.
      // Kontaktdaten wandern NICHT auf die Kundenseite — der Link ist ein
      // Bearer-Link, und die Kundschaft kennt ihre eigenen Angaben.
      prefill: {
        need: (ft.briefings[projectId] || {}).goal || (project.ftVision || {}).idea || "",
        deliveryType: project.deliveryType || "",
        budget: project.budget,
        deadline: project.dueDate || "",
      },
      now: now(),
    });
  }
  window._ftClientSnapshot = clientSnapshot;

  // ── Zentrale Stelle fuer Kundenseite: Token sichern und Snapshot schreiben ──
  // Jeder Anlageweg und jede relevante Aenderung ruft NUR das hier auf.
  function portalRef(token) {
    if (!window.firebase || !firebase.app) return null;
    try { return firebase.app().database(RTDB).ref("flowertech/clientPortals/" + token); }
    catch (error) { return null; }
  }

  /* ── Phase 2: Wann ist das Kundenportal ein Link? ────────────────────────
     Erst wenn es etwas zu zeigen gibt UND ich es bewusst veröffentlicht habe.
     Die Bedingung liegt im Kern (portalReleaseState), damit Anzeige, Snapshot
     und Test dieselbe Wahrheit benutzen — eine Prüfung nur in der Anzeige wäre
     mit einem Klick umgangen.
     ------------------------------------------------------------------- */
  function portalRelease(projectId) {
    var core = W();
    var project = projectById(projectId) || {};
    var share = sharesOf(projectId);
    if (!core) return { ready: false, published: false, missing: [], label: "Kundenportal", reason: "" };
    var content = contentOf(projectId);
    var offers = docsOfProject("offer", projectId);
    return core.portalReleaseState({
      hasPreview: !!String((project.ftTemplate && project.ftTemplate.html) || "").trim()
        || !!core.clientSafeUrl(project.previewUrl),
      hasService: blocksOf(content).some(function (b) { return b.enabled !== false && String(b.body || "").trim(); }),
      // Eine Offerte zählt erst, wenn sie eine Leistung und einen Preis trägt.
      hasOffer: offers.some(function (doc) {
        return core.offerSendableState({ doc: doc, total: docTotals(doc).rounded }).ready;
      }),
      hasContract: (blocksOf(contractOf(projectId)) || []).some(function (b) { return String(b.body || "").trim(); }),
      hasTerms: !!String((termsForProject(projectId) || {}).body || "").trim(),
      // Abwärtskompatibilität, rein lesend: Vorgänge aus der Zeit vor dieser
      // Trennung wurden beim Anlegen automatisch veröffentlicht. Ihr Portal ist
      // bei der Kundschaft bereits im Umlauf — es darf nicht dadurch dunkel
      // werden, dass es den Knopf damals noch nicht gab. Ein vorhandenes
      // publishedAt zählt deshalb als erteilte Freigabe. Vollständig sein muss
      // der Vorgang trotzdem; ein halb leeres Portal ist genau das, was diese
      // Trennung abschafft. Es wird kein Datum geschrieben.
      released: share.portalReleased === true
        || (share.portalReleased !== false && !!share.publishedAt),
      releasedAt: share.portalReleasedAt || share.publishedAt || "",
    });
  }
  window._ftPortalRelease = portalRelease;

  // Schreibt den Snapshot — ausschliesslich für ein freigegebenes Portal.
  // Ohne Freigabe wird NICHTS geschrieben: ein Token darf vorbereitet sein,
  // eine öffentlich lesbare Seite entsteht daraus aber erst nach der Freigabe.
  function publishClientPortal(projectId) {
    var core = W();
    var ft = wf();
    if (!core || !ft || !projectById(projectId)) return null;
    var share = sharesOf(projectId);
    if (!portalRelease(projectId).published) return share.portalToken || null;
    // Genau EIN Token pro Projekt — ensureToken legt nur an, wenn keiner da ist.
    var token = ensureToken(projectId, "portalToken");
    var snapshot = clientSnapshot(projectId);
    if (!snapshot) return null;
    var ref = portalRef(token);
    if (!ref) {
      // Ohne Firebase kein Snapshot — das wird sichtbar vermerkt statt still
      // zu scheitern, sonst zeigte der Link dauerhaft einen Leerzustand.
      share.publishError = "Firebase nicht verfügbar — Kundenportal noch nicht veröffentlicht";
      return token;
    }
    ref.set(snapshot).then(function () {
      share.publishedAt = now();
      share.publishError = null;
      save();
    }, function (error) {
      share.publishError = error && error.message;
      save();
    });
    return token;
  }
  window._ftPublishClientPortal = publishClientPortal;

  /* Die bewusste Veröffentlichung. Sie ist der einzige Weg, aus dem
     vorbereiteten Token einen versendbaren Kundenportal-Link zu machen —
     und sie verweigert sich, solange etwas fehlt. */
  function releaseClientPortal(projectId) {
    var state = portalRelease(projectId);
    if (!state.ready) {
      notify("warn", "Kundenportal", state.reason);
      return null;
    }
    var share = sharesOf(projectId);
    share.portalReleased = true;
    share.portalReleasedAt = share.portalReleasedAt || now();
    ensureToken(projectId, "portalToken");
    var token = publishClientPortal(projectId);
    save();
    notify("ok", "Kundenportal", "Veröffentlicht — der Kundenportal-Link ist jetzt gültig.");
    return token;
  }
  window._ftReleaseClientPortal = function (projectId) {
    releaseClientPortal(projectId);
    rerender();
  };

  // Zurückziehen: Der Link verliert seinen Inhalt und gilt wieder als nicht
  // veröffentlicht. Bestehende Daten am Projekt bleiben unangetastet.
  window._ftUnpublishClientPortal = function (projectId) {
    if (!window.confirm("Kundenportal zurückziehen? Der Link zeigt danach nichts mehr.")) return;
    var share = sharesOf(projectId);
    share.portalReleased = false;
    share.publishedAt = null;
    var ref = share.portalToken ? portalRef(share.portalToken) : null;
    if (ref) ref.remove().catch(function () {});
    save();
    notify("ok", "Kundenportal", "Zurückgezogen — der Link zeigt nichts mehr.");
    rerender();
  };

  // Nach jeder relevanten Aenderung aufrufen. Gebuendelt, damit Tippen in einem
  // Feld nicht pro Anschlag schreibt. Wirkt nur auf ein freigegebenes Portal.
  var _portalTimers = {};
  function refreshClientPortal(projectId) {
    if (!projectId || !sharesOf(projectId).portalToken) return;
    if (!portalRelease(projectId).published) return;
    if (_portalTimers[projectId]) return;
    _portalTimers[projectId] = setTimeout(function () {
      delete _portalTimers[projectId];
      publishClientPortal(projectId);
    }, 600);
  }
  window._ftRefreshClientPortal = refreshClientPortal;

  // Der Link existiert erst nach der Freigabe. Vorher gibt es bewusst KEINEN
  // String, den man versehentlich kopieren und verschicken könnte.
  function clientPortalLink(projectId) {
    var core = W();
    var token = sharesOf(projectId).portalToken;
    if (!core || !token) return "";
    return portalRelease(projectId).published ? core.clientPortalUrl(token) : "";
  }
  window._ftClientPortalLink = clientPortalLink;

  /* Der Kundenportal-Link ist der ZWEITE Link. Vor der Freigabe gibt es hier
     bewusst keinen kopierbaren String, sondern den internen Zustand und die
     Liste dessen, was noch fehlt. So kann niemand versehentlich eine leere
     Seite verschicken — und der Fragebogen-Link bleibt der Link der Phase 1. */
  function clientLinkRowHtml(projectId, label) {
    var core = W();
    if (!projectId || !core) return "";
    var state = portalRelease(projectId);
    if (!state.published) {
      return '<div class="ft-legal-note"><b>' + esc(core.LINK_LABELS.portalUnpublished) + "</b><br>" +
        esc(state.reason) + "</div>";
    }
    var link = clientPortalLink(projectId);
    if (!link) {
      return '<div class="ft-legal-note">Der Kundenportal-Link konnte nicht erzeugt werden — ' +
        "ohne Firebase-Zugang gibt es keine Kundenseite.</div>";
    }
    return '<div class="ft-link-row"><span>' + esc(label || core.LINK_LABELS.portal) + "</span>" +
      '<input readonly value="' + attr(link) + '" onclick="this.select()">' +
      '<button class="btn sm primary" onclick="window._ftCopyLink(\'' + attr(link) + '\')">Kopieren</button>' +
      '<a class="btn sm ghost" href="' + attr(link) + '" target="_blank" rel="noopener">Öffnen</a></div>';
  }
  window._ftClientLinkRow = clientLinkRowHtml;

  // Manuelles Aktualisieren bleibt moeglich, macht aber dasselbe wie der
  // automatische Weg — eine Stelle, kein zweiter Pfad.
  window._ftPublishClientView = function (projectId) {
    var token = publishClientPortal(projectId);
    notify(token ? "ok" : "warn", "Kundenseite",
      token ? "Kundenseite aktualisiert" : "Kundenseite konnte nicht aktualisiert werden");
    rerender();
  };

  window._ftRotateToken = function (projectId, key) {
    if (!window.confirm("Neuen Link erzeugen? Der bisherige Link funktioniert danach nicht mehr.")) return;
    var share = sharesOf(projectId);
    var previous = share[key];
    share[key] = makeToken();
    // Widerruf heisst Widerruf: Der alte Snapshot wird geloescht, sonst bliebe
    // der alte Link weiter lesbar.
    if (key === "portalToken" && previous) {
      var ref = portalRef(previous);
      if (ref) ref.remove().catch(function () {});
    }
    save();
    if (key === "portalToken") publishClientPortal(projectId);
    notify("ok", "Link", "Neuer Link erzeugt — der alte ist widerrufen");
    rerender();
  };


  window._ftCopyLink = function (url) {
    if (!url) return notify("warn", "Link", "Noch kein Link vorhanden");
    copyText(url, "Link kopiert");
  };

  // Aus einer Liste heraus: Der Zugang entsteht erst beim Klick. Beim Rendern
  // eine Kundenseite fuer jedes Projekt anzulegen waere ein Schreibvorgang pro
  // Zeile — und pro Neuzeichnen.
  window._ftCopyProjectLink = function (projectId) {
    if (!projectId) return;
    var state = portalRelease(projectId);
    if (!state.published) return notify("warn", "Kundenportal", state.reason);
    var link = clientPortalLink(projectId);
    if (!link) return notify("warn", "Kundenportal", "Ohne Firebase-Zugang gibt es keine Kundenseite.");
    copyText(link, "Kundenportal-Link kopiert");
  };

  // ── Kundenmail aus Vorlage ──────────────────────────────────────────────
  window._ftComposeTemplate = function (projectId, key) {
    var core = W();
    if (!core) return;
    var draft = core.buildMessageDraft(key, wfVars(projectId));
    var project = projectById(projectId) || {};
    var to = (project.client || {}).email || "";
    if (typeof window.gmailComposeToEntity === "function") {
      window.gmailComposeToEntity("project", projectId, { to: to, subject: draft.subject, body: draft.body });
    }
    // Immer auch in die Zwischenablage: so ist der Entwurf nutzbar, egal welcher
    // Mailweg verwendet wird.
    copyText(draft.subject + "\n\n" + draft.body, "Entwurf kopiert");
    var log = project.ftContactLog = Array.isArray(project.ftContactLog) ? project.ftContactLog : [];
    log.unshift({ id: id(), at: now(), channel: "mail", text: "Vorlage vorbereitet: " + draft.subject });
    save();
  };

  // ── Versionen / Freigabe ────────────────────────────────────────────────
  window._ftAddVersion = function (projectId) {
    var project = projectById(projectId);
    if (!project) return;
    var label = ((document.getElementById("ftVersionLabel") || {}).value || "").trim();
    if (!label) return notify("warn", "Version", "Bitte kurz beschreiben, was neu ist");
    project.ftVersions = Array.isArray(project.ftVersions) ? project.ftVersions : [];
    project.ftVersions.unshift({ id: id(), at: now(), label: label, approved: false });
    project.updatedAt = now();
    refreshClientPortal(projectId);
    var el = document.getElementById("ftVersionLabel");
    if (el) el.value = "";
    save();
    rerender();
  };

  window._ftApproveVersion = function (projectId, versionId) {
    var core = W();
    var project = projectById(projectId);
    if (!project || !Array.isArray(project.ftVersions)) return;
    var version = project.ftVersions.find(function (v) { return v.id === versionId; });
    if (!version) return;
    version.approved = !version.approved;
    version.approvedAt = version.approved ? now() : null;
    if (version.approved && core) project.pipelineStage = "approval";
    project.updatedAt = now();
    refreshClientPortal(projectId);
    save();
    rerender();
  };

  // ── Beilage zur Offerte: Vision Room oder echte Beispiel-URL ────────────
  window._ftSetOfferAttachment = function (projectId, kind) {
    var project = projectById(projectId);
    if (!project) return;
    project.ftOfferAttachment = Object.assign({}, project.ftOfferAttachment, { kind: kind });
    if (kind === "vision" && !project.ftOfferAttachment.visionToken) {
      project.ftOfferAttachment.visionToken = makeToken();
      // Der Vision-Token haengt am Vorgang — die Ausarbeitung landet damit
      // wieder genau hier und nicht in einem neuen Projekt.
      sharesOf(projectId).visionToken = project.ftOfferAttachment.visionToken;
    }
    project.updatedAt = now();
    save();
    rerender();
  };

  window._ftSetExampleUrl = function (projectId, value) {
    var project = projectById(projectId);
    if (!project) return;
    project.ftOfferAttachment = Object.assign({}, project.ftOfferAttachment, { exampleUrl: value });
    project.updatedAt = now();
    save();
  };

  function visionLinkFor(projectId) {
    var project = projectById(projectId) || {};
    var token = project.ftOfferAttachment && project.ftOfferAttachment.visionToken;
    if (!token) return "";
    var ft = wf();
    var base = (ft && ft.company && ft.company.visionBase) || "https://flowertech.ch";
    return base.replace(/\/+$/, "") + "/?v=" + token + "#vision";
  }
  window._ftVisionLink = visionLinkFor;

  // Annahme startet die Umsetzung IM SELBEN Projekt, Ablehnung schliesst den
  // Vorgang. In keinem Fall entsteht ein zweites Projekt.
  window._ftOfferDecision = function (projectId, decision) {
    var core = W();
    var project = projectById(projectId);
    if (!core || !project) return;
    docsOfProject("offer", projectId).forEach(function (offer) {
      if (offer.status === "sent" || offer.status === "draft") {
        offer.status = decision === "accepted" ? "accepted" : "declined";
        offer.updatedAt = now();
      }
    });
    if (decision === "accepted") {
      project.pipelineStage = "build";
      project.ftOutcome = null;
    } else {
      project.pipelineStage = "approval";
      project.status = "archived";
      project.ftOutcome = "lost";
      project.ftOutcomeAt = now();
    }
    project.updatedAt = now();
    save();
    refreshClientPortal(projectId);
    notify("ok", "Offerte", decision === "accepted"
      ? "Angenommen — die Umsetzung ist gestartet"
      : "Abgelehnt — der Angebotsvorgang ist geschlossen");
    rerender();
  };

  // ==========================================================================
  //  Darstellung des Workflows im Projekt
  // ==========================================================================
  function stepperHtml(project) {
    var core = W();
    if (!core) return "";
    var active = core.stageIndex(project.pipelineStage);
    return '<div class="ft-steps" role="list">' + core.WORKFLOW_STAGES.map(function (stage, i) {
      var cls = i < active ? "done" : i === active ? "active" : "";
      return '<button class="ft-step ' + cls + '" role="listitem" title="' + attr(stage.hint) + '" ' +
        'onclick="window._ftSetProjectStage(\'' + attr(project.id) + "','" + stage.key + '\')">' +
        '<span class="ft-step-no">' + (i + 1) + "</span><span>" + esc(stage.label) + "</span></button>";
    }).join("") + "</div>" +
      '<div class="ft-step-hint">' + esc(core.WORKFLOW_STAGES[active].hint) + "</div>" +
      '<div class="ft-quick mb-3">' +
      '<button class="btn sm" onclick="window._ftAdvanceStage(\'' + attr(project.id) + '\',\'back\')">← Zurück</button>' +
      '<button class="btn sm primary" onclick="window._ftAdvanceStage(\'' + attr(project.id) + '\',\'next\')">Nächster Schritt →</button>' +
      "</div>";
  }

  // Vor dem Senden verbindlich waehlen, was der Offerte beigelegt wird.
  function offerAttachmentHtml(projectId) {
    var core = W();
    var project = projectById(projectId);
    if (!core || !project) return "";
    var offers = docsOfProject("offer", projectId);
    var route = core.routeOf(project, offers);
    var attachment = project.ftOfferAttachment || {};
    var visionLink = visionLinkFor(projectId);
    var state = core.offerAttachmentState({
      kind: attachment.kind, visionToken: attachment.visionToken, exampleUrl: attachment.exampleUrl,
    });
    var decision = core.offerDecisionState(project, offers);

    if (route === "direct") {
      return '<div class="card p-4 mb-3"><h3>Weg: Direktprojekt</h3><div class="sep"></div>' +
        '<div class="ft-skip">Der Angebotsschritt ist bewusst übersprungen. Es wird ohne Offerte umgesetzt.</div>' +
        '<div class="mini mt-2">Leistung und Vertrag hältst du im Reiter <b>Vertrag</b> fest.</div></div>';
    }

    var picker = core.OFFER_ATTACHMENTS.map(function (a) {
      return '<button class="ft-route' + (attachment.kind === a.key ? " on" : "") +
        '" onclick="window._ftSetOfferAttachment(\'' + attr(projectId) + "','" + a.key + '\')">' +
        '<strong>' + esc(a.label) + "</strong><small>" + esc(a.hint) + "</small></button>";
    }).join("");

    var detail = "";
    if (attachment.kind === "vision") {
      detail = '<div class="ft-link-row"><span>Persönlicher Vision-Link</span>' +
        '<input readonly value="' + attr(visionLink) + '">' +
        '<button class="btn sm" onclick="window._ftCopyLink(\'' + attr(visionLink) + '\')">Kopieren</button></div>' +
        '<div class="mini">Die Ausarbeitung der Kundschaft landet über diesen Link genau an dieser Offerte — ' +
        "nicht in einem neuen Projekt.</div>";
    } else if (attachment.kind === "example") {
      detail = '<label class="ft-inline-label">Beispiel-/Vorschau-URL' +
        '<input type="url" placeholder="https://…" value="' + attr(attachment.exampleUrl || "") +
        '" oninput="window._ftSetExampleUrl(\'' + attr(projectId) + '\',this.value)"></label>' +
        '<div class="mini">Eine echte Adresse, die du selbst pflegst. Es wird kein Link erfunden.</div>';
    }

    var status = state.ready
      ? '<div class="ft-ready">✓ Beilage bereit — die Offerte kann raus.</div>'
      : '<div class="ft-legal-note">⚠ ' + esc(state.reason) + "</div>";

    var decisionBlock = "";
    if (decision === "sent" || decision === "draft") {
      decisionBlock = '<div class="sep"></div><div class="ft-quick">' +
        '<button class="btn primary" onclick="window._ftOfferDecision(\'' + attr(projectId) +
          '\',\'accepted\')">Angenommen → Umsetzung starten</button>' +
        '<button class="btn" onclick="window._ftOfferDecision(\'' + attr(projectId) +
          '\',\'declined\')">Abgelehnt → Vorgang schliessen</button></div>' +
        '<div class="mini mt-1">Beides bleibt in diesem Vorgang. Es entsteht kein zweites Projekt.</div>';
    } else if (decision === "accepted") {
      decisionBlock = '<div class="sep"></div><div class="ft-ready">✓ Offerte angenommen — die Umsetzung läuft.</div>';
    } else if (decision === "declined") {
      decisionBlock = '<div class="sep"></div><div class="mini">Angebotsvorgang als verloren geschlossen.</div>';
    }

    return '<div class="card p-4 mb-3"><h3>Weg: Offerte zuerst</h3><div class="sep"></div>' +
      '<div class="mini">Was wird der Offerte beigelegt?</div>' +
      '<div class="ft-routes mt-2">' + picker + "</div>" +
      (detail ? '<div class="mt-2">' + detail + "</div>" : "") +
      status + decisionBlock + "</div>";
  }

  function briefingFormHtml(projectId) {
    var core = W();
    if (!core) return "";
    var briefing = briefingOf(projectId) || {};
    var fields = core.BRIEFING_FIELDS.map(function (field) {
      var value = briefing[field.key];
      if (Array.isArray(value)) value = value.join("\n");
      if (value == null) value = "";
      var hint = field.hint ? '<small class="ft-hint">' + esc(field.hint) + "</small>" : "";
      var input;
      if (field.type === "textarea") {
        input = '<textarea id="ftBrief_' + field.key + '" rows="3">' + esc(value) + "</textarea>";
      } else if (field.type === "select") {
        input = '<select id="ftBrief_' + field.key + '">' + field.options.map(function (opt) {
          return '<option value="' + opt[0] + '"' + (String(value) === opt[0] ? " selected" : "") + ">" + esc(opt[1]) + "</option>";
        }).join("") + "</select>";
      } else {
        input = '<input id="ftBrief_' + field.key + '" type="' + (field.type === "date" ? "date" : "text") +
          '" value="' + attr(value) + '">';
      }
      return "<label>" + esc(field.label) + (field.required ? " *" : "") + input + hint + "</label>";
    }).join("");
    return '<div class="ft-brief-grid">' + fields + "</div>" +
      '<div class="ft-quick mt-2"><button class="btn primary" onclick="window._ftSaveBriefing(\'' + attr(projectId) +
      '\')">Bedarf übernehmen &amp; Aufgaben erstellen</button></div>' +
      '<div class="mini mt-2">Aus den Angaben entstehen Projektfelder und ganz normale Quantus-Aufgaben — ' +
      "sie erscheinen automatisch in der zentralen Aufgaben-App.</div>";
  }

  /* Die zentrale Standard-AGB — nur ansehen, nichts bearbeiten.
     Es gibt bewusst kein Titelfeld, keine Textfelder, keinen "Abschnitt
     hinzufügen" und keinen Freigabeknopf: Die Fassung gilt für alle Projekte
     gleich und steht im Code, nicht in den Projektdaten. Wer sie ändern will,
     ändert sie dort — und dann überall auf einmal. */
  function standardTermsHtml() {
    var core = W();
    if (!core || !core.STANDARD_TERMS) return '<div class="ft-empty">Kern nicht geladen.</div>';
    var t = core.STANDARD_TERMS;
    var head = '<div class="ft-doc-head">' +
      "<strong>" + esc(t.title) + "</strong>" +
      '<span class="badge">Fassung ' + esc(t.version) + " · zentral</span>" +
      '<span class="badge">nicht bearbeitbar</span>' +
      '<button class="btn sm" onclick="window._ftCopyStandardTerms()">Kopieren</button>' +
      "</div>";
    var hinweis = '<div class="ft-legal-note">⚠ ' + esc(t.notice) + "</div>" +
      '<div class="mini mt-2">Diese Fassung erscheint unverändert auf jedem FlowerTech-Kundenlink, ' +
      "im Kundenportal und in jedem erzeugten Projekt-Prompt. Sie lässt sich hier nicht bearbeiten und " +
      "nicht pro Projekt abweichen — genau das ist ihr Zweck. Geändert wird sie zentral in " +
      "<code>public/flowertech-workflow-core.js</code>; dabei steigt die Fassungsnummer und erteilte " +
      "Zustimmungen gelten sichtbar als veraltet.</div>";
    var intro = '<p class="mini mt-2">' + esc(t.intro) + "</p>";
    var body = t.sections.map(function (sec) {
      return '<div class="ft-block"><div class="ft-block-head"><strong>' + esc(sec.title) + "</strong></div>" +
        '<pre class="ft-block-read">' + esc(sec.body) + "</pre></div>";
    }).join("");
    return head + hinweis + intro + body;
  }

  window._ftCopyStandardTerms = function () {
    var core = W();
    if (!core) return;
    copyText(core.standardTermsText(), "Standard-AGB kopiert (Fassung " + core.STANDARD_TERMS.version + ")");
  };

  function blockEditorHtml(projectId, scope, doc, label) {
    var core = W();
    // AGB gehen nie durch den Editor — egal, wer ihn mit welchem Dokument ruft.
    if (scope === "agb") return standardTermsHtml();
    if (!doc) {
      return '<div class="ft-empty">Noch nicht erstellt.</div>';
    }
    var blocks = blocksOf(doc);
    var vars = wfVars(projectId);
    var notice = doc.legalNotice || (core && core.LEGAL_REVIEW_NOTICE) || "";
    var head = '<div class="ft-doc-head">' +
      '<input class="ft-doc-title" value="' + attr(doc.title || label) + '" oninput="window._ftDocMetaSet(\'' +
        attr(projectId) + "','" + scope + "','title',this.value)\">" +
      '<span class="badge">v' + esc(String(doc.version || 1)) + " · " + esc(doc.status === "released" ? "Freigegeben" : "Entwurf") + "</span>" +
      '<button class="btn sm" onclick="window._ftDocStatusSet(\'' + attr(projectId) + "','" + scope + "','" +
        (doc.status === "released" ? "draft" : "released") + '\')">' +
        (doc.status === "released" ? "Zurück auf Entwurf" : "Freigeben") + "</button>" +
      '<button class="btn sm" onclick="window._ftCopyDoc(\'' + attr(projectId) + "','" + scope + '\')">Kopieren</button>' +
      '<button class="btn sm" onclick="window._ftPrintDocText(\'' + attr(projectId) + "','" + scope + '\')">Drucken / PDF</button>' +
      "</div>";
    var legal = (scope === "contract" || scope === "agb" || scope === "privacy")
      ? '<div class="ft-legal-note">⚠ ' + esc(doc.intro ? doc.intro + " " : "") + esc(notice) + "</div>"
      : "";
    var body = blocks.map(function (block, i) {
      var preview = core ? core.renderTemplate(block.body || "", vars) : (block.body || "");
      var varsUsed = (block.variables || (core ? core.templateVariables(block.body || "") : []));
      return '<div class="ft-block' + (block.enabled === false ? " off" : "") + '">' +
        '<div class="ft-block-head">' +
          '<input class="ft-block-title" value="' + attr(block.title || "") + '" oninput="window._ftBlockSet(\'' +
            attr(projectId) + "','" + scope + "','" + attr(block.key) + "','title',this.value)\">" +
          '<label class="ft-block-on"><input type="checkbox"' + (block.enabled === false ? "" : " checked") +
            ' onchange="window._ftBlockToggle(\'' + attr(projectId) + "','" + scope + "','" + attr(block.key) +
            '\',this.checked)"> aktiv</label>' +
          '<button class="btn sm ghost" title="Nach oben" onclick="window._ftBlockMove(\'' + attr(projectId) + "','" +
            scope + "','" + attr(block.key) + '\',-1)">↑</button>' +
          '<button class="btn sm ghost" title="Nach unten" onclick="window._ftBlockMove(\'' + attr(projectId) + "','" +
            scope + "','" + attr(block.key) + '\',1)">↓</button>' +
          '<button class="btn sm ghost" title="Entfernen" onclick="window._ftBlockDelete(\'' + attr(projectId) + "','" +
            scope + "','" + attr(block.key) + '\')">×</button>' +
        "</div>" +
        '<textarea class="ft-block-body" rows="' + Math.min(16, Math.max(4, String(block.body || "").split("\n").length + 2)) +
          '" oninput="window._ftBlockSet(\'' + attr(projectId) + "','" + scope + "','" + attr(block.key) +
          '\',\'body\',this.value)">' + esc(block.body || "") + "</textarea>" +
        (varsUsed.length ? '<div class="ft-vars">Variablen: ' + varsUsed.map(function (v) {
          return '<code>{{' + esc(v) + "}}</code>";
        }).join(" ") + "</div>" : "") +
        '<details class="ft-preview"><summary>Vorschau (Variablen eingesetzt)</summary><pre>' + esc(preview) + "</pre></details>" +
        "</div>";
    }).join("");
    return head + legal + body +
      '<button class="btn sm mt-2" onclick="window._ftBlockAdd(\'' + attr(projectId) + "','" + scope +
      '\')">＋ Abschnitt hinzufügen</button>';
  }

  function changeRequestsHtml(projectId) {
    var core = W();
    if (!core) return "";
    var list = changesOf(projectId);
    var rows = list.length ? list.map(function (entry) {
      var task = entry.taskId && data() && data().entities.tasks[entry.taskId];
      return '<div class="ft-cr ft-cr-' + esc(entry.status) + '">' +
        '<div class="ft-cr-main"><strong>' + esc(entry.title) + "</strong>" +
        (entry.detail ? "<small>" + esc(String(entry.detail).slice(0, 220)) + "</small>" : "") +
        '<small class="ft-hint">' + esc(entry.origin === "internal" ? "intern" : "vom Kunden") +
        (entry.requestedBy ? " · " + esc(entry.requestedBy) : "") + " · " + esc(dateTime(entry.createdAt)) + "</small></div>" +
        '<select onchange="window._ftSetChangeStatus(\'' + attr(entry.id) + '\',this.value)">' +
          core.CHANGE_STATUSES.map(function (s) {
            return '<option value="' + s.key + '"' + (entry.status === s.key ? " selected" : "") + ">" + esc(s.label) + "</option>";
          }).join("") + "</select>" +
        (task ? '<button class="btn sm ghost" onclick="location.hash=\'#/tasks/' + attr(entry.taskId) +
          '\'" title="Zur Aufgabe in der Aufgaben-App">↗ Aufgabe</button>'
          : '<span class="mini">keine Aufgabe</span>') +
        '<button class="btn sm ghost" onclick="window._ftDeleteChangeRequest(\'' + attr(entry.id) + '\')">×</button>' +
        "</div>";
    }).join("") : empty("Noch keine Änderungswünsche");
    return '<div class="ft-inline-form">' +
      '<input id="ftCrTitle" placeholder="Änderungswunsch, z. B. Startseite: Bilder tauschen">' +
      '<input id="ftCrArea" placeholder="Bereich (optional)">' +
      '<select id="ftCrPriority"><option value="1">Hoch</option><option value="2" selected>Normal</option><option value="3">Tief</option></select>' +
      '<button class="btn primary" onclick="window._ftAddChangeRequest(\'' + attr(projectId) + '\')">Erfassen</button></div>' +
      '<textarea id="ftCrDetail" rows="2" placeholder="Details (optional)" class="ft-cr-detail"></textarea>' +
      rows +
      '<div class="mini mt-2">Jeder Änderungswunsch wird zu einer normalen Quantus-Aufgabe. ' +
      "Wird die Aufgabe erledigt, springt der Wunsch automatisch auf \u201eErledigt\u201c.</div>";
  }

  /* Die zwei Freigaben der Stufe 3. Jede ist eine eigene Entscheidung und
     jederzeit widerrufbar — der Kundenlink bleibt dabei derselbe. */
  function customerReleaseHtml(projectId) {
    var area = customerArea(projectId);
    if (!area) return "";
    var row = function (title, gate, fn, hint) {
      var on = !!gate.visible;
      return '<div class="ft-release-row">' +
        '<div><b>' + esc(title) + "</b>" +
          '<div class="mini">' + esc(on ? hint : (gate.reason || hint)) + "</div></div>" +
        '<button class="btn sm ' + (on ? "ghost" : "primary") + '" onclick="window.' + fn + "('" +
          attr(projectId) + "'," + (on ? "false" : "true") + ')">' +
          (on ? "Zurückziehen" : "Freigeben") + "</button></div>";
    };
    if (!area.hasLink) {
      return '<div class="mini mt-2">Für die Freigabe braucht dieses Projekt zuerst seinen ' +
        "Kundenlink (Karte „Zugänge“ nebenan).</div>";
    }
    return '<div class="sep"></div>' +
      '<div class="mini">Freigaben für den Kundenbereich — sie wandern in genau den Link, ' +
        "den die Kundschaft schon hat.</div>" +
      row("Website-Vorschau & Änderungswünsche", area.preview, "_ftReleaseCustomerPreview",
        "Die Kundschaft sieht die Vorschau und kann dazu Änderungswünsche melden.") +
      row("Verwaltung", area.admin, "_ftReleaseCustomerAdmin",
        "Die Kundschaft sieht die Verwaltungsadresse.") +
      testServiceHtml(projectId);
  }

  /* Die Test-Kachel im Bedienfeld. Bewusst unterhalb der normalen Freigaben
     und sichtbar als Ausnahme beschriftet — damit niemand sie fuer den
     Offertenweg haelt. */
  function testServiceHtml(projectId) {
    var project = projectById(projectId) || {};
    var tile = project.ftTestServiceTile && typeof project.ftTestServiceTile === "object"
      ? project.ftTestServiceTile : {};
    var on = tile.released === true;
    var core = W();
    var kosten = core ? core.TEST_SERVICE_COST_STATUS : "Kosten noch offen";
    var feld = function (key, label, platzhalter) {
      return "<label class=\"ft-test-f\"><span>" + esc(label) + "</span>" +
        '<input value="' + attr(tile[key] || "") + '" placeholder="' + attr(platzhalter || "") +
        '" oninput="window._ftSetTestServiceTile(\'' + attr(projectId) + "','" + key + "',this.value)\"></label>";
    };
    return '<div class="sep"></div>' +
      '<div class="ft-legal-note">⚠ Ausnahme, nur fuer Testlaeufe: eine unverbindliche ' +
        "Leistungsuebersicht ohne Preis. Sie ist <b>keine Offerte</b> — es wird nichts versendet, " +
        "keine Rechnung angelegt und kein Status veraendert. Der normale Weg (Offerte erst nach " +
        "Versand und mit Kosten) bleibt unveraendert.</div>" +
      '<div class="ft-test-grid">' +
        feld("title", "Titel der Leistung", "Website-Neukonzept …") +
        feld("summary", "Kurzbeschreibung (freiwillig)", "Worum es geht") +
        feld("currentUrl", "Bestehende Website (HTTPS)", "https://…") +
        feld("previewUrl", "Vorschau / Vorschlag (HTTPS)", "https://…") +
      "</div>" +
      '<div class="ft-release-row"><div><strong>Leistungsuebersicht · TEST</strong>' +
        '<div class="mini">Kostenstand auf der Kachel: „' + esc(kosten) + '“. ' +
        "Ein Betrag wird nie angezeigt — auch keine Null.</div></div>" +
        '<button class="btn sm ' + (on ? "ghost" : "primary") + '" onclick="window._ftReleaseTestService(\'' +
          attr(projectId) + "'," + (on ? "false" : "true") + ')">' +
          (on ? "Zurueckziehen" : "Freigeben") + "</button></div>";
  }

  function clientPortalHtml(projectId) {
    var core = W();
    // BEWUSST kein Veröffentlichen beim Rendern: Das Kundenportal entsteht
    // durch eine Entscheidung, nicht dadurch, dass jemand einen Reiter öffnet.
    var project = projectById(projectId) || {};
    var links = shareLinks(projectId);
    var share = sharesOf(projectId);
    var kundenLink = clientPortalLink(projectId);
    var costs = core ? core.costOverview({
      offers: docsOfProject("offer", projectId),
      invoices: docsOfProject("invoice", projectId),
      totals: function (doc) { return docTotals(doc).rounded; },
    }) : { offered: 0, invoiced: 0, paid: 0, open: 0 };
    var versions = (project.ftVersions || []);

    // Preview/Admin: nur echte HTTPS-Adressen. Was nicht taugt, wird benannt
    // statt still verworfen — und es wird nie ein Link erfunden.
    function urlField(label, field, hint) {
      var value = project[field] || "";
      var bad = value && core && !core.clientSafeUrl(value);
      return '<label class="ft-inline-label">' + esc(label) +
        '<input type="url" value="' + attr(value) + '" placeholder="https://…" oninput="window._ftSetProjectField(\'' +
          attr(projectId) + "','" + field + '\',this.value)"></label>' +
        (bad ? '<div class="ft-legal-note">⚠ Nur vollständige HTTPS-Adressen werden der Kundschaft gezeigt. ' +
          "Dieser Eintrag erscheint nicht auf der Kundenseite.</div>"
          : '<div class="mini">' + esc(hint) + "</div>");
    }

    var release = portalRelease(projectId);
    var status = share.publishError
      ? '<div class="ft-legal-note">⚠ ' + esc(share.publishError) + "</div>"
      : release.published
        ? '<div class="ft-ready">✓ Kundenportal ist online · Stand ' +
          esc(dateTime(share.publishedAt || share.portalReleasedAt)) + "</div>"
        : '<div class="ft-legal-note"><b>' + esc(core ? core.LINK_LABELS.portalUnpublished : "Nicht veröffentlicht") +
          "</b><br>" + esc(release.reason) + "</div>";

    // Die Checkliste ist die Wahrheit, nicht nur eine Erinnerung: Solange ein
    // Punkt fehlt, verweigert die Freigabe den Dienst.
    var checklist = core
      ? '<div class="ft-steps mt-2">' + core.PORTAL_RELEASE_REQUIREMENTS.map(function (r) {
          var done = release.missing.indexOf(r.label) < 0;
          return '<span class="ft-step' + (done ? " done" : "") + '">' +
            (done ? "✓ " : "○ ") + esc(r.label) + "</span>";
        }).join("") + "</div>"
      : "";

    var quote = project.ftQuoteRequest || null;
    var quoteState = quote
      ? '<div class="ft-ready">✓ Offertenanfrage eingegangen · ' + esc(dateTime(quote.submittedAt)) +
        " · Status " + esc(core ? core.quoteStatusLabel(quote.status) : "Neu") + "</div>" +
        '<div class="mini mt-2">' + esc(String(quote.need || "").slice(0, 240)) + "</div>"
      : '<div class="mini">Noch keine Offertenanfrage. Schicke der Kundschaft den Link — sobald sie ' +
        "absendet, entsteht hier die Anfrage und genau eine Aufgabe.</div>";

    // Der Fortschritt, den die Kundschaft sieht — nicht die interne Pipeline.
    var portal = core ? core.portalProgress({
      project: project,
      hasPreview: !!((project.ftTemplate || {}).html || "").trim(),
      changes: changesOf(projectId),
      versions: versions,
    }) : { steps: [], label: "" };
    var terms = core ? core.termsState({
      terms: termsForProject(projectId), consent: project.ftTermsConsent || null,
    }) : { accepted: false, outdated: false, version: "" };
    var questions = project.ftPortalQuestions || [];

    var portalCard = '<div class="card p-4"><h3>Kundenportal — Phase 2</h3><div class="sep"></div>' +
      '<div class="mini">Altbestand: Das getrennte Kundenportal. Neue Vorgaenge brauchen es nicht — ' +
      'die Kundschaft bekommt genau EINE Adresse, die mitwaechst. Er zeigt Vorschau, Leistungsbeschreibung, Offerte, Vertrag, AGB, ' +
      "Änderungswünsche und Rückfragen — und existiert erst, wenn all das steht und du ihn " +
      "bewusst veröffentlichst. Der Fragebogen-Link der Phase 1 ist ein anderer Link.</div>" +
      checklist +
      status +
      (release.published
        ? clientLinkRowHtml(projectId, core ? core.LINK_LABELS.portal : "Kundenportal-Link") +
          '<div class="ft-quick mt-2">' +
            '<button class="btn sm" onclick="window._ftPublishClientView(\'' + attr(projectId) +
              '\')">Jetzt aktualisieren</button>' +
            '<button class="btn sm ghost" onclick="window._ftUnpublishClientPortal(\'' + attr(projectId) +
              '\')">Zurückziehen</button></div>'
        : '<div class="ft-quick mt-2"><button class="btn primary"' + (release.ready ? "" : " disabled") +
            ' onclick="window._ftReleaseClientPortal(\'' + attr(projectId) +
            '\')">Kundenportal veröffentlichen</button></div>') +
      '<div class="ft-steps mt-2">' + portal.steps.map(function (st) {
        return '<span class="ft-step' + (st.done ? " done" : "") + (st.current ? " active" : "") + '">' +
          esc(st.label) + "</span>";
      }).join("") + "</div>" +
      '<div class="mini mt-2">Stand: <b>' + esc(portal.label) + "</b>" +
        (portal.openChanges ? " · " + portal.openChanges + " offene Änderungswünsche" : "") + "</div>" +
      (terms.accepted
        ? '<div class="ft-ready mt-2">✓ AGB zugestimmt am ' + esc(dateTime(terms.acceptedAt)) +
          " (Fassung " + esc(terms.version) + ")</div>"
        : terms.outdated
          ? '<div class="ft-legal-note">⚠ Die Zustimmung gilt einer älteren AGB-Fassung. ' +
            "Im Portal wird erneut um Zustimmung gebeten.</div>"
          : '<div class="mini mt-2">AGB: noch keine Zustimmung.' +
            (termsForProject(projectId).body ? "" : " Es ist auch noch kein AGB-Entwurf gepflegt " +
              "(Reiter „AGB / Datenschutz\u201c) — ohne Text wird im Portal nichts zur Zustimmung gezeigt.") +
            "</div>") +
      '<div class="sep"></div><h4 class="ft-sub">Rückfragen an die Kundschaft</h4>' +
      '<div class="ft-inline-form"><input id="ftPortalQuestion" placeholder="Frage, z. B. Haben Sie ein Logo als Datei?">' +
        '<button class="btn primary" onclick="window._ftAskPortalQuestion(\'' + attr(projectId) + '\')">Fragen</button></div>' +
      (questions.length ? questions.map(function (q) {
        return '<div class="ft-qa"><div><strong>' + esc(q.question) + "</strong>" +
          (String(q.answer || "").trim()
            ? "<p>" + esc(q.answer) + '</p><small class="mini">beantwortet ' + esc(dateTime(q.answeredAt)) + "</small>"
            : '<p class="mini">Noch keine Antwort.</p>') + "</div>" +
          '<button class="btn sm ghost" onclick="window._ftRemovePortalQuestion(\'' + attr(projectId) +
            "','" + attr(q.id) + '\')">×</button></div>';
      }).join("") : empty("Noch keine Rückfragen")) +
      "</div>";

    var quoteCard = quote
      ? '<div class="card p-4 mt-3"><h3>Frühere Offertenanfrage</h3><div class="sep"></div>' + quoteState + "</div>"
      : "";

    return portalCard + quoteCard + '<div class="ft-grid-2 mt-3">' +
      '<div class="card p-4"><h3>Zugänge</h3><div class="sep"></div>' +
        '<div class="ft-legal-note">⚠ <b>Alte Ansicht — nicht mehr benutzen.</b> Sie stammt aus der ' +
        "Zeit mit zwei getrennten Links. Heute bekommt die Kundschaft genau EINE Adresse, die " +
        "mitwaechst; ein zweiter Link wird nicht mehr verschickt. Der Block bleibt nur stehen, " +
        "damit bereits verschickte Portal-Links weiter auffindbar sind.</div>" +
        '<div class="mini">Der Kundenportal-Link ' +
        "entsteht erst nach der Veröffentlichung oben.</div>" +
        projectIntakeRowHtml(projectId) +
        '<div class="sep"></div>' +
        (release.published
          ? '<div class="ft-link-row mt-2"><span>Zugang erneuern</span>' +
              '<input readonly value="' + attr(kundenLink) + '">' +
              '<button class="btn sm ghost" onclick="window._ftRotateToken(\'' + attr(projectId) +
                '\',\'portalToken\')">Neu</button></div>' +
            '<div class="mini mt-2">„Neu\u201c widerruft den alten Link samt Inhalt.</div>'
          : '<div class="mini mt-2">Noch kein Kundenportal-Link — er entsteht mit der Veröffentlichung.</div>') +
        '<div class="sep"></div>' +
        '<div class="ft-link-row"><span>Bedarfsformular</span>' +
          '<input readonly value="' + attr(links.form) + '">' +
          '<button class="btn sm" onclick="window._ftCopyLink(\'' + attr(links.form) + '\')">Kopieren</button>' +
          '<button class="btn sm ghost" onclick="window._ftRotateToken(\'' + attr(projectId) +
            '\',\'formToken\')">Neu</button></div>' +
        '<div class="mini mt-2">Gezeigt werden nur: Projektname, Phase, vereinbarte Kosten, ' +
          "Leistungsbeschreibung, Termine, Versionen und Änderungswünsche. Keine internen Notizen, " +
          "kein Mailverlauf, keine Rechnungsdetails.</div>" +
      "</div>" +
      '<div class="card p-4"><h3>Kostenübersicht</h3><div class="sep"></div>' +
        '<div class="ft-kpis"><div class="ft-kpi"><span>Offeriert</span><strong>' + money(costs.offered) + "</strong></div>" +
        '<div class="ft-kpi"><span>Fakturiert</span><strong>' + money(costs.invoiced) + "</strong></div>" +
        '<div class="ft-kpi"><span>Bezahlt</span><strong>' + money(costs.paid) + "</strong></div>" +
        '<div class="ft-kpi"><span>Offen</span><strong>' + money(costs.open) + "</strong></div></div>" +
        urlField("Vorschau-Link (zeigt die Kundschaft)", "previewUrl",
          "Die Adresse allein zeigt noch nichts — sie wird unten ausdrücklich freigegeben.") +
        urlField("Verwaltung / Admin (optional)", "adminUrl",
          "Nur setzen, wenn die Kundschaft dort wirklich etwas verwalten kann.") +
        customerReleaseHtml(projectId) +
      "</div></div>" +
      '<div class="card p-4 mt-3"><h3>Versionen &amp; Freigabe</h3><div class="sep"></div>' +
        '<div class="ft-inline-form"><input id="ftVersionLabel" placeholder="Was ist neu? z. B. Entwurf Startseite">' +
        '<button class="btn primary" onclick="window._ftAddVersion(\'' + attr(projectId) + '\')">Version festhalten</button></div>' +
        (versions.length ? versions.map(function (v) {
          return '<div class="ft-ms' + (v.approved ? " done" : "") + '">' +
            '<button class="ft-check' + (v.approved ? " on" : "") + '" onclick="window._ftApproveVersion(\'' +
              attr(projectId) + "','" + attr(v.id) + '\')">' + (v.approved ? "✓" : "") + "</button>" +
            '<span class="ft-ms-title">' + esc(v.label) + "</span><small>" + esc(dateTime(v.at)) +
            (v.approved ? " · freigegeben" : "") + "</small></div>";
        }).join("") : empty("Noch keine Versionen")) +
      "</div>";
  }

  function communicationHtml(projectId) {
    var core = W();
    var project = projectById(projectId) || {};
    var addresses = core ? core.projectMailAddresses(project) : [];
    var log = project.ftContactLog || [];
    var templates = (core ? core.MESSAGE_TEMPLATES : []).map(function (m) {
      return '<button class="btn sm" onclick="window._ftComposeTemplate(\'' + attr(projectId) + "','" + m.key +
        '\')">✉️ ' + esc(m.subject.replace(/\{\{.*?\}\}/g, "").trim() || m.key) + "</button>";
    }).join("");
    return '<div class="ft-grid-2">' +
      '<div class="card p-4"><h3>Mailverlauf</h3><div class="sep"></div>' +
        '<div class="mini">Zugeordnet wird ausschliesslich über den ausdrücklichen Projektkontakt und über ' +
        "Mails, die aus diesem Projekt gesendet oder manuell verknüpft wurden. Es findet keine allgemeine " +
        "Postfachüberwachung statt; alle Mails bleiben zusätzlich normal im Posteingang.</div>" +
        '<div class="ft-addr mt-2">' + (addresses.length
          ? addresses.map(function (a) { return '<span class="badge">' + esc(a) + "</span>"; }).join("")
          : '<span class="mini">Noch keine Projektadresse hinterlegt.</span>') + "</div>" +
        '<div class="ft-quick mt-2">' +
          '<button class="btn sm" onclick="window.gmailComposeToEntity(\'project\',\'' + attr(projectId) +
            '\')">✉️ Mail schreiben</button>' +
          '<button class="btn sm" onclick="window.gmailManageEntityMails&&window.gmailManageEntityMails(\'project\',\'' +
            attr(projectId) + '\')">⚙️ Adressen zuordnen</button>' +
        "</div>" +
        '<div class="mini mt-2">Die vollständige Mailkarte dieses Projekts steht weiter unten auf der Seite.</div>' +
      "</div>" +
      '<div class="card p-4"><h3>Kundenkommunikation</h3><div class="sep"></div>' +
        '<div class="ft-quick">' + templates + "</div>" +
        '<div class="mini mt-2">Vorlagen werden mit den Projektdaten gefüllt, in die Zwischenablage gelegt ' +
        "und — falls Gmail verbunden ist — direkt im Verfassen-Fenster geöffnet. Vor dem Senden editierbar.</div>" +
      "</div></div>" +
      '<div class="card p-4 mt-3"><h3>Kontaktverlauf</h3><div class="sep"></div>' +
        '<div class="ft-inline-form">' +
          '<select id="ftContactChannel"><option value="note">Notiz</option><option value="call">Telefon</option>' +
            '<option value="meeting">Termin</option><option value="mail">Mail</option></select>' +
          '<input id="ftContactText" placeholder="Was wurde besprochen?">' +
          '<button class="btn primary" onclick="window._ftAddContactEntry(\'' + attr(projectId) + '\')">Festhalten</button>' +
        "</div>" +
        (log.length ? log.map(function (entry) {
          return '<div class="ft-row"><span>' + esc({ note: "📝", call: "📞", meeting: "🤝", mail: "✉️" }[entry.channel] || "📝") +
            " " + esc(entry.text) + '<small> · ' + esc(dateTime(entry.at)) + "</small></span>" +
            '<button class="btn sm ghost" onclick="window._ftDeleteContactEntry(\'' + attr(projectId) + "','" +
            attr(entry.id) + '\')">×</button></div>';
        }).join("") : empty("Noch kein Kontaktverlauf")) +
      "</div>";
  }

  /* ── Der Reiter „Claude-Prompt" ────────────────────────────────────────
     Er zeigt den vollständigen, automatisch erzeugten Prompt dieses Projekts —
     aus ALLEN bisherigen Daten: Fragebogen, Vision Room, Kundendaten, Budget
     und Frist, Leistungsbeschreibung, versendete Offerte und Änderungswünsche.
     Dazu, was er woher hat, wie frisch das ist und was noch fehlt.

     Der Reiter war bisher leer, wo kein internes Bedarfsformular ausgefüllt
     war: Er las ausschliesslich das Briefing. Genau das ist hier behoben — der
     Projekt-Prompt ist die Grundlage, der datensparsame Claude-Code-Prompt
     bleibt daneben bestehen.
     ------------------------------------------------------------------- */
  function promptHtml(projectId) {
    var core = W();
    var project = projectById(projectId);
    if (!core || !project) return "";
    var stored = project.ftPrompt || {};
    var text = stored.text || buildPromptFor(projectId);
    var sources = core.projectPromptSources(promptContext(projectId));
    var missing = core.projectPromptMissing(promptContext(projectId));
    var template = project.ftTemplate || {};
    var area = customerArea(projectId);

    var sourceRows = sources.map(function (s) {
      return '<div class="ft-row"><span>' + (s.present ? "✓" : "○") + " " + esc(s.label) +
        '<small> · ' + esc(s.detail) + (s.at ? " · " + esc(dateTime(s.at)) : "") + "</small></span>" +
        "<strong>" + (s.present ? "vorhanden" : "offen") + "</strong></div>";
    }).join("");

    return '<div class="card p-4"><h3>Projektspezifischer Prompt</h3><div class="sep"></div>' +
      '<div class="mini">' + esc(stored.name || "prompt.md") + " · " +
        esc(stored.source === "hochgeladen" ? "hochgeladen" : "automatisch aus dem aktuellen Stand erzeugt") +
        (stored.updatedAt ? " · Stand " + esc(dateTime(stored.updatedAt)) : "") + "</div>" +
      '<pre class="ft-prompt">' + esc(text) + "</pre>" +
      '<div class="ft-quick mt-2">' +
        '<button class="btn sm primary" onclick="window._ftCopyPrompt(\'' + attr(projectId) +
          '\')">Prompt kopieren</button>' +
        '<button class="btn sm" onclick="window._ftDownloadPrompt(\'' + attr(projectId) +
          '\')">⭳ .md herunterladen</button>' +
        '<button class="btn sm" onclick="window._ftDownloadTemplate(\'' + attr(projectId) +
          '\')">⭳ HTML-Vorlage herunterladen</button>' +
        '<label class="btn sm ghost ft-upload">⭱ HTML-Vorlage hochladen' +
          '<input type="file" accept=".html,.htm,text/html" onchange="window._ftUploadTemplate(\'' +
            attr(projectId) + '\',this)"></label>' +
        '<button class="btn sm ghost" onclick="window._ftCopyClaudePrompt(\'' + attr(projectId) +
          '\')">Prompt für Claude Code kopieren</button>' +
        '<button class="btn sm ghost" onclick="window._ftRegeneratePrompt(\'' + attr(projectId) +
          '\')">Neu erzeugen</button>' +
      "</div>" +
      '<div class="mini mt-2">Der Upload legt die Vorlage nur am Projekt ab — er ' +
        "veröffentlicht nichts. Sichtbar wird eine Vorschau erst über die ausdrückliche " +
        "Freigabe im Reiter „Kundenportal“." +
        (template.name ? " Zuletzt: " + esc(template.name) + " · " + esc(dateTime(template.updatedAt)) : "") +
      "</div></div>" +

      '<div class="card p-4 mt-3"><h3>Quellen und Stand</h3><div class="sep"></div>' +
        '<div class="mini">Woraus dieser Prompt gebaut ist. Was offen ist, wird im Prompt ' +
        "ausdrücklich als offen benannt — statt erfunden.</div>" + sourceRows +
        (missing.length
          ? '<div class="ft-legal-note mt-2">Fehlende Angaben: ' + esc(missing.join(", ")) + ".</div>"
          : '<div class="ft-ready mt-2">✓ Alle Angaben für einen belastbaren Prompt sind da.</div>') +
      "</div>" +

      (area && area.hasLink
        ? '<div class="card p-4 mt-3"><h3>Vorschau und Verwaltung beim Kunden</h3><div class="sep"></div>' +
          '<div class="mini">Genau die hier hinterlegten Adressen erscheinen — nach der Freigabe — ' +
          "in den zwei Kacheln des Kundenbereichs.</div>" +
          '<div class="ft-row"><span>Website-Vorschau<small> · ' +
            esc(area.preview.url || "keine Adresse hinterlegt") + "</small></span><strong>" +
            (area.preview.visible ? "sichtbar" : "nicht sichtbar") + "</strong></div>" +
          '<div class="ft-row"><span>Verwaltung<small> · ' +
            esc(area.admin.url || "keine Adresse hinterlegt") + "</small></span><strong>" +
            (area.admin.visible ? "sichtbar" : "nicht sichtbar") + "</strong></div>" +
          (area.preview.visible || area.admin.visible ? "" :
            '<div class="mini mt-2">' + esc(area.preview.reason || area.admin.reason) + "</div>") +
          "</div>"
        : "") +

      promptOptionsHtml(projectId);
  }

  // Der datensparsame Claude-Code-Prompt behält seine eigene Karte: Modus und
  // Datenauswahl gehören zu ihm, nicht zum Projekt-Prompt.
  function promptOptionsHtml(projectId) {
    var core = W();
    if (!core) return "";
    var include = promptInclude(projectId);
    var options = core.PROMPT_DATA_OPTIONS.map(function (opt) {
      return '<label class="ft-block-on"><input type="checkbox"' + (include[opt.key] ? " checked" : "") +
        ' onchange="window._ftTogglePromptData(\'' + attr(projectId) + "','" + opt.key + '\',this.checked)"> ' +
        esc(opt.label) + "</label>";
    }).join("");
    var mode = promptMode(projectId);
    var modeButtons = core.PROMPT_MODES.map(function (m) {
      return '<button class="ft-mode' + (mode === m.key ? " on" : "") + '" title="' + attr(m.hint) +
        '" onclick="window._ftSetPromptMode(\'' + attr(projectId) + "','" + m.key + '\')">' +
        esc(m.label) + "</button>";
    }).join("");
    var activeMode = core.PROMPT_MODES.find(function (m) { return m.key === mode; });

    return '<div class="card p-4"><h3>Claude-Code-Prompt</h3><div class="sep"></div>' +
      '<div class="mini">Wofür ist der Prompt?</div>' +
      '<div class="ft-modes mt-2">' + modeButtons + "</div>" +
      '<div class="mini mt-1">' + esc(activeMode ? activeMode.hint : "") + "</div>" +
      '<div class="sep"></div>' +
      '<div class="mini">Wähle bewusst aus, welche Daten in den Prompt wandern. Kundendaten, Preise und ' +
      "interne Notizen sind standardmässig NICHT enthalten.</div>" +
      '<div class="ft-checks mt-2">' + options + "</div>" +
      '<textarea class="ft-block-body mt-2" rows="16" readonly>' + esc(claudePromptText(projectId)) + "</textarea>" +
      '<div class="ft-quick mt-2"><button class="btn primary" onclick="window._ftCopyClaudePrompt(\'' +
        attr(projectId) + '\')">Prompt kopieren</button></div></div>';
  }

  // Der ganze Workflow-Block auf der Projektseite.
  function ftWorkflowPanel(projectId) {
    var core = W();
    var ft = wf();
    var project = projectById(projectId);
    if (!core || !ft || !project) return "";
    syncChangeStatusFromTasks();

    var tabs = [
      ["workflow", "Ablauf"], ["bedarf", "Bedarf"], ["angebot", "Angebot / Leistung"],
      ["vertrag", "Vertrag"], ["aenderungen", "Änderungen"],
      ["vorschau", "Vorschau & Prompt"], ["kunde", "Kundenportal"],
      ["kommunikation", "Kommunikation"], ["recht", "AGB / Datenschutz"], ["prompt", "Claude-Prompt"],
    ];
    var active = ft.ui.projectTab || "workflow";
    if (!tabs.some(function (t) { return t[0] === active; })) active = "workflow";

    var body = "";
    if (active === "workflow") {
      var openChanges = changesOf(projectId).filter(function (c) { return c.status !== "done" && c.status !== "rejected"; });
      body = stepperHtml(project) +
        '<div class="ft-grid-2"><div class="card p-4"><h3>Eckdaten</h3><div class="sep"></div>' +
          '<div class="ft-field-grid">' +
            "<label>Typ<select onchange=\"window._ftSetDeliveryType('" + attr(projectId) + "',this.value)\">" +
              core.DELIVERY_TYPES.map(function (t) {
                return '<option value="' + t.key + '"' + ((project.deliveryType || "website") === t.key ? " selected" : "") +
                  ">" + esc(t.label) + "</option>";
              }).join("") + "</select></label>" +
            '<label>Budget / Preisvorstellung (CHF)<input type="number" step="0.05" value="' +
              attr(project.budget == null ? "" : project.budget) + '" oninput="window._ftSetProjectNumber(\'' +
              attr(projectId) + '\',\'budget\',this.value)"></label>' +
            '<label>Bisheriger Anbieterpreis (CHF)<input type="number" step="0.05" value="' +
              attr(project.currentProviderPrice == null ? "" : project.currentProviderPrice) +
              '" oninput="window._ftSetProjectNumber(\'' + attr(projectId) + '\',\'currentProviderPrice\',this.value)"></label>' +
            '<label>Wunschtermin<input type="date" value="' + attr(project.dueDate || "") +
              '" oninput="window._ftSetProjectField(\'' + attr(projectId) + '\',\'dueDate\',this.value)"></label>' +
          "</div>" +
          '<div class="mini mt-2">' + esc(core.DELIVERY_TYPES.find(function (t) {
            return t.key === (project.deliveryType || "website");
          }).hint) + "</div></div>" +
        '<div class="card p-4"><h3>Stand</h3><div class="sep"></div>' +
          '<div class="ft-row"><span>Bedarf erfasst</span><strong>' + (briefingOf(projectId) ? "ja" : "nein") + "</strong></div>" +
          '<div class="ft-row"><span>Leistungsbeschreibung</span><strong>' + (contentOf(projectId) ? "vorhanden" : "offen") + "</strong></div>" +
          '<div class="ft-row"><span>Vertrag</span><strong>' + (contractOf(projectId) ? (contractOf(projectId).status === "released" ? "freigegeben" : "Entwurf") : "offen") + "</strong></div>" +
          '<div class="ft-row"><span>Offene Änderungswünsche</span><strong>' + openChanges.length + "</strong></div>" +
          '<div class="ft-row"><span>Offene Aufgaben</span><strong>' +
            tasksOfProject(projectId).filter(function (t) { return t.status !== "done"; }).length + "</strong></div>" +
        "</div></div>";
    } else if (active === "bedarf") {
      body = '<div class="card p-4"><h3>Bestandesaufnahme / Bedarf</h3><div class="sep"></div>' +
        '<div class="mini">Intern ausfüllen oder den Formularlink (Reiter \u201eKundenansicht\u201c) an den Kunden schicken. ' +
        "Beides landet an derselben Stelle.</div>" + briefingFormHtml(projectId) + "</div>";
    } else if (active === "angebot") {
      body = offerAttachmentHtml(projectId) +
        '<div class="card p-4"><h3>Leistungsbeschreibung / Angebot</h3><div class="sep"></div>' +
        '<div class="ft-quick mb-3">' +
          '<button class="btn primary" onclick="window._ftBuildContent(\'' + attr(projectId) + '\')">' +
            (contentOf(projectId) ? "Aus Vorlage neu aufbauen" : "Aus Vorlage erstellen") + "</button>" +
          '<button class="btn" onclick="window._ftAiContentDraft(\'' + attr(projectId) + '\')">✨ KI überarbeiten</button>' +
        "</div>" + blockEditorHtml(projectId, "content", contentOf(projectId), "Leistungsbeschreibung") + "</div>";
    } else if (active === "vertrag") {
      body = '<div class="card p-4"><h3>Projektauftrag / Vertrag</h3><div class="sep"></div>' +
        '<div class="ft-quick mb-3"><button class="btn primary" onclick="window._ftBuildContract(\'' + attr(projectId) + '\')">' +
          (contractOf(projectId) ? "Aus Vorlage neu aufbauen" : "Aus Vorlage erstellen") + "</button></div>" +
        blockEditorHtml(projectId, "contract", contractOf(projectId), "Projektauftrag") + "</div>";
    } else if (active === "aenderungen") {
      body = '<div class="card p-4"><h3>Änderungswünsche</h3><div class="sep"></div>' + changeRequestsHtml(projectId) + "</div>";
    } else if (active === "vorschau") {
      body = previewPromptHtml(projectId);
    } else if (active === "kunde") {
      body = clientPortalHtml(projectId);
    } else if (active === "kommunikation") {
      body = communicationHtml(projectId);
    } else if (active === "recht") {
      body = '<div class="card p-4"><h3>AGB (Entwurf)</h3><div class="sep"></div>' +
        '<div class="ft-quick mb-3"><button class="btn primary" onclick="window._ftBuildLegal(\'' + attr(projectId) +
          '\',\'agb\')">' + (legalOf(projectId, "agb") ? "Neu aufbauen" : "Entwurf erstellen") + "</button></div>" +
        blockEditorHtml(projectId, "agb", legalOf(projectId, "agb"), "AGB") + "</div>" +
        '<div class="card p-4 mt-3"><h3>Datenschutz (Entwurf)</h3><div class="sep"></div>' +
        '<div class="ft-quick mb-3"><button class="btn primary" onclick="window._ftBuildLegal(\'' + attr(projectId) +
          '\',\'privacy\')">' + (legalOf(projectId, "privacy") ? "Neu aufbauen" : "Entwurf erstellen") + "</button></div>" +
        blockEditorHtml(projectId, "privacy", legalOf(projectId, "privacy"), "Datenschutz") + "</div>";
    } else if (active === "prompt") {
      body = promptHtml(projectId);
    }

    var nav = '<div class="ft-tabs ft-subtabs">' + tabs.map(function (tab) {
      return '<button class="ft-tab ' + (active === tab[0] ? "active" : "") + '" onclick="window._ftSetProjectTab(\'' +
        attr(projectId) + "','" + tab[0] + '\')">' + esc(tab[1]) + "</button>";
    }).join("") + "</div>";

    return '<div class="ft-workflow">' + nav + body + "</div>";
  }
  window.ftWorkflowPanel = ftWorkflowPanel;

  var STYLES =
    ".ft-shell{--ft:#e879a9;--ft2:#7c3aed}" +
    ".ft-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;margin-bottom:20px}" +
    ".ft-brand{display:flex;align-items:center;gap:12px}" +
    ".ft-mark{width:46px;height:46px;border-radius:15px;display:grid;place-items:center;font-size:25px;background:linear-gradient(135deg,rgba(232,121,169,.24),rgba(124,58,237,.22));border:1px solid rgba(232,121,169,.35)}" +
    ".ft-sync{font-size:11px;color:var(--muted);text-align:right}" +
    // .ft-tabs/.ft-tab tragen jetzt nur noch die Bereichsnavigation INNERHALB
    // eines Projekts (Ablauf, Bedarf, Angebot …). Die App-weite Bereichsleiste
    // ueber dem Inhalt ist ersatzlos entfernt.
    ".ft-tabs{display:flex;gap:6px;overflow:auto;padding-bottom:8px;margin-bottom:18px}" +
    ".ft-context{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:0 0 16px}" +
    ".ft-context-back{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);" +
      "background:var(--panel2);color:var(--muted);padding:6px 11px;border-radius:9px;cursor:pointer;font-size:12.5px}" +
    ".ft-context-back:hover{background:var(--hover);color:var(--text)}" +
    ".ft-context-sep{color:var(--muted);font-size:13px}" +
    ".ft-context-title{margin:0;font-size:17px;font-weight:700}" +
    ".ft-routes{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px}" +
    ".ft-route{display:flex;flex-direction:column;gap:3px;text-align:left;border:1px solid var(--border);" +
      "background:var(--panel2);color:var(--text);border-radius:12px;padding:12px 14px;cursor:pointer}" +
    ".ft-route:hover{background:var(--hover);border-color:var(--ft)}" +
    ".ft-route.on{border-color:transparent;background:linear-gradient(135deg,rgba(232,121,169,.22),rgba(124,58,237,.20))}" +
    ".ft-route small{color:var(--muted);font-size:11.5px;line-height:1.45}" +
    ".ft-ready{border:1px solid rgba(60,180,120,.45);background:rgba(60,180,120,.12);border-radius:10px;" +
      "padding:9px 11px;font-size:12.5px;margin-top:10px}" +
    ".ft-skip{border:1px solid rgba(240,180,60,.45);background:rgba(240,180,60,.12);border-radius:10px;" +
      "padding:9px 11px;font-size:12.5px}" +
    ".ft-step-row{border-top:1px solid var(--border);padding:11px 0}" +
    ".ft-step-row:first-of-type{border-top:0;padding-top:2px}" +
    ".ft-step-head{display:flex;align-items:center;gap:8px;margin-bottom:2px}" +
    ".ft-step-items{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}" +
    ".ft-step-item{border:1px solid var(--border);background:var(--panel2);color:var(--text);" +
      "border-radius:9px;padding:6px 11px;cursor:pointer;font-size:12.5px;text-align:left}" +
    ".ft-step-item:hover{background:var(--hover);border-color:var(--ft)}" +
    ".ft-step-item small{color:var(--muted)}" +
    ".ft-entries{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px}" +
    ".ft-entry{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--border);" +
      "border-radius:11px;text-decoration:none;color:var(--text);transition:background .13s ease}" +
    ".ft-entry:hover{background:var(--hover)}" +
    ".ft-entry-icon{font-size:19px;flex:none}" +
    ".ft-entry-text{display:flex;flex-direction:column;min-width:0}" +
    ".ft-entry-text small{color:var(--muted);font-size:11.5px}" +
    ".ft-tab{white-space:nowrap;border:1px solid var(--border);background:var(--panel2);color:var(--muted);padding:8px 12px;border-radius:10px;cursor:pointer}" +
    ".ft-tab.active{color:#fff;border-color:transparent;background:linear-gradient(135deg,var(--ft),var(--ft2))}" +
    ".ft-subtabs{margin-top:14px}" +
    ".ft-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}" +
    ".ft-kpi{padding:18px;border-radius:14px;background:var(--panel);border:1px solid var(--border)}" +
    ".ft-kpi span{display:block;color:var(--muted);font-size:11px;margin-bottom:7px}.ft-kpi strong{font-size:22px}" +
    ".ft-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:14px}" +
    ".ft-card-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}" +
    ".ft-form,.ft-inline-form{display:flex;gap:10px;margin-bottom:14px}.ft-form{flex-direction:column}.ft-inline-form>*{flex:1}" +
    ".ft-quick{display:flex;flex-wrap:wrap;gap:8px}" +
    ".ft-alert{padding:12px 14px;border-radius:12px;border:1px solid var(--border);background:var(--panel2);margin-bottom:14px;display:flex;align-items:center;gap:10px;justify-content:space-between}" +
    ".ft-row,.ft-task,.ft-list-item{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)}" +
    ".ft-row>span,.ft-task>span,.ft-list-item>strong{flex:1}" +
    ".ft-list-item{align-items:flex-start;flex-direction:column;gap:2px}" +
    ".ft-list-item span,.ft-row small{color:var(--muted);font-size:11px}.ft-task small{color:var(--muted);flex:0 0 auto}" +
    ".ft-done{text-decoration:line-through;opacity:.55}" +
    ".ft-check{width:22px;height:22px;flex:0 0 auto;border-radius:7px;border:1px solid var(--border2);background:var(--panel2);color:var(--accent);cursor:pointer;display:grid;place-items:center;font-size:13px}" +
    ".ft-check.on{background:var(--accent);color:var(--on-accent,#fff);border-color:transparent}" +
    ".ft-lead{display:grid;grid-template-columns:1fr 190px;gap:18px;padding:16px 0;border-bottom:1px solid var(--border)}" +
    ".ft-lead p{white-space:pre-wrap;margin:8px 0 0}" +
    ".ft-pipeline{display:grid;grid-template-columns:repeat(6,minmax(180px,1fr));gap:10px;overflow:auto;padding-bottom:8px}" +
    ".ft-column{background:var(--panel2);border:1px solid var(--border);border-radius:14px;padding:12px;min-height:210px}" +
    ".ft-column h3{display:flex;justify-content:space-between;font-size:13px}" +
    ".ft-pipeline-card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:10px;margin-top:9px}" +
    ".ft-pipeline-card strong{display:block;margin-bottom:8px}.ft-pipeline-card select{width:100%;font-size:11px}" +
    ".ft-empty{padding:28px;text-align:center;color:var(--muted);border:1px dashed var(--border);border-radius:12px}" +
    // Projektliste statt Kacheln
    ".ft-plist-head,.ft-prow{display:grid;grid-template-columns:minmax(0,2.4fr) 110px 90px 120px 120px 150px;gap:12px;align-items:center}" +
    ".ft-plist-head{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding-bottom:8px;border-bottom:1px solid var(--border)}" +
    ".ft-prow{padding:12px 0;border-bottom:1px solid var(--border);cursor:pointer;font-variant-numeric:tabular-nums}" +
    ".ft-prow:hover{background:var(--hover,rgba(255,255,255,.03))}" +
    ".ft-prow.late .ft-prow-main strong{color:var(--danger)}" +
    ".ft-prow-main{display:flex;flex-direction:column;gap:3px;min-width:0}" +
    ".ft-prow-main small,.ft-prow small{color:var(--muted);font-size:11px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    // Planung
    ".ft-plan-row{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);cursor:pointer}" +
    ".ft-plan-icon{width:26px;text-align:center;flex:0 0 auto}" +
    ".ft-plan-title{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}" +
    ".ft-plan-title small{color:var(--muted);font-size:11px}" +
    ".ft-plan-date{text-align:right;white-space:nowrap;font-size:12px}.ft-plan-date small{display:block;color:var(--muted);font-size:10.5px}" +
    ".ft-plan-row.late .ft-plan-date{color:var(--danger)}" +
    // Meilensteine
    ".ft-ms{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)}" +
    ".ft-ms-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".ft-ms input[type=date]{width:150px;font-size:11px}.ft-ms small{color:var(--muted);font-size:11px;white-space:nowrap}" +
    ".ft-ms.done .ft-ms-title{text-decoration:line-through;opacity:.55}.ft-ms.late small{color:var(--danger)}" +
    // FlowerTech-Block auf der Projektseite
    ".ft-panel{--ft:#e879a9;--ft2:#7c3aed;margin-top:16px;padding:18px;border-radius:16px;border:1px solid var(--border);background:var(--panel)}" +
    ".ft-panel-head{display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;align-items:center;margin-bottom:16px}" +
    ".ft-alert.warn{border-color:color-mix(in oklab,var(--danger) 45%,transparent)}" +
    // Kennzahlenstreifen im Dokument
    ".ft-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:6px 0 4px}" +
    ".ft-fact{padding:10px 12px;border-radius:10px;background:var(--panel2);border:1px solid var(--border)}" +
    ".ft-fact span{display:block;color:var(--muted);font-size:10.5px;margin-bottom:4px}.ft-fact strong{font-size:14px}" +
    ".ft-history-row{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);font-size:12.5px}" +
    ".ft-history-row span:nth-child(2){flex:1;min-width:0}.ft-history-row small{color:var(--muted);white-space:nowrap}" +
    ".ft-history-icon{width:20px;text-align:center;color:var(--muted)}" +
    ".ft-doc-row{display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--border);cursor:pointer}" +
    ".ft-doc-main{flex:1;min-width:0}.ft-doc-side{display:flex;align-items:center;gap:12px;white-space:nowrap}" +
    ".ft-status{font-size:10px;text-transform:uppercase;letter-spacing:.06em;padding:3px 8px;border-radius:999px;border:1px solid var(--border);color:var(--muted)}" +
    ".ft-status.paid,.ft-status.accepted{color:var(--ok);border-color:color-mix(in oklab,var(--ok) 45%,transparent)}" +
    ".ft-status.overdue,.ft-status.declined{color:var(--danger);border-color:color-mix(in oklab,var(--danger) 45%,transparent)}" +
    ".ft-status.sent{color:var(--info,#6aa3de);border-color:color-mix(in oklab,var(--info,#6aa3de) 45%,transparent)}" +
    ".ft-editor{margin-top:14px}" +
    ".ft-editor-head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start;margin-bottom:12px}" +
    ".ft-editor-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}" +
    ".ft-sub{margin:18px 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}" +
    ".ft-field-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}" +
    ".ft-field-grid label{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--muted)}" +
    ".ft-field-grid input,.ft-field-grid select{width:100%}" +
    ".ft-editor textarea{width:100%;margin-bottom:8px}" +
    ".ft-item-head,.ft-item-row{display:grid;grid-template-columns:1fr 80px 100px 110px 90px 110px 40px;gap:8px;align-items:center}" +
    ".ft-item-head{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding-bottom:6px;border-bottom:1px solid var(--border)}" +
    ".ft-item-row{padding:6px 0}.ft-item-total{text-align:right;font-variant-numeric:tabular-nums}" +
    ".ft-item-block{padding:4px 0 10px;border-bottom:1px solid var(--border)}" +
    ".ft-item-detail{width:100%;margin-top:6px;font-size:12px}" +
    ".ft-doc-row.late .ft-doc-main strong{color:var(--danger)}" +
    ".ft-status.expired{color:var(--warn,#d9a441);border-color:color-mix(in oklab,var(--warn,#d9a441) 45%,transparent)}" +
    ".ft-totals{margin-top:14px;margin-left:auto;max-width:330px}" +
    ".ft-total-row{display:flex;justify-content:space-between;padding:5px 0}" +
    ".ft-total-row.sum{border-top:2px solid var(--border2);margin-top:6px;padding-top:8px;font-size:16px}" +
    ".ft-qr{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}" +
    ".ft-qr img{width:180px;border-radius:10px;background:#fff;padding:8px}" +
    ".ft-qr-drop{flex:1;min-width:240px;border:1px dashed var(--border2);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:8px}" +
    "@media(max-width:1180px){.ft-plist-head{display:none}" +
    ".ft-prow{grid-template-columns:minmax(0,1fr) auto;gap:6px 12px}" +
    ".ft-prow>span:not(.ft-prow-main){font-size:11.5px;color:var(--muted);text-align:right}}" +
    "@media(max-width:980px){.ft-item-head,.ft-item-row{grid-template-columns:1fr 70px 80px 90px 70px 90px 34px;font-size:12px}}" +
    // ── Kundenworkflow ──
    ".ft-workflow{margin:18px 0}" +
    ".ft-steps{display:flex;gap:6px;overflow-x:auto;padding-bottom:6px;margin-bottom:6px}" +
    ".ft-step{display:flex;align-items:center;gap:7px;white-space:nowrap;border:1px solid var(--border);" +
      "background:var(--panel2);color:var(--muted);padding:8px 12px;border-radius:10px;cursor:pointer;font-size:12.5px}" +
    ".ft-step .ft-step-no{width:19px;height:19px;border-radius:50%;display:grid;place-items:center;" +
      "background:var(--border);font-size:11px;font-weight:700}" +
    ".ft-step.done{color:var(--text2);border-color:rgba(232,121,169,.35)}" +
    ".ft-step.done .ft-step-no{background:rgba(232,121,169,.35)}" +
    ".ft-step.active{color:#fff;border-color:transparent;background:linear-gradient(135deg,var(--ft),var(--ft2))}" +
    ".ft-step.active .ft-step-no{background:rgba(255,255,255,.28)}" +
    ".ft-step-hint{font-size:12px;color:var(--muted);margin-bottom:10px}" +
    ".ft-brief-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}" +
    ".ft-brief-grid label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)}" +
    ".ft-brief-grid input,.ft-brief-grid textarea,.ft-brief-grid select{width:100%}" +
    ".ft-hint{font-size:11px;color:var(--muted);opacity:.85}" +
    ".ft-doc-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}" +
    ".ft-doc-title{flex:1;min-width:180px;font-weight:600}" +
    /* Die zentrale AGB wird gelesen, nicht bearbeitet: Fliesstext statt
       Eingabefeld, damit auf einen Blick klar ist, dass hier nichts zu tippen
       ist. Umbrueche bleiben erhalten, lange Zeilen brechen trotzdem um. */
    ".ft-test-grid{display:grid;gap:8px;margin:10px 0}" +
    ".ft-test-f{display:grid;gap:4px;font-size:.85em;color:var(--text2)}" +
    ".ft-test-f input{width:100%}" +
    ".ft-block-read{margin:0;padding:10px 12px;white-space:pre-wrap;overflow-wrap:anywhere;" +
    "font:inherit;line-height:1.55;color:var(--text2);background:transparent;border:0}" +
    ".ft-legal-note{border:1px solid rgba(240,180,60,.45);background:rgba(240,180,60,.12);color:var(--text2);" +
      "border-radius:10px;padding:9px 11px;font-size:12px;line-height:1.5;margin-bottom:12px}" +
    ".ft-block{border:1px solid var(--border);border-radius:12px;padding:11px;margin-bottom:10px;background:var(--panel2)}" +
    ".ft-block.off{opacity:.5}" +
    ".ft-block-head{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:7px}" +
    ".ft-block-title{flex:1;min-width:140px;font-weight:600}" +
    ".ft-block-on{display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--muted);white-space:nowrap}" +
    ".ft-block-body{width:100%;font-family:inherit;font-size:12.5px;line-height:1.55;resize:vertical}" +
    ".ft-vars{font-size:11px;color:var(--muted);margin-top:5px;display:flex;flex-wrap:wrap;gap:5px}" +
    ".ft-vars code{background:var(--border);border-radius:5px;padding:1px 5px}" +
    ".ft-preview{margin-top:6px;font-size:11.5px;color:var(--muted)}" +
    ".ft-preview pre{white-space:pre-wrap;font-family:inherit;background:var(--panel);border-radius:8px;padding:9px;margin:6px 0 0}" +
    ".ft-cr{display:grid;grid-template-columns:1fr auto auto auto;gap:8px;align-items:center;" +
      "border:1px solid var(--border);border-radius:10px;padding:9px 11px;margin-top:8px}" +
    ".ft-cr-main{display:flex;flex-direction:column;gap:2px;min-width:0}" +
    ".ft-cr-main small{color:var(--muted);font-size:11.5px}" +
    ".ft-cr-done{opacity:.6}.ft-cr-rejected{opacity:.5}" +
    ".ft-cr-detail{width:100%;margin-top:8px}" +
    ".ft-prow-link{margin-left:8px;padding:2px 7px;font-size:12px;vertical-align:middle}" +
    ".ft-linkbar{border:1px solid var(--border);border-radius:12px;padding:10px 12px;margin-bottom:12px;" +
      "background:var(--panel2)}" +
    ".ft-linkbar .ft-link-row{margin-bottom:0}" +
    /* Die beiden Phasen tragen sichtbar verschiedene Farben und Titel. Wer den
       Fragebogen-Link sucht, soll ihn nicht mit dem Kundenportal verwechseln
       koennen — die Verwechslung war der ganze Fehler. */
    ".ft-phase{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);" +
      "font-weight:700;margin-bottom:6px}" +
    ".ft-linkbar-intake{border-color:rgba(232,121,169,.45);" +
      "background:linear-gradient(180deg,rgba(232,121,169,.10),transparent)}" +
    ".ft-linkbar-intake .ft-phase{color:#e879a9}" +
    ".ft-linkbar-intake .ft-link-row+.mini,.ft-linkbar-intake .ft-ready{margin-top:6px}" +
    /* Der Rücksetz-Knopf ist ausdrücklich kein Normalweg: eigene Farbe, eigene
       Zeile, und daneben in einem Satz, was er tut und was er nicht tut. */
    ".ft-intake-reset{margin-top:8px;align-items:flex-start}" +
    ".ft-intake-reset .mini{flex:1;min-width:200px}" +
    ".btn.ft-danger{border-color:rgba(197,48,48,.45);color:#e06767}" +
    ".btn.ft-danger:hover{background:rgba(197,48,48,.12)}" +
    /* Die Stufen des Kundenbereichs: was hinter dem einen Link sichtbar ist —
       und was ausdruecklich noch nicht. Beides steht da, nicht nur das eine. */
    ".ft-stages{margin-top:10px;border-top:1px dashed var(--border);padding-top:8px}" +
    ".ft-stages-head{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;" +
      "color:var(--muted);font-weight:700;margin-bottom:5px}" +
    ".ft-stage{display:flex;gap:7px;align-items:flex-start;font-size:12px;color:var(--muted);margin-bottom:4px}" +
    ".ft-stage.on{color:var(--text)}" +
    ".ft-stage-dot{width:14px;flex:none;text-align:center}" +
    ".ft-release-row{display:flex;gap:10px;align-items:center;justify-content:space-between;" +
      "border:1px solid var(--border);border-radius:10px;padding:8px 10px;margin-top:8px}" +
    ".ft-release-row .mini{margin-top:2px}" +
    ".ft-link-row{display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap}" +
    ".ft-link-row span{font-size:12px;color:var(--muted);min-width:120px}" +
    ".ft-link-intake>span{color:var(--text);font-weight:600;min-width:220px}" +
    ".ft-link-row input{flex:1;min-width:160px;font-size:11.5px}" +
    ".ft-inline-label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted);margin-top:10px}" +
    /* Kundenanfrage: Fragen bearbeiten */
    ".ft-q-row{border:1px solid var(--line);border-radius:10px;padding:10px;margin-top:8px}" +
    ".ft-q-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}" +
    ".ft-q-actions{display:flex;gap:4px}" +
    ".ft-q-row input,.ft-q-row textarea,.ft-q-row select{width:100%}" +
    ".ft-q-label{font-weight:600}" +
    ".ft-q-meta{display:grid;grid-template-columns:1fr 1fr auto;gap:6px;margin-top:6px;align-items:center}" +
    ".ft-q-req{display:flex;gap:5px;align-items:center;font-size:12px;color:var(--muted);white-space:nowrap}" +
    ".ft-q-req input{width:auto}" +
    ".ft-q-hint,.ft-q-opts{margin-top:6px;font-size:12px}" +
    ".ft-answer{border-top:1px solid var(--line);padding-top:8px;margin-top:8px}" +
    ".ft-answer p{margin:3px 0 0;white-space:pre-wrap;color:var(--text2);font-size:13px}" +
    /* Vorschau und Prompt */
    ".ft-preview{width:100%;height:460px;border:1px solid var(--line);border-radius:10px;background:#fff;margin-top:8px}" +
    ".ft-prompt{max-height:340px;overflow:auto;white-space:pre-wrap;font-size:11.5px;line-height:1.5;" +
      "border:1px solid var(--line);border-radius:10px;padding:10px;margin-top:8px;background:var(--bg2,rgba(0,0,0,.15))}" +
    ".ft-upload{position:relative;overflow:hidden;display:inline-flex;align-items:center;cursor:pointer}" +
    ".ft-upload input{position:absolute;inset:0;opacity:0;cursor:pointer}" +
    ".ft-qa{border-top:1px solid var(--line);padding:8px 0;display:flex;gap:8px;justify-content:space-between;align-items:flex-start}" +
    ".ft-qa p{margin:3px 0 0;white-space:pre-wrap;font-size:12.5px;color:var(--text2)}" +
    "@media(max-width:780px){.ft-q-meta{grid-template-columns:1fr}.ft-preview{height:320px}}" +
    ".ft-addr{display:flex;flex-wrap:wrap;gap:6px}" +
    ".ft-modes{display:flex;flex-wrap:wrap;gap:6px}" +
    ".ft-mode{border:1px solid var(--border);background:var(--panel2);color:var(--muted);border-radius:9px;" +
      "padding:6px 12px;cursor:pointer;font-size:12.5px}" +
    ".ft-mode:hover{background:var(--hover);color:var(--text)}" +
    ".ft-mode.on{color:#fff;border-color:transparent;background:linear-gradient(135deg,var(--ft),var(--ft2))}" +
    ".ft-checks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}" +
    "@media(max-width:780px){.ft-brief-grid,.ft-checks{grid-template-columns:1fr}" +
      ".ft-cr{grid-template-columns:1fr;align-items:stretch}.ft-link-row span{min-width:0}}" +
    "@media(max-width:780px){.ft-entries{grid-template-columns:1fr}.ft-context-title{font-size:15px}" +
    "@media(max-width:780px){.ft-head{flex-direction:column}.ft-sync{text-align:left}.ft-kpis{grid-template-columns:1fr 1fr}" +
    ".ft-grid-2{grid-template-columns:1fr}.ft-inline-form{flex-direction:column}.ft-lead{grid-template-columns:1fr}" +
    ".ft-pipeline{grid-template-columns:repeat(6,220px)}.ft-ms{flex-wrap:wrap}.ft-ms input[type=date]{width:130px}" +
    ".ft-item-head{display:none}.ft-item-row{grid-template-columns:1fr 1fr;gap:6px}.ft-item-row .ft-item-desc{grid-column:1/-1}}" +
    "@media(max-width:460px){.ft-kpis{grid-template-columns:1fr}}";

  // Die globale Suche (Cmd/Ctrl+K) zieht die Bereiche hier ab — dieselbe Liste,
  // aus der die Einstiegskarten gebaut werden. Damit ersetzt die Suche die
  // entfernte Bereichsleiste vollwertig.
  window.flowerTechSearchSections = function () {
    return SECTIONS.filter(function (s) { return s[0] !== "dashboard"; }).map(function (s) {
      return { key: s[0], icon: s[2], title: "FlowerTech: " + s[1], sub: s[3] };
    });
  };

  window.viewFlowerTech = renderFlowerTech;
  // Wird von viewProjectDetail() aufgerufen: der FlowerTech-Block auf der
  // normalen Projektseite. Für Nicht-FlowerTech-Projekte liefert er "".
  window.ftProjectPanel = ftProjectPanel;

  // Für Mobile/Tablet: dieselbe Rechenlogik ohne UI (Reuse statt Duplikat).
  window.FlowerTechCore = {
    docTotals: docTotals,
    itemAmount: itemAmount,
    stages: STAGES,
    offerStatuses: OFFER_STATUSES,
    invoiceStatuses: INVOICE_STATUSES
  };

  function waitForApp() {
    if (state()) initializeSync();
    else setTimeout(waitForApp, 250);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", waitForApp);
  else waitForApp();
})();
