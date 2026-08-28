/*
 * Budget: Loeschungen hinterlassen einen Grabstein, und ein Reiterklick
 * schreibt nicht die ganze Wolke.
 *
 * BEFUND 1 — LOESCHEN OHNE GRABSTEIN
 * Fuenf Budget-Loeschungen liefen als rohes `delete` am Loeschweg vorbei:
 *   delete APP.state.data.entities.accounts[id]        (Konto)
 *   delete APP.state.data.entities.subscriptions[id]   (Abo)
 *   delete APP.state.data.entities.transactions[id]    (Buchung)
 *   delete APP.state.data.entities.creditCards[id]     (Kreditkarte)
 *   delete APP.state.data.entities.financialGoals[id]  (Sparziel)
 * Nur deleteEntity() ruft logDeletion() und legt damit einen Grabstein in
 * _deleteLog. Ohne ihn ist eine Loeschung fuer den Merge nicht von "kenne ich
 * nicht" zu unterscheiden: das naechste Geraet bringt den Eintrag zurueck.
 * Genau diese Klasse hat schon einmal Journaleintraege gekostet (CLAUDE.md,
 * Fallstrick 2) und war der Kern von F-25.
 *
 * BEFUND 2 — ANSICHTSZUSTAND LOESTE EINEN VOLLEN PUSH AUS
 * Ein Klick auf einen Budget-Reiter rief scheduleSave() — Pull, Merge und
 * Push des GESAMTEN Datenstandes, nur um zu vermerken, welcher Reiter offen
 * ist. Fuenf Reiter durchklicken hiess fuenf vollstaendige
 * Wolkenschreibvorgaenge. Derselbe Fehler beim Buchungsfilter.
 * Der Reiter gehoert lokal gesichert (er soll ein Neuladen ueberleben), aber
 * er ist keinen Push wert — und synchronisiert schon gar nicht: sonst springt
 * das Handy auf den Reiter, den man am Tablet zuletzt offen hatte.
 *
 * Geprueft wird am ausgelieferten Quelltext und, fuer den Grabstein, an der
 * ECHTEN deleteEntity()/logDeletion()-Paarung gegen ein Stub-DOM.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
let checks = 0;
const luecken = [];
const ok = (b, t) => { checks++; if (!b) luecken.push(t); };
const ohneKommentare = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const AKTIV = ohneKommentare(index);

// ═══ 1. KEINE BUDGET-LOESCHUNG MEHR AM LOESCHWEG VORBEI ════════════════
const SAMMLUNGEN = ['accounts', 'transactions', 'subscriptions', 'creditCards', 'financialGoals'];
const ARTEN = { accounts: 'account', transactions: 'transaction', subscriptions: 'subscription',
  creditCards: 'creditCard', financialGoals: 'financialGoal' };

SAMMLUNGEN.forEach((coll) => {
  const roh = new RegExp('delete\\s+APP\\.state\\.data\\.entities\\.' + coll + '\\[');
  ok(!roh.test(AKTIV),
    `DER BEFUND: ${coll} wird wieder per rohem delete entfernt — ohne Grabstein holt der Merge ` +
    'des naechsten Geraets den Eintrag zurueck');
  ok(new RegExp('deleteEntity\\("' + ARTEN[coll] + '"').test(AKTIV),
    `die Loeschung von ${coll} laeuft nicht ueber deleteEntity()`);
});

// Und der Weg, an dem der Grabstein haengt, ist noch da.
ok(/function deleteEntity\(kind, id\)/.test(index), 'deleteEntity gibt es nicht mehr');
ok(/if \(typeof logDeletion === 'function'\) logDeletion\(kind, id\);/.test(index),
  'deleteEntity schreibt keinen Grabstein mehr — dann nuetzt der Umweg nichts');
// getEntityMap muss alle fuenf Arten kennen, sonst gibt deleteEntity still false.
Object.values(ARTEN).forEach((kind) => {
  ok(new RegExp('\\b' + kind + ':\\s*e\\.').test(index),
    `getEntityMap kennt die Art ${kind} nicht — deleteEntity gaebe still false zurueck`);
});

// ═══ 2. DER GRABSTEIN ENTSTEHT WIRKLICH ════════════════════════════════
// Die ECHTEN Funktionen, gegen ein Stub-DOM. Ein Quelltextmuster allein wuerde
// nicht zeigen, dass am Ende auch etwas in _deleteLog steht.
{
  const schneide = (name) => {
    const a = index.indexOf('\nfunction ' + name + '(');
    if (a < 0) { ok(false, `${name} nicht gefunden`); return ''; }
    const e = index.indexOf('\n}\n', a);
    return index.slice(a + 1, e + 3);
  };
  const quelle = ['logDeletion', 'getDeleteLog'].map(schneide).join('\n');
  let gespeichert = null;
  const localStorage = {
    getItem: () => gespeichert,
    setItem: (k, v) => { gespeichert = v; },
  };
  const api = new Function('localStorage', 'JSON', 'Date', 'Object',
    quelle + '\nreturn { logDeletion, getDeleteLog };')(localStorage, JSON, Date, Object);

  api.logDeletion('transaction', 'txn-1');
  const log = api.getDeleteLog();
  ok(log.transaction && typeof log.transaction['txn-1'] === 'number',
    'logDeletion legt keinen Grabstein fuer eine Buchung an');
  ok(gespeichert && JSON.parse(gespeichert).transaction['txn-1'],
    'der Grabstein wird nicht lokal gesichert — nach einem Neuladen waere er weg');

  // Alte Grabsteine werden geprunt, neue nicht.
  const alt = JSON.parse(gespeichert);
  alt.account = { 'acc-alt': Date.now() - 40 * 24 * 3600 * 1000 };
  gespeichert = JSON.stringify(alt);
  api.logDeletion('account', 'acc-neu');
  const log2 = api.getDeleteLog();
  ok(!log2.account['acc-alt'], 'Grabsteine aelter als 30 Tage werden nicht mehr entfernt');
  ok(log2.account['acc-neu'], 'der frische Grabstein wurde mit weggeraeumt');
}

// ═══ 3. ANSICHTSZUSTAND SCHREIBT NICHT IN DIE WOLKE ════════════════════
function fall(name) {
  const a = AKTIV.indexOf(`case "${name}": {`);
  if (a < 0) return '';
  return AKTIV.slice(a, AKTIV.indexOf('\n    }', a));
}
for (const name of ['budget-tab', 'budget-tx-filter']) {
  const koerper = fall(name);
  ok(koerper.length > 0, `der Fall ${name} wurde nicht gefunden`);
  ok(!/\bscheduleSave\(\)/.test(koerper),
    `DER BEFUND: ${name} ruft wieder scheduleSave() — ein Reiterklick stoesst Pull, Merge und Push ` +
    'des gesamten Datenstandes an');
  ok(/scheduleLocalSave\(\)/.test(koerper),
    `${name} sichert gar nicht mehr — der Reiter ueberlebt kein Neuladen`);
  ok(!/APP\.state\.data\._budget/.test(koerper),
    `${name} schreibt den Ansichtszustand wieder direkt in den Datenstand — ` +
    'buildLocalAppSnapshot() setzt das Feld ohnehin aus APP.state.ui');
  ok(/APP\.state\.ui\.budget/.test(koerper), `${name} merkt sich den Zustand nicht mehr in APP.state.ui`);
}

// scheduleLocalSave muss es geben und darf NICHT selbst pushen — sonst waere
// die Umstellung nur ein anderer Name fuer dasselbe.
{
  const a = index.indexOf('\nfunction scheduleLocalSave()');
  ok(a > 0, 'scheduleLocalSave gibt es nicht');
  const koerper = ohneKommentare(index.slice(a, index.indexOf('\n}\n', a)));
  ok(!/doSave\(|remotePut\(|canonicalWrite\(/.test(koerper),
    'scheduleLocalSave stoesst einen Wolkenschreibvorgang an — dann war die Umstellung wirkungslos');
}

// Die Reiterfelder bleiben Transportwurzeln: sie werden beim Push neu gebaut,
// ihr Verlust im Abgleich ist folgenlos. Faellt das weg, waere der lokale
// Zustand ploetzlich Fachdatum.
ok(/'_budgetTab', '_budgetTxFilter'/.test(index),
  'die Budget-Reiterfelder stehen nicht mehr in TRANSPORT_ROOTS');
ok(/snapshot\._budgetTab = APP\.state\.ui\.budgetTab/.test(index),
  'der Reiter wird nicht mehr aus APP.state.ui in den Schnappschuss gesetzt');

// ═══ 4. WEICH GELOESCHTES VERSCHWINDET AUCH HIER ═══════════════════════
// Das Handy loescht weich (deleted:true) — so ueberlebt die Loeschung den
// Merge. Die Budget-Ansichten lasen die Sammlungen aber roh: eine am Handy
// geloeschte Buchung stand hier weiter in der Liste UND in jeder Summe.
{
  const SAMM = ['accounts', 'transactions', 'subscriptions', 'creditCards', 'financialGoals', 'purchaseProposals'];
  SAMM.forEach((coll) => {
    const roh = new RegExp('Object\\.values\\(APP\\.state\\.data\\.entities\\.' + coll + ' \\|\\| \\{\\}\\)');
    ok(!roh.test(AKTIV),
      `DER BEFUND: ${coll} wird wieder roh mit Object.values gelesen — am Handy geloeschte ` +
      'Eintraege stehen dann wieder in Liste und Summen');
  });
  ok(/function budgetWerte\(map\)/.test(index), 'budgetWerte gibt es nicht mehr');

  // Der Filter wird ECHT ausgefuehrt, nicht nur im Quelltext gesucht.
  // TOLERANT: auf einem Stand ohne budgetWerte wuerde ein direkter Aufruf den
  // Lauf mit einer ReferenceError beenden — rot aus dem falschen Grund.
  const a = index.indexOf('\nfunction budgetWerte(map) {');
  const fn = a > 0
    ? new Function('Object', index.slice(a, index.indexOf('\n}\n', a) + 3) + '\nreturn budgetWerte;')(Object)
    : () => { throw new Error('budgetWerte fehlt'); };
  const rufe = (arg) => { try { return fn(arg) || []; } catch (e) { return null; } };
  const raus = rufe({
    t1: { id: 't1', amount: -10 },
    t2: { id: 't2', amount: -20, deleted: true },
    t3: { id: 't3', amount: -30, archived: true },
    t4: null,
  });
  ok(raus && raus.length === 1 && raus[0].id === 't1',
    `budgetWerte liefert ${JSON.stringify((raus || []).map(x => x && x.id))} — erwartet nur t1`);
  ok((rufe(null) || []).length === 0, 'budgetWerte stolpert ueber eine fehlende Sammlung');
  ok((rufe(undefined) || []).length === 0, 'budgetWerte stolpert ueber undefined');
}

if (luecken.length) {
  console.error(`BUDGET SPEICHERUNG — ${luecken.length} von ${checks} Pruefungen:`);
  luecken.forEach((l) => console.error('   - ' + l));
  process.exit(1);
}
console.log(`budget speicherung: ok (${checks} Pruefungen)`);
