(function (global) {
  "use strict";

  if (!global) return;
  if (global.QuantusDeviceSync) {
    if (global.QuantusBundleLoader && !global.QuantusBundleLoader.jobs["quantus-device-sync"]) {
      global.QuantusBundleLoader.jobs["quantus-device-sync"] = Promise.resolve(true);
    }
    return;
  }

  var FIREBASE_CONFIG = {
    apiKey: "AIzaSyC6xVo-wmXC4JjG7qMQnOExIjU-UDvBluE",
    authDomain: "jupidu-36804.firebaseapp.com",
    databaseURL: "https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "jupidu-36804",
    storageBucket: "jupidu-36804.firebasestorage.app",
    messagingSenderId: "11390726952",
    appId: "1:11390726952:web:aba2f101b6c5ca2bc5561d"
  };
  var RTDB_URL = FIREBASE_CONFIG.databaseURL;
  var DESKTOP_ORIGIN = "https://management-xo2-pro.netlify.app";
  var DEVICE_ID_KEY = "quantus-device-id-v3";
  var DEVICE_NAME_KEY = "quantus-device-name-v3";
  var SEEN_KEY = "quantus-device-command-seen-v3";
  var PENDING_KEY = "quantus-device-pending-context-v3";
  var HEARTBEAT_MS = 20000;
  var PRESENCE_TTL_MS = 90000;
  var COMMAND_TTL_MS = 5 * 60 * 1000;
  var SDK_URLS = [
    "https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js",
    "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth-compat.js",
    "https://www.gstatic.com/firebasejs/10.12.5/firebase-database-compat.js"
  ];

  var readyResolve;
  var state = {
    status: "booting",
    error: null,
    user: null,
    app: null,
    auth: null,
    db: null,
    device: null,
    context: null,
    devices: {},
    deviceRef: null,
    devicesRef: null,
    commandsRef: null,
    heartbeat: null,
    firebaseListeners: [],
    ready: new Promise(function (resolve) { readyResolve = resolve; })
  };

  function emit(name, detail) {
    try { global.document.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (_) {}
  }

  function text(value, max) {
    return String(value == null ? "" : value)
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ").trim().slice(0, max || 300);
  }

  function randomId(prefix) {
    try {
      if (global.crypto && typeof global.crypto.randomUUID === "function") return (prefix || "id") + "_" + global.crypto.randomUUID();
      if (global.crypto && typeof global.crypto.getRandomValues === "function") {
        var bytes = new Uint8Array(12); global.crypto.getRandomValues(bytes);
        return (prefix || "id") + "_" + Array.prototype.map.call(bytes, function (n) { return n.toString(16).padStart(2, "0"); }).join("");
      }
    } catch (_) {}
    return (prefix || "id") + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function localGet(key, fallback) {
    try {
      var raw = global.localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (_) { return fallback; }
  }

  function localSet(key, value) {
    try { global.localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  }

  function sessionSet(key, value) {
    try { global.sessionStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  }

  function detectKind() {
    var ua = String(global.navigator && global.navigator.userAgent || "");
    var width = Math.max(global.innerWidth || 0, global.screen && global.screen.width || 0);
    if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua)) || (width >= 700 && width <= 1450 && (global.navigator.maxTouchPoints || 0) > 1)) return "tablet";
    if (/Mobi|iPhone|Android/i.test(ua) || width < 700) return "phone";
    return "laptop";
  }

  function defaultDeviceName(kind) {
    var platform = String(global.navigator && (global.navigator.userAgentData && global.navigator.userAgentData.platform || global.navigator.platform) || "");
    if (kind === "tablet") return /iPad|Mac/i.test(platform) ? "iPad" : "Tablet";
    if (kind === "phone") return /iPhone|Mac/i.test(platform) ? "iPhone" : "Handy";
    if (/Win/i.test(platform)) return "Windows-Laptop";
    if (/Mac/i.test(platform)) return "MacBook";
    return "Laptop";
  }

  function loadDevice() {
    var kind = detectKind();
    var id = localGet(DEVICE_ID_KEY, "");
    if (!id || typeof id !== "string") { id = randomId("device"); localSet(DEVICE_ID_KEY, id); }
    var name = localGet(DEVICE_NAME_KEY, "");
    if (!name || typeof name !== "string") { name = defaultDeviceName(kind); localSet(DEVICE_NAME_KEY, name); }
    return {
      id: text(id, 120),
      name: text(name, 60),
      kind: kind,
      platform: text(global.navigator && (global.navigator.userAgentData && global.navigator.userAgentData.platform || global.navigator.platform) || "", 80)
    };
  }

  function isAllowedUrl(value) {
    try {
      var url = new URL(String(value || ""), global.location.href);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return false;
      if (url.origin === global.location.origin || url.origin === DESKTOP_ORIGIN) return true;
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;
      return url.hostname.endsWith(".netlify.app") && /(quantus|tablet|management)/i.test(url.hostname);
    } catch (_) { return false; }
  }

  function safeUrl(value) {
    if (!isAllowedUrl(value)) return "";
    try { return new URL(String(value), global.location.href).href; } catch (_) { return ""; }
  }

  function routeParts() {
    var raw = String(global.location.hash || "").replace(/^#\/?/, "").split("?")[0];
    return raw.split("/").filter(Boolean).map(function (part) {
      try { return decodeURIComponent(part); } catch (_) { return part; }
    });
  }

  function inferEntity(route) {
    var doc = global.document;
    if (!doc || !doc.querySelectorAll) return null;
    var selector = [
      "[data-project-id]", "[data-task-id]", "[data-entity-id]",
      "[data-collection][data-id]", "[data-action='edit-entity'][data-id]",
      "[data-action*='project'][data-id]", "[data-action*='task'][data-id]"
    ].join(",");
    var candidates = Array.prototype.slice.call(doc.querySelectorAll(selector));
    var active = doc.activeElement && doc.activeElement.closest && doc.activeElement.closest(selector);
    if (active) candidates.unshift(active);
    for (var i = 0; i < candidates.length; i += 1) {
      var node = candidates[i];
      if (!node || node.closest && node.closest("#quantusDeviceUi")) continue;
      var ds = node.dataset || {};
      var collection = text(ds.collection || "", 80);
      var id = text(ds.projectId || ds.taskId || ds.entityId || ds.id || "", 160);
      var action = text(ds.action || "", 80).toLowerCase();
      if (!id) continue;
      if (ds.projectId || /project/.test(action)) collection = collection || "projects";
      if (ds.taskId || /task/.test(action)) collection = collection || "tasks";
      collection = collection || route || "items";
      var titleNode = node.querySelector && node.querySelector(".item-title,.project-title,h1,h2,h3,strong");
      var title = text(ds.title || node.getAttribute("aria-label") || titleNode && titleNode.textContent || global.document.title || "Quantus Eintrag", 160);
      return { kind: "entity", route: route || collection, collection: collection, entityId: id, title: title };
    }
    return null;
  }

  function normalizeContext(input) {
    input = input && typeof input === "object" ? input : {};
    var url = safeUrl(input.url || global.location.href) || DESKTOP_ORIGIN + "/";
    return {
      kind: text(input.kind || "route", 30) || "route",
      route: text(input.route || "home", 80) || "home",
      collection: text(input.collection || "", 80),
      entityId: text(input.entityId || "", 160),
      title: text(input.title || global.document && global.document.title || "Quantus", 160) || "Quantus",
      url: url,
      sourceOrigin: text(input.sourceOrigin || global.location.origin, 180),
      updatedAt: Number(input.updatedAt) || Date.now()
    };
  }

  function contextFromLocation() {
    if (state.context && state.context.locked) return normalizeContext(state.context);
    var parts = routeParts();
    var path = global.location.pathname || "/";
    var route = parts[0] || "home";
    var entityId = parts[1] || "";
    var kind = "route";
    var title = text(global.document && global.document.title || "Quantus", 160);
    var url = global.location.href;
    if (/\/bm\.html$/i.test(path)) { kind = "bm"; route = "bm"; title = "BM Vorbereitung"; }
    else if (/\/career-model\.html$/i.test(path)) { kind = "career"; route = "career"; title = "Career Model"; }
    var inferred = inferEntity(route);
    if (inferred) return normalizeContext(Object.assign(inferred, { url: DESKTOP_ORIGIN + "/#/" + encodeURIComponent(inferred.route) + "/" + encodeURIComponent(inferred.entityId) }));
    return normalizeContext({ kind: kind, route: route, entityId: entityId, title: title, url: url, sourceOrigin: global.location.origin });
  }

  function publicDevice(value, key) {
    value = value && typeof value === "object" ? value : {};
    var updatedAt = Number(value.updatedAt) || 0;
    return {
      id: text(value.deviceId || value.id || key || "", 120),
      name: text(value.name || "Gerät", 60),
      kind: text(value.kind || "laptop", 20),
      platform: text(value.platform || "", 80),
      online: value.online !== false,
      active: value.online !== false && (!updatedAt || Date.now() - updatedAt <= PRESENCE_TTL_MS),
      updatedAt: updatedAt,
      currentContext: value.currentContext ? normalizeContext(value.currentContext) : null
    };
  }

  function serverTimestamp() {
    try { return global.firebase.database.ServerValue.TIMESTAMP; } catch (_) { return Date.now(); }
  }

  function presencePayload() {
    return {
      deviceId: state.device.id,
      name: state.device.name,
      kind: state.device.kind,
      platform: state.device.platform,
      online: true,
      currentContext: normalizeContext(state.context || contextFromLocation()),
      updatedAt: serverTimestamp()
    };
  }

  function writePresence() {
    if (!state.deviceRef) return Promise.resolve(false);
    return state.deviceRef.update(presencePayload()).then(function () { return true; }).catch(function () { return false; });
  }

  function detach() {
    state.firebaseListeners.forEach(function (entry) { try { entry.ref.off(entry.event, entry.handler); } catch (_) {} });
    state.firebaseListeners = [];
    if (state.heartbeat) clearInterval(state.heartbeat);
    state.heartbeat = null;
    state.deviceRef = null;
    state.devicesRef = null;
    state.commandsRef = null;
    state.devices = {};
  }

  function listen(ref, event, handler, errorHandler) {
    ref.on(event, handler, errorHandler);
    state.firebaseListeners.push({ ref: ref, event: event, handler: handler });
  }

  function seenMap() {
    var map = localGet(SEEN_KEY, {});
    var now = Date.now();
    Object.keys(map || {}).forEach(function (key) { if (now - Number(map[key] || 0) > 86400000) delete map[key]; });
    return map || {};
  }

  function markSeen(id) {
    var map = seenMap(); map[id] = Date.now(); localSet(SEEN_KEY, map);
  }

  function mapContextForThisDevice(context) {
    context = normalizeContext(context);
    var tablet = Boolean(global.__quantusTablet) || /tablet/i.test(global.location.hostname);
    if (!tablet || context.kind === "career" || context.kind === "bm") return context;
    var route = context.route || context.collection || "home";
    var target = new URL(global.location.href);
    target.hash = "#/" + encodeURIComponent(route);
    context.url = target.href;
    return context;
  }

  function openContext(context) {
    var mapped = mapContextForThisDevice(context);
    localSet(PENDING_KEY, mapped);
    sessionSet(PENDING_KEY, mapped);
    emit("quantus:open-context", { context: mapped });
    try {
      var target = new URL(mapped.url, global.location.href);
      if (target.href !== global.location.href) global.location.assign(target.href);
      else if (mapped.route) global.location.hash = "#/" + encodeURIComponent(mapped.route);
    } catch (_) {}
  }

  function receiveCommand(snapshot) {
    var command = snapshot && snapshot.val && snapshot.val();
    if (!command || command.type !== "open") { try { snapshot.ref.remove(); } catch (_) {} return; }
    var id = text(command.id || snapshot.key, 160);
    if (!id || seenMap()[id] || Number(command.expiresAt || 0) < Date.now() || !command.context || !isAllowedUrl(command.context.url)) {
      try { snapshot.ref.remove(); } catch (_) {}
      return;
    }
    markSeen(id);
    command.id = id;
    command.context = normalizeContext(command.context);
    try { snapshot.ref.update({ receivedAt: serverTimestamp(), receivedBy: state.device.id }); } catch (_) {}
    var detail = { command: command, context: command.context, handled: false };
    emit("quantus:command", detail);
    setTimeout(function () { if (!detail.handled) openContext(command.context); }, 80);
    setTimeout(function () { try { snapshot.ref.remove(); } catch (_) {} }, 1500);
  }

  function attachUser(user) {
    detach();
    state.user = user || null;
    if (!user || user.isAnonymous) {
      state.status = "signed-out";
      emit("quantus:device-state", { state: state });
      return;
    }
    state.status = "connecting";
    var base = state.db.ref("quantusRealtime/workspaces/" + user.uid);
    state.deviceRef = base.child("devices/" + state.device.id);
    state.devicesRef = base.child("devices");
    state.commandsRef = base.child("commands/" + state.device.id);
    try { state.deviceRef.onDisconnect().update({ online: false, updatedAt: serverTimestamp() }); } catch (_) {}
    listen(state.devicesRef, "value", function (snapshot) {
      var raw = snapshot.val() || {}; var next = {};
      Object.keys(raw).forEach(function (key) { var item = publicDevice(raw[key], key); if (item.id) next[item.id] = item; });
      state.devices = next;
      state.status = "ready";
      emit("quantus:devices", { devices: api.listDevices(), currentDevice: state.device });
    }, function (error) { state.error = error; state.status = "error"; emit("quantus:device-error", { error: error }); });
    listen(state.commandsRef, "child_added", receiveCommand, function (error) { state.error = error; emit("quantus:device-error", { error: error }); });
    writePresence();
    state.heartbeat = setInterval(writePresence, HEARTBEAT_MS);
    emit("quantus:device-state", { state: state });
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var existing = global.document.querySelector('script[src="' + src + '"]');
      if (existing) {
        if (existing.dataset.quantusLoaded === "1") return resolve();
        existing.addEventListener("load", resolve, { once: true }); existing.addEventListener("error", reject, { once: true }); return;
      }
      var script = global.document.createElement("script"); script.src = src; script.async = false; script.crossOrigin = "anonymous";
      script.addEventListener("load", function () { script.dataset.quantusLoaded = "1"; resolve(); }, { once: true });
      script.addEventListener("error", function () { reject(new Error("Firebase SDK konnte nicht geladen werden.")); }, { once: true });
      (global.document.head || global.document.documentElement).appendChild(script);
    });
  }

  function ensureFirebase() {
    if (global.firebase && global.firebase.initializeApp && global.firebase.auth && global.firebase.database) return Promise.resolve();
    return new Promise(function (resolve) {
      var attempts = 0; var timer = setInterval(function () {
        attempts += 1;
        if (global.firebase && global.firebase.initializeApp && global.firebase.auth && global.firebase.database) { clearInterval(timer); resolve(true); }
        else if (attempts >= 20) { clearInterval(timer); resolve(false); }
      }, 75);
    }).then(function (found) {
      if (found) return;
      return SDK_URLS.reduce(function (chain, src) {
        return chain.then(function () {
          if (/firebase-app/.test(src) && global.firebase && global.firebase.initializeApp) return;
          if (/firebase-auth/.test(src) && global.firebase && global.firebase.auth) return;
          if (/firebase-database/.test(src) && global.firebase && global.firebase.database) return;
          return loadScript(src);
        });
      }, Promise.resolve());
    });
  }

  function setContext(context) {
    state.context = normalizeContext(Object.assign({}, context || {}, { updatedAt: Date.now() }));
    writePresence();
    emit("quantus:context", { context: state.context });
    return state.context;
  }

  function listDevices(options) {
    options = options || {};
    return Object.keys(state.devices).map(function (key) { return state.devices[key]; })
      .filter(function (device) { return options.includeCurrent || device.id !== state.device.id; })
      .filter(function (device) { return options.includeOffline || device.active; })
      .sort(function (a, b) { return Number(b.active) - Number(a.active) || b.updatedAt - a.updatedAt || a.name.localeCompare(b.name, "de"); });
  }

  function sendToDevice(targetDeviceId, context) {
    return state.ready.then(function () {
      if (!state.user || state.user.isAnonymous || !state.db) throw new Error("Für Geräteübergaben mit demselben Quantus-Konto anmelden.");
      var target = text(targetDeviceId, 120);
      if (!target || target === state.device.id) throw new Error("Ungültiges Zielgerät.");
      var ctx = normalizeContext(context || state.context || contextFromLocation());
      var id = randomId("command");
      var command = {
        id: id,
        type: "open",
        context: ctx,
        fromDeviceId: state.device.id,
        fromDeviceName: state.device.name,
        targetDeviceId: target,
        createdAt: Date.now(),
        expiresAt: Date.now() + COMMAND_TTL_MS
      };
      return state.db.ref("quantusRealtime/workspaces/" + state.user.uid + "/commands/" + target + "/" + id).set(command).then(function () {
        emit("quantus:command-sent", { command: command }); return command;
      });
    });
  }

  function renameDevice(name) {
    var clean = text(name, 60);
    if (!clean) return Promise.reject(new Error("Gerätename darf nicht leer sein."));
    state.device.name = clean; localSet(DEVICE_NAME_KEY, clean);
    return writePresence().then(function () { emit("quantus:device-renamed", { device: state.device }); return state.device; });
  }

  var api = {
    state: state,
    ready: state.ready,
    setContext: setContext,
    getContext: function () { return normalizeContext(state.context || contextFromLocation()); },
    listDevices: listDevices,
    sendToDevice: sendToDevice,
    sendCurrentTo: function (targetDeviceId) { return sendToDevice(targetDeviceId, api.getContext()); },
    renameDevice: renameDevice,
    writePresence: writePresence,
    openContext: openContext,
    pendingKey: PENDING_KEY
  };
  global.QuantusDeviceSync = api;
  state.device = loadDevice();
  state.context = contextFromLocation();

  if (global.QuantusBundleLoader && !global.QuantusBundleLoader.jobs["quantus-device-sync"]) {
    global.QuantusBundleLoader.jobs["quantus-device-sync"] = Promise.resolve(true);
  }
  emit("quantus:bundle-ready", { name: "quantus-device-sync" });

  ensureFirebase().then(function () {
    state.app = global.firebase.apps.length ? global.firebase.app() : global.firebase.initializeApp(FIREBASE_CONFIG);
    state.auth = state.app.auth(); state.db = state.app.database(RTDB_URL);
    try { state.auth.setPersistence(global.firebase.auth.Auth.Persistence.LOCAL).catch(function () {}); } catch (_) {}
    state.auth.onAuthStateChanged(attachUser, function (error) { state.error = error; state.status = "error"; emit("quantus:device-error", { error: error }); });
    readyResolve(api);
  }).catch(function (error) {
    state.error = error; state.status = "error"; readyResolve(api); emit("quantus:device-error", { error: error });
  });

  global.addEventListener("hashchange", function () { if (!state.context || !state.context.locked) setContext(contextFromLocation()); });
  global.addEventListener("popstate", function () { if (!state.context || !state.context.locked) setContext(contextFromLocation()); });
  global.addEventListener("pagehide", function () { if (state.deviceRef) state.deviceRef.update({ online: false, updatedAt: serverTimestamp() }).catch(function () {}); });
})(typeof window !== "undefined" ? window : null);
