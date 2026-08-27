/*
 * F-26 — der ambigue RTDB-Commit: der Anbieteruebergang nach einem
 * Schreibvorgang mit UNBEKANNTEM Ausgang.
 *
 * PRODUKTIONSBEFUND (live, S3b, ein bestaetigtes NoteFlow-Loeschen):
 *   1. transaction at /appStore/app-data_json failed: disconnect
 *   2. [CloudSync] rtdb temporarily paused: disconnect
 *   3. [CloudSync] Netlify PUT auf den Kerndatensatz ohne If-Match abgewiesen
 * — und TROTZDEM war der Commit serverseitig erfolgt: Grabstein
 * _deleteLog.note[813197f9-…] vorhanden, Entitaet weg, UI 38 -> 37, nach Reload
 * weiterhin weg. Der Client meldete dem Nutzer das Gegenteil.
 *
 * DER SPALTZUSTAND ist der Kern: der RTDB-LESEvorgang ist gesund, der
 * RTDB-SCHREIBvorgang endet mit unbekanntem Ausgang. Genau dann kann der
 * deklarierte Failover RTDB -> Netlify NICHT mehr bedingt schreiben, denn der
 * erfolgreiche RTDB-Lesevorgang NULLT APP.state.storage.etag aktiv
 * (rtdbJsonGet, Erfolgszweig), und remoteGetByKey kehrt beim ersten Erfolg
 * zurueck — ein Netlify-GET, der einen ETag liefern koennte, findet nie statt.
 *
 * DER FIX (jetzt gebaut)
 * Jeder Transaktionsversuch traegt eine VERSUCHSKENNUNG (attemptId) bis in den
 * gespeicherten Wrapper. Meldet die Transaktion einen FEHLER — Ausgang
 * unbekannt, nicht "nicht geschrieben" —, liest rtdbJsonPut den Kernknoten
 * zurueck und vergleicht:
 *   unsere Kennung steht dort -> Erfolg, Beweis 'rtdb-ambiguous-verified'
 *   fremde/keine Kennung      -> 'ambiguous_not_applied' (Wiederholung erlaubt)
 *   nicht lesbar              -> 'ambiguous_unverified', KEIN Anbieterwechsel
 * Erst diese Kennung macht den Ausgang entscheidbar: savedBy allein ist die
 * GERAETE-Kennung und unterscheidet zwei Versuche desselben Geraets nicht — das
 * war der offene Punkt in Abschnitt 4.
 *
 * WAS DIESER WAECHTER TUT
 * Abschnitt 1 misst den ambiguen Livefall: der Commit IST erfolgt, und der
 * Client meldet das jetzt auch — mit CAS-Beweis, ohne Anbieterwechsel.
 * Abschnitt 2 misst die drei Ausgaenge einzeln, inklusive der Fassung, in der
 * NICHTS geschrieben wurde und in der der Rueckleseweg selbst scheitert.
 * Abschnitt 3 ist die Sicherheitsinvariante (siehe unten).
 * Abschnitt 4 misst die Versuchskennung und die Symmetrie der Rueckzugsfrist.
 *
 * SICHERHEITSINVARIANTE FUER JEDEN SPAETEREN FIX (Abschnitt 3)
 * Ein Netlify-GET nach dem ambiguen RTDB-Ausgang darf NICHT einfach denselben
 * Koerper freischalten, der gegen den VOR-Transaktions-Stand gebaut wurde. Das
 * waere ein bedingter Schreibvorgang auf einen Stand, den dieser Koerper nie
 * gesehen hat — und wuerde den soeben committeten Stand samt fremder Merges und
 * Grabsteine ersetzen (die F-25-Verlustklasse). Zuerst muss der RTDB-Ausgang
 * VERIFIZIERT werden; der If-Match-Riegel in netlifyBlobPut bleibt scharf.
 * Abschnitt 3 misst, dass der Riegel bei einem EINHEITLICHEN RTDB-Ausfall
 * weiterhin den regulaeren Netlify-CAS-Weg zulaesst — der Fix darf ihn also
 * weder aufweichen noch zumauern.
 *
 * ABGRENZUNG P1.2
 * Die Warteschlange fuer nicht zustellbare Schreibvorgaenge ist P1.2 und
 * ausdruecklich NICHT Gegenstand von F-26. F-26 fragt nur: Ist der Ausgang
 * bekannt? P1.2 fragt: Was tun, wenn er bekannt und "nicht geschrieben" ist.
 *
 * KEIN NETZ. Die Attrappe fuer fetchWithTimeout wirft,
 * falls doch jemand hinausgreift.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

let checks = 0;
const luecken = [];
const offen = [];
const ok = (bedingung, text) => { checks++; if (!bedingung) luecken.push(text); };
// TODO/SKIP: bewusst offene Invariante. Wird sichtbar gemeldet, laesst die
// Suite aber gruen. Kippt sie auf gruen, ist F-26 gebaut — dann wandert die
// Zeile nach ok() und dieser Kommentar weg.
const todo = (erfuellt, text) => { checks++; offen.push((erfuellt ? "UNERWARTET GRUEN: " : "") + text); return erfuellt; };

// ── Die ECHTEN ausgelieferten Funktionen ────────────────────────────────
// Keine Attrappe eines fertigen Netlify-Ergebnisses: der Riegel in
// netlifyBlobPut muss selbst laufen, sonst beweist der Test nichts.
function schneide(name) {
  for (const p of [`async function ${name}(`, `function ${name}(`]) {
    const a = index.indexOf("\n" + p);
    if (a > 0) {
      const e = index.indexOf("\n}\n", a);
      if (e > a) return index.slice(a + 1, e + 3);
    }
  }
  luecken.push(`${name} wurde in public/index.html nicht gefunden`);
  return "";
}
const ECHTE = ["canonicalWrite", "remoteGetByKey", "remotePutByKey", "rtdbJsonPut",
  "netlifyBlobPut", "getCloudProviderOrder", "shouldTryCloudProvider",
  "coreWriteGuard", "rememberCloudFailure"];
const quelle = ECHTE.map(schneide).join("\n");
ok(ECHTE.every((n) => quelle.includes(n + "(")), "nicht alle echten Funktionen konnten geladen werden");

// Gegenprobe zum Loader: die Riegel-Zeile MUSS im geladenen Quelltext stehen.
// Ohne sie liefe der Test gegen einen Ausschnitt, der die Politik gar nicht
// enthaelt, und waere gruen aus dem falschen Grund.
ok(/isCoreDataKey\(key\) && !etag/.test(quelle),
  "der If-Match-Riegel steht nicht im geladenen netlifyBlobPut — der Ausschnitt traegt die Politik nicht");
ok(/if \(res\.ok\) return res;/.test(quelle),
  "remoteGetByKey kehrt nicht mehr beim ersten Erfolg zurueck — die Praemisse des Befunds ist weg");

// ── Umgebung ────────────────────────────────────────────────────────────
const KERN_KEY = "app-data.json";
const NOTE_WEG = "813197f9-ccbc-4fbc-adf5-ae273277baec";
const GRABSTEIN_TS = 1787738501400;

function umgebung({ rtdbLesenOk = true, transaktion = "ambiguous",
                   commitAngewendet = true, rueckleseFehler = false,
                   fremdeKennung = null, backoffBis = 0 } = {}) {
  const z = { rtdbGet: 0, rtdbTxn: 0, netGet: 0, netPut: 0, serverCommits: 0, rueckLesen: 0 };
  const meldungen = [];
  // Der Server haelt den VOLLSTAENDIGEN Wrapper — samt attemptId. Genau daran
  // haengt der Fix: ein Test, der nur .data behaelt, koennte die Verifikation
  // gar nicht messen.
  let SERVER = {
    data: JSON.stringify({
      entities: { notes: { behalten: { id: "behalten" }, [NOTE_WEG]: { id: NOTE_WEG } } },
      meta: { updatedAt: "2026-08-26T09:00:00.000Z" },
    }),
    etag: "srv-1",
    savedAt: 1787738000000,
    savedBy: "geraet-fremd",
    attemptId: fremdeKennung || "w_vorher",
  };
  let gesendeterIfMatch = "__nie_aufgerufen__";

  const APP = { state: {
    settings: { storage: { blobKey: KERN_KEY, putUrl: "https://beispiel/{key}", authToken: null } },
    // Ein ALTER ETag aus einem frueheren Netlify-Lesevorgang. Er darf den
    // Riegel nicht retten: der gesunde RTDB-Read nullt ihn.
    storage: { etag: "ALT-ETAG-aus-frueherem-Netlify-Lesevorgang", lastRemoteSeenAt: 0 },
    data: {},
  } };
  const _cloudHealth = {
    rtdb: backoffBis ? { backoffUntil: backoffBis, lastError: "disconnect", failCount: 1 } : {},
    netlify: {}, firebase: {}, lastGoodProvider: null,
  };
  const _remoteEtags = {};
  const isCoreDataKey = (k) => k === KERN_KEY;

  // rtdbJsonGet: der Erfolgszweig NULLT storage.etag — exakt wie im Original.
  const rtdbJsonGet = async () => {
    z.rtdbGet++;
    if (!rtdbLesenOk) return { ok: false, error: new Error("offline"), provider: "rtdb" };
    APP.state.storage.lastRemoteProvider = "rtdb";
    APP.state.storage.etag = null;
    return { ok: true, data: JSON.parse(SERVER.data), provider: "rtdb" };
  };
  // netlifyBlobGet: der Erfolgszweig SETZT storage.etag — ebenfalls wie im
  // Original. Ohne das waere der Netlify-CAS-Weg in Abschnitt 3 kuenstlich tot.
  const netlifyBlobGet = async (k) => {
    z.netGet++;
    _remoteEtags[k] = SERVER.etag;
    if (isCoreDataKey(k)) APP.state.storage.etag = SERVER.etag;
    return { ok: true, data: JSON.parse(SERVER.data), etag: SERVER.etag, provider: "netlify" };
  };

  // DIE PRAEMISSE, nicht die Schlussfolgerung: die Transaktion wendet die
  // Mutation serverseitig an und meldet DANACH einen Verbindungsabbruch. Das
  // ist die dokumentierte Firebase-Lage, wenn die Verbindung waehrend einer
  // laufenden Transaktion abreisst — der Client erfaehrt den Ausgang nicht.
  // Ein EINHEITLICHER RTDB-Ausfall trifft Lesen UND Schreiben: ohne Ref gibt es
  // keine Transaktion, und rtdbJsonPut bricht auf dem Kernschluessel bewusst ab
  // (no_sdk_no_transaction) statt bedingungslos per REST zu ersetzen.
  const rtdbDbRef = () => rtdbLesenOk ? ({
    transaction(updateFn, onComplete) {
      z.rtdbTxn++;
      const neu = updateFn({ data: SERVER.data });
      // Nur der ERSTE Versuch ist unklar; ein Wiederholungsversuch laeuft
      // sauber durch. So misst Abschnitt 2 die Erholung statt einer Schleife.
      const jetztAmbig = transaktion === "ambiguous" && z.rtdbTxn === 1;
      if (jetztAmbig) {
        if (neu !== undefined && commitAngewendet) {
          SERVER = { ...neu, etag: "srv-2" };   // VOLLER Wrapper, attemptId inklusive
          z.serverCommits++;
        }
        onComplete(new Error("transaction at /appStore/app-data_json failed: disconnect"), false, null);
      } else {
        if (neu !== undefined) { SERVER = { ...neu, etag: "srv-2" }; z.serverCommits++; }
        onComplete(null, true, { val: () => neu });
      }
    },
    // Der Rueckleseweg des Fixes.
    async once() {
      z.rueckLesen++;
      if (rueckleseFehler) throw new Error("read failed: disconnect");
      return { val: () => SERVER };
    },
  }) : null;

  const api = new Function(
    "APP", "_cloudHealth", "_remoteEtags", "CORE_PROVIDER_ORDER", "CANONICAL_WRITE_MAX_ATTEMPTS",
    "RTDB_NODE", "RTDB_DB_URL", "isCoreDataKey", "rtdbNodeKey", "persistCloudHealth",
    "rememberCloudSuccess", "rememberCoreAuthRequired", "isAuthDeniedError", "getOrCreateDeviceId",
    "getDataTimestamp", "isAutoSyncEnabled", "isBlobSyncConfigured", "isFirebaseCloudAvailable",
    "isRtdbCloudAvailable", "primaryCloudProvider", "normalizeData", "mergeData", "coreAuthReady",
    "coreKeyAuthGate", "hasAnyCloudProviderAvailable", "firebaseJsonPut", "firebaseJsonGet",
    "rtdbJsonGet", "netlifyBlobGet", "rtdbDbRef", "fetchWithTimeout", "buildStorageAuthHeaders",
    "console", "_lastShadowWriteAt", "JSON", "Date", "Promise", "Error", "Object", "Array", "Math", "String",
    quelle + "\nreturn { canonicalWrite, remotePutByKey, netlifyBlobPut };")(
    APP, _cloudHealth, _remoteEtags, ["rtdb", "netlify"], 2,
    "appStore", "https://db.beispiel", isCoreDataKey, (k) => k.replace(/\./g, "_"), () => {},
    (p) => { _cloudHealth.lastGoodProvider = p; }, () => {}, () => false, () => "geraet-1",
    (d) => Date.parse(d?.meta?.updatedAt || 0) || 0, () => true, () => true, () => false,
    () => true, () => "rtdb", (d) => d,
    // mergeData: fuer den gemessenen Kontrollfluss genuegt eine Vereinigung.
    // Der Inhalt des Merges ist nicht Gegenstand dieses Waechters — das prueft
    // tests/sync-merge.test.mjs und tests/delete-tombstone.test.mjs.
    (a, b) => ({ ...b, ...a, entities: { ...(b.entities || {}), ...(a.entities || {}) } }),
    async () => ({ user: { uid: "u" } }), async () => null, () => true,
    async () => ({ ok: false, provider: "firebase" }), async () => ({ ok: false, provider: "firebase" }),
    rtdbJsonGet, netlifyBlobGet, rtdbDbRef,
    async (url, opt) => {
      z.netPut++;
      gesendeterIfMatch = (opt && opt.headers && opt.headers["If-Match"]) || null;
      return { ok: true, status: 200, headers: { get: () => "srv-3" }, json: async () => ({}) };
    },
    () => ({}),
    { log: () => {}, info: (...a) => meldungen.push(a.join(" ")),
      warn: (...a) => meldungen.push(a.join(" ")), error: (...a) => meldungen.push(a.join(" ")) },
    0, JSON, Date, Promise, Error, Object, Array, Math, String);

  return {
    api, z, meldungen, APP, _cloudHealth,
    server: () => JSON.parse(SERVER.data),
    wrapper: () => SERVER,
    ifMatch: () => gesendeterIfMatch,
  };
}

// Der lokale Stand NACH dem bestaetigten Loeschen: Entitaet weg, Grabstein da.
const NACH_DEM_LOESCHEN = {
  entities: { notes: { behalten: { id: "behalten" } } },
  _deleteLog: { note: { [NOTE_WEG]: GRABSTEIN_TS } },
  meta: { updatedAt: "2026-08-26T10:01:41.416Z" },
};

// ═══ 1. DER LIVEFALL: Commit erfolgt, Client meldet es jetzt auch ══
const u = umgebung();
const res = await u.api.canonicalWrite(NACH_DEM_LOESCHEN);

ok(u.z.rtdbGet === 1, `RTDB-GET ${u.z.rtdbGet} statt 1 — der Lesevorgang war nicht gesund`);
ok(u.z.rtdbTxn === 1, `RTDB-Transaktion ${u.z.rtdbTxn} statt 1`);
ok(u.z.serverCommits === 1, "die Praemisse greift nicht: serverseitig wurde nichts angewendet");

// Die Mutation IST remote angekommen — das ist der ganze Witz des Befunds.
ok(u.server().entities.notes[NOTE_WEG] === undefined,
  "die geloeschte Notiz steht serverseitig noch — die Praemisse bildet den Livebefund nicht ab");
ok(u.server()._deleteLog?.note?.[NOTE_WEG] === GRABSTEIN_TS,
  "der Grabstein ist serverseitig nicht angekommen");

// DER FIX: es wurde zurueckgelesen, und zwar genau einmal.
ok(u.z.rueckLesen === 1,
  `Rueckleseweg ${u.z.rueckLesen}x statt 1x — der Ausgang wurde nicht verifiziert (F-26)`);

// Und das Ergebnis stimmt jetzt mit dem Server ueberein.
ok(res.ok === true,
  `ein serverseitig erfolgter Commit wird als Fehlschlag gemeldet (reason ${res.reason}) — ` +
  "der Server traegt den neueren Stand, der Client sagt das Gegenteil");
ok(res.provider === "rtdb",
  `Resultat meldet provider "${res.provider}" statt rtdb — die Diagnose zeigt auf den falschen Speicher`);
ok(res.casProof && res.casProof.kind === "rtdb-ambiguous-verified",
  `CAS-Beweis ${JSON.stringify(res.casProof && res.casProof.kind)} statt rtdb-ambiguous-verified`);
ok(res.casProof && typeof res.casProof.attemptId === "string" && res.casProof.attemptId.length > 0,
  "der Beweis traegt keine Versuchskennung — dann ist er eine Vermutung, kein Beweis");
ok(res.casProof && res.casProof.attemptId === u.wrapper().attemptId,
  "die Kennung im Beweis ist nicht die, die serverseitig steht");
ok(res.mergedRemote === true, "canonicalWrite hat den verifizierten Ausgang nicht als Erfolg durchgereicht");

// Der zurueckgemeldete Stand ist der SERVERSTAND, nicht der lokal gebaute.
ok(res.data && res.data._deleteLog?.note?.[NOTE_WEG] === GRABSTEIN_TS,
  "das Resultat traegt nicht den zurueckgelesenen Serverstand");

// KEIN Anbieterwechsel. Der Riegel wurde gar nicht erst gebraucht.
ok(u.z.netGet === 0, `Netlify-GET ${u.z.netGet} statt 0 — es wurde nachtraeglich ein ETag geholt`);
ok(u.z.netPut === 0,
  `Netlify-NETZWERK-PUT ${u.z.netPut} statt 0 — DER RIEGEL IST OFFEN: ein unbedingter Kern-Write ` +
  "auf einen soeben committeten Stand ist wieder moeglich (F-25-Verlustklasse)");
ok(u.ifMatch() === "__nie_aufgerufen__", "es ging doch ein Netlify-PUT hinaus");

// Genau ein Versuch: verifiziert heisst fertig, nicht wiederholen.
ok(u.z.rtdbTxn === 1, "es lief eine zweite Transaktion, obwohl der Commit verifiziert war");

// Der gesunde RTDB-Read nullt den ETag — die Ursachenkette des Befunds bleibt
// gemessen, auch wenn sie jetzt nicht mehr zum Schaden fuehrt.
ok(u.APP.state.storage.etag === null,
  `storage.etag ist ${JSON.stringify(u.APP.state.storage.etag)} statt null — ` +
  "der gesunde RTDB-Lesevorgang nullt ihn nicht mehr; die Ursachenkette hat sich verschoben");

// ═══ 2. DIE DREI AUSGAENGE, EINZELN ═════════════════════════════
// (a) Fehler gemeldet, NICHTS geschrieben. Das ist ein gewoehnlicher
// Fehlschlag — Wiederholung erlaubt, und der zweite Versuch kommt durch.
{
  const v = umgebung({ commitAngewendet: false });
  const r = await v.api.canonicalWrite(NACH_DEM_LOESCHEN);
  ok(v.z.rueckLesen === 1, `(a) Rueckleseweg ${v.z.rueckLesen}x statt 1x`);
  ok(v.z.rtdbTxn === 2,
    `(a) ${v.z.rtdbTxn} Transaktionen statt 2 — ein gesichert NICHT geschriebener Versuch muss ` +
    "wiederholt werden duerfen");
  ok(r.ok === true, `(a) der Wiederholungsversuch scheitert (${r.reason})`);
  ok(r.casProof && r.casProof.kind === "rtdb-transaction",
    "(a) der Wiederholungsversuch liefert keinen regulaeren Transaktionsbeweis");
  ok(v.z.netPut === 0, `(a) Netlify-PUT ${v.z.netPut} statt 0 — es wurde doch durchgefallen`);
}

// (b) Fehler gemeldet, EIN FREMDER Versuch steht im Knoten. Auch das ist
// entscheidbar: unsere Kennung fehlt, also kam unser Versuch nicht durch.
{
  const v = umgebung({ commitAngewendet: false, fremdeKennung: "w_anderesGeraet" });
  const r = await v.api.canonicalWrite(NACH_DEM_LOESCHEN);
  ok(v.z.rueckLesen === 1, `(b) Rueckleseweg ${v.z.rueckLesen}x statt 1x`);
  ok(v.z.rtdbTxn === 2, `(b) ${v.z.rtdbTxn} Transaktionen statt 2`);
  ok(r.ok === true, `(b) der Wiederholungsversuch scheitert (${r.reason})`);
}

// (c) Fehler gemeldet, RUECKLESEN SCHEITERT AUCH. Jetzt ist der Ausgang
// wirklich unbekannt — und dann wird NICHT geschrieben: kein Anbieterwechsel,
// keine blinde Wiederholung, aber eine ehrliche Kennzeichnung.
{
  const v = umgebung({ rueckleseFehler: true });
  const r = await v.api.canonicalWrite(NACH_DEM_LOESCHEN);
  ok(v.z.rueckLesen === 1, `(c) Rueckleseweg ${v.z.rueckLesen}x statt 1x`);
  ok(r.ok === false, "(c) unbekannter Ausgang wurde als Erfolg gemeldet");
  ok(r.ambiguous === true,
    "(c) der unbekannte Ausgang ist nicht als solcher gekennzeichnet — 'nicht geschrieben' und " +
    "'Ausgang unbekannt' waeren im Resultat wieder dasselbe");
  ok(r.reason === "ambiguous_unverified", `(c) reason "${r.reason}" statt ambiguous_unverified`);
  ok(r.provider === "rtdb", `(c) provider "${r.provider}" statt rtdb — der Ausloeser geht verloren`);
  ok(!r.casProof, "(c) es wurde ein CAS-Beweis gemeldet, obwohl nichts bewiesen ist");
  ok(v.z.netGet === 0 && v.z.netPut === 0,
    `(c) Anbieterwechsel trotz unbekanntem Ausgang (GET ${v.z.netGet}, PUT ${v.z.netPut}) — ` +
    "der Koerper waere gegen den VOR-Transaktions-Stand gemergt (F-25-Verlustklasse)");
  ok(v.z.rtdbTxn === 1,
    `(c) ${v.z.rtdbTxn} Transaktionen — bei unbekanntem Ausgang darf NICHT blind wiederholt werden`);
}

// (d) Und der Nutzer bekommt bei unbekanntem Ausgang nicht "Lokal gespeichert"
// zu lesen. Das ist die falsche Richtung: er sichert von Hand nach, waehrend
// sein Stand moeglicherweise schon oben liegt.
{
  const ds = index.indexOf("\n  const result = await remotePut(payload);");
  const koerper = ds > 0 ? index.slice(ds, index.indexOf("\n  updateSyncChip();", ds)) : "";
  ok(ds > 0, "der Ergebniszweig von doSave wurde nicht gefunden");
  const ambigZweig = koerper.indexOf("result.ambiguous");
  const offlineZweig = koerper.indexOf('APP.state.storage.message = "Lokal gespeichert"');
  ok(ambigZweig > 0, "doSave kennt den unbekannten Ausgang nicht — er faellt in den offline-Zweig");
  ok(ambigZweig < offlineZweig,
    "der offline-Zweig kommt vor der Ambiguitaetspruefung — dann faengt er sie ab");
  ok(/Serverstand unklar/.test(koerper), "die Statusmeldung fuer den unbekannten Ausgang fehlt");
}

// P1.2 grenzt daran an, ist aber NICHT Teil von F-26: eine Warteschlange fuer
// nicht zustellbare Schreibvorgaenge. Sie darf erst greifen, wenn der Ausgang
// BEKANNT und "nicht geschrieben" ist — sonst stellt sie einen bereits
// committeten Stand ein zweites Mal zu.
ok(/Eine Warteschlange kommt spaeter \(P1\.2\)/.test(quelle),
  "canonicalWrite vertagt die Warteschlange nicht mehr ausdruecklich auf P1.2 — " +
  "entweder ist sie gebaut oder die Abgrenzung dieses Waechters ist veraltet");
ok(!/_writeQueue|schreibWarteschlange|pendingWrites/.test(quelle),
  "im Schreibpfad steht bereits eine Warteschlange (P1.2) — ein ambiguer Ausgang darf dort nicht " +
  "eingestellt werden, sonst wird ein committeter Stand ein zweites Mal zugestellt");

// ═══ 3. SICHERHEITSINVARIANTE: der Riegel bleibt scharf ═════════════════
// Gegenprobe zum ambiguen Fall: bei EINHEITLICHEM RTDB-Ausfall (auch der
// Lesevorgang scheitert) liefert der Netlify-GET einen ETag, und der PUT geht
// BEDINGT hinaus. Der Failover ist also nicht generell kaputt — er ist genau
// im Spaltzustand blind. Ein Fix fuer F-26 darf diesen Weg weder aufweichen
// (unbedingter PUT) noch zumauern (gar kein Netlify-CAS mehr).
{
  const v = umgebung({ rtdbLesenOk: false });
  const r = await v.api.canonicalWrite(NACH_DEM_LOESCHEN);
  ok(v.z.netGet === 1, `einheitlicher RTDB-Ausfall: Netlify-GET ${v.z.netGet} statt 1`);
  ok(v.z.netPut === 1, `einheitlicher RTDB-Ausfall: Netlify-PUT ${v.z.netPut} statt 1`);
  ok(typeof v.ifMatch() === "string" && v.ifMatch().length > 0,
    `einheitlicher RTDB-Ausfall: If-Match ${JSON.stringify(v.ifMatch())} — ein PUT ohne If-Match ist kein CAS`);
  ok(r.ok === true, `einheitlicher RTDB-Ausfall: der regulaere Netlify-CAS-Weg scheitert (${r.reason})`);
  ok(r.casProof && r.casProof.kind === "netlify-etag",
    "einheitlicher RTDB-Ausfall: es kam kein netlify-etag-Beweis zurueck");
  // Und der Koerper, den dieser Weg schreibt, ist gegen den GELESENEN Stand
  // gemergt — nicht gegen einen fremden. Das ist der Unterschied, den ein
  // spaeterer Fix nicht verwischen darf.
  ok(v.z.rtdbTxn === 0, "einheitlicher RTDB-Ausfall: es lief trotzdem eine RTDB-Transaktion");
}

// ═══ 4. DIE VERSUCHSKENNUNG UND DIE RUECKZUGSFRIST ══════════════
// deleteEntity() und das anschliessende NoteFlow-save() rufen BEIDE den
// Scheduler. Ohne Versuchskennung waren zwei Verlaeufe ununterscheidbar: der
// fehlergemeldete Versuch committete selbst — oder ein spaeterer
// Scheduler-Durchlauf schrieb den Stand und der erste tat nichts. Beide
// erzeugen dieselbe Beobachtung. Die Kennung entscheidet es.
// Die Schedulerlogik selbst ist unveraendert.
{
  const de = index.indexOf("\nfunction deleteEntity(");
  const deKoerper = index.slice(de, index.indexOf("\n}\n", de));
  ok(/scheduleSave\(\)/.test(deKoerper), "deleteEntity stoesst den Scheduler nicht mehr an");
  const nf = index.indexOf("  function deleteNote(id) {");
  const nfKoerper = index.slice(nf, index.indexOf("\n  }\n", nf));
  ok(/\bsave\(\);/.test(nfKoerper), "deleteNote ruft save() nicht mehr");
  ok(/const save = \(\) => \{ try \{ window\.scheduleSave/.test(index),
    "das NoteFlow-save() geht nicht mehr ueber window.scheduleSave — die Doppelanstoss-Lage hat sich geaendert");

  // Der gespeicherte Wrapper traegt jetzt BEIDES: savedBy (welches Geraet) und
  // attemptId (welcher Versuch). Ohne das zweite ist F-26 nicht entscheidbar.
  ok(/savedBy: myDevice/.test(quelle), "der Wrapper traegt savedBy nicht mehr aus der Geraetekennung");
  ok(/attemptId: versuchsId/.test(quelle),
    "der gespeicherte Wrapper traegt keine Versuchskennung — dann ist der Ausgang nicht entscheidbar");

  // Die Kennung muss pro VERSUCH neu sein, nicht pro Geraet — sonst
  // unterscheidet sie genau das nicht, wofuer es sie gibt.
  {
    const v = umgebung({ commitAngewendet: false });
    // Erster Versuch scheitert (nichts geschrieben), zweiter committet.
    // Die Kennung im Knoten stammt damit vom ZWEITEN Versuch.
    const vorher = v.wrapper().attemptId;
    await v.api.canonicalWrite(NACH_DEM_LOESCHEN);
    ok(v.wrapper().attemptId !== vorher,
      "die Versuchskennung im Knoten hat sich nicht geaendert — sie ist nicht versuchsgebunden");
    ok(/^w_/.test(v.wrapper().attemptId || ""),
      `Versuchskennung ${JSON.stringify(v.wrapper().attemptId)} — erwartet das Praefix w_`);
  }

  // Und der Fehler traegt die Kennung bis in den catch. Ohne das koennte der
  // Rueckleseweg gar nicht vergleichen: die Variable aus dem
  // Transaktionsblock ist dort nicht mehr sichtbar.
  ok(/__versuchsId: versuchsId/.test(quelle),
    "die Versuchskennung reist nicht am Fehler mit — der catch kann nicht vergleichen");
  ok(/__ambiguous: true/.test(quelle),
    "der Transaktionsfehler wird nicht als unklarer Ausgang markiert");
}

// DIE RUECKZUGSFRIST — die zweite Haelfte von F-26.
// canonicalWrite liest mit force:true und kommt an einer laufenden
// Rueckzugsfrist vorbei; der Schreibvorgang derselben Runde lief ohne und
// blieb haengen. Ergebnis: gelesen ja, geschrieben nein, gemeldet "offline" —
// obwohl der Anbieter nachweislich in derselben Sekunde geantwortet hat.
{
  const v = umgebung({ transaktion: "ok", backoffBis: Date.now() + 5000 });
  const r = await v.api.canonicalWrite(NACH_DEM_LOESCHEN);
  ok(v.z.rtdbGet === 1, `Rueckzugsfrist: RTDB-GET ${v.z.rtdbGet} statt 1 — der Lesevorgang kommt nicht durch`);
  ok(v.z.rtdbTxn === 1,
    `Rueckzugsfrist: RTDB-Transaktion ${v.z.rtdbTxn} statt 1 — der Schreibvorgang bleibt an einer Frist ` +
    "haengen, an der der Lesevorgang derselben Runde soeben vorbeikam");
  ok(r.ok === true, `Rueckzugsfrist: der Schreibvorgang scheitert (${r.reason})`);
  ok(v.z.netPut === 0, `Rueckzugsfrist: Netlify-PUT ${v.z.netPut} statt 0 — es wurde durchgefallen`);
}

// Ein NETZfehler bleibt gesperrt — ignoreBackoff hebt genau eine Sperre auf,
// nicht die Spam-Bremse.
ok(/if \(force \|\| options\.ignoreBackoff\) return true;/.test(quelle),
  "ignoreBackoff wirkt nicht mehr innerhalb des Rueckzugsfenster-Zweigs");
{
  const netzZweig = quelle.slice(quelle.indexOf("const isNetworkError"), quelle.indexOf("ignoreBackoff) return true"));
  ok(/if \(isNetworkError\) return false;/.test(netzZweig),
    "die Netzfehlersperre steht nicht mehr VOR der ignoreBackoff-Ausnahme — Netzfehler waeren nicht mehr gebremst");
}
// Und ignoreBackoff darf den Abgleichsschalter nicht aushebeln.
ok(/if \(!force && !isAutoSyncEnabled\(\)\) return false;/.test(quelle),
  "die isAutoSyncEnabled-Sperre haengt nicht mehr allein an force — ignoreBackoff koennte sie mit aufreissen");

// ── Bericht ─────────────────────────────────────────────────────────────
if (luecken.length) {
  console.error("F-26 AMBIGUOUS RTDB COMMIT — " + luecken.length + " von " + checks + " Pruefungen:");
  luecken.forEach((l) => console.error("   - " + l));
  process.exit(1);
}
console.log(`f26 ambiguous rtdb commit: ok (${checks} Pruefungen)`);
if (offen.length) {
  console.error("   TODO-Reste vorhanden, obwohl F-26 gebaut ist — bitte aufraeumen:");
  offen.forEach((t) => console.error("   ~ " + t));
  process.exit(1);
}
