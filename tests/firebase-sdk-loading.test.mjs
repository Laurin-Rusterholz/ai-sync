/*
 * Regression: "⚠️ Firebase nicht geladen".
 *
 * Das SDK wurde ausschliesslich von gstatic.com geladen. Blockt ein Adblocker,
 * ein Privacy-Filter oder ein Firmen-Proxy diesen Pfad, ist window.firebase
 * undefined — und weil primaryCloudProvider() den App-Datensatz in der Firebase
 * RTDB bzw. Firebase Storage haelt, laedt und speichert die App dann gar nichts
 * mehr in der Cloud: Sticky Boards, Anhaenge und Sync bleiben leer.
 *
 * Diese Tests halten die Gegenmassnahmen fest:
 *   1. Das SDK liegt vendored im eigenen Origin und wird von dort geladen.
 *   2. gstatic/jsdelivr sind nur noch Fallback, nicht mehr einzige Quelle.
 *   3. Die Initialisierung ist wiederholbar, damit ein spaet eintreffendes SDK
 *      noch verbunden wird (initFirebaseNow) und der Cloud-Stand nachgeholt wird.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// ── 1. Die vendorten Bundles sind da und sind echte UMD-Browser-Builds ───────
const VENDORED = {
  "public/vendor/cloud-sdk/app.js": 20000,
  "public/vendor/cloud-sdk/auth.js": 80000,
  "public/vendor/cloud-sdk/storage.js": 20000,
  "public/vendor/cloud-sdk/db.js": 80000,
};
for (const [file, minBytes] of Object.entries(VENDORED)) {
  assert.ok(fs.existsSync(path.join(root, file)), `${file} fehlt — ohne die vendorten Dateien ist die Seite wieder auf gstatic angewiesen`);
  const src = read(file);
  assert.ok(src.length > minBytes, `${file} ist unerwartet klein (${src.length} B) — vermutlich kein vollstaendiges Bundle`);
  new vm.Script(src, { filename: file });          // muss parsebar sein
  assert.doesNotMatch(src, /sourceMappingURL/, `${file} verweist auf eine .map-Datei, die nicht mit ausgeliefert wird (404 in der Konsole)`);
}
// app.js muss globalThis.firebase setzen, die Module haengen sich daran.
assert.match(read("public/vendor/cloud-sdk/app.js"), /\.firebase\s*=/, "app.js exportiert kein globales firebase");

// ── 2. Die Seiten laden das SDK aus dem eigenen Origin ───────────────────────
const PAGES = {
  "public/index.html": ["app.js", "auth.js", "storage.js", "db.js"],
  "public/drive.html": ["app.js", "auth.js", "storage.js", "db.js"],
  "public/docstudio.html": ["app.js", "auth.js", "storage.js"],
  "public/nobraine.html": ["app.js", "auth.js", "db.js"],
};
for (const [page, mods] of Object.entries(PAGES)) {
  const html = read(page);
  for (const mod of mods) {
    assert.ok(
      html.includes(`<script src="vendor/cloud-sdk/${mod}"></script>`),
      `${page} laedt vendor/cloud-sdk/${mod} nicht`,
    );
  }
  // Kein <script src="https://…gstatic…"> mehr als Ladeweg (URLs im
  // Fallback-Lader sind Strings in einem Array, keine Script-Tags).
  assert.doesNotMatch(
    html,
    /<script src="https:\/\/www\.gstatic\.com\/firebasejs\//,
    `${page} haengt noch mit einem harten Script-Tag an gstatic`,
  );
}

// ── 3. Fallback + wiederholbare Initialisierung in index.html ────────────────
const index = read("public/index.html");
assert.match(index, /cdn\.jsdelivr\.net\/npm\/firebase@10\.8\.0\/firebase-app-compat\.js/, "kein zweiter Fallback-CDN hinterlegt");
assert.match(index, /function initFirebaseNow\s*\(/, "initFirebaseNow() fehlt — das SDK koennte nicht mehr nachtraeglich verbunden werden");
assert.match(index, /window\.initFirebaseNow = initFirebaseNow/, "initFirebaseNow() ist nicht global erreichbar");
assert.match(index, /window\.initFirebaseNow && window\.initFirebaseNow\(\)/, "der Fallback-Lader ruft initFirebaseNow() nicht auf");
// Idempotenz: ein zweiter initializeApp() wuerde "app/duplicate-app" werfen.
assert.match(index, /firebase\.apps && firebase\.apps\.length/, "initFirebaseNow() prueft nicht auf eine bereits initialisierte App");
// Nach spaetem Verbinden muss der Cloud-Stand nachgeholt werden.
assert.match(index, /function onFirebaseReady\s*\(/, "onFirebaseReady() fehlt");
assert.match(index, /syncFreshness\('firebase-ready'\)/, "nach dem Verbinden wird der Cloud-Stand nicht nachgeholt");
assert.match(index, /window\.firebaseStorage = firebaseStorage/, "window.firebaseStorage wird nicht (neu) gesetzt");

// Die alte, irrefuehrende Empfehlung ("Auf Netlify deployen") ist raus — die
// App laeuft bereits auf Netlify, wenn der Hinweis erscheint.
assert.doesNotMatch(index, /auf Netlify deployen/i, "irrefuehrender Hinweistext ist noch vorhanden");

console.log("firebase sdk loading: ok");
