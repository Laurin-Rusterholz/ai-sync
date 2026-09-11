/*
 * Der Empfänger schien im Verfassen-Dialog zu verschwinden.
 * ---------------------------------------------------------------------------
 * Befund (11.09.2026, live in Quantus): Neue Mail, Betreff und Text bleiben
 * stehen. In #gmlTo „silviataisch@bluewin.ch" eingegeben — per Tastendruck
 * oder fill —, die Vorschlagsliste zeigte prompt „Silvia Taisch". Unmittelbar
 * danach las die Pruefung das An-Feld wieder LEER. Auch nach Auswahl des
 * Vorschlags leer. Genau ein Eingabefeld im DOM, sichtbar und fokussiert.
 *
 * Im echten Browser nachgemessen war der Wert NIE verloren. Ein <input> hat
 * zwei Dinge:
 *   · die Eigenschaft `value` — was wirklich drinsteht. Daraus liest die
 *     Vorschlagsliste, und daraus baut gmailSend die To-Zeile.
 *   · das Attribut `value="…"` im Markup — der Startwert. Tippen aendert es
 *     nicht; es bleibt fuer immer so, wie das Feld gerendert wurde.
 * Wer das Markup liest — eine Fernbedienung, ein DOM-Abzug, ein Vorlese-
 * Werkzeug — sah deshalb ein leeres Feld, obwohl es voll war. Dasselbe erklaert
 * den frueheren Befund „Antwort oeffnet mit leerem An-Feld".
 *
 * Repariert wird deshalb nicht der Wert (da war nichts kaputt), sondern die
 * Lesbarkeit: Das Attribut zieht nach jeder Eingabe und jeder Auswahl mit.
 *
 * Dieser Test bildet beide Ebenen getrennt nach — ein DOM-Doppel mit echter
 * Eigenschaft/Attribut-Trennung — und fuehrt den ECHTEN Code aus index.html
 * aus. Gesendet wird nichts: geprueft wird die MIME-Kopfzeile, die der
 * Versandweg erzeugt haette.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const quelle = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

let checks = 0;
const ok = (b, m) => { assert.ok(b, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

function schnitt(von, bis, was) {
  const a = quelle.indexOf(von);
  const b = quelle.indexOf(bis, a + 1);
  assert.ok(a > -1 && b > a, `${was} wurde in index.html nicht gefunden`);
  checks++;
  return quelle.slice(a, b);
}

/* ── Ein <input>, das sich wie ein echtes verhält ──────────────────────────
   Entscheidend: Die Eigenschaft `value` und das Attribut `value` sind ZWEI
   Dinge. Das Zuweisen der Eigenschaft laesst das Attribut unberuehrt — genau
   so verhaelt sich ein Browser, und genau daran ist die Live-Pruefung
   gescheitert. */
function feld(id, startwert = "") {
  const el = {
    id, _attr: { value: String(startwert) }, _prop: String(startwert),
    focus() {}, setSelectionRange() {},
    setAttribute(n, v) { this._attr[n] = String(v); },
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attr, n) ? this._attr[n] : null; },
  };
  Object.defineProperty(el, "value", {
    get() { return this._prop; },
    set(v) { this._prop = String(v == null ? "" : v); },   // Attribut bleibt bewusst unberührt
  });
  return el;
}

function bauen(kontakte) {
  const felder = new Map([
    ["gmlTo", feld("gmlTo")],
    ["gmlTo_ac", { hidden: true, innerHTML: "", children: [], setAttribute() {}, getAttribute: () => null }],
    ["gmlSubject", feld("gmlSubject")],
  ]);
  const GM = {};
  const win = {};
  const scope = {
    window: win, GM,
    document: { getElementById: (id) => felder.get(id) || null },
    esc: (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    gmlContactOptions: () => kontakte,
    isBlocked: () => false,
    encodeHeaderWord: (v) => String(v),     // nur die Adresslogik ist hier die Frage
    toast: () => {},
  };
  win.window = win;
  const teile = [
    schnitt("  window.gmlSpiegelWert = function(el){", "  window.gmailCompose = function(prefill){", "der Wertspiegel"),
    schnitt("  function gmlContacts(){", "  function buildQuote(o){", "die Empfänger-Vervollständigung"),
    schnitt("  function encodeAddressList(s){", "  // ── Plain-Text-Marker", "die Adresskodierung"),
  ];
  const namen = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  const api = new Function(...namen, "with (window) {\n" + teile.join("\n") +
    "\nreturn { input: gmlAcInput, pick: gmlAcPick, adressen: encodeAddressList };\n}")(
    ...namen.map((n) => scope[n]));
  return { win, GM, felder, api, to: () => felder.get("gmlTo") };
}

const KONTAKTE = [
  { email: "silviataisch@bluewin.ch", name: "Silvia Taisch" },
  { email: "silvan@example.test", name: "Silvan Beispiel" },
];

/* ══ 1. Tippen: der Wert steht drin — und ist jetzt auch von aussen lesbar ══ */
{
  const t = bauen(KONTAKTE);
  const an = t.to();
  eq(an.getAttribute("value"), "", "das Feld startet nicht leer");

  // So tippt ein Mensch (oder eine Fernbedienung): Eigenschaft setzen, input feuern.
  an.value = "silviataisch@bluewin.ch";
  t.api.input("gmlTo");

  eq(an.value, "silviataisch@bluewin.ch", "der eingegebene Wert ist verloren");
  eq(an.getAttribute("value"), "silviataisch@bluewin.ch",
    "das Markup zeigt weiterhin ein leeres Feld — von aussen ist der Empfänger nicht prüfbar");
  // Und die Vorschlagsliste hat wirklich gearbeitet.
  eq(t.GM._ac.items.length, 1, "die Vorschlagsliste fand nicht genau einen Kontakt");
  eq(t.GM._ac.items[0].email, "silviataisch@bluewin.ch", "die Vorschlagsliste fand den falschen Kontakt");
  eq(t.felder.get("gmlTo_ac").hidden, false, "die Vorschlagsliste bleibt verborgen");
}

/* ══ 2. Auswahl aus der Liste: dasselbe, und im Klartext ══════════════════ */
{
  const t = bauen(KONTAKTE);
  const an = t.to();
  an.value = "silvia";
  t.api.input("gmlTo");
  t.api.pick(null, 0);
  eq(an.value, "Silvia Taisch <silviataisch@bluewin.ch>, ", "die Auswahl steht nicht im Feld");
  eq(an.getAttribute("value"), "Silvia Taisch <silviataisch@bluewin.ch>, ",
    "nach der Auswahl zeigt das Markup weiterhin ein leeres Feld");
  eq(t.felder.get("gmlTo_ac").hidden, true, "die Liste bleibt nach der Auswahl offen");
}

/* ══ 3. Mehrere Empfänger: nur das aktuelle Stück wird ersetzt ════════════ */
{
  const t = bauen(KONTAKTE);
  const an = t.to();
  an.value = "Silvia Taisch <silviataisch@bluewin.ch>, silvan";
  t.api.input("gmlTo");
  t.api.pick(null, 0);
  eq(an.value, "Silvia Taisch <silviataisch@bluewin.ch>, Silvan Beispiel <silvan@example.test>, ",
    "die Auswahl hat den ersten Empfänger überschrieben");
  eq(an.getAttribute("value"), an.value, "das Markup und das Feld sagen Verschiedenes");
}

/* ══ 4. Was der Versandweg daraus macht — an genau diese Adresse ══════════
   Gesendet wird hier nichts: geprueft wird die To-Kopfzeile, die aus dem
   Feldwert entsteht. */
{
  const t = bauen(KONTAKTE);
  const an = t.to();
  an.value = "silviataisch@bluewin.ch";
  t.api.input("gmlTo");
  t.api.pick(null, 0);
  // Genau der Weg aus gmailSend: Feldwert → encodeAddressList → „To: …"
  const kopf = "To: " + t.api.adressen(String(an.value || "").trim());
  eq(kopf, "To: Silvia Taisch <silviataisch@bluewin.ch>",
    "die To-Zeile trifft nicht genau den gewählten Empfänger");
  ok(!/laurin|rusterholz/i.test(kopf), "die To-Zeile adressiert den Absender selbst");
  // Ein leeres Feld erzeugt keine Adresse — gmailSend bricht davor ab.
  eq(t.api.adressen(""), "", "aus einem leeren Feld entsteht eine Adresse");
}

/* ══ 5. Quelltext: der Spiegel hängt an beiden Wegen ══════════════════════ */
{
  const ac = schnitt("  window.gmlAcInput = function(id){", "  window.gmlAcKey = function(ev, id){",
    "Eingabe und Auswahl");
  ok(/gmlSpiegelWert\(inp\)/.test(ac.slice(0, ac.indexOf("window.gmlAcPick"))),
    "die Eingabe spiegelt den Wert nicht ins Markup");
  ok(/gmlSpiegelWert\(inp\)/.test(ac.slice(ac.indexOf("window.gmlAcPick"))),
    "die Auswahl spiegelt den Wert nicht ins Markup");
  ok(/oninput="gmlSpiegelWert\(this\)"/.test(quelle),
    "die Felder ohne Vervollständigung (z. B. Betreff) spiegeln nicht");
  // Der Versand liest weiterhin die Eigenschaft — nicht das Attribut.
  ok(/var to=\(g\("gmlTo"\)&&g\("gmlTo"\)\.value\|\|""\)\.trim\(\);/.test(quelle),
    "der Versandweg liest den Empfänger nicht mehr aus dem Feld selbst");
}

/* ══ 6. Eine überholte Abfrage überschreibt die Liste nicht mehr ══════════
   Befund (11.09.2026): Das erste Laden des Eingangs lief noch, waehrend schon
   gesucht wurde. Die aeltere Antwort kam spaeter zurueck und ueberschrieb die
   Suchtreffer — der Suchkopf zeigte weiter die Suche, die Liste darunter den
   Eingang. */
{
  const laden = schnitt("  async function loadMessages(reset){", "  async function openMessageById(id){",
    "das Laden der Liste");
  const GM = { messages: [], smart: "inbox" };
  const win = {};
  let offen = [];
  const antwort = () => new Promise((res) => { offen.push(res); });
  const scope = {
    window: win, GM,
    ensureClassifications: async () => {},
    buildListSpec: () => ({ query: { q: GM.smart } }),
    gmApi: (verb, pfad) => (/\/messages$/.test(pfad)
      ? antwort().then((etikett) => ({ messages: [{ id: etikett }] }))
      : Promise.resolve({ id: "m", payload: {} })),
    gmMapPool: async (ids, n, w) => Promise.all(ids.map(w)),
    parseMeta: () => ({ id: GM._letzteAntwort, from: "a@b.test" }),
    isBlocked: () => false,
    addrOf: (v) => v,
    syncIndex: () => {},
    rerender: () => {},
  };
  win.window = win;
  const namen = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  const load = new Function(...namen, "with (window) {\n" + laden + "\nreturn loadMessages;\n}")(
    ...namen.map((n) => scope[n]));

  // Erst der Eingang, dann — waehrend der noch laeuft — die Suche.
  const warte = () => new Promise((r) => setTimeout(r, 0));
  const eingang = load(true);
  await warte();
  const suche = load(true);
  await warte();
  eq(offen.length, 2, "es liefen nicht zwei Abfragen gleichzeitig");
  // Die JUENGERE antwortet zuerst …
  GM._letzteAntwort = "treffer-suche";
  offen[1]("treffer-suche");
  await suche;
  eq(GM.messages.map((m) => m.id), ["treffer-suche"], "die Suchtreffer stehen nicht in der Liste");
  // … und die aeltere kommt hinterher. Sie darf nichts mehr anfassen.
  GM._letzteAntwort = "alter-eingang";
  offen[0]("alter-eingang");
  await eingang;
  eq(GM.messages.map((m) => m.id), ["treffer-suche"],
    "die überholte Abfrage hat die Suchtreffer überschrieben");
  eq(GM.listLoading, false, "die Liste hängt weiterhin im Ladezustand");

  ok(/GM\._listSeq/.test(laden), "es gibt keine Abfragenummer");
  ok((laden.match(/veraltet\(\)/g) || []).length >= 3,
    "die Abfragenummer wird nicht an allen Rückkehrpunkten geprüft");
}

console.log(`gmail composer empfaenger: ok (${checks} Pruefungen)`);
