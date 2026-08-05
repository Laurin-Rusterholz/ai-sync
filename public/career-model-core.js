(function (global) {
  "use strict";
  if (!global || !global.QuantusBundleLoader) throw new Error("Quantus Bundle Loader fehlt.");
  global.QuantusBundleLoader.load("career-model-core", ["/quantus-bundles/career-core.01.txt", "/quantus-bundles/career-core.02.txt", "/quantus-bundles/career-core.03.txt"], []);
})(typeof window !== "undefined" ? window : null);
