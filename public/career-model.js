(function (global) {
  "use strict";
  if (!global || !global.QuantusBundleLoader) throw new Error("Quantus Bundle Loader fehlt.");
  global.QuantusBundleLoader.load("career-model-app", ["/quantus-bundles/career-app.01.txt", "/quantus-bundles/career-app.02.txt", "/quantus-bundles/career-app.03.txt", "/quantus-bundles/career-app.04.txt", "/quantus-bundles/career-app.05.txt"], ["career-model-core", "quantus-device-sync", "quantus-universal-ui"]);
})(typeof window !== "undefined" ? window : null);
