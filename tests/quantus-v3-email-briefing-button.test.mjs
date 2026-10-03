/*
 * Der manuelle "E-Mails auswerten"-Knopf im DailyBriefing (public/index.html,
 * `dbRunV3EmailBriefing` + der Knopf in `renderV3AutomationStatus`).
 *
 * Nutzeranforderung: ein wirklich ausfuehrbarer UI-Weg, kein reines Doku-
 * Versprechen — authentifizierter POST an denselben Endpunkt wie der lokale
 * ChatGPT-Agent, sichtbare Ergebnisse/Fehler, und danach ein SICHERER
 * Refresh (syncFreshness = Pull-Merge-Render), der nie lokale, noch
 * ungesicherte Aenderungen ueberschreibt.
 *
 * Diese Tests extrahieren die ECHTEN Funktionen aus index.html (kein
 * Duplikat) und fuehren sie gegen ein Stub-DOM/Stub-fetch aus.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

function extract(startMarker, endMarker, startFrom = 0) {
  const start = index.indexOf(startMarker, startFrom);
  assert.ok(start > 0, `Marker nicht gefunden: ${startMarker}`);
  const end = index.indexOf(endMarker, start);
  assert.ok(end > start, `Endmarker nicht gefunden nach ${startMarker}: ${endMarker}`);
  return index.slice(start, end + endMarker.length);
}

// ── Extraktion: renderV3AutomationStatus (fuer den Knopf) ──────────────────
function loadRenderer() {
  const escSrc = extract("\nfunction esc(s){", "}\n");
  const todaySrc = extract("const todayYmd = () => {", "};\n");
  const capSrc = extract("const V3_MONTHLY_CAP_MICROS", ";\n");
  const warnSrc = extract("const V3_MONTHLY_WARN_MICROS", ";\n");
  const yearMonthFnSrc = extract("function v3ZurichYearMonth(ms) {", "\n}\n");
  const monthFnSrc = extract("function v3MonthToDateMicros() {", "\n}\n");
  const usdFnSrc = extract("function v3Usd(micros)", "\n");
  const budgetSrc = extract("function renderV3BudgetStatus() {", "\n}\n");
  const rendererSrc = extract("function renderV3AutomationStatus(selectedDate) {", "\n}\n");
  const fn = new Function("APP", "window",
    escSrc + "\n" + todaySrc + "\n" + capSrc + "\n" + warnSrc + "\n" + yearMonthFnSrc + "\n" + monthFnSrc + "\n" + usdFnSrc + "\n" + budgetSrc + "\n" + rendererSrc
    + "\nreturn renderV3AutomationStatus;");
  return fn;
}

function appWith(data) { return { state: { data } }; }

test("Knopf 'E-Mails auswerten' erscheint fuer HEUTE, mit Status-Bereich", () => {
  const heute = new Date().toISOString().slice(0, 10);
  const render = loadRenderer()(appWith({ entities: {}, dailyBriefing: {} }), {});
  const html = render(heute);
  assert.match(html, /id="dbV3EmailRunBtn"/, "der Knopf muss vorhanden sein");
  assert.match(html, /dbRunV3EmailBriefing\(\)/, "der Knopf muss die echte Funktion aufrufen");
  assert.match(html, /id="dbV3EmailRunStatus"/, "der Status-Bereich fuer Ergebnisse/Fehler muss vorhanden sein");
});

test("fuer einen ANDEREN Tag als heute erscheint kein Knopf (der Server wertet immer 'heute' aus)", () => {
  const render = loadRenderer()(appWith({ entities: {}, dailyBriefing: {} }), {});
  const html = render("2000-01-01");
  assert.doesNotMatch(html, /id="dbV3EmailRunBtn"/, "ohne 'heute' darf kein irrefuehrender Knopf erscheinen");
  assert.match(html, /nur für heute verfügbar/, "der Hinweis muss ehrlich erklaeren, warum kein Knopf da ist");
});

// ── Extraktion: dbRunV3EmailBriefing (fuer das Verhalten des Knopfs) ───────
const HANDLER_SRC = extract("async function dbRunV3EmailBriefing() {", "\nwindow.dbRunV3EmailBriefing = dbRunV3EmailBriefing;");
function loadHandler({ window: win = {}, document, APP, fetch: fetchImpl, syncFreshness: syncImpl }) {
  return new Function(
    "window", "document", "APP", "fetch", "sanitizeApiKey", "syncFreshness", "esc",
    HANDLER_SRC + "\nreturn dbRunV3EmailBriefing;"
  )(win, document, APP, fetchImpl,
    (k) => String(k || "").trim(),
    syncImpl || (async () => {}),
    (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
}

function stubDom() {
  const els = {
    dbV3EmailRunBtn: { disabled: false, textContent: "" },
    dbV3EmailRunStatus: { innerHTML: "" },
  };
  return { document: { getElementById: (id) => els[id] || null }, els };
}

test("ohne Zugangsschlüssel: sichtbarer Fehler, kein fetch-Aufruf", async () => {
  let fetchCalled = false;
  const { document, els } = stubDom();
  const APP = { state: { settings: { v3EmailAuthToken: "" } } };
  const fn = loadHandler({ document, APP, fetch: async () => { fetchCalled = true; return { status: 200, json: async () => ({ ok: true }) }; } });
  await fn();
  assert.equal(fetchCalled, false, "ohne Token darf niemals ein Aufruf gesendet werden");
  assert.match(els.dbV3EmailRunStatus.innerHTML, /Zugangsschlüssel/, "der fehlende Zugangsschlüssel muss sichtbar erklaert werden");
});

test("mit Zugangsschlüssel: sendet POST mit korrektem Bearer-Header an den echten Endpunkt", async () => {
  let gesehen = null;
  const { document, els } = stubDom();
  const APP = { state: { settings: { v3EmailAuthToken: "  mein-token  " } } };
  const fn = loadHandler({
    document, APP,
    fetch: async (url, opts) => { gesehen = { url, opts }; return { status: 200, json: async () => ({ ok: true, drafted: true, sourceOutcome: "ok" }) }; },
  });
  await fn();
  assert.ok(gesehen, "fetch haette aufgerufen werden muessen");
  assert.equal(gesehen.url, "/.netlify/functions/quantus-v3-daily-briefing-run");
  assert.equal(gesehen.opts.method, "POST");
  assert.equal(gesehen.opts.headers.Authorization, "Bearer mein-token");
  assert.match(els.dbV3EmailRunStatus.innerHTML, /Entwurf erstellt/, "ein erfolgreicher Lauf muss sichtbar bestaetigt werden");
});

test("bei Erfolg (Status 200) wird syncFreshness() aufgerufen — sicherer Refresh, kein Ueberschreiben", async () => {
  let syncAufgerufenMit = null;
  const { document } = stubDom();
  const APP = { state: { settings: { v3EmailAuthToken: "tok" } } };
  const fn = loadHandler({
    document, APP,
    fetch: async () => ({ status: 200, json: async () => ({ ok: true, drafted: false, sourceOutcome: "ok" }) }),
    syncFreshness: async (reason) => { syncAufgerufenMit = reason; },
  });
  await fn();
  assert.equal(syncAufgerufenMit, "v3-email-run", "syncFreshness() (Pull-Merge-Render) muss nach einem echten Lauf aufgerufen werden");
});

test("bei 401 wird der Zugriff als verweigert angezeigt und syncFreshness() NICHT aufgerufen", async () => {
  let syncCalled = false;
  const { document, els } = stubDom();
  const APP = { state: { settings: { v3EmailAuthToken: "falsch" } } };
  const fn = loadHandler({
    document, APP,
    fetch: async () => ({ status: 401, json: async () => ({ ok: false, error: "KEIN_ZUGANG" }) }),
    syncFreshness: async () => { syncCalled = true; },
  });
  await fn();
  assert.equal(syncCalled, false, "bei abgelehntem Zugriff wurde nichts persistiert — kein Refresh noetig");
  assert.match(els.dbV3EmailRunStatus.innerHTML, /Zugang verweigert/, "eine 401-Antwort muss verstaendlich sichtbar sein");
});

// ── Review-Fix (25.09.2026, belegter Fehler): der Knopf endete oeffentlich
// mit einem opaken "run_failed", weil netlify/functions/quantus-v3-daily-
// briefing-run.mjs den Fehler seines eigenen catch-Blocks verschluckte — Auth
// und Konfigurationspruefung waren dabei laengst durchlaufen (kein GESPERRT).
// Fix: runDailyBriefing() klassifiziert jetzt jeden bekannten Fehlschlagspunkt
// selbst (mitPhase() in quantus-v3-daily-briefing.mjs) und liefert IMMER ein
// sicheres { blocked, code } ohne Geheimnisse/Mailinhalt; der Knopf muss
// dieses Paar sichtbar anzeigen statt nur "Lauf fehlgeschlagen".
test("ein serverseitig klassifizierter Fehlschlag (blocked+code) wird sichtbar mit BEIDEN Angaben angezeigt, nicht nur generisch", async () => {
  const { document, els } = stubDom();
  const APP = { state: { settings: { v3EmailAuthToken: "tok" } } };
  const fn = loadHandler({
    document, APP,
    fetch: async () => ({ status: 200, json: async () => ({ ok: false, blocked: "unexpected_error:core_read", code: "credentials_missing" }) }),
  });
  await fn();
  assert.match(els.dbV3EmailRunStatus.innerHTML, /unexpected_error:core_read/, "die Phase (aus 'blocked') muss sichtbar sein, nicht nur ein generischer Satz");
  assert.match(els.dbV3EmailRunStatus.innerHTML, /credentials_missing/, "der sichere Fehlercode muss sichtbar sein");
});

test("ein wirklich unklassifizierter 500er (run_failed+code, keine Phase) wird trotzdem mit dem Code angezeigt", async () => {
  const { document, els } = stubDom();
  const APP = { state: { settings: { v3EmailAuthToken: "tok" } } };
  const fn = loadHandler({
    document, APP,
    fetch: async () => ({ status: 500, json: async () => ({ ok: false, error: "run_failed", phase: "unclassified", code: "TypeError" }) }),
  });
  await fn();
  assert.match(els.dbV3EmailRunStatus.innerHTML, /run_failed/, "run_failed muss weiterhin sichtbar sein");
  assert.match(els.dbV3EmailRunStatus.innerHTML, /TypeError/, "der sichere Fehlername muss sichtbar sein, auch ohne bekannte Phase");
});

// Befund (25.09.2026, echter Knopflauf): unexpected_error:core_migrate
// [CORE_PARTIAL_V3] allein sagt nicht, WELCHES Feld unvollstaendig ist. Der
// Server liefert jetzt zusaetzlich body.violations ({code,path}[], nur
// Feldpfade, nie ein Wert) — der Knopf muss das sichtbar anzeigen, nicht nur
// den Sammelcode.
test("violations (sichere Feldpfade) werden bei CORE_PARTIAL_V3 sichtbar angezeigt", async () => {
  const { document, els } = stubDom();
  const APP = { state: { settings: { v3EmailAuthToken: "tok" } } };
  const fn = loadHandler({
    document, APP,
    fetch: async () => ({
      status: 200,
      json: async () => ({
        ok: false, blocked: "unexpected_error:core_migrate", code: "CORE_PARTIAL_V3",
        violations: [{ code: "CORE_NOT_MIGRATED", path: "automation.migration" }, { code: "CORE_RUN_CORRUPT", path: "dailyBriefing.assistantRuns.2026-09-25" }],
      }),
    }),
  });
  await fn();
  assert.match(els.dbV3EmailRunStatus.innerHTML, /CORE_PARTIAL_V3/, "der Sammelcode muss weiterhin sichtbar sein");
  assert.match(els.dbV3EmailRunStatus.innerHTML, /CORE_NOT_MIGRATED@automation\.migration/, "der erste Feldpfad ist nicht sichtbar");
  assert.match(els.dbV3EmailRunStatus.innerHTML, /CORE_RUN_CORRUPT@dailyBriefing\.assistantRuns\.2026-09-25/, "der zweite Feldpfad ist nicht sichtbar");
});

console.log("quantus-v3-email-briefing-button: alle Pruefungen bestanden");

function memorySession() {
  const values=new Map();
  return {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
}
function completedCore(at, {outcome='partial',linked=true,active=false,noteAt=at}={}) {
  const id='v3-draft:test';
  return {ok:true,data:{automation:{activeLease:active?{holder:'netlify-scheduled'}:null},dailyBriefing:{assistantRuns:{today:{sourceChecks:{gmail:{checkedAt:new Date(at).toISOString(),outcome}},noteIds:linked?[id]:[]}}},entities:{chatgptNotes:{[id]:{createdAt:new Date(noteAt).toISOString(),instruction:'Actual saved draft'}}}}};
}
test('504 reconciles a new persisted partial draft without a second POST', async()=>{
  const {document,els}=stubDom();let posts=0,reads=0;
  const win={sessionStorage:memorySession(),remoteGetByKey:async(key,opts)=>{
    reads++;assert.equal(key,'app-data.json');assert.equal(opts.force,true);return completedCore(Date.now()+10);
  }};
  await loadHandler({window:win,document,APP:{state:{settings:{v3EmailAuthToken:'tok'}}},fetch:async()=>{posts++;return {status:504,json:async()=>{throw Error('html')}};}})();
  assert.equal(posts,1);assert.equal(reads,1);
  assert.match(els.dbV3EmailRunStatus.innerHTML,/Serverstand bestätigt/);
  assert.match(els.dbV3EmailRunStatus.innerHTML,/nur teilweise geprüft/);
  assert.equal(win.sessionStorage.getItem('quantus-v3-email-pending-start'),null);
  assert.equal(els.dbV3EmailRunBtn.disabled,false);
});
test('ambiguous network outcome survives reload; subsequent clicks read only',async()=>{
  const sessionStorage=memorySession();let posts=0,reads=0;
  const read=async()=>{reads++;return {ok:true,data:{}};};
  const APP={state:{settings:{v3EmailAuthToken:'tok'}}};
  const first=stubDom();
  const handler=loadHandler({window:{sessionStorage,remoteGetByKey:read},document:first.document,APP,fetch:async()=>{posts++;throw Error('SECRET must not appear');}});
  await handler();await handler();
  const second=stubDom();const reloaded={sessionStorage,remoteGetByKey:read};
  await loadHandler({window:reloaded,document:second.document,APP,fetch:async()=>{posts++;throw Error('No second POST');}})();
  assert.equal(posts,1);assert.equal(reads,3);
  assert.equal(second.els.dbV3EmailRunBtn.textContent,'Serverergebnis prüfen');
  assert.doesNotMatch(first.els.dbV3EmailRunStatus.innerHTML,/SECRET/);
  const today=new Date().toISOString().slice(0,10);
  assert.match(loadRenderer()(appWith({}),reloaded)(today),/Serverergebnis prüfen/);
});
for(const [label,options,checkedOffset] of [['old check',{},-1000],['old note',{noteAt:1000},10],['orphan note',{linked:false},10],['active lease',{active:true},10]]) {
  test('does not claim success from '+label,async()=>{
    const at=Date.now();const {document,els}=stubDom();let posts=0;
    const win={_v3EmailPendingAt:at,remoteGetByKey:async()=>completedCore(at+checkedOffset,options)};
    await loadHandler({window:win,document,APP:{state:{}},fetch:async()=>{posts++;}})();
    assert.equal(posts,0);assert.equal(win._v3EmailPendingAt,at);
    assert.doesNotMatch(els.dbV3EmailRunStatus.innerHTML,/Serverstand bestätigt/);
    assert.equal(els.dbV3EmailRunBtn.textContent,'Serverergebnis prüfen');
  });
}
test('failed read preserves pending outcome and does not leak exception details',async()=>{
  const {document,els}=stubDom();const win={_v3EmailPendingAt:Date.now(),remoteGetByKey:async()=>{throw Error('SECRET');}};
  await loadHandler({window:win,document,APP:{state:{}},fetch:async()=>assert.fail('POST')})();
  assert.match(els.dbV3EmailRunStatus.innerHTML,/nicht erreichbar/);
  assert.doesNotMatch(els.dbV3EmailRunStatus.innerHTML,/SECRET/);
  assert.ok(win._v3EmailPendingAt);
});
test('explicit reset cancels on refusal and never launches work by itself',()=>{
  const source=extract('function dbResetV3EmailPending() {','\n}\n');
  const {document,els}=stubDom();let allow=false;
  const win={_v3EmailPendingAt:1,sessionStorage:memorySession(),confirm:()=>allow};
  win.sessionStorage.setItem('quantus-v3-email-pending-start','1');
  const reset=new Function('window','document',source+'\nreturn dbResetV3EmailPending;')(win,document);
  reset();assert.equal(win._v3EmailPendingAt,1);
  allow=true;reset();assert.equal(win._v3EmailPendingAt,0);
  assert.equal(win.sessionStorage.getItem('quantus-v3-email-pending-start'),null);
  assert.match(els.dbV3EmailRunStatus.textContent,/noch kein Lauf gestartet/);
});
