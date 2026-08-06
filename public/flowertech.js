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

  var STAGES = [
    ["lead", "Lead"], ["discovery", "Abklärung"], ["proposal", "Offerte"],
    ["build", "Umsetzung"], ["won", "Gewonnen"], ["lost", "Verloren"]
  ];

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
    return hit ? hit[1] : (fallback || value || "—");
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

  function stopListeners() {
    try { if (inquiryRef) inquiryRef.off(); } catch (error) {}
    try { if (videoRef) videoRef.off(); } catch (error) {}
    inquiryRef = null;
    videoRef = null;
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
  window._ftSetTab = function (tab) {
    var ft = state();
    ft.activeTab = tab;
    ft.ui.docId = null;
    save();
    rerender();
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
    rerender();
  };

  window._ftSetProjectField = function (projectId, field, value) {
    var project = projectById(projectId);
    if (!project) return;
    project[field] = value;
    project.updatedAt = now();
    save();
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

  window._ftInquiryToProject = function (inquiryId) {
    var inquiry = (state().inquiries || {})[inquiryId];
    if (!inquiry) return;
    var projectId = window.createEntity("project", {
      title: inquiry.company || inquiry.name || "FlowerTech-Projekt",
      description: [inquiry.service ? "Interesse: " + inquiry.service : "", inquiry.message || ""].filter(Boolean).join("\n\n"),
      status: "active",
      projectType: "flowertech",
      pipelineStage: "discovery",
      client: {
        name: inquiry.name || "", company: inquiry.company || "",
        email: inquiry.email || "", phone: inquiry.phone || ""
      },
      sourceInquiryId: inquiryId,
      tags: ["flowertech"]
    });
    save();
    notify("ok", "FlowerTech", "Projekt aus Anfrage erstellt");
    if (projectId) window._ftOpenProject(projectId);
  };

  // ── Offerten & Rechnungen ────────────────────────────────────────────────
  function blankDoc(kind, projectId) {
    var ft = state();
    var project = projectId ? projectById(projectId) : null;
    var client = (project && project.client) || {};
    var doc = {
      id: id(),
      kind: kind,
      number: nextNumber(kind),
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
    if (!projectId) ft.activeTab = kind === "invoice" ? "invoices" : "offers";
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

  window._ftDocStatus = function (kind, docId, status) {
    var doc = docById(kind, docId);
    if (!doc || doc.status === status) return;
    var list = kind === "invoice" ? INVOICE_STATUSES : OFFER_STATUSES;
    pushHistory(doc, "status", labelOf(list, doc.status) + " → " + labelOf(list, status));
    doc.status = status;
    doc.updatedAt = now();
    if (status === "sent" && !doc.sentAt) doc.sentAt = now();
    if (kind === "invoice" && status === "paid" && !doc.paidAt) {
      doc.paidAt = now();
      bookInvoicePayment(doc);
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
      ft.activeTab = "invoices";
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
    ft.activeTab = "invoices";
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
          var reader = new FileReader();
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
      esc((isInvoice ? "Rechnung " : "Offerte ") + (doc.number || "")) + "</title><style>" +
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
      "<h1>" + esc((isInvoice ? "Rechnung " : "Offerte ") + (doc.number || "")) + "</h1>" +
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
      state().activeTab = "ai";
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
      state().activeTab = "ai";
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
      '<div class="ft-doc-main"><strong>' + esc(doc.number || "—") + " · " + esc(doc.title || "Ohne Titel") + "</strong>" +
      '<div class="mini">' + esc(meta.join(" · ")) + "</div></div>" +
      '<div class="ft-doc-side">' + statusBadge(kind, doc) + "<strong>" + money(docTotals(doc).rounded) + "</strong></div></div>";
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

    return '<div class="card p-4 ft-editor">' +
      '<div class="ft-editor-head"><div><h3 style="margin:0">' + esc(doc.number || "") + " " + statusBadge(kind, doc) + "</h3>" +
      '<div class="mini">' + (isInvoice ? "Rechnung" : "Offerte") + " · zuletzt " + esc(dateTime(doc.updatedAt)) + "</div></div>" +
      '<div class="ft-editor-actions">' +
      "<select onchange=\"window._ftDocStatus('" + kind + "','" + attr(doc.id) + "',this.value)\">" +
      statuses.map(function (status) {
        return '<option value="' + status[0] + '"' + (doc.status === status[0] ? " selected" : "") + ">" + esc(status[1]) + "</option>";
      }).join("") + "</select>" +
      '<button class="btn sm primary" onclick="window._ftMailDoc(\'' + kind + "','" + attr(doc.id) + '\')" ' +
        'title="Per Gmail versenden — der Thread wird mit dem Projekt verknüpft">✉️ Per Mail senden</button>' +
      '<button class="btn sm" onclick="window._ftPrintDoc(\'' + kind + "','" + attr(doc.id) + '\')">Drucken / PDF</button>' +
      (isInvoice
        ? '<button class="btn sm" onclick="window._ftAiReminder(\'' + attr(doc.id) + '\')">KI-Mahnung</button>'
        : '<button class="btn sm" onclick="window._ftOfferToInvoice(\'' + attr(doc.id) + '\')">In Rechnung umwandeln</button>' +
          '<button class="btn sm" onclick="window._ftOfferToTasks(\'' + attr(doc.id) + '\')" ' +
            'title="Jede Position wird zu einer Quantus-Aufgabe am Projekt">☑ In Arbeitspaket</button>') +
      '<button class="btn sm ghost" onclick="window._ftDeleteDoc(\'' + kind + "','" + attr(doc.id) + '\')">Löschen</button>' +
      "</div></div>" +

      deadlineWarning +
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
      "</div></div>";

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
      head + kpis + sales +
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
      '<span class="ft-prow-main"><strong>' + esc(project.title || "Projekt") + "</strong>" +
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

  // ==========================================================================
  //  Hauptansicht
  // ==========================================================================
  function renderFlowerTech() {
    var ft = state();
    if (!ft) return '<div class="card p-4">FlowerTech wird geladen…</div>';
    initializeSync();

    var allProjects = projects();
    var allTasks = tasks();
    var allInquiries = inquiries();
    var allVideos = videos();
    var activeTab = ft.activeTab;

    var tabs = [
      ["dashboard", "Dashboard"], ["projects", "Projekte"], ["planung", "Planung"], ["tasks", "Aufgaben"],
      ["offers", "Offerten"], ["invoices", "Rechnungen"], ["ai", "KI"],
      ["leads", "Leads / Anfragen"], ["pipeline", "Pipeline"], ["finances", "Finanzen"],
      ["notes", "Notizen"], ["links", "Links"], ["videos", "Instagram-Videos"], ["settings", "Firma"]
    ];
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

    } else if (activeTab === "projects") {
      // Keine Kacheln mehr: eine ruhige Liste mit allen Zahlen, die man zum
      // Sortieren braucht. Ein Klick öffnet die vollwertige Projektseite.
      content =
        '<div class="card p-4 ft-form"><h3>FlowerTech-Projekt erstellen</h3>' +
          '<input id="ftProjectTitle" type="text" placeholder="Projektname">' +
          '<textarea id="ftProjectDescription" rows="3" placeholder="Kurzbeschreibung"></textarea>' +
          '<button class="btn primary" onclick="window._ftCreateProject()">Projekt erstellen</button></div>' +
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
          '<button class="btn sm mt-2" onclick="window._ftInquiryToProject(\'' + attr(inquiry.id) + '\')">Projekt anlegen</button>' +
          '<button class="btn sm mt-2" onclick="window._ftAiReply(\'' + attr(inquiry.id) + '\')">KI-Antwort</button></div></div>';
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
      '<div class="ft-tabs">' + tabs.map(function (tab) {
        return '<button class="ft-tab ' + (activeTab === tab[0] ? "active" : "") + '" onclick="window._ftSetTab(\'' +
          tab[0] + '\')">' + esc(tab[1]) + "</button>";
      }).join("") + "</div>" + content + "</div>";
  }

  var STYLES =
    ".ft-shell{--ft:#e879a9;--ft2:#7c3aed}" +
    ".ft-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;margin-bottom:20px}" +
    ".ft-brand{display:flex;align-items:center;gap:12px}" +
    ".ft-mark{width:46px;height:46px;border-radius:15px;display:grid;place-items:center;font-size:25px;background:linear-gradient(135deg,rgba(232,121,169,.24),rgba(124,58,237,.22));border:1px solid rgba(232,121,169,.35)}" +
    ".ft-sync{font-size:11px;color:var(--muted);text-align:right}" +
    ".ft-tabs{display:flex;gap:6px;overflow:auto;padding-bottom:8px;margin-bottom:18px}" +
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
    "@media(max-width:780px){.ft-head{flex-direction:column}.ft-sync{text-align:left}.ft-kpis{grid-template-columns:1fr 1fr}" +
    ".ft-grid-2{grid-template-columns:1fr}.ft-inline-form{flex-direction:column}.ft-lead{grid-template-columns:1fr}" +
    ".ft-pipeline{grid-template-columns:repeat(6,220px)}.ft-ms{flex-wrap:wrap}.ft-ms input[type=date]{width:130px}" +
    ".ft-item-head{display:none}.ft-item-row{grid-template-columns:1fr 1fr;gap:6px}.ft-item-row .ft-item-desc{grid-column:1/-1}}" +
    "@media(max-width:460px){.ft-kpis{grid-template-columns:1fr}}";

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
