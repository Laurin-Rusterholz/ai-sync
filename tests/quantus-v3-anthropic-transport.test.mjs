/*
 * Unabhaengiges Zweitreview von f2d3f68 (F/G-Review-Paket), zwei verbleibende
 * harte Risiken direkt in anthropic-transport.mjs:
 *
 *  #1 "Zeichen/3" (bzw. jede reine Zeichenzaehlung) ist KEINE nachweislich
 *     konservative Tokenobergrenze: mehrbytige UTF-8-Zeichen (Umlaute,
 *     Emoji, CJK) erzeugen mehr Bytes als JS-"Zeichen" (UTF-16-Codeeinheiten)
 *     zaehlen. `estimateRequestTokenCap` muss auf echten UTF-8-Bytes
 *     rechnen, nicht auf `.length`.
 *  #7 Der Zeitgeber wurde VOR dem Lesen des Antwortkoerpers geloescht: ein
 *     Server kann die Kopfzeilen sofort schicken und den Koerper nie (oder
 *     beliebig langsam) liefern — `dispatch()` haette dann ohne Frist
 *     gehangen. Zusaetzlich fehlte eine Bytegrenze fuer den Koerper selbst.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createAnthropicTransport, estimateRequestTokenCap } from "../runtime/quantus-v3/src/anthropic-transport.mjs";

const MODEL_PRICING = Object.freeze({ inputMicrosPerMillionTokens: 2_000_000, outputMicrosPerMillionTokens: 10_000_000 });

function startHttp(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// ── #1: Byte-basierte, nachweislich konservative Obergrenze ──────────────
test("estimateRequestTokenCap rechnet auf UTF-8-Bytes, nicht auf JS-Zeichenlaenge (Unicode unterschaetzt sonst)", () => {
  const asciiMsgs = [{ evidenceRef: "m1", subject: "Hello", snippet: "plain ascii text" }];
  // Gleich viele JS-"Zeichen", aber mehrbytige UTF-8-Kodierung (Umlaute + Emoji).
  const unicodeMsgs = [{ evidenceRef: "m1", subject: "Hällö", snippet: "plän ünicöde text 😀😀" }];
  const asciiCap = estimateRequestTokenCap(asciiMsgs);
  const unicodeCap = estimateRequestTokenCap(unicodeMsgs);
  assert.ok(unicodeCap > asciiCap, `eine mehrbytige Eingabe muss eine HOEHERE Obergrenze ergeben als reine ASCII-Zeichen gleicher .length: ascii=${asciiCap} unicode=${unicodeCap}`);

  // Nachweis, dass es wirklich an Bytes (nicht an .length) haengt: ein
  // reiner CJK-Text hat WENIGER JS-"Zeichen" als sein ASCII-Gegenstueck,
  // aber MEHR UTF-8-Bytes — eine .length-basierte Schaetzung wuerde ihn
  // UNTERSCHAETZEN, eine byte-basierte nicht.
  const cjk = [{ evidenceRef: "m1", subject: "件名", snippet: "本文本文本文本文本文本文本文本文本文本文" }]; // 20 CJK-Zeichen
  const asciiGleicheLaenge = [{ evidenceRef: "m1", subject: "aa", snippet: "aaaaaaaaaaaaaaaaaaaa" }]; // 20 ASCII-Zeichen
  assert.equal(cjk[0].snippet.length, asciiGleicheLaenge[0].snippet.length, "Testaufbau: gleiche .length");
  assert.ok(estimateRequestTokenCap(cjk) > estimateRequestTokenCap(asciiGleicheLaenge),
    "bei gleicher .length muss der bytenlastigere CJK-Text die HOEHERE Obergrenze ergeben");
});

test("estimateRequestTokenCap deckt die tatsaechlich gesendete Bytezahl (System + Nutzerinhalt) ab", async () => {
  const captured = [];
  const server = await startHttp(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    captured.push(Buffer.concat(chunks));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "msg_1", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 5 } }));
  });
  const transport = createAnthropicTransport({ apiKey: "k", model: "claude-sonnet-5", modelPricing: MODEL_PRICING, apiBase: server.base, timeoutMs: 2000 });
  const sourceMessages = [{ evidenceRef: "m1", subject: "Ätzend ünicöde", snippet: "😀 mehrbytige Zeichen überall ÄÖÜ" }];
  const cap = estimateRequestTokenCap(sourceMessages);
  await transport.dispatch({ sourceMessages, requestId: "r1" });
  await server.close();
  const gesendeteBytes = captured[0].byteLength;
  assert.ok(cap >= gesendeteBytes / 4, `die Obergrenze (${cap}) sollte in derselben Groessenordnung wie die gesendeten Rohbytes (${gesendeteBytes}) liegen, nicht winzig dagegen`);
});

// ── #7: Zeitgeber deckt das Lesen des Koerpers, nicht nur die Kopfzeilen ──
test("dispatch() haengt nicht, wenn der Server Kopfzeilen sofort sendet und den Koerper nie liefert", async () => {
  const server = await startHttp(async (req, res) => {
    for await (const _c of req) { /* Anfrage konsumieren */ }
    res.writeHead(200, { "content-type": "application/json" });
    // Koerper wird NIE geschrieben/beendet — die Verbindung bleibt offen.
  });
  const transport = createAnthropicTransport({ apiKey: "k", model: "claude-sonnet-5", modelPricing: MODEL_PRICING, apiBase: server.base, timeoutMs: 200 });
  const start = Date.now();
  const ausgang = await transport.dispatch({ sourceMessages: [{ evidenceRef: "m1", subject: "x", snippet: "y" }], requestId: "r1" });
  const dauer = Date.now() - start;
  await server.close();
  assert.equal(ausgang.outcome, "unknown", `ein ewig haengender Koerper muss 'unknown' ergeben, nicht erfolgreich abschliessen: ${JSON.stringify(ausgang)}`);
  assert.ok(dauer < 5000, `dispatch() haette innerhalb der Frist zurueckkehren muessen, brauchte aber ${dauer}ms`);
});

test("dispatch() bricht eine unbegrenzt/langsam wachsende Antwort ab, statt sie vollstaendig zu puffern", async () => {
  const server = await startHttp(async (req, res) => {
    for await (const _c of req) { /* Anfrage konsumieren */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"id":"msg_1","content":[{"type":"text","text":"');
    // Sehr viele Bytes langsam nachliefern, weit ueber jede sinnvolle
    // Antwortgroesse hinaus — ohne Bytegrenze wuerde dispatch() das
    // unbegrenzt puffern.
    const stueck = "a".repeat(65536);
    let geschrieben = 0;
    const timer = setInterval(() => {
      if (geschrieben > 4_000_000) { clearInterval(timer); res.end(); return; }
      res.write(stueck);
      geschrieben += stueck.length;
    }, 5);
    req.on("close", () => clearInterval(timer));
  });
  const transport = createAnthropicTransport({ apiKey: "k", model: "claude-sonnet-5", modelPricing: MODEL_PRICING, apiBase: server.base, timeoutMs: 10_000 });
  const start = Date.now();
  const ausgang = await transport.dispatch({ sourceMessages: [{ evidenceRef: "m1", subject: "x", snippet: "y" }], requestId: "r1" });
  const dauer = Date.now() - start;
  await server.close();
  assert.equal(ausgang.outcome, "unknown", `eine ueberdimensionierte Antwort muss abgebrochen werden ('unknown'), nicht als Erfolg gelten: ${JSON.stringify(ausgang)}`);
  assert.ok(dauer < 9000, `der Abbruch haette lange vor der 10s-Frist erfolgen sollen (Bytegrenze), brauchte aber ${dauer}ms`);
});
