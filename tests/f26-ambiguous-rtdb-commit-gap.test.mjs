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
 * WAS DIESER WAECHTER TUT
 * Abschnitt 1 haelt den HEUTIGEN, fail-closed Zustand fest. Diese Pruefungen
 * sind scharf: faellt eine, ist ein unbedingter oder ungedeckter Kern-Write
 * moeglich geworden.
 * Abschnitt 2 beschreibt die GEWUENSCHTE, noch NICHT gebaute Invariante
 * (Read-after-ambiguous-error) als sichtbares TODO. Sie ist rot und laesst die
 * Suite bewusst gruen — F-26 ist erfasst, nicht behoben.
 * Abschnitt 3 ist die Sicherheitsinvariante zu Abschnitt 2 (siehe unten).
 * Abschnitt 4 haelt die offene Kausalitaetsfrage fest.
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
 * KEIN PRODUKTIONSCODE. Kein Netz. Die Attrappe fuer fetchWithTimeout wirft,
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

function umgebung({ rtdbLesenOk = true, transaktion = "ambiguous" } = {}) {
  const z = { rtdbGet: 0, rtdbTxn: 0, netGet: 0, netPut: 0, serverCommits: 0 };
  const meldungen = [];
  let SERVER = {
    data: JSON.stringify({
      entities: { notes: { behalten: { id: "behalten" }, [NOTE_WEG]: { id: NOTE_WEG } } },
      meta: { updatedAt: "2026-08-26T09:00:00.000Z" },
    }),
    etag: "srv-1",
  };
  let gesendeterIfMatch = "__nie_aufgerufen__";

  const APP = { state: {
    settings: { storage: { blobKey: KERN_KEY, putUrl: "https://beispiel/{key}", authToken: null } },
    // Ein ALTER ETag aus einem frueheren Netlify-Lesevorgang. Er darf den
    // Riegel nicht retten: der gesunde RTDB-Read nullt ihn.
    storage: { etag: "ALT-ETAG-aus-frueherem-Netlify-Lesevorgang", lastRemoteSeenAt: 0 },
    data: {},
  } };
  const _cloudHealth = { rtdb: {}, netlify: {}, firebase: {}, lastGoodProvider: null };
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
      if (transaktion === "ambiguous") {
        if (neu !== undefined) { SERVER = { data: neu.data, etag: "srv-2" }; z.serverCommits++; }
        onComplete(new Error("transaction at /appStore/app-data_json failed: disconnect"), false, null);
      } else {
        onComplete(null, true, { val: () => neu });
      }
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
    ifMatch: () => gesendeterIfMatch,
  };
}

// Der lokale Stand NACH dem bestaetigten Loeschen: Entitaet weg, Grabstein da.
const NACH_DEM_LOESCHEN = {
  entities: { notes: { behalten: { id: "behalten" } } },
  _deleteLog: { note: { [NOTE_WEG]: GRABSTEIN_TS } },
  meta: { updatedAt: "2026-08-26T10:01:41.416Z" },
};

// ═══ 1. HEUTIGER ZUSTAND: fail-closed. Diese Pruefungen sind scharf. ═════
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

// Kein zweiter Anbieter hat den Kern angefasst.
ok(u.z.netGet === 0, `Netlify-GET ${u.z.netGet} statt 0 — es wurde nachtraeglich ein ETag geholt`);
ok(u.z.netPut === 0,
  `Netlify-NETZWERK-PUT ${u.z.netPut} statt 0 — DER RIEGEL IST OFFEN: ein unbedingter Kern-Write ` +
  "auf einen soeben committeten Stand ist wieder moeglich (F-25-Verlustklasse)");
ok(u.ifMatch() === "__nie_aufgerufen__", "es ging doch ein Netlify-PUT hinaus");

// Der gesunde RTDB-Read nullt den ETag — deshalb kann der Failover nicht.
ok(u.APP.state.storage.etag === null,
  `storage.etag ist ${JSON.stringify(u.APP.state.storage.etag)} statt null — ` +
  "der gesunde RTDB-Lesevorgang nullt ihn nicht mehr; die Ursachenkette des Befunds hat sich verschoben");

// Das Clientresultat: fail-closed, aber mit dem FALSCHEN Anbieter und der
// falschen Ursache. Der RTDB-Fehler wird in remotePutByKey von 'last'
// ueberschrieben und ueberlebt nur in der Konsole.
ok(res.ok === false, "der Schreibvorgang meldete Erfolg, obwohl der Ausgang unbekannt war");
ok(res.reason === "missing_if_match",
  `Clientresultat "${res.reason}" statt missing_if_match`);
ok(res.provider === "netlify",
  `Clientresultat meldet provider "${res.provider}" — erwartet netlify (der RTDB-Fehler geht verloren)`);
ok(!res.casProof, "es wurde ein CAS-Beweis gemeldet, obwohl nichts bedingt geschrieben wurde");

// Genau ein Versuch: der Grund ist kein Konflikt, also keine Wiederholung.
ok(res.attempts === undefined && u.z.rtdbTxn === 1,
  "es lief eine zweite Transaktion — ein ambiguer Ausgang darf nicht blind wiederholt werden");

// Die drei Live-Meldungen, in dieser Reihenfolge.
ok(/rtdb temporarily paused/.test(u.meldungen[0] || ""),
  `erste Meldung: ${JSON.stringify(u.meldungen[0])} — erwartet die rtdb-Pause`);
ok(/disconnect/.test(u.meldungen[0] || ""), "die Pause nennt den Verbindungsabbruch nicht");
ok(/ohne If-Match abgewiesen/.test(u.meldungen[1] || ""),
  `zweite Meldung: ${JSON.stringify(u.meldungen[1])} — erwartet die Riegel-Meldung`);

// Das Backoff-Fenster: 'disconnect' trifft keinen Netz-Regex, also die
// Zaehlregel — rund fuenf Sekunden, in denen der Kern-Write deterministisch
// scheitert. Kein Zufall, ein Fenster.
{
  const bis = u._cloudHealth.rtdb.backoffUntil || 0;
  const ms = bis - Date.now();
  ok(ms > 3000 && ms <= 5000, `rtdb-Backoff ${ms} ms — erwartet rund 5000 (5000 * failCount)`);
}

// ═══ 2. F-26 — DIE NOCH NICHT GEBAUTE INVARIANTE (TODO/SKIP) ════════════
// Read-after-ambiguous-error: nach einem Schreibvorgang mit unbekanntem
// Ausgang muss der Client den Kernknoten LESEN und den Ausgang feststellen,
// statt zum naechsten Anbieter durchzufallen.
todo(res.ok === true,
  "F-26: ein serverseitig erfolgter Commit wird dem Aufrufer weiterhin als Fehlschlag gemeldet " +
  "(Read-after-ambiguous-error fehlt) — der Server traegt den neueren Stand, der Client sagt das Gegenteil");
todo(res.ambiguous === true || res.reason === "ambiguous_unverified",
  "F-26: der unbekannte Ausgang wird nicht als solcher gekennzeichnet — 'nicht geschrieben' und " +
  "'Ausgang unbekannt' sind im Resultat immer noch dasselbe");
todo(u.z.netGet > 0 || (res.casProof && /ambiguous/.test(res.casProof.kind || "")),
  "F-26: es findet keine Verifikation des RTDB-Ausgangs statt — weder ein Lesevorgang noch ein Beweis");
todo(res.provider === "rtdb",
  "F-26: der Ausloeser (rtdb) geht im Resultat verloren, gemeldet wird der Folgeanbieter (netlify) — " +
  "die Diagnose zeigt auf den falschen Speicher");

// Es gibt heute keine Read-after-error-Verifikation im Quelltext. Die einzige
// Read-back-Pruefung haengt am ERFOLGSzweig des manuellen Transferpfads
// (if (okResults.length > 0)) und ist damit in genau diesem Fall unzustaendig.
{
  const rb = index.indexOf("const readBack = await fetchRemoteCandidates(");
  const davor = rb > 0 ? index.slice(Math.max(0, rb - 400), rb) : "";
  ok(rb > 0 && /okResults\.length > 0/.test(davor),
    "die bekannte Read-back-Pruefung sitzt nicht mehr am Erfolgszweig — die Lagebeschreibung von F-26 stimmt nicht mehr");
  todo(false,
    "F-26: die einzige Read-back-Verifikation laeuft nur nach ERFOLG und nur im manuellen Transferpfad; " +
    "der automatische Speicherweg hat keine");
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

// ═══ 4. KAUSALITAETSALTERNATIVE — offen, bewusst nicht angetastet ════════
// deleteEntity() und das anschliessende NoteFlow-save() rufen BEIDE den
// Scheduler. Der konkrete Livelauf kann deshalb nicht belegen, ob der
// fehlergemeldete Versuch SELBST committete oder ob ein spaeterer
// Scheduler-Durchlauf den Stand schrieb und der erste tatsaechlich nichts tat.
// Beide Verlaeufe erzeugen dieselbe Beobachtung (Grabstein remote da, Client
// meldet Fehler). Unterscheidbar waeren sie nur mit einer Write-Attempt-Id, die
// den Schreibvorgang bis in den gespeicherten Wrapper markiert.
// Die Schedulerlogik wird in diesem Auftrag NICHT geaendert.
{
  const de = index.indexOf("\nfunction deleteEntity(");
  const deKoerper = index.slice(de, index.indexOf("\n}\n", de));
  ok(/scheduleSave\(\)/.test(deKoerper), "deleteEntity stoesst den Scheduler nicht mehr an");
  const nf = index.indexOf("  function deleteNote(id) {");
  const nfKoerper = index.slice(nf, index.indexOf("\n  }\n", nf));
  ok(/\bsave\(\);/.test(nfKoerper), "deleteNote ruft save() nicht mehr");
  ok(/const save = \(\) => \{ try \{ window\.scheduleSave/.test(index),
    "das NoteFlow-save() geht nicht mehr ueber window.scheduleSave — die Doppelanstoss-Lage hat sich geaendert");

  // Der gespeicherte Wrapper traegt savedAt/savedBy/updatedAt — savedBy ist die
  // GERAETE-Kennung, keine Kennung DIESES Schreibversuchs. Damit laesst sich
  // ein Commit keinem Versuch zuordnen.
  ok(/savedBy: myDevice/.test(quelle),
    "der Wrapper traegt savedBy nicht mehr aus der Geraetekennung — die Zuordnungsluecke hat sich geaendert");
  ok(!/attemptId|writeAttempt|versuchsId/i.test(quelle),
    "es gibt bereits eine Write-Attempt-Id im Schreibpfad — dann ist die Kausalitaetsfrage entscheidbar " +
    "und dieser Abschnitt veraltet");
  todo(false,
    "F-26: ohne Write-Attempt-Id im gespeicherten Wrapper laesst sich nicht entscheiden, ob der " +
    "fehlergemeldete Versuch selbst committete oder ein spaeterer Scheduler-Durchlauf");
}

// ── Bericht ─────────────────────────────────────────────────────────────
if (luecken.length) {
  console.error("F-26 AMBIGUOUS RTDB COMMIT — " + luecken.length + " von " + checks + " Pruefungen:");
  luecken.forEach((l) => console.error("   - " + l));
  process.exit(1);
}
console.log(`f26 ambiguous rtdb commit gap: ok (${checks - offen.length} Pruefungen)`);
console.log(`   TODO/SKIP — F-26 offen, ${offen.length} Invariante(n) noch rot (Suite bleibt bewusst gruen):`);
offen.forEach((t) => console.log("   ~ " + t));
