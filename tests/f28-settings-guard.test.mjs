/*
 * F-28 — der Kernschluessel wird sicher gelesen, auch im Startfenster.
 *
 * BEFUND (live, S3b): remoteGet() las APP.state.settings.storage.blobKey ohne
 * Absicherung:
 *
 *     async function remoteGet(options = {}) {
 *       return remoteGetByKey(APP.state.settings.storage.blobKey, { … });
 *     }
 *
 * APP.state.settings ist aber der ANFANGSWERT null; erst der Bootlauf setzt
 * loadSettings(). Der Firebase-Auth-Listener steht weit frueher in der Datei.
 * Kommt die Anmeldung herein, bevor der Bootlauf so weit ist, wirft die Kette
 * genau die Meldung aus dem Livelauf:
 *
 *     TypeError: Cannot read properties of null (reading 'storage')
 *
 * Der Wortlaut nennt das nullende Glied: "reading 'storage'" heisst
 * settings === null. Bei storage === null hiesse es "reading 'blobKey'".
 *
 * resyncAfterAuth fing den Wurf zwar ab, aber der nachgeholte Kern-Abgleich
 * fand nicht statt — und weil markCoreReadOk UNTERHALB des Wurfs steht, blieb
 * _coreReadOk fuer die ganze Sitzung false und der automatische Push gesperrt.
 *
 * Dasselbe Muster im 5-Sekunden-Netz: es las APP.state.settings.storage.autoSave
 * ebenso ungesichert — dort still, weil ein setInterval seine Ausnahme
 * niemandem zeigt.
 *
 * Der Fix ist EIN Helfer statt dreizehn Fragezeichen: coreBlobKey() liefert den
 * konfigurierten Schluessel oder faellt auf CORE_BLOB_KEY zurueck — denselben
 * Wert, den canonicalWrite ohnehin als Rueckfall benutzte. Solange settings da
 * ist, aendert sich am Verhalten nichts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

let checks = 0;
const luecken = [];
const ok = (b, t) => { checks++; if (!b) luecken.push(t); };
const ohneKommentare = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

// ═══ 1. Die ECHTEN Helfer gegen einen fehlenden settings-Zweig ═════════
function lade(APP) {
  const a = index.indexOf("function coreBlobKey() {");
  ok(a > 0, "coreBlobKey wurde nicht gefunden — es gibt keinen sicheren Weg zum Kernschluessel");
  if (a < 0) return null;
  const b = index.indexOf("function autoSaveAn() {");
  ok(b > 0, "autoSaveAn wurde nicht gefunden — das 5-Sekunden-Netz liest weiterhin ungesichert");
  if (b < 0) return null;
  const src = index.slice(a, index.indexOf("\n}\n", a) + 3) +
    index.slice(b, index.indexOf("\n}\n", b) + 3) +
    "\nreturn { coreBlobKey, autoSaveAn };";
  return new Function("APP", "CORE_BLOB_KEY", "window", src)(APP, "app-data.json", {});
}

// Genau die Lage aus dem Livelauf: settings ist noch null.
{
  const api = lade({ state: { settings: null, data: null } });
  if (api) {
    ok(api.coreBlobKey() === "app-data.json",
      `DER BEFUND: bei settings === null liefert coreBlobKey "${api.coreBlobKey()}" statt des Rueckfalls`);
    ok(api.autoSaveAn() === true, "bei settings === null meldet autoSaveAn nicht den Vorgabewert");
  }
}
// Und die weiteren Loecher derselben Kette.
for (const [name, APP] of [
  ["state fehlt", { }],
  ["state === null", { state: null }],
  ["storage === null", { state: { settings: { storage: null } } }],
  ["blobKey fehlt", { state: { settings: { storage: {} } } }],
  ["blobKey ist leer", { state: { settings: { storage: { blobKey: "" } } } }],
  ["blobKey ist keine Zeichenkette", { state: { settings: { storage: { blobKey: 42 } } } }],
]) {
  const api = lade(APP);
  if (!api) break;
  let wert = null, geworfen = null;
  try { wert = api.coreBlobKey(); } catch (e) { geworfen = e; }
  ok(!geworfen, `${name}: coreBlobKey wirft (${geworfen && geworfen.message})`);
  ok(wert === "app-data.json", `${name}: coreBlobKey liefert ${JSON.stringify(wert)} statt des Rueckfalls`);
}
// Ist ein Schluessel konfiguriert, gilt ER — der Helfer darf ihn nicht ersetzen.
{
  const api = lade({ state: { settings: { storage: { blobKey: "eigener-kern.json" } } } });
  if (api) {
    ok(api.coreBlobKey() === "eigener-kern.json",
      `ein konfigurierter Schluessel wird ueberschrieben ("${api.coreBlobKey()}")`);
  }
}
// autoSaveAn: nur ein ausdrueckliches false schaltet ab.
for (const [wert, erwartet] of [[true, true], [undefined, true], [false, false]]) {
  const api = lade({ state: { settings: { storage: { autoSave: wert } } } });
  if (!api) break;
  ok(api.autoSaveAn() === erwartet,
    `autoSave=${JSON.stringify(wert)}: autoSaveAn meldet ${api.autoSaveAn()} statt ${erwartet}`);
}

// ═══ 2. Der Helfer ruft sich nicht selbst auf ══════════════════════════
// Eine pauschale Ersetzung haette genau das erzeugt: coreBlobKey liest den
// Zweig, den es ersetzen sollte — und liefe endlos.
{
  const a = index.indexOf("function coreBlobKey() {");
  const koerper = index.slice(a, index.indexOf("\n}\n", a));
  ok(!/coreBlobKey\(\)/.test(koerper.slice(koerper.indexOf("{"))),
    "coreBlobKey ruft sich selbst auf — der Aufruf liefe endlos");
  ok(/APP\.state\.settings\.storage\.blobKey/.test(koerper),
    "coreBlobKey liest den konfigurierten Schluessel gar nicht mehr");
}

// ═══ 3. KEINE ungesicherte Lesestelle mehr ═════════════════════════════
{
  const k = ohneKommentare(index);
  // Erlaubt bleiben: Zuweisungen (sie SETZEN den Wert) und die Pruefung, die
  // eine Zuweisung auf derselben Zeile bewacht — die laeuft im Bootlauf, wo
  // settings gerade angelegt wurde. Gezaehlt werden nur die echten Lesestellen.
  const lesend = k.split("\n").filter((zeile) => {
    if (!/APP\.state\.settings\.storage\.blobKey/.test(zeile)) return false;
    if (/APP\.state\.settings\.storage\.blobKey\s*=[^=]/.test(zeile)) return false;   // Zuweisung
    return true;
  });
  ok(lesend.length === 1,
    `${lesend.length} ungesicherte Lesestellen von …storage.blobKey statt genau einer (der im Helfer selbst): ` +
    lesend.map((z) => z.trim().slice(0, 60)).join(" | "));
  const auto = [...k.matchAll(/APP\.state\.settings\.storage\.autoSave(?!\s*=[^=])/g)];
  ok(auto.length <= 2,
    `${auto.length} ungesicherte Lesestellen von …storage.autoSave — der Speicherpfad muss ueber autoSaveAn gehen`);

  // Die beiden Stellen, die den Wert SETZEN, bleiben unangetastet.
  ok(/if \(!APP\.state\.settings\.storage\.blobKey\) APP\.state\.settings\.storage\.blobKey = "app-data\.json";/.test(k),
    "die Erstbelegung des Schluessels ging verloren");
  ok(/APP\.state\.settings\.storage\.blobKey = CORE_BLOB_KEY;/.test(k),
    "das Festschreiben des Kernschluessels beim Speichern ging verloren");
}

// ═══ 4. remoteGet und das 5-Sekunden-Netz gehen ueber die Helfer ═══════
{
  const a = index.indexOf("async function remoteGet(options = {}) {");
  ok(a > 0, "remoteGet wurde nicht gefunden");
  const koerper = ohneKommentare(index.slice(a, index.indexOf("\n}\n", a)));
  ok(/coreBlobKey\(\)/.test(koerper),
    "DER BEFUND: remoteGet liest den Schluessel weiterhin ungesichert — es wirft im Startfenster");
  ok(!/APP\.state\.settings\.storage\.blobKey/.test(koerper), "remoteGet greift weiterhin direkt zu");

  const netz = ohneKommentare(index.slice(index.indexOf("// Safety net: check every 5s if dirty")));
  ok(/_saveDirty && autoSaveAn\(\)/.test(netz.slice(0, 600)),
    "das 5-Sekunden-Netz liest autoSave weiterhin direkt — es wirft dort still");
}

// ═══ 5. Der Schreibvertrag bleibt, wie er war ══════════════════════════
// F-28 ist ein Lesefehler. Nichts am Trichter, an der Anbieterreihe oder am
// CAS-Beweis darf sich dabei verschoben haben.
for (const anker of [
  "async function canonicalWrite(quelle, options = {})",
  "const CORE_PROVIDER_ORDER = ['rtdb', 'netlify'];",
  "reason: 'missing_if_match'",
  "function coreWriteGuard(fnName, key, options)",
  "if (!forceRemote && !_coreReadOk) {",
  "markCoreReadOk();",
]) {
  ok(index.includes(anker), `der Schreibvertrag wurde beruehrt: "${anker}" fehlt`);
}

if (luecken.length) {
  console.error("F-28 SETTINGS GUARD — " + luecken.length + " von " + checks + " Pruefungen:");
  luecken.forEach((l) => console.error("   - " + l));
  process.exit(1);
}
console.log(`f28 settings guard: ok (${checks} Pruefungen)`);
