#!/usr/bin/env node
// Validiert n8n-Workflow-Exporte auf Syntaxfehler:
//
//   node scripts/validate-n8n-workflow.js [datei1.json datei2.json ...]
//   (ohne Argumente: n8n/nobraine-weekly-planner.workflow.json)
//
// Geprueft wird:
//   1. Datei ist valides JSON
//   2. Grundstruktur: nodes[] + connections{}; alle Verbindungen zeigen auf existierende Nodes
//   3. jeder Code-Node (parameters.jsCode) parst als JavaScript
//      (new Function = reines Parsen ueber die JS-Engine, KEINE Ausfuehrung)
//   4. jede n8n-Expression ("=... {{ ... }} ...") parst als JavaScript-Ausdruck;
//      bei "}}" innerhalb des Ausdrucks wird das naechst-laengere Ende probiert,
//      bis ein Kandidat parst (balancierte Ausdruecke)
//   5. keine unsichtbaren Unicode-Zeichen (Zero-Width-Space/-Joiner, BOM,
//      Word-Joiner, Soft-Hyphen) in Code oder Expressions
//   6. "jsonBody"-Felder (HTTP-Request mit specifyBody: "json"): ohne Expression
//      valides JSON, als Expression ohne echte Zeilenumbrueche und kurz gehalten
import { readFileSync } from 'node:fs';

const UNSICHTBAR = /[\u200B\u200C\u200D\u2060\uFEFF\u00AD]/g;

// n8n JSON.parst den aufgeloesten Wert des Feldes \u201EJSON Body". Ein langer
// Inline-Body (z. B. ein kompletter LLM-Prompt in einer {{ \u2026 }}-Expression) ist
// dort die haeufigste Fehlerquelle \u2014 n8n meldet dann \u201EThe value in 'JSON Body'
// field is not valid JSON". Solche Bodies gehoeren in einen Code-Node davor; das
// Feld enthaelt dann nur noch {{ JSON.stringify($json.<feld>) }}.
const JSONBODY_MAX = 400;

function jsParsbar(quelle) {
  try { new Function(quelle); return null; } catch (e) { return e.message; }
}

function exprParsbar(ausdruck) {
  try { new Function('return (' + ausdruck + '\n);'); return null; } catch (e) { return e.message; }
}

function zeileVonIndex(text, index) {
  return text.slice(0, index).split('\n').length;
}

function unsichtbareZeichen(text, kontext, fehler) {
  UNSICHTBAR.lastIndex = 0;
  let m;
  while ((m = UNSICHTBAR.exec(text)) !== null) {
    const code = m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
    fehler.push(kontext + ': unsichtbares Zeichen U+' + code + ' (Zeile ' + zeileVonIndex(text, m.index) + ', Index ' + m.index + ')');
  }
}

function expressionsPruefen(text, kontext, fehler) {
  let i = 0;
  while ((i = text.indexOf('{{', i)) !== -1) {
    let j = text.indexOf('}}', i + 2);
    if (j === -1) {
      fehler.push(kontext + ': "{{" ohne schliessendes "}}"');
      return;
    }
    let ok = false;
    let ersterFehler = null;
    let ende = j;
    while (j !== -1) {
      const kandidat = text.slice(i + 2, j);
      const f = exprParsbar(kandidat);
      if (f === null) { ok = true; ende = j; break; }
      if (ersterFehler === null) ersterFehler = f;
      ende = j;
      j = text.indexOf('}}', j + 1);
    }
    if (!ok) {
      const ausschnitt = text.slice(i, Math.min(i + 140, text.length)).replace(/\n/g, '\\n');
      fehler.push(kontext + ': Expression nicht parsebar — ' + ersterFehler + ' — Ausschnitt: ' + ausschnitt);
    }
    i = ende + 2;
  }
}

function jsonBodyPruefen(text, kontext, fehler) {
  if (!text.startsWith('=')) {
    try { JSON.parse(text); }
    catch (e) { fehler.push(kontext + ': jsonBody ohne Expression ist kein valides JSON — ' + e.message); }
    return;
  }
  const ausdruck = text.slice(1);
  if (/[\n\r\t]/.test(ausdruck)) {
    fehler.push(kontext + ': jsonBody-Expression enthaelt echte Zeilenumbrueche/Tabs — n8n kann den Body dann nicht parsen ' +
      '(mehrzeiligen Text in einen Code-Node auslagern)');
  }
  if (ausdruck.length > JSONBODY_MAX) {
    fehler.push(kontext + ': jsonBody-Expression ist ' + ausdruck.length + ' Zeichen lang (Limit ' + JSONBODY_MAX + ') — ' +
      'Body in einem Code-Node bauen und hier nur {{ JSON.stringify($json.<feld>) }} verwenden');
  }
}

function alleStringsBesuchen(wert, pfad, cb) {
  if (typeof wert === 'string') { cb(wert, pfad); return; }
  if (Array.isArray(wert)) { wert.forEach((v, idx) => alleStringsBesuchen(v, pfad + '[' + idx + ']', cb)); return; }
  if (wert && typeof wert === 'object') {
    for (const [k, v] of Object.entries(wert)) alleStringsBesuchen(v, pfad ? pfad + '.' + k : k, cb);
  }
}

function workflowPruefen(datei) {
  const fehler = [];
  let roh;
  try { roh = readFileSync(datei, 'utf8'); }
  catch (e) { return { datei, fehler: ['Datei nicht lesbar: ' + e.message], geprueft: 0 }; }

  let wf;
  try { wf = JSON.parse(roh); }
  catch (e) { return { datei, fehler: ['Kein valides JSON: ' + e.message], geprueft: 0 }; }

  if (!Array.isArray(wf.nodes) || wf.nodes.length === 0) fehler.push('nodes[] fehlt oder ist leer');
  if (!wf.connections || typeof wf.connections !== 'object') fehler.push('connections{} fehlt');

  const nodeNamen = new Set((wf.nodes || []).map((n) => n && n.name));
  for (const [von, ausgaenge] of Object.entries(wf.connections || {})) {
    if (!nodeNamen.has(von)) fehler.push('connections: Quell-Node "' + von + '" existiert nicht');
    for (const liste of Object.values(ausgaenge || {})) {
      for (const zweig of (Array.isArray(liste) ? liste : [])) {
        for (const ziel of (Array.isArray(zweig) ? zweig : [])) {
          if (ziel && !nodeNamen.has(ziel.node)) fehler.push('connections: Ziel-Node "' + ziel.node + '" existiert nicht');
        }
      }
    }
  }

  let geprueft = 0;
  for (const node of wf.nodes || []) {
    if (!node || !node.parameters) continue;
    if (node.type === 'n8n-nodes-base.stickyNote') continue; // reine Doku, kein Code
    const basis = 'Node "' + (node.name || node.id || '?') + '"';
    alleStringsBesuchen(node.parameters, '', (text, pfad) => {
      const kontext = basis + (pfad ? ' → ' + pfad : '');
      if (pfad === 'jsCode' || pfad.endsWith('.jsCode')) {
        geprueft++;
        unsichtbareZeichen(text, kontext, fehler);
        const f = jsParsbar(text);
        if (f) fehler.push(kontext + ': JS-Syntaxfehler — ' + f);
      } else if (pfad === 'jsonBody' || pfad.endsWith('.jsonBody')) {
        geprueft++;
        unsichtbareZeichen(text, kontext, fehler);
        if (text.includes('{{')) expressionsPruefen(text, kontext, fehler);
        jsonBodyPruefen(text, kontext, fehler);
      } else if (text.includes('{{')) {
        geprueft++;
        unsichtbareZeichen(text, kontext, fehler);
        expressionsPruefen(text, kontext, fehler);
      }
    });
  }
  return { datei, fehler, geprueft };
}

const dateien = process.argv.slice(2);
if (dateien.length === 0) dateien.push('n8n/nobraine-weekly-planner.workflow.json');

let gesamtFehler = 0;
for (const datei of dateien) {
  const r = workflowPruefen(datei);
  if (r.fehler.length === 0) {
    console.log('OK   ' + r.datei + ' — valides JSON, ' + r.geprueft + ' Code-Bloecke/Expressions geparst, 0 Fehler');
  } else {
    gesamtFehler += r.fehler.length;
    console.log('FAIL ' + r.datei + ' — ' + r.fehler.length + ' Fehler:');
    for (const f of r.fehler) console.log('     • ' + f);
  }
}
process.exit(gesamtFehler === 0 ? 0 : 1);
