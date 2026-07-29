(function () {
  "use strict";

  var inquiryRef = null;
  var videoRef = null;
  var initialized = false;

  function esc(value) {
    return window.esc ? window.esc(value) : String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function id() {
    return window.uuid ? window.uuid() : "ft_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function now() {
    return window.nowIso ? window.nowIso() : new Date().toISOString();
  }

  function today() {
    return window.todayYmd ? window.todayYmd() : new Date().toISOString().slice(0, 10);
  }

  function save() {
    if (window.scheduleSave) window.scheduleSave();
  }

  function rerender() {
    if (window.render) window.render();
  }

  function notify(type, title, message) {
    if (window.toast) window.toast(type, title, message);
  }

  function data() {
    return window.APP && APP.state && APP.state.data;
  }

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
    ft.syncStatus = ft.syncStatus || "idle";
    return ft;
  }

  function projects() {
    var root = data();
    return Object.values(root && root.entities && root.entities.projects || {})
      .filter(function (project) { return project && project.projectType === "flowertech"; });
  }

  function tasks() {
    var root = data();
    var projectIds = new Set(projects().map(function (project) { return project.id; }));
    return Object.values(root && root.entities && root.entities.tasks || {})
      .filter(function (task) {
        return task && (task.sourceInquiryId || task.category === "flowertech" || projectIds.has(task.projectId));
      });
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

  function money(value) {
    return new Intl.NumberFormat("de-CH", { style: "currency", currency: "CHF" }).format(Number(value) || 0);
  }

  function dateTime(value) {
    if (!value) return "—";
    try { return new Date(value).toLocaleString("de-CH", { dateStyle: "medium", timeStyle: "short" }); }
    catch (error) { return String(value); }
  }

  function safeUrl(value) {
    try {
      var url = new URL(String(value || ""));
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : "#";
    } catch (error) {
      return "#";
    }
  }

  function empty(label) {
    return '<div class="ft-empty">' + esc(label) + "</div>";
  }

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
        var db = firebase.app().database("https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app");
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

  window._ftSetTab = function (tab) {
    state().activeTab = tab;
    save();
    rerender();
  };

  window._ftCreateProject = function () {
    var title = (document.getElementById("ftProjectTitle")?.value || "").trim();
    var description = (document.getElementById("ftProjectDescription")?.value || "").trim();
    if (!title) return notify("warn", "FlowerTech", "Projektname erforderlich");
    window.createEntity("project", {
      title: title,
      description: description,
      status: "active",
      projectType: "flowertech",
      pipelineStage: "lead",
      tags: ["flowertech"]
    });
    save();
    notify("ok", "FlowerTech", "Projekt erstellt und in AI Sync aufgenommen");
    rerender();
  };

  window._ftSetProjectStage = function (projectId, stage) {
    var project = data().entities.projects && data().entities.projects[projectId];
    if (!project) return;
    project.pipelineStage = stage;
    project.updatedAt = now();
    save();
    rerender();
  };

  window._ftCreateTask = function () {
    var title = (document.getElementById("ftTaskTitle")?.value || "").trim();
    var projectId = document.getElementById("ftTaskProject")?.value || null;
    if (!title) return notify("warn", "FlowerTech", "Aufgabentitel erforderlich");
    window.createEntity("task", {
      title: title,
      projectId: projectId,
      status: "todo",
      priority: 3,
      category: "flowertech",
      tags: ["flowertech"]
    });
    save();
    notify("ok", "FlowerTech", "Aufgabe erstellt");
    rerender();
  };

  window._ftAddFinance = function () {
    var title = (document.getElementById("ftFinanceTitle")?.value || "").trim();
    var amount = Number(document.getElementById("ftFinanceAmount")?.value || 0);
    var type = document.getElementById("ftFinanceType")?.value || "income";
    if (!title || !Number.isFinite(amount) || amount <= 0) {
      return notify("warn", "FlowerTech", "Titel und positiver Betrag erforderlich");
    }
    state().finances.unshift({ id: id(), title: title, amount: amount, type: type, date: today(), createdAt: now() });
    save();
    rerender();
  };

  window._ftDeleteFinance = function (entryId) {
    state().finances = state().finances.filter(function (entry) { return entry.id !== entryId; });
    save();
    rerender();
  };

  window._ftAddNote = function () {
    var title = (document.getElementById("ftNoteTitle")?.value || "").trim();
    var content = (document.getElementById("ftNoteContent")?.value || "").trim();
    if (!title && !content) return notify("warn", "FlowerTech", "Notiz ist leer");
    state().notes.unshift({ id: id(), title: title || "Notiz", content: content, createdAt: now(), updatedAt: now() });
    save();
    rerender();
  };

  window._ftDeleteNote = function (entryId) {
    state().notes = state().notes.filter(function (entry) { return entry.id !== entryId; });
    save();
    rerender();
  };

  window._ftAddLink = function () {
    var title = (document.getElementById("ftLinkTitle")?.value || "").trim();
    var url = safeUrl((document.getElementById("ftLinkUrl")?.value || "").trim());
    if (!title || url === "#") return notify("warn", "FlowerTech", "Titel und gültige URL erforderlich");
    state().links.unshift({ id: id(), title: title, url: url, createdAt: now() });
    save();
    rerender();
  };

  window._ftDeleteLink = function (entryId) {
    state().links = state().links.filter(function (entry) { return entry.id !== entryId; });
    save();
    rerender();
  };

  window._ftSetInquiryStatus = async function (inquiryId, status) {
    var ft = state();
    if (ft.inquiries[inquiryId]) {
      ft.inquiries[inquiryId].status = status;
      ft.inquiries[inquiryId].updatedAt = now();
    }
    try {
      await firebase.app().database("https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app")
        .ref("flowertech/inquiries/" + inquiryId).update({ status: status, updatedAt: now() });
      save();
      rerender();
    } catch (error) {
      notify("err", "FlowerTech", "Status konnte nicht gespeichert werden");
    }
  };

  window._ftSyncNow = async function () {
    var ft = state();
    if (!firebase.auth().currentUser) return notify("warn", "Firebase-Anmeldung", "Bitte zuerst in AI Sync mit Google anmelden");
    ft.syncStatus = "syncing";
    rerender();
    try {
      var db = firebase.app().database("https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app");
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
      notify("ok", "FlowerTech synchronisiert", created ? created + " neue Aufgabe(n)" : "Keine Duplikate,