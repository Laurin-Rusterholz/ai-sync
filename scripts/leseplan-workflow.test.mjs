import { readFileSync } from "node:fs";
const wf = JSON.parse(readFileSync("n8n/leseplan.workflow.json", "utf8"));
const code = name => wf.nodes.find(n => n.name === name).parameters.jsCode;
function run(js, ctx) { return new Function("$", "$json", "$input", js)(ctx.$, ctx.$json, ctx.$input); }

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) pass++; else { fail++; console.log("FAIL:", n, e != null ? JSON.stringify(e) : ""); } };

const bodyHtml = "<h1>Doku</h1>" + Array.from({ length: 8 }, (_, i) => `<h2>Kapitel ${i + 1}</h2><p>${Array.from({ length: 400 }).map(() => "wort").join(" ")}</p>`).join("");

// 1) Ingest: valides Dokument
{
  const mk$ = (name) => ({ first: () => ({ json: name === "Webhook: leseplan-ingest" ? { body: { title: "", zieldatum: "2026-08-20", html: bodyHtml } } : { wordsPerMinute: 200, minMinutesPerUnit: 10, timezone: "Europe/Zurich" } }) });
  const out = run(code("Aufteilen + Tempo planen"), { $: mk$, $json: {}, $input: null });
  const r = out[0].json;
  ok("ingest ok", r.ok === true, r.error);
  ok("ingest hat docId+doc", !!r.docId && !!r.doc, r);
  ok("ingest einheiten>0", r.einheiten > 0, r.einheiten);
  ok("ingest doc.plan referenziert sektionen", r.doc.plan.every(sl => sl.sektionIds.every(id => r.doc.sektionen[id])), true);
  globalThis.__doc = r.doc; globalThis.__docId = r.docId;
}
// 1b) Ingest: Vergangenheit
{
  const mk$ = (name) => ({ first: () => ({ json: name === "Webhook: leseplan-ingest" ? { body: { zieldatum: "2000-01-01", html: bodyHtml } } : { timezone: "Europe/Zurich" } }) });
  const out = run(code("Aufteilen + Tempo planen"), { $: mk$, $json: {}, $input: null });
  ok("ingest Vergangenheit -> ok:false", out[0].json.ok === false, out[0].json);
}
// 1c) Ingest: leeres html
{
  const mk$ = (name) => ({ first: () => ({ json: name === "Webhook: leseplan-ingest" ? { body: { zieldatum: "2026-09-01", html: "" } } : {} }) });
  const out = run(code("Aufteilen + Tempo planen"), { $: mk$, $json: {}, $input: null });
  ok("ingest leer -> ok:false", out[0].json.ok === false, out[0].json);
}

// 2) Daily select: faellige Einheit finden (heute liegt nach dem ersten Slot)
{
  const doc = globalThis.__doc, docId = globalThis.__docId;
  // Setze ersten Slot-datum auf ein sicher vergangenes Datum, damit heute >= datum
  doc.plan[0].datum = "2020-01-01";
  const docs = {}; docs[docId] = doc;
  const mk$ = (name) => ({
    first: () => ({ json: name === "RTDB: config lesen (Daily)" ? { timezone: "Europe/Zurich" } : name === "RTDB: docs lesen" ? docs : {} })
  });
  const out = run(code("Faellige Einheiten waehlen"), { $: mk$, $json: {}, $input: null });
  ok("daily: mind. eine faellige Einheit", out.length >= 1, out.length);
  ok("daily: item hat docId+index+system+userText", out[0] && out[0].json.docId === docId && out[0].json.index === 0 && !!out[0].json.system && !!out[0].json.userText, out[0] && out[0].json);
  globalThis.__selItems = out;
}
// 2b) Daily select: bereits aufbereitete Einheit wird uebersprungen
{
  const doc = globalThis.__doc, docId = globalThis.__docId;
  const docs = {}; docs[docId] = doc;
  const ab = {}; ab[docId] = { 0: { zusammenfassung: "x" } };  // index 0 schon aufbereitet
  const mk$ = (name) => ({
    first: () => ({ json: name === "RTDB: config lesen (Daily)" ? { timezone: "Europe/Zurich" } : name === "RTDB: docs lesen" ? docs : name === "RTDB: aufbereitung lesen" ? ab : {} })
  });
  const out = run(code("Faellige Einheiten waehlen"), { $: mk$, $json: {}, $input: null });
  // index 0 uebersprungen; naechste faellige nur falls datum<=heute (die anderen liegen in Zukunft) -> evtl. 0
  ok("daily: aufbereitete Einheit uebersprungen (index!=0)", out.every(i => i.json.index !== 0), out.map(i => i.json.index));
}

// 3) Aufbereitung bauen: Anthropic-Antwort (mit thinking-Block) parsen
{
  const sel = globalThis.__selItems;
  const anthropicItems = sel.map(() => ({ json: { content: [{ type: "thinking", thinking: "…" }, { type: "text", text: '{"zusammenfassung":"Kurz.","kernpunkte":["A","B","C"]}' }] } }));
  const mk$ = (name) => name === "Faellige Einheiten waehlen" ? { all: () => sel } : ({ all: () => sel });
  const $input = { all: () => anthropicItems };
  const out = run(code("Aufbereitung bauen"), { $: mk$, $json: {}, $input });
  ok("build: aufbereitung erzeugt", out.length === sel.length, out.length);
  ok("build: zusammenfassung+kernpunkte geparst", out[0].json.aufbereitung.zusammenfassung === "Kurz." && out[0].json.aufbereitung.kernpunkte.length === 3, out[0].json.aufbereitung);
  ok("build: docId+index durchgereicht", out[0].json.docId === globalThis.__docId && out[0].json.index === sel[0].json.index, out[0].json);
}

console.log(`\nWorkflow-Exec: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
