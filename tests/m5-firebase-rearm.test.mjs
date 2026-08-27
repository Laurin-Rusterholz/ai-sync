/*
 * M5 — der Kaltstart-Riegel in Smarter und Leseplan.
 *
 * BEFUND: rtdbDbRef() liefert null, solange das Firebase-SDK noch nicht geladen
 * ist — ein Startfenster von Sekundenbruchteilen, kein Ausfall. smarterLoad()
 * und leseplanLoad() werteten dieses null aber als "offline" und markierten
 * sich SOFORT als frisch geladen:
 *
 *     if (!db) { X.noFirebase = true; X.loaded = true; X.loadedAt = Date.now(); … }
 *
 * Danach griff nur noch die 60-Sekunden-Frischepruefung der eigenen Ansicht —
 * und die auch nur, wenn diese Ansicht ueberhaupt neu rendert. Der
 * Offline-Hinweis blieb also mindestens eine Minute stehen, obwohl Firebase
 * laengst bereit war. Auf dem Telefon ist genau das als "offline" aufgefallen.
 *
 * Der Fix verkuerzt die Frist NICHT (das wuerde bei echtem Ausfall im Kreis
 * rendern), sondern wartet auf das Ereignis: wennFirebaseBereit() prueft kurz
 * getaktet und ruft dann GENAU EINMAL zurueck.
 *
 * Geprueft wird die ECHTE Funktion gegen eine steuerbare Uhr und einen
 * steuerbaren rtdbDbRef.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

let checks = 0;
const luecken = [];
const ok = (b, t) => { checks++; if (!b) luecken.push(t); };

// ═══ Die echte Funktion mit steuerbarer Uhr und Taktgeber ═══════════════
function harness({ refAb = Infinity } = {}) {
  const a = index.indexOf("function wennFirebaseBereit(kennung, fn, maxMs) {");
  ok(a > 0, "wennFirebaseBereit wurde nicht gefunden — es gibt keinen Nachzieher");
  if (a < 0) return null;
  const src = index.slice(a, index.indexOf("\nwindow.wennFirebaseBereit", a));

  let jetzt = 0;
  let takte = 0;
  const timer = new Map();
  let naechsteId = 1;
  const waechter = {};
  const protokoll = { refAufrufe: 0 };

  const fn = new Function("rtdbDbRef", "_firebaseBereitWaechter", "Date", "setInterval",
    "clearInterval", "console", src + "\nreturn wennFirebaseBereit;")(
    () => { protokoll.refAufrufe++; return takte >= refAb ? { ref: true } : null; },
    waechter,
    { now: () => jetzt },
    (cb, ms) => { const id = naechsteId++; timer.set(id, { cb, ms }); return id; },
    (id) => timer.delete(id),
    { warn() {}, log() {} });

  // Einen Takt weiterdrehen: Zeit vor, alle laufenden Timer einmal feuern.
  const takt = () => {
    takte++;
    jetzt += 400;
    for (const [, t] of [...timer]) t.cb();
  };
  return { fn, takt, timerZahl: () => timer.size, waechter, protokoll,
    setzeZeit: (ms) => { jetzt = ms; } };
}

// ── 1. Firebase ist schon da: sofort, ohne Timer ───────────────────────
{
  const h = harness({ refAb: 0 });
  if (h) {
    let gerufen = 0;
    h.fn("smarter", () => { gerufen++; });
    ok(gerufen === 1, `bei bereitem Firebase lief der Rueckruf ${gerufen}x statt sofort einmal`);
    ok(h.timerZahl() === 0, "es wurde ein Taktgeber gestartet, obwohl Firebase bereit war");
  }
}

// ── 2. Firebase kommt nach: GENAU EINMAL, dann ist der Waechter weg ────
{
  const h = harness({ refAb: 3 });
  if (h) {
    let gerufen = 0;
    h.fn("smarter", () => { gerufen++; });
    ok(h.timerZahl() === 1, `es laufen ${h.timerZahl()} Taktgeber statt einem`);
    h.takt(); ok(gerufen === 0, "der Rueckruf lief, bevor Firebase da war");
    h.takt(); ok(gerufen === 0, "der Rueckruf lief zu frueh");
    h.takt();
    ok(gerufen === 1, `nach dem Bereitwerden lief der Rueckruf ${gerufen}x statt genau einmal`);
    ok(h.timerZahl() === 0, "der Taktgeber laeuft weiter, obwohl er fertig ist");
    ok(!h.waechter.smarter, "der Merker wurde nicht aufgeraeumt — ein zweiter Anlauf waere blockiert");
    h.takt(); h.takt();
    ok(gerufen === 1, `der Rueckruf lief erneut (${gerufen}x) — er ist nicht einmalig`);
  }
}

// ── 3. Idempotent: dreimal anmelden, ein Waechter ─────────────────────
{
  const h = harness({ refAb: 2 });
  if (h) {
    let gerufen = 0;
    h.fn("smarter", () => { gerufen++; });
    h.fn("smarter", () => { gerufen++; });
    h.fn("smarter", () => { gerufen++; });
    ok(h.timerZahl() === 1, `nach drei Anmeldungen laufen ${h.timerZahl()} Taktgeber`);
    h.takt(); h.takt();
    ok(gerufen === 1, `nach drei Anmeldungen lief der Rueckruf ${gerufen}x statt einmal`);
  }
}

// ── 4. Zwei Kennungen stoeren einander nicht ──────────────────────────
{
  const h = harness({ refAb: 2 });
  if (h) {
    let s = 0, l = 0;
    h.fn("smarter", () => { s++; });
    h.fn("leseplan", () => { l++; });
    ok(h.timerZahl() === 2, `zwei Kennungen ergeben ${h.timerZahl()} Taktgeber statt 2`);
    h.takt(); h.takt();
    ok(s === 1 && l === 1, `Smarter ${s}x, Leseplan ${l}x — erwartet je einmal`);
  }
}

// ── 5. Bleibt Firebase weg, gibt der Waechter auf ─────────────────────
{
  const h = harness({ refAb: Infinity });
  if (h) {
    let gerufen = 0;
    h.fn("smarter", () => { gerufen++; }, 2000);
    for (let i = 0; i < 20; i++) h.takt();
    ok(gerufen === 0, "der Rueckruf lief, obwohl Firebase nie kam");
    ok(h.timerZahl() === 0,
      "der Taktgeber laeuft nach Fristablauf weiter — er tickt dann bis ans Ende der Sitzung");
    ok(!h.waechter.smarter, "der Merker blieb nach Fristablauf stehen — ein spaeterer Anlauf waere blockiert");
  }
}

// ═══ 6. QUELLTEXT: beide Zwillinge sind angeschlossen ══════════════════
for (const [name, anker, aufruf] of [
  ["Smarter", "SMARTER.noFirebase = true; SMARTER.loaded = true;", "wennFirebaseBereit('smarter'"],
  ["Leseplan", "LESEPLAN.noFirebase = true; LESEPLAN.loaded = true;", "wennFirebaseBereit('leseplan'"],
]) {
  const a = index.indexOf(anker);
  ok(a > 0, `${name}: der Offline-Zweig wurde nicht gefunden`);
  if (a < 0) continue;
  const umfeld = index.slice(a, a + 700);
  ok(umfeld.includes(aufruf),
    `${name}: der Offline-Zweig meldet keinen Nachzieher an — der Hinweis bleibt bis zu einer Minute stehen`);
  ok(/loaded = false;/.test(umfeld),
    `${name}: der Nachzieher setzt loaded nicht zurueck — der Ladelauf wuerde uebersprungen`);
}

// Die bestehende 60-Sekunden-Regel bleibt, wie sie war: der Nachzieher ist ein
// ZUSATZ, kein Ersatz. Wird sie entfernt, faellt der Rueckfall weg.
for (const regel of [
  "(Date.now() - SMARTER.loadedAt) > 60000",
  "(Date.now() - LESEPLAN.loadedAt) > 60000",
]) {
  ok(index.includes(regel), `die bestehende Frischepruefung fehlt: ${regel}`);
}

// ═══ 7. Fremde Bereiche unberuehrt ════════════════════════════════════
for (const anker of [
  "async function canonicalWrite(quelle, options = {})",
  "const CORE_PROVIDER_ORDER = ['rtdb', 'netlify'];",
  "function openRenameSheet(opt) {",
  "function openConfirmSheet(opt) {",
]) {
  ok(index.includes(anker), `ein fremder Bereich wurde beruehrt: "${anker}" fehlt`);
}

if (luecken.length) {
  console.error("M5 FIREBASE REARM — " + luecken.length + " von " + checks + " Pruefungen:");
  luecken.forEach((l) => console.error("   - " + l));
  process.exit(1);
}
console.log(`m5 firebase rearm: ok (${checks} Pruefungen)`);
