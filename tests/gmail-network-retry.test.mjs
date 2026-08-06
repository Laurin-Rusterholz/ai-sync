/*
 * Regression: „Failed to fetch" im Gmail-Modul.
 *
 * Beim Oeffnen einer Mail stand im Detailbereich nur „⚠️ Failed to fetch".
 * Diese Meldung kommt nicht vom Backend, sondern direkt vom Browser: fetch()
 * lehnt bei einem echten Netzwerkfehler (Verbindungsabbruch, HTTP/2-Reset,
 * mitten im Stream abreissende Antwort, offline) mit einem TypeError ab, dessen
 * message genau "Failed to fetch" lautet. openMessageById() hat diese message
 * ungefiltert in GM.open.error geschrieben.
 *
 * Beguenstigt wurde der Abbruch dadurch, dass loadMessages() die Metadaten von
 * bis zu 25 Mails mit Promise.all GLEICHZEITIG durch dieselbe Netlify-Funktion
 * geschickt hat. Klickte man waehrenddessen eine Mail an, konkurrierte deren
 * Anfrage mit dem Ansturm — und serverseitig entschieden gleich 25 parallele
 * Function-Instanzen unabhaengig voneinander, dass der Google-Access-Token zu
 * erneuern sei.
 *
 * Der Fix hat drei Teile, die hier festgehalten werden:
 *   1. gmApi() wiederholt LESENDE Aufrufe nach einem Netzwerkfehler und meldet
 *      im Fehlerfall Klartext statt „Failed to fetch". Schreibende Aufrufe
 *      werden NICHT wiederholt (messages/send wuerde sonst doppelt senden).
 *   2. Die Metadaten der Liste laufen ueber einen Pool mit begrenzter
 *      Parallelitaet statt ueber Promise.all.
 *   3. Der Fehlerzustand der Detailansicht bietet „Erneut versuchen" an.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

// ── 1. gmApi() faengt Netzwerkfehler ab und wiederholt lesende Aufrufe ──────
const gmApiStart = index.indexOf("async function gmApi(method, path, opts){");
assert.ok(gmApiStart > 0, "gmApi() nicht gefunden");
const gmApi = index.slice(gmApiStart, index.indexOf("async function gmMapPool"));
assert.ok(gmApi.length > 300, "gmApi()/gmMapPool() nicht in erwarteter Reihenfolge gefunden");

assert.doesNotMatch(
  gmApi,
  /^\s*var r = await fetch\("\/\.netlify\/functions\/gmail-api"/m,
  "gmApi() ruft fetch() wieder ungeschuetzt auf — ein Verbindungsabbruch landet dann erneut als „Failed to fetch\" in der Oberflaeche",
);
assert.match(gmApi, /catch\s*\(err\)\s*\{/, "gmApi() faengt den fetch-Fehler nicht ab");
assert.match(gmApi, /GM_NET_ERR/, "gmApi() meldet im Netzwerkfehlerfall keinen Klartext");
// Nur GET wird wiederholt — ein zweiter Versuch von messages/send waere fatal.
assert.match(
  gmApi,
  /var retries = \(String\(method\|\|"GET"\)\.toUpperCase\(\)==="GET"\) \? 3 : 0;/,
  "gmApi() unterscheidet nicht mehr zwischen lesenden und schreibenden Aufrufen — schreibende duerfen nicht wiederholt werden",
);
assert.match(gmApi, /await gmSleep\(400 \* Math\.pow\(2, attempt\)\)/, "gmApi() wartet zwischen den Versuchen nicht mit wachsender Pause");

// Die Hilfsfunktionen selbst muessen vorhanden sein.
assert.match(index, /function gmIsNetErr\(e\)\{ return !!e && \(e\.name==="TypeError" \|\| e\.name==="AbortError"\); \}/,
  "gmIsNetErr() fehlt oder erkennt Abbruch/Timeout nicht mehr");
assert.match(index, /var GM_NET_ERR = "Netzwerkfehler/, "GM_NET_ERR fehlt");
assert.match(index, /var GM_RPC_TIMEOUT = \d+;/, "GM_RPC_TIMEOUT fehlt — Aufrufe koennen wieder unbegrenzt haengen");

// Der Antwortkoerper muss noch im Wiederholungsfenster gelesen werden, sonst
// wirft eine mitten im Stream abreissende Antwort ausserhalb des Retries.
const gmRpcOnce = index.slice(index.indexOf("async function gmRpcOnce"), gmApiStart);
assert.match(gmRpcOnce, /return \{ res: r, text: await r\.text\(\) \};/,
  "gmRpcOnce() liest den Antwortkoerper nicht mehr innerhalb des Wiederholungsfensters");
assert.match(gmRpcOnce, /new AbortController\(\)/, "gmRpcOnce() bricht haengende Aufrufe nicht mehr ab");

// Auch der Status-Aufruf darf „Failed to fetch" nicht mehr durchreichen.
const gmAuthCall = index.slice(index.indexOf("async function gmAuthCall(action){"), index.indexOf("// ── Netzwerk-robuster Aufruf"));
assert.match(gmAuthCall, /catch\(err\)\{[\s\S]*?GM_NET_ERR/, "gmAuthCall() reicht Netzwerkfehler wieder ungefiltert durch");

// ── 2. Metadaten der Liste laufen gedrosselt ───────────────────────────────
assert.match(index, /async function gmMapPool\(items, limit, worker\)\{/, "gmMapPool() fehlt");
const loadMessages = index.slice(index.indexOf("async function loadMessages(reset){"), index.indexOf("async function openMessageById"));
assert.ok(loadMessages.length > 500, "loadMessages() nicht gefunden");
assert.match(
  loadMessages,
  /var metas = await gmMapPool\(ids, 5, function\(id\)\{/,
  "loadMessages() laedt die Metadaten wieder ungedrosselt",
);
assert.doesNotMatch(
  loadMessages,
  /await Promise\.all\(ids\.map\(/,
  "loadMessages() feuert wieder alle Metadaten-Anfragen auf einen Schlag ab",
);

// ── 3. Detailansicht bietet einen erneuten Versuch an ──────────────────────
assert.match(
  index,
  /GM\.open = \{ error: e\.message\|\|"Nachricht konnte nicht geladen werden", failedId: id \};/,
  "openMessageById() merkt sich die fehlgeschlagene messageId nicht — „Erneut versuchen\" kann nicht greifen",
);
assert.match(
  index,
  /window\.gmailRetryOpen = function\(\)\{ var id = GM\.open && GM\.open\.failedId; if \(id\) openMessageById\(id\); \};/,
  "gmailRetryOpen() fehlt",
);
assert.match(index, /onclick="gmailRetryOpen\(\)"/, "die Fehleransicht bietet keinen erneuten Versuch an");

console.log("gmail network retry: ok");
