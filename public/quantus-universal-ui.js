(function (global) {
  "use strict";

  if (!global) return;
  if (global.QuantusUniversalUI) {
    if (global.QuantusBundleLoader && !global.QuantusBundleLoader.jobs["quantus-universal-ui"]) {
      global.QuantusBundleLoader.jobs["quantus-universal-ui"] = Promise.resolve(true);
    }
    return;
  }

  var PENDING_CONTEXT_KEY = "quantus-universal-pending-context-v3";
  var ROOT_ID = "quantusDeviceUi";
  var liveRefs = [];
  var firstValues = Object.create(null);
  var deferredRefresh = null;
  var selectedContext = null;
  var panelOpen = false;

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char];
    });
  }

  function text(value, max) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max || 240);
  }

  function storePending(context) {
    try { global.sessionStorage.setItem(PENDING_CONTEXT_KEY, JSON.stringify(context)); } catch (_) {}
    try { global.localStorage.setItem(PENDING_CONTEXT_KEY, JSON.stringify({ context: context, expiresAt: Date.now() + 5 * 60 * 1000 })); } catch (_) {}
  }

  function loadPending() {
    try {
      var session = JSON.parse(global.sessionStorage.getItem(PENDING_CONTEXT_KEY) || "null");
      if (session) return session;
    } catch (_) {}
    try {
      var local = JSON.parse(global.localStorage.getItem(PENDING_CONTEXT_KEY) || "null");
      if (local && local.context && Number(local.expiresAt) > Date.now()) return local.context;
    } catch (_) {}
    return null;
  }

  function clearPending() {
    try { global.sessionStorage.removeItem(PENDING_CONTEXT_KEY); } catch (_) {}
    try { global.localStorage.removeItem(PENDING_CONTEXT_KEY); } catch (_) {}
  }

  function root() {
    return global.document.getElementById(ROOT_ID);
  }

  function deviceIcon(kind) {
    return kind === "tablet" ? "▯" : kind === "phone" ? "▯" : "▰";
  }

  function currentContext() {
    return selectedContext || global.QuantusDeviceSync && global.QuantusDeviceSync.getContext() || {
      kind: "route", route: "home", title: global.document.title || "Quantus", url: global.location.href
    };
  }

  function renderPanel() {
    var host = root();
    if (!host) return;
    var api = global.QuantusDeviceSync;
    var context = currentContext();
    var devices = api ? api.listDevices({ includeOffline: true }) : [];
    var signedIn = Boolean(api && api.state && api.state.user && !api.state.user.isAnonymous);
    host.classList.toggle("open", panelOpen);
    var panel = host.querySelector(".qu-panel");
    if (!panel) return;
    panel.innerHTML =
      '<div class="qu-panel-head"><div><strong>Quantus Geräte</strong><small>' + esc(context.title || "Aktuelle Ansicht") + '</small></div><button type="button" data-qu-action="close" aria-label="Schliessen">×</button></div>' +
      '<div class="qu-context"><span>' + esc(context.kind === "entity" ? "Ausgewählter Eintrag" : "Aktuelle Ansicht") + '</span><strong>' + esc(context.title || "Quantus") + '</strong>' +
      (context.entityId ? '<small>' + esc((context.collection || context.route || "Eintrag") + " · " + context.entityId) + '</small>' : '') + '</div>' +
      (!signedIn ? '<div class="qu-note">Melde dich in Quantus mit demselben Google-Konto an. Danach erscheinen Tablet und Laptop hier automatisch.</div>' : '') +
      '<div class="qu-device-list">' + (devices.length ? devices.map(function (device) {
        return '<button type="button" class="qu-device ' + (device.active ? "active" : "offline") + '" data-qu-action="send" data-device-id="' + esc(device.id) + '">' +
          '<span class="qu-device-icon">' + deviceIcon(device.kind) + '</span><span><strong>' + esc(device.name) + '</strong><small>' +
          esc(device.active ? device.currentContext && device.currentContext.title || "Quantus geöffnet" : "Nicht aktiv") + '</small></span><i>' + (device.active ? "Senden" : "Später öffnen") + '</i></button>';
      }).join("") : '<div class="qu-empty">Kein weiteres Gerät erkannt.</div>') + '</div>' +
      '<div class="qu-panel-actions"><a href="/career-model.html" class="qu-link">Career Model öffnen</a><button type="button" data-qu-action="rename">Dieses Gerät umbenennen</button></div>';
  }

  function mount() {
    if (!global.document.body || root()) return;
    var host = global.document.createElement("div");
    host.id = ROOT_ID;
    host.innerHTML = '<button type="button" class="qu-fab" data-qu-action="toggle" aria-label="An andere Geräte senden" title="An anderes Gerät senden">⇄</button><aside class="qu-panel" aria-label="Quantus Geräte"></aside>';
    global.document.body.appendChild(host);
    renderPanel();
    decorateEntities();
    tryPendingContext();
  }

  function openPanel(context) {
    if (context) selectedContext = context;
    panelOpen = true;
    renderPanel();
  }

  function closePanel() {
    panelOpen = false;
    selectedContext = null;
    renderPanel();
  }

  function inferContext(node) {
    if (!node) return null;
    var ds = node.dataset || {};
    var action = text(ds.action || "", 80).toLowerCase();
    var route = text(ds.route || "", 80);
    var collection = text(ds.collection || "", 80);
    var entityId = text(ds.projectId || ds.taskId || ds.entityId || ds.id || "", 160);
    if (!entityId) return null;
    if (ds.projectId || /project/.test(action) || collection === "projects") { collection = collection || "projects"; route = route || "projects"; }
    if (ds.taskId || /task/.test(action) || collection === "tasks") { collection = collection || "tasks"; route = route || "tasks"; }
    route = route || collection || String(global.location.hash || "#/home").replace(/^#\/?/, "").split("/")[0] || "home";
    collection = collection || route;
    var titleNode = node.querySelector && node.querySelector(".item-title,.project-title,h1,h2,h3,strong");
    var title = text(ds.title || node.getAttribute("aria-label") || titleNode && titleNode.textContent || "Quantus Eintrag", 160);
    var url = "https://management-xo2-pro.netlify.app/#/" + encodeURIComponent(route) + "/" + encodeURIComponent(entityId);
    return { kind: "entity", route: route, collection: collection, entityId: entityId, title: title, url: url, sourceOrigin: global.location.origin };
  }

  function decorateEntities() {
    if (!global.document.querySelectorAll) return;
    var selector = ".entity-card,[data-project-id],[data-task-id],[data-entity-id],[data-action='edit-entity'][data-id]";
    Array.prototype.forEach.call(global.document.querySelectorAll(selector), function (node) {
      if (!node || node.closest && node.closest("#" + ROOT_ID) || node.dataset.quantusSendDecorated === "1") return;
      var context = inferContext(node);
      if (!context) return;
      node.dataset.quantusSendDecorated = "1";
      var button = global.document.createElement("button");
      button.type = "button";
      button.className = "qu-entity-send";
      button.setAttribute("aria-label", "Auf anderem Gerät öffnen");
      button.title = "Auf anderem Gerät öffnen";
      button.textContent = "⇄";
      button._quantusContext = context;
      button.addEventListener("click", function (event) { event.preventDefault(); event.stopPropagation(); openPanel(button._quantusContext); });
      try { node.appendChild(button); } catch (_) {}
    });
  }

  function isTablet() {
    return Boolean(global.__quantusTablet) || /tablet/i.test(global.location.hostname);
  }

  function openReceivedContext(context) {
    if (!context) return;
    storePending(context);
    if (isTablet() && context.kind !== "career" && context.kind !== "bm") {
      var route = context.route || context.collection || "home";
      global.location.hash = "#/" + encodeURIComponent(route);
      setTimeout(tryPendingContext, 100);
      return;
    }
    try {
      var url = new URL(context.url, global.location.href);
      if (url.href !== global.location.href) global.location.assign(url.href);
      else tryPendingContext();
    } catch (_) {}
  }

  function tryPendingContext() {
    var context = loadPending();
    if (!context) return;
    if (!context.entityId) { clearPending(); return; }
    var escapedId = global.CSS && global.CSS.escape ? global.CSS.escape(context.entityId) : String(context.entityId).replace(/["\\]/g, "\\$&");
    var selectors = [
      '[data-project-id="' + escapedId + '"]', '[data-task-id="' + escapedId + '"]',
      '[data-entity-id="' + escapedId + '"]', '[data-id="' + escapedId + '"][data-action="edit-entity"]',
      '[data-id="' + escapedId + '"][data-collection="' + String(context.collection || "").replace(/["\\]/g, "\\$&") + '"]'
    ];
    var target = global.document.querySelector(selectors.join(","));
    if (target) {
      clearPending();
      try { target.click(); } catch (_) {}
      try { target.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (_) {}
      return;
    }
    var attempts = Number(context._attempts || 0);
    if (attempts < 20) {
      context._attempts = attempts + 1; storePending(context); setTimeout(tryPendingContext, 180);
    } else {
      clearPending();
      try { global.document.dispatchEvent(new CustomEvent("quantus:open-entity", { detail: { context: context } })); } catch (_) {}
    }
  }

  function userIsEditing() {
    var active = global.document.activeElement;
    return Boolean(active && /^(INPUT|TEXTAREA|SELECT)$/i.test(active.tagName) && !active.readOnly && !active.disabled);
  }

  function runRefresh(reason) {
    if (userIsEditing()) {
      deferredRefresh = reason || "remote";
      var active = global.document.activeElement;
      if (active) active.addEventListener("blur", function once() { active.removeEventListener("blur", once); var pending = deferredRefresh; deferredRefresh = null; runRefresh(pending); }, { once: true });
      return;
    }
    try {
      if (typeof global.pullAndMergeBeforeSave === "function") {
        Promise.resolve(global.pullAndMergeBeforeSave("realtime_listener")).then(function () { if (typeof global.render === "function") global.render(); });
      } else if (typeof global.syncFreshness === "function") {
        Promise.resolve(global.syncFreshness(true)).then(function () { if (typeof global.render === "function") global.render(); });
      } else if (/\/bm\.html$/i.test(global.location.pathname) && typeof global.fbGet === "function" && global.CFG && global.U) {
        global.fbGet(global.CFG.NS).then(function (data) {
          data = data || {}; global.U.aufg = data.aufg || {}; global.U.notes = data.notes || {}; global.U.config = data.config || {}; global.U.chat = data.chat || []; global.U.activity = data.activity || {};
          if (typeof global.cacheSave === "function") global.cacheSave(); if (typeof global.route === "function") global.route();
        }).catch(function () {});
      }
    } catch (_) {}
    try { global.document.dispatchEvent(new CustomEvent("quantus:live-refresh", { detail: { reason: reason || "remote" } })); } catch (_) {}
  }

  function bindLiveRef(db, path, label) {
    var ref = db.ref(path);
    var handler = function (snapshot) {
      var value = snapshot.val();
      var signature = "";
      try { signature = JSON.stringify(value && (value.updatedAt || value.savedAt || value.meta && value.meta.updatedAt || value)); } catch (_) { signature = String(Date.now()); }
      if (!(label in firstValues)) { firstValues[label] = signature; return; }
      if (firstValues[label] === signature) return;
      firstValues[label] = signature;
      runRefresh(label);
    };
    ref.on("value", handler, function () {});
    liveRefs.push({ ref: ref, handler: handler });
  }

  function bindLiveSync() {
    var api = global.QuantusDeviceSync;
    if (!api) return;
    api.ready.then(function () {
      var db = api.state && api.state.db;
      if (!db || liveRefs.length) return;
      bindLiveRef(db, "appStore/app-data_json", "appStore/app-data_json");
      if (/\/bm\.html$/i.test(global.location.pathname)) bindLiveRef(db, "bmpruefung", "bmpruefung");
      bindLiveRef(db, "smarter/documents", "smarter/documents");
      bindLiveRef(db, "leseplan/docs", "leseplan/docs");
    });
  }

  global.document.addEventListener("click", function (event) {
    var button = event.target.closest && event.target.closest("[data-qu-action]");
    if (!button) return;
    var action = button.dataset.quAction;
    if (action === "toggle") { panelOpen = !panelOpen; renderPanel(); return; }
    if (action === "close") { closePanel(); return; }
    if (action === "send") {
      var api = global.QuantusDeviceSync;
      if (!api) return;
      button.disabled = true;
      api.sendToDevice(button.dataset.deviceId, currentContext()).then(function () {
        button.classList.add("sent"); button.querySelector("i").textContent = "Gesendet"; setTimeout(closePanel, 650);
      }).catch(function (error) { global.alert(error.message || "Übergabe fehlgeschlagen."); }).finally(function () { button.disabled = false; });
      return;
    }
    if (action === "rename") {
      var current = global.QuantusDeviceSync && global.QuantusDeviceSync.state.device && global.QuantusDeviceSync.state.device.name || "Gerät";
      var name = global.prompt("Name dieses Geräts", current);
      if (name && global.QuantusDeviceSync) global.QuantusDeviceSync.renameDevice(name).then(renderPanel).catch(function () {});
    }
  });

  global.document.addEventListener("quantus:devices", renderPanel);
  global.document.addEventListener("quantus:device-state", renderPanel);
  global.document.addEventListener("quantus:command", function (event) {
    var detail = event.detail || {};
    detail.handled = true;
    openReceivedContext(detail.context || detail.command && detail.command.context);
  });
  global.addEventListener("hashchange", function () { setTimeout(function () { decorateEntities(); tryPendingContext(); }, 80); });

  var observer = new MutationObserver(function () { decorateEntities(); tryPendingContext(); });
  function start() {
    mount();
    if (global.document.body) observer.observe(global.document.body, { childList: true, subtree: true });
    bindLiveSync();
  }
  if (global.document.readyState === "loading") global.document.addEventListener("DOMContentLoaded", start, { once: true }); else start();

  var api = { openPanel: openPanel, closePanel: closePanel, currentContext: currentContext, decorateEntities: decorateEntities, PENDING_CONTEXT_KEY: PENDING_CONTEXT_KEY };
  global.QuantusUniversalUI = api;
  if (global.QuantusBundleLoader && !global.QuantusBundleLoader.jobs["quantus-universal-ui"]) global.QuantusBundleLoader.jobs["quantus-universal-ui"] = Promise.resolve(true);
  try { global.document.dispatchEvent(new CustomEvent("quantus:bundle-ready", { detail: { name: "quantus-universal-ui" } })); } catch (_) {}
})(typeof window !== "undefined" ? window : null);
