/*
 * „Absender als Person speichern" hielt den ganzen Tab an.
 * ---------------------------------------------------------------------------
 * Befund (11.09.2026): Gmail-Mail öffnen → 🔗 Quantus → 👤 Person. Es erschien
 * ein natives window.confirm. Bei gesperrtem Rechner war es weder anklickbar
 * noch wegzuklicken — getJsDialog zeigte „confirm", dismiss scheiterte an
 * Emulation.setFocusEmulationEnabled. Derselbe Blocker wie zuvor beim
 * Wiederherstellen, beim Dokumentindex, beim Hinfällig-Weg und beim
 * Wartestatus; das war der letzte im Gmail-Hub.
 *
 * Die Rückfrage ist jetzt das gewöhnliche Fenster des Hubs (openModal):
 * gewöhnliches HTML, anklickbar wie jeder andere Knopf, mit „Abbrechen".
 *
 * Und weil zwischen Frage und Zusage ein Abgleich die Person angelegt haben
 * kann, wird die Doppelprüfung VOR und HINTER der Rückfrage gemacht — zwei
 * Einträge zur selben Adresse wären genau das Durcheinander, das diese
 * Funktion vermeiden soll.
 *
 * Geprüft wird der ECHTE Code aus index.html. Es werden keine Personen und
 * keine Mails verändert.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

let checks = 0;
const ok = (b, m) => { assert.ok(b, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

const von = index.indexOf("  window.gmailToPerson = function(){");
const bis = index.indexOf("  // 5) Absender-Kontext", von + 1);
ok(von > -1 && bis > von, "der Weg „Absender als Person“ wurde in index.html nicht gefunden");
const quelle = index.slice(von, bis);

function bauen(opts) {
  opts = opts || {};
  const angelegt = [];
  const meldungen = [];
  const fenster = [];
  let zu = 0;
  const win = {};
  const scope = {
    window: win,
    GM: { open: opts.mail === null ? null : Object.assign({ id: "m1", from: "Arthur Lenart <arthur@example.test>" }, opts.mail || {}) },
    parseAddr: (v) => {
      const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(String(v || ""));
      return m ? { name: m[1].trim(), email: m[2] } : { name: "", email: String(v || "").trim() };
    },
    personOf: () => (opts.person ? opts.person() : null),
    esc: (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    toast: (typ, titel, text) => meldungen.push({ typ, titel, text }),
    openModal: (titel, body, footer) => fenster.push({ titel, body, footer }),
    closeModal: () => { zu++; },
    gmlAI: async () => (opts.ki || '{"company":"Beispiel AG","role":"Redaktion","phone":"079 000 00 00"}'),
    gmlJsonObj: (t) => { try { return JSON.parse(t); } catch (e) { return null; } },
    gmlCreatePerson: (p) => { angelegt.push(p); return opts.anlegenScheitert ? null : "prs_neu"; },
  };
  win.window = win;
  win.closeModal = scope.closeModal;
  win.openModal = scope.openModal;
  const namen = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  new Function(...namen, "with (window) {\n" + quelle + "\n}")(...namen.map((n) => scope[n]));
  return { win, angelegt, meldungen, fenster, zu: () => zu };
}

/* ══ 1. Die Rückfrage ist sichtbar — und legt noch nichts an ══════════════ */
{
  const t = bauen();
  t.win.gmailToPerson();
  eq(t.angelegt.length, 0, "die Person wird schon vor der Zusage angelegt");
  eq(t.fenster.length, 1, "es erscheint kein sichtbares Fenster");
  const f = t.fenster[0];
  ok(/role="alertdialog"/.test(f.body), "die Rückfrage ist für Bedienhilfen nicht erkennbar");
  ok(/Arthur Lenart/.test(f.body), "die Rückfrage nennt den Absender nicht");
  ok(/arthur@example\.test/.test(f.body), "die Rückfrage nennt die Adresse nicht");
  ok(/Signatur/.test(f.body), "es steht nicht da, dass die Signatur gelesen wird");
  ok(/ändert sich nichts/.test(f.body), "es steht nicht da, was NICHT geschieht");
  ok(/gmailToPersonConfirm\(\)/.test(f.footer) && /Person anlegen/.test(f.footer),
    "der Rückfrage fehlt der zustimmende Knopf");
  ok(/closeModal\(\)/.test(f.footer) && /Abbrechen/.test(f.footer),
    "der Rückfrage fehlt „Abbrechen“");
}

/* ══ 2. Zustimmen legt an — einmal, mit allem aus der Signatur ════════════ */
{
  const t = bauen();
  t.win.gmailToPerson();
  await t.win.gmailToPersonConfirm();
  eq(t.angelegt.length, 1, "die Person wurde nicht angelegt");
  const p = t.angelegt[0];
  eq(p.name, "Arthur Lenart", "der Name stimmt nicht");
  eq(p.emails, ["arthur@example.test"], "die Adresse stimmt nicht");
  eq(p.company, "Beispiel AG", "die Firma aus der Signatur fehlt");
  eq(p.role, "Redaktion", "die Rolle aus der Signatur fehlt");
  eq(p.phone, "079 000 00 00", "das Telefon aus der Signatur fehlt");
  eq(p.source, "gmail", "die Herkunft wurde nicht vermerkt");
  ok((p.tags || []).includes("Gmail"), "die Marke „Gmail“ fehlt");
  ok(t.zu() >= 1, "das Fenster bleibt nach dem Anlegen offen");
  ok(t.meldungen.some((m) => m.typ === "ok"), "der Erfolg wird nicht gemeldet");
}

/* ══ 3. Abbrechen ist folgenlos ═══════════════════════════════════════════ */
{
  const t = bauen();
  t.win.gmailToPerson();
  t.win.closeModal();              // genau das, was der Knopf tut
  eq(t.angelegt.length, 0, "das Abbrechen hat eine Person angelegt");
  eq(t.meldungen.filter((m) => m.typ === "ok").length, 0, "das Abbrechen meldet einen Erfolg");
}

/* ══ 4. Keine zweite Person zur selben Adresse ════════════════════════════ */
{
  // a) Schon vorhanden: gar keine Rückfrage.
  const da = bauen({ person: () => ({ id: "prs_alt" }) });
  da.win.gmailToPerson();
  eq(da.fenster.length, 0, "es wird gefragt, obwohl die Person schon existiert");
  eq(da.angelegt.length, 0, "es wurde eine zweite Person angelegt");
  ok(da.meldungen.some((m) => /Bereits vorhanden/.test(m.titel || "")),
    "es wird nicht gesagt, dass es die Person schon gibt");

  // b) Erst während der Rückfrage entstanden — etwa durch einen Abgleich.
  let existiert = false;
  const spaet = bauen({ person: () => (existiert ? { id: "prs_alt" } : null) });
  spaet.win.gmailToPerson();
  eq(spaet.fenster.length, 1, "die Rückfrage erschien nicht");
  existiert = true;                                  // dazwischen angelegt
  await spaet.win.gmailToPersonConfirm();
  eq(spaet.angelegt.length, 0,
    "die inzwischen entstandene Person wurde ein zweites Mal angelegt");
  ok(spaet.meldungen.some((m) => /Bereits vorhanden/.test(m.titel || "")),
    "die Doppelung wird nicht erklärt");
  ok(spaet.zu() >= 1, "das Fenster bleibt offen");
}

/* ══ 5. Die Randfälle bleiben, wie sie waren ══════════════════════════════ */
{
  const ohneMail = bauen({ mail: null });
  ohneMail.win.gmailToPerson();
  eq(ohneMail.fenster.length, 0, "ohne offene Mail wird gefragt");
  ok(ohneMail.meldungen.some((m) => /Keine Mail offen/.test(m.titel || "")), "es wird nichts gesagt");

  // Eine Mail ganz ohne Absenderzeile — der Fall, den die Abfrage abdeckt.
  const ohneAdresse = bauen({ mail: { from: "" } });
  ohneAdresse.win.gmailToPerson();
  eq(ohneAdresse.fenster.length, 0, "ohne Adresse wird gefragt");
  ok(ohneAdresse.meldungen.some((m) => /Keine Adresse/.test(m.titel || "")), "es wird nichts gesagt");

  // Scheitert das Anlegen, wird das gesagt — nicht als Erfolg gemeldet.
  const kaputt = bauen({ anlegenScheitert: true });
  kaputt.win.gmailToPerson();
  await kaputt.win.gmailToPersonConfirm();
  ok(kaputt.meldungen.some((m) => m.typ === "err"), "ein Fehlschlag wird als Erfolg gemeldet");
}

/* ══ 6. Quelltext: kein natives confirm mehr im Gmail-Hub ═════════════════ */
{
  const ohneKommentar = (x) => x.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  ok(!/(^|[^.\w])(confirm|prompt)\s*\(/.test(ohneKommentar(quelle)),
    "der Weg hält den Browser weiterhin mit einem nativen Dialog an");
  // Und die Mail selbst wird dabei nicht angefasst.
  ok(!/messages\/.*modify|addLabelIds|removeLabelIds/.test(quelle),
    "beim Anlegen der Person wird an der Mail etwas geändert");
}

console.log(`gmail person-dialog: ok (${checks} Pruefungen)`);
