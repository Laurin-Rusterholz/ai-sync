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
      notify("ok", "FlowerTech synchronisiert", created ? created + " neue Aufgabe(n)" : "Keine Duplikate, alles aktuell");
      rerender();
    } catch (error) {
      ft.syncStatus = "error";
      notify("err", "FlowerTech", error.message);
      rerender();
    }
  };

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
      ["dashboard", "Dashboard"], ["projects", "Projekte"], ["tasks", "Aufgaben"],
      ["leads", "Leads / Anfragen"], ["pipeline", "Pipeline"], ["finances", "Finanzen"],
      ["notes", "Notizen"], ["links", "Links"], ["videos", "Instagram-Videos"]
    ];
    var syncLabels = {
      connected: "Firebase verbunden", syncing: "Synchronisiert…",
      login_required: "Anmeldung erforderlich", error: "Synchronisationsfehler",
      unavailable: "Firebase nicht verfügbar", idle: "Bereit"
    };
    var inquiryStatuses = [
      ["new", "Neu"], ["contacted", "Kontaktiert"], ["qualified", "Qualifiziert"],
      ["proposal", "Offerte"], ["won", "Gewonnen"], ["lost", "Verloren"]
    ];
    var stages = [
      ["lead", "Lead"], ["discovery", "Abklärung"], ["proposal", "Offerte"],
      ["won", "Gewonnen"], ["lost", "Verloren"]
    ];
    var content = "";

    if (activeTab === "dashboard") {
      var openTasks = allTasks.filter(function (task) { return task.status !== "done"; }).length;
      var income = ft.finances.filter(function (entry) { return entry.type === "income"; })
        .reduce(function (sum, entry) { return sum + Number(entry.amount || 0); }, 0);
      var expense = ft.finances.filter(function (entry) { return entry.type === "expense"; })
        .reduce(function (sum, entry) { return sum + Number(entry.amount || 0); }, 0);
      content =
        '<div class="ft-kpis">' +
          '<div class="ft-kpi"><span>Aktive Projekte</span><strong>' + allProjects.filter(function (p) { return p.status !== "done" && p.status !== "archived"; }).length + '</strong></div>' +
          '<div class="ft-kpi"><span>Offene Aufgaben</span><strong>' + openTasks + '</strong></div>' +
          '<div class="ft-kpi"><span>Neue Anfragen</span><strong>' + allInquiries.filter(function (i) { return !i.status || i.status === "new"; }).length + '</strong></div>' +
          '<div class="ft-kpi"><span>Netto</span><strong>' + money(income - expense) + '</strong></div>' +
        '</div>' +
        '<div class="ft-grid-2"><div class="card p-4"><h3>Pipeline</h3><div class="sep"></div>' +
          stages.map(function (stage) {
            return '<div class="ft-row"><span>' + esc(stage[1]) + '</span><strong>' +
              allProjects.filter(function (p) { return (p.pipelineStage || "lead") === stage[0]; }).length + '</strong></div>';
          }).join("") +
        '</div><div class="card p-4"><h3>Letzte Anfragen</h3><div class="sep"></div>' +
          (allInquiries.length ? allInquiries.slice(0, 5).map(function (inquiry) {
            return '<div class="ft-list-item"><strong>' + esc(inquiry.name || inquiry.email || "Anfrage") +
              '</strong><span>' + esc(inquiry.company || inquiry.service || inquiry.status || "neu") + '</span></div>';
          }).join("") : empty("Noch keine Website-Anfragen")) +
        '</div></div>';
    } else if (activeTab === "projects") {
      content =
        '<div class="card p-4 ft-form"><h3>FlowerTech-Projekt erstellen</h3>' +
          '<input id="ftProjectTitle" type="text" placeholder="Projektname">' +
          '<textarea id="ftProjectDescription" rows="3" placeholder="Kurzbeschreibung"></textarea>' +
          '<button class="btn primary" onclick="window._ftCreateProject()">Projekt erstellen</button></div>' +
        '<div class="ft-card-grid">' + (allProjects.length ? allProjects.map(function (project) {
          return '<div class="card p-4"><div class="flex justify-between gap-2"><h3>' + esc(project.title || "Projekt") +
            '</h3><span class="badge">' + esc(project.status || "active") + '</span></div><p class="mini">' +
            esc(project.description || "Keine Beschreibung") + '</p><select onchange="window._ftSetProjectStage(\'' + esc(project.id) + '\',this.value)">' +
            stages.map(function (stage) {
              return '<option value="' + stage[0] + '" ' + ((project.pipelineStage || "lead") === stage[0] ? "selected" : "") + '>' + esc(stage[1]) + '</option>';
            }).join("") + '</select><button class="btn sm mt-3" onclick="location.hash=\'#/projects/' + esc(project.id) + '\'">In AI Sync öffnen</button></div>';
        }).join("") : empty("Noch keine FlowerTech-Projekte")) + '</div>';
    } else if (activeTab === "tasks") {
      content =
        '<div class="card p-4 ft-inline-form"><input id="ftTaskTitle" type="text" placeholder="Neue Aufgabe">' +
        '<select id="ftTaskProject"><option value="">Ohne Projekt</option>' + allProjects.map(function (p) {
          return '<option value="' + esc(p.id) + '">' + esc(p.title) + '</option>';
        }).join("") + '</select><button class="btn primary" onclick="window._ftCreateTask()">Hinzufügen</button></div>' +
        '<div class="card p-4">' + (allTasks.length ? allTasks.map(function (task) {
          var project = allProjects.find(function (p) { return p.id === task.projectId; });
          return '<div class="ft-task"><span class="' + (task.status === "done" ? "ft-done" : "") + '">' +
            esc(task.title || "Aufgabe") + '</span><small>' + esc(project && project.title || (task.sourceInquiryId ? "Website-Anfrage" : "FlowerTech")) +
            '</small><button class="btn sm" onclick="location.hash=\'#/tasks/' + esc(task.id) + '\'">Öffnen</button></div>';
        }).join("") : empty("Keine FlowerTech-Aufgaben")) + '</div>';
    } else if (activeTab === "leads") {
      content = '<div class="card p-4">' + (allInquiries.length ? allInquiries.map(function (inquiry) {
        return '<div class="ft-lead"><div><strong>' + esc(inquiry.name || "Unbekannt") + '</strong><div class="mini">' +
          esc(inquiry.company || "") + (inquiry.email ? " · " + esc(inquiry.email) : "") + '</div><p>' + esc(inquiry.message || "") +
          '</p></div><select onchange="window._ftSetInquiryStatus(\'' + esc(inquiry.id) + '\',this.value)">' +
          inquiryStatuses.map(function (status) {
            return '<option value="' + status[0] + '" ' + ((inquiry.status || "new") === status[0] ? "selected" : "") + '>' + esc(status[1]) + '</option>';
          }).join("") + '</select></div>';
      }).join("") : empty("Noch keine Anfragen unter flowertech/inquiries")) + '</div>';
    } else if (activeTab === "pipeline") {
      content = '<div class="ft-pipeline">' + stages.map(function (stage) {
        var items = allProjects.filter(function (p) { return (p.pipelineStage || "lead") === stage[0]; });
        return '<div class="ft-column"><h3>' + esc(stage[1]) + ' <span>' + items.length + '</span></h3>' +
          (items.length ? items.map(function (project) {
            return '<div class="ft-pipeline-card"><strong>' + esc(project.title || "Projekt") +
              '</strong><select onchange="window._ftSetProjectStage(\'' + esc(project.id) + '\',this.value)">' +
              stages.map(function (option) {
                return '<option value="' + option[0] + '" ' + (option[0] === stage[0] ? "selected" : "") + '>' + esc(option[1]) + '</option>';
              }).join("") + '</select></div>';
          }).join("") : '<div class="mini">Leer</div>') + '</div>';
      }).join("") + '</div>';
    } else if (activeTab === "finances") {
      var totalIncome = ft.finances.filter(function (entry) { return entry.type === "income"; })
        .reduce(function (sum, entry) { return sum + Number(entry.amount || 0); }, 0);
      var totalExpense = ft.finances.filter(function (entry) { return entry.type === "expense"; })
        .reduce(function (sum, entry) { return sum + Number(entry.amount || 0); }, 0);
      content =
        '<div class="ft-kpis"><div class="ft-kpi"><span>Einnahmen</span><strong>' + money(totalIncome) +
        '</strong></div><div class="ft-kpi"><span>Ausgaben</span><strong>' + money(totalExpense) +
        '</strong></div><div class="ft-kpi"><span>Netto</span><strong>' + money(totalIncome - totalExpense) + '</strong></div></div>' +
        '<div class="card p-4 ft-inline-form"><input id="ftFinanceTitle" placeholder="Bezeichnung"><input id="ftFinanceAmount" type="number" min="0" step="0.05" placeholder="CHF">' +
        '<select id="ftFinanceType"><option value="income">Einnahme</option><option value="expense">Ausgabe</option></select><button class="btn primary" onclick="window._ftAddFinance()">Buchen</button></div>' +
        '<div class="card p-4">' + (ft.finances.length ? ft.finances.map(function (entry) {
          return '<div class="ft-row"><span>' + esc(entry.title) + ' <small>' + esc(entry.date || "") + '</small></span><strong style="color:' +
            (entry.type === "income" ? "var(--ok)" : "var(--danger)") + '">' + (entry.type === "income" ? "+" : "−") + " " + money(entry.amount) +
            '</strong><button class="btn sm ghost" onclick="window._ftDeleteFinance(\'' + esc(entry.id) + '\')">×</button></div>';
        }).join("") : empty("Noch keine Finanzbuchungen")) + '</div>';
    } else if (activeTab === "notes") {
      content =
        '<div class="card p-4 ft-form"><input id="ftNoteTitle" placeholder="Titel"><textarea id="ftNoteContent" rows="4" placeholder="Notiz"></textarea><button class="btn primary" onclick="window._ftAddNote()">Notiz speichern</button></div>' +
        '<div class="ft-card-grid">' + (ft.notes.length ? ft.notes.map(function (note) {
          return '<div class="card p-4"><div class="flex justify-between"><h3>' + esc(note.title) + '</h3><button class="btn sm ghost" onclick="window._ftDeleteNote(\'' +
            esc(note.id) + '\')">×</button></div><p style="white-space:pre-wrap">' + esc(note.content || "") + '</p><div class="mini">' + dateTime(note.createdAt) + '</div></div>';
        }).join("") : empty("Noch keine FlowerTech-Notizen")) + '</div>';
    } else if (activeTab === "links") {
      content =
        '<div class="card p-4 ft-inline-form"><input id="ftLinkTitle" placeholder="Bezeichnung"><input id="ftLinkUrl" type="url" placeholder="https://…"><button class="btn primary" onclick="window._ftAddLink()">Link speichern</button></div>' +
        '<div class="card p-4">' + (ft.links.length ? ft.links.map(function (link) {
          return '<div class="ft-row"><a href="' + esc(safeUrl(link.url)) + '" target="_blank" rel="noopener noreferrer">' + esc(link.title) +
            '</a><span class="mini">' + esc(link.url) + '</span><button class="btn sm ghost" onclick="window._ftDeleteLink(\'' + esc(link.id) + '\')">×</button></div>';
        }).join("") : empty("Noch keine Links")) + '</div>';
    } else if (activeTab === "videos") {
      content = '<div class="ft-card-grid">' + (allVideos.length ? allVideos.map(function (video) {
        var url = safeUrl(video.url || video.instagramUrl);
        return '<div class="card p-4"><div class="flex justify-between gap-2"><h3>' + esc(video.title || video.hook || "Instagram Reel") +
          '</h3><span class="badge">' + esc(video.status || "draft") + '</span></div><p>' + esc(video.caption || "") +
          '</p><div class="mini">' + dateTime(video.publishedAt || video.createdAt) + " · " +
          Number(video.views || 0).toLocaleString("de-CH") + " Views · " + Number(video.likes || 0).toLocaleString("de-CH") +
          ' Likes</div>' + (url !== "#" ? '<a class="btn sm mt-3" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Reel öffnen</a>' : "") + '</div>';
      }).join("") : empty("Noch keine Videos unter flowertech/videos")) + '</div>';
    }

    return '<style>' +
      '.ft-shell{--ft:#e879a9;--ft2:#7c3aed}.ft-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;margin-bottom:20px}.ft-brand{display:flex;align-items:center;gap:12px}.ft-mark{width:46px;height:46px;border-radius:15px;display:grid;place-items:center;font-size:25px;background:linear-gradient(135deg,rgba(232,121,169,.24),rgba(124,58,237,.22));border:1px solid rgba(232,121,169,.35)}.ft-sync{font-size:11px;color:var(--muted);text-align:right}.ft-tabs{display:flex;gap:6px;overflow:auto;padding-bottom:8px;margin-bottom:18px}.ft-tab{white-space:nowrap;border:1px solid var(--border);background:var(--panel2);color:var(--muted);padding:8px 12px;border-radius:10px;cursor:pointer}.ft-tab.active{color:#fff;border-color:transparent;background:linear-gradient(135deg,var(--ft),var(--ft2))}.ft-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}.ft-kpi{padding:18px;border-radius:14px;background:var(--panel);border:1px solid var(--border)}.ft-kpi span{display:block;color:var(--muted);font-size:11px;margin-bottom:7px}.ft-kpi strong{font-size:22px}.ft-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:14px}.ft-card-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}.ft-form,.ft-inline-form{display:flex;gap:10px;margin-bottom:14px}.ft-form{flex-direction:column}.ft-inline-form>*{flex:1}.ft-row,.ft-task,.ft-list-item{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)}.ft-row>span,.ft-task>span,.ft-task>small,.ft-list-item>strong{flex:1}.ft-list-item{align-items:flex-start;flex-direction:column;gap:2px}.ft-list-item span,.ft-row small{color:var(--muted);font-size:11px}.ft-task small{color:var(--muted)}.ft-done{text-decoration:line-through;opacity:.55}.ft-lead{display:grid;grid-template-columns:1fr 170px;gap:18px;padding:16px 0;border-bottom:1px solid var(--border)}.ft-lead p{white-space:pre-wrap;margin:8px 0 0}.ft-pipeline{display:grid;grid-template-columns:repeat(5,minmax(190px,1fr));gap:10px;overflow:auto;padding-bottom:8px}.ft-column{background:var(--panel2);border:1px solid var(--border);border-radius:14px;padding:12px;min-height:210px}.ft-column h3{display:flex;justify-content:space-between;font-size:13px}.ft-pipeline-card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:10px;margin-top:9px}.ft-pipeline-card strong{display:block;margin-bottom:8px}.ft-pipeline-card select{width:100%;font-size:11px}.ft-empty{padding:28px;text-align:center;color:var(--muted);border:1px dashed var(--border);border-radius:12px}' +
      '@media(max-width:780px){.ft-head{flex-direction:column}.ft-sync{text-align:left}.ft-kpis{grid-template-columns:1fr 1fr}.ft-grid-2{grid-template-columns:1fr}.ft-inline-form{flex-direction:column}.ft-lead{grid-template-columns:1fr}.ft-pipeline{grid-template-columns:repeat(5,220px)}}@media(max-width:460px){.ft-kpis{grid-template-columns:1fr}}' +
      '</style><div class="ft-shell"><div class="ft-head"><div class="ft-brand"><div class="ft-mark">🌸</div><div><h1 style="margin:0">FlowerTech</h1><div class="mini">Web-Apps & KI · Schweizer KMU</div></div></div>' +
      '<div class="ft-sync"><div>' + esc(syncLabels[ft.syncStatus] || ft.syncStatus) + '</div><div>' +
      (ft.lastSyncAt ? "Zuletzt " + dateTime(ft.lastSyncAt) : "Noch nicht synchronisiert") +
      '</div><button class="btn sm mt-2" onclick="window._ftSyncNow()">Jetzt synchronisieren</button></div></div>' +
      '<div class="ft-tabs">' + tabs.map(function (tab) {
        return '<button class="ft-tab ' + (activeTab === tab[0] ? "active" : "") + '" onclick="window._ftSetTab(\'' + tab[0] + '\')">' + esc(tab[1]) + '</button>';
      }).join("") + '</div>' + content + '</div>';
  }

  window.viewFlowerTech = renderFlowerTech;

  function waitForApp() {
    if (state()) initializeSync();
    else setTimeout(waitForApp, 250);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", waitForApp);
  else waitForApp();
})();
