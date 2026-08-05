(function (global) {
  "use strict";
  if (!global || global.QuantusBundleLoader) return;
  var jobs = {};
  function emit(name, detail) {
    try { global.document.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (_) {}
  }
  function loadText(url) {
    return fetch(url, { credentials: "same-origin", cache: "no-cache" }).then(function (response) {
      if (!response.ok) throw new Error("Bundle-Teil konnte nicht geladen werden: " + url + " (" + response.status + ")");
      return response.text();
    });
  }
  function execute(name, source) {
    var script = global.document.createElement("script");
    script.dataset.quantusBundle = name;
    script.textContent = source + "\n//# sourceURL=quantus-bundle://" + name + ".js";
    (global.document.head || global.document.documentElement).appendChild(script);
    script.remove();
  }
  function load(name, parts, dependencies) {
    if (jobs[name]) return jobs[name];
    var deps = (dependencies || []).map(function (dependency) {
      return jobs[dependency] || Promise.reject(new Error("Bundle-Abhängigkeit wurde nicht registriert: " + dependency));
    });
    jobs[name] = Promise.all(deps).then(function () { return Promise.all(parts.map(loadText)); })
      .then(function (sources) {
        execute(name, sources.join(""));
        emit("quantus:bundle-ready", { name: name });
        return true;
      }).catch(function (error) {
        console.error("[QuantusBundleLoader]", name, error);
        emit("quantus:bundle-error", { name: name, error: error });
        throw error;
      });
    return jobs[name];
  }
  global.QuantusBundleLoader = { load: load, jobs: jobs };
})(typeof window !== "undefined" ? window : null);
