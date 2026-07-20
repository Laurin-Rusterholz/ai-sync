#!/usr/bin/env node
// Reiner Reducer-Test der Polaris-Inbox-Merge-Logik — OHNE echtes Firebase/DOM.
//
//   node scripts/polaris-inbox-merge.test.mjs
//
// Extrahiert die reinen Funktionen (plParseTs, plInboxDecide, plInboxScrub)
// direkt aus public/index.html, damit der Test mit dem echten Code synchron
// bleibt, und prüft die Merge-Entscheidungen sowie das Feld-Scrubbing.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'public/index.html'), 'utf8');

function extract(name) {
  const start = html.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('Funktion nicht gefunden: ' + name);
  let depth = 0, started = false, end = start;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') { depth--; if (started && depth === 0) { end = i + 1; break; } }
  }
  return html.slice(start, end);
}

// Regex direkt aus index.html ziehen, damit der Test die ECHTE (erweiterte)
// BLOCK-Feldliste prüft statt einer veralteten Kopie.
function extractLine(prefix) {
  const start = html.indexOf(prefix);
  if (start < 0) throw new Error('Zeile nicht gefunden: ' + prefix);
  return html.slice(start, html.indexOf('\n', start)).trim();
}
const SENSITIVE = extractLine('const POLARIS_SENSITIVE_RE =');
const src = [SENSITIVE, extract('plParseTs'), extract('plInboxDecide'), extract('plInboxScrub'),
  'return { plParseTs, plInboxDecide, plInboxScrub };'].join('\n');
const { plParseTs, plInboxDecide, plInboxScrub } = new Function(src)();

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) console.log('OK  ' + label);
  else { fails++; console.log('FAIL ' + label, detail !== undefined ? JSON.stringify(detail) : ''); }
};

// ── plInboxDecide: create/update/delete/skip ──
check('create: kein existing → create', plInboxDecide(null, { op: 'create', updatedAt: 100 }) === 'create');
check('create: fehlende op → create', plInboxDecide(null, { updatedAt: 100 }) === 'create');
check('update: Polaris neuer → update', plInboxDecide({ updatedAt: 100 }, { op: 'update', updatedAt: 200 }) === 'update');
check('update: Polaris älter → skip (LWW schützt App-Stand)', plInboxDecide({ updatedAt: 300 }, { op: 'update', updatedAt: 200 }) === 'skip');
check('update: gleich alt → skip', plInboxDecide({ updatedAt: 200 }, { op: 'update', updatedAt: 200 }) === 'skip');
check('update: kein existing → create', plInboxDecide(null, { op: 'update', updatedAt: 200 }) === 'create');
check('delete: existing → delete (soft)', plInboxDecide({ updatedAt: 100 }, { op: 'delete' }) === 'delete');
check('delete: kein existing → skip', plInboxDecide(null, { op: 'delete' }) === 'skip');
check('delete: bereits deleted → skip (idempotent)', plInboxDecide({ status: 'deleted' }, { op: 'delete' }) === 'skip');
check('processedAt gesetzt → skip (nie doppelt mergen)', plInboxDecide(null, { op: 'create', processedAt: 1, updatedAt: 100 }) === 'skip');
check('unbekannte op → skip', plInboxDecide(null, { op: 'frobnicate', updatedAt: 100 }) === 'skip');
check('null/leer entry → skip', plInboxDecide(null, null) === 'skip');
check('ISO-updatedAt neuer erkannt', plInboxDecide({ updatedAt: '2026-01-01T00:00:00Z' }, { op: 'update', updatedAt: '2026-06-01T00:00:00Z' }) === 'update');
check('ts als Fallback für updatedAt', plInboxDecide({ createdAt: 100 }, { op: 'update', ts: 200 }) === 'update');
check('polarisTs hat Vorrang vor updatedAt (gleich-zu-gleich)', plInboxDecide({ polarisTs: 500, updatedAt: 1 }, { op: 'update', updatedAt: 400 }) === 'skip' && plInboxDecide({ polarisTs: 500, updatedAt: 1 }, { op: 'update', updatedAt: 600 }) === 'update');

// ── plParseTs ──
check('parseTs: Zahl', plParseTs(1700000000000) === 1700000000000);
check('parseTs: numerischer String', plParseTs('1700000000000') === 1700000000000);
check('parseTs: ISO', plParseTs('2026-07-15T00:00:00Z') === Date.parse('2026-07-15T00:00:00Z'));
check('parseTs: null → 0', plParseTs(null) === 0);
check('parseTs: Müll → 0', plParseTs('kein datum') === 0);

// ── plInboxScrub: sensible Felder entfernen ──
const s = plInboxScrub({ title: 'X', password: 'g', pin: '1', iban: 'CH', bic: 'B', apikey: 'k', api_key: 'k', token: 't', secret: 's', cvv: '1', description: 'ok' });
check('scrub: alle sensiblen Felder weg', ['password','pin','iban','bic','apikey','api_key','token','secret','cvv'].every(k => !(k in s)), Object.keys(s));
check('scrub: harmlose Felder bleiben', s.title === 'X' && s.description === 'ok');
check('scrub: case-insensitive', !('Passwort' in plInboxScrub({ Passwort: 'x', ok: 1 })) && !('APIKEY' in plInboxScrub({ APIKEY: 'y' })));
const nested = plInboxScrub({ title: 'T', meta: { token: 'abc', note: 'sichtbar' }, tags: ['a', 'b'] });
check('scrub: rekursiv in verschachtelten Objekten', !('token' in nested.meta) && nested.meta.note === 'sichtbar');
check('scrub: Arrays bleiben erhalten', Array.isArray(nested.tags) && nested.tags.length === 2);
// erweiterte BLOCK-Feldliste (pass, cardnumber, card_number)
const s2 = plInboxScrub({ title: 'Y', pass: 'x', cardnumber: '4111', card_number: '4111', cardNumber: '4111', ok: 1 });
check('scrub: pass/cardnumber/card_number/cardNumber weg', !('pass' in s2) && !('cardnumber' in s2) && !('card_number' in s2) && !('cardNumber' in s2) && s2.ok === 1, Object.keys(s2));

console.log(fails === 0 ? '\nALLE INBOX-REDUCER-TESTS OK' : '\n' + fails + ' TEST(S) FEHLGESCHLAGEN');
process.exit(fails ? 1 : 0);
