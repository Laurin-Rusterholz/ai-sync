/*
 * Der Personen-Editor verlor beim Reiterwechsel alles Ungespeicherte.
 * ---------------------------------------------------------------------------
 * Befund (11.09.2026, neue Person „Pius M. Sueess-Bischof"):
 *   Basis ausgefuellt → Kontakt: E-Mail, Telefon, Adresse erfasst → Beruf:
 *   Rolle und Organisation → Verknuepfungen: 3 Aufgaben → „Speichern".
 *   Das Fenster blieb offen, und beim Zurueckwechseln auf Basis war dort
 *   alles wieder leer. Der Umweg, der half: Basis allein speichern und die
 *   dann bestehende Person je Reiter einzeln „Aktualisieren".
 *
 * Zwei Ursachen, beide im Editor:
 *   1. Der Reiterwechsel zeichnete den Editor komplett neu — aus dem
 *      GESPEICHERTEN Datensatz. Bei einer neuen Person gibt es den nicht,
 *      also war alles Getippte weg; bei einer bestehenden fielen die Felder
 *      auf den alten Stand zurueck. (Genau deshalb funktionierte der Umweg:
 *      ab dem ersten Speichern gab es einen Datensatz, auf den zurueckfiel,
 *      was gerade nicht sichtbar war.)
 *   2. „Speichern" brach still ab: Der Anzeigename steht im Reiter Basis;
 *      war der nicht im DOM, galt der Name als leer. Die Warnung war eine
 *      kurze Einblendung, das Fenster blieb offen — niemand sah, WELCHES
 *      Feld fehlt.
 *
 * Geprueft wird der ECHTE Code aus index.html gegen ein Mini-DOM, das das
 * erzeugte Markup zurueckliest — also genau der Weg, den ein Mensch geht.
 * Es werden keine echten Daten angefasst.
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

/* ── Der echte Abschnitt aus index.html ───────────────────────────────── */
const von = quelle.indexOf("  window._mhPersonDraft = null;");
const bis = quelle.indexOf("  window.mhDeletePerson = function(id) {");
ok(von > -1 && bis > von, "der Personen-Editor wurde in index.html nicht gefunden");
const abschnitt = quelle.slice(von, bis);

/* ── Ein Mini-DOM, das das erzeugte Markup zurueckliest ───────────────── */
const entities = (t) => String(t)
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function element(id) {
  return { id, value: "", style: {}, focused: false, kinder: [],
    focus() { this.focused = true; },
    setAttribute(n, v) { if (n === "data-id") this._dataId = v; this["_" + n] = v; },
    getAttribute(n) { return n === "data-id" ? (this._dataId || null) : (this["_" + n] ?? null); },
    appendChild(k) { this.kinder.push(k); },
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html || ""; } };
}

function parse(html) {
  const felder = new Map();
  const setze = (id, wert) => { const e = element(id); e.value = wert; felder.set(id, e); };
  for (const m of html.matchAll(/<input\b([^>]*)>/g)) {
    const id = /id="([^"]+)"/.exec(m[1]); if (!id) continue;
    const v = /value="([^"]*)"/.exec(m[1]);
    setze(id[1], entities(v ? v[1] : ""));
  }
  for (const m of html.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
    const id = /id="([^"]+)"/.exec(m[1]); if (!id) continue;
    setze(id[1], entities(m[2]));
  }
  for (const m of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const id = /id="([^"]+)"/.exec(m[1]); if (!id) continue;
    const gewaehlt = /<option value="([^"]*)"[^>]*\bselected\b/.exec(m[2]);
    setze(id[1], gewaehlt ? entities(gewaehlt[1]) : "");
  }
  // Listen: vom Behaelter bis zum zugehoerigen Auswahlfeld darunter.
  for (const listId of ["mhpLinkedProjectsList", "mhpLinkedTasksList", "mhpLinkedNotesList",
    "mhpLinkedMeetingsList", "mhpLinkedDecisionsList", "mhpLinkedIdeasList", "mhpLinkedGoalsList",
    "mhpRelatedPersonsList"]) {
    const start = html.indexOf(`id="${listId}"`);
    if (start < 0) continue;
    const ende = html.indexOf("<select", start);
    const inhalt = html.slice(start, ende < 0 ? html.length : ende);
    const aus = [...inhalt.matchAll(/data-id="([^"]+)"/g)].map((x) => ({ getAttribute: (n) => (n === "data-id" ? x[1] : null) }));
    const relIds = [...inhalt.matchAll(/class="mhp-rel-id"[^>]*value="([^"]*)"/g)].map((x) => ({ value: x[1] }));
    const relTexte = [...inhalt.matchAll(/class="mh-input mhp-rel-relation"[^>]*value="([^"]*)"/g)]
      .map((x) => ({ value: entities(x[1]) }));
    const e = element(listId);
    // Was der Editor waehrend der Sitzung anhaengt, zaehlt genauso.
    e.querySelectorAll = (sel) => (sel === "[data-id]" ? aus.concat(e.kinder.filter((k) => k.getAttribute("data-id")))
      : sel === ".mhp-rel-id" ? relIds.concat(e.kinder.flatMap((k) => (k._relId ? [{ value: k._relId }] : [])))
      : sel === ".mhp-rel-relation" ? relTexte.concat(e.kinder.flatMap((k) => (k._relId ? [{ value: "" }] : [])))
      : []);
    felder.set(listId, e);
  }
  return felder;
}

function bauen(daten) {
  const gespeichert = daten.persons || {};
  let felder = new Map();
  let letztesHtml = "";
  let overlay = null;
  // createElement liefert JEDES Mal ein neues Element — sonst wuerde der
  // Editor beim Anhaengen einer Verknuepfung sein eigenes Fenster ueberschreiben.
  const createElement = () => {
    const e = element("");
    e.classList = { add() {}, remove() {} };
    Object.defineProperty(e, "innerHTML", {
      set(v) { this._html = v; if (this.id === "mhPersonEditorOverlay") { letztesHtml = v; felder = parse(v); } },
      get() { return this._html || ""; }, configurable: true,
    });
    return e;
  };
  const document = {
    getElementById: (id) => (id === "mhPersonEditorOverlay" ? overlay : (felder.get(id) || null)),
    createElement,
    body: { appendChild(el) { if (el && el.id === "mhPersonEditorOverlay") overlay = el; } },
  };
  const win = {};
  const APP = { state: { data: { entities: { persons: gespeichert }, projects: daten.projects || {} } } };
  const meldungen = [];
  const gerufen = { save: 0, render: 0, navigate: [] };
  const scope = {
    window: win, document, APP,
    mhPersons: () => gespeichert,
    mhData: () => ({ organizations: daten.organizations || {}, projects: daten.projects || {},
      tasks: daten.tasks || {}, notes: {}, meetings: {}, decisions: {}, ideas: {}, goals: {} }),
    mhEsc: (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    mhId: () => "prs_neu",
    mhSave: () => { gerufen.save++; },
    mhRender: () => { gerufen.render++; },
    mhToast: (typ, titel, text) => meldungen.push({ typ, titel, text }),
    toast: () => {}, render: () => {}, scheduleSave: () => {},
    setTimeout: (fn) => { if (typeof fn === "function") fn(); return 0; },
    countMailsForPerson: () => 0, mhEmails: () => ({}),
  };
  win.navigate = (route, id) => gerufen.navigate.push([route, id]);
  scope.navigate = win.navigate;
  win.window = win;
  const namen = Object.keys(scope);
  /* „with" ist hier kein Stilmittel, sondern noetig: Im Browser sind
     window.mhOpenPersonEditor & Co. zugleich globale Namen — der Editor ruft
     sich selbst ohne „window."-Vorsatz. Ohne „with" waere genau dieser
     Aufruf im Test nicht aufloesbar, und der Test pruefte etwas anderes als
     die Wirklichkeit. */
  // eslint-disable-next-line no-new-func
  new Function(...namen, "with (window) {\n" + abschnitt + "\n}")(...namen.map((n) => scope[n]));
  return { win, document, gespeichert, meldungen, gerufen, html: () => letztesHtml,
    tippe: (id, wert) => { const f = document.getElementById(id); assert.ok(f, `Feld ${id} fehlt`); f.value = wert; } };
}

const DATEN = {
  persons: {},
  organizations: { org_spar: { id: "org_spar", name: "SPAR" } },
  tasks: { t1: { id: "t1", title: "Angebot prüfen" }, t2: { id: "t2", title: "Termin abstimmen" },
    t3: { id: "t3", title: "Vertrag ablegen" } },
  projects: {},
};

/* ══ 1. Neue Person ueber vier Reiter — nichts geht verloren ══════════════
   Genau der Weg aus dem Befund: Basis · Kontakt · Beruf · Verknuepfungen. */
{
  const t = bauen(JSON.parse(JSON.stringify(DATEN)));
  t.win.mhOpenPersonEditor();
  ok(/Neue Person/.test(t.html()), "der Editor öffnet nicht als „Neue Person“");

  t.tippe("mhpFirstName", "Pius M.");
  t.tippe("mhpLastName", "Süess-Bischof");
  t.tippe("mhpName", "Pius M. Süess-Bischof");

  t.win.mhPersonSwitchTab("contact", "");
  t.tippe("mhpEmails", "pius@example.test");
  t.tippe("mhpPhones", "079 000 00 00");
  t.tippe("mhpStreet", "Musterweg 1");
  t.tippe("mhpZip", "8000");
  t.tippe("mhpCity", "Zürich");

  t.win.mhPersonSwitchTab("work", "");
  t.tippe("mhpRole", "Geschäftsführer");
  t.tippe("mhpOrg", "org_spar");

  t.win.mhPersonSwitchTab("links", "");
  ["t1", "t2", "t3"].forEach((id) => t.win._mhpAddLink("Tasks", id, "Aufgabe " + id));

  // DER Befund: zurueck auf Basis.
  t.win.mhPersonSwitchTab("basic", "");
  const zurueck = t.document;
  eq(zurueck.getElementById("mhpName").value, "Pius M. Süess-Bischof",
    "der Anzeigename ist beim Zurückwechseln verschwunden");
  eq(zurueck.getElementById("mhpFirstName").value, "Pius M.", "der Vorname ist verschwunden");
  eq(zurueck.getElementById("mhpLastName").value, "Süess-Bischof", "der Nachname ist verschwunden");

  // Und die anderen Reiter halten ebenfalls.
  t.win.mhPersonSwitchTab("contact", "");
  eq(t.document.getElementById("mhpEmails").value, "pius@example.test", "die E-Mail ist verschwunden");
  eq(t.document.getElementById("mhpPhones").value, "079 000 00 00", "die Telefonnummer ist verschwunden");
  eq(t.document.getElementById("mhpCity").value, "Zürich", "der Ort ist verschwunden");
  t.win.mhPersonSwitchTab("work", "");
  eq(t.document.getElementById("mhpRole").value, "Geschäftsführer", "die Rolle ist verschwunden");
  eq(t.document.getElementById("mhpOrg").value, "org_spar", "die Organisation ist verschwunden");
  t.win.mhPersonSwitchTab("links", "");
  eq(t.document.getElementById("mhpLinkedTasksList").querySelectorAll("[data-id]").map((e) => e.getAttribute("data-id")),
    ["t1", "t2", "t3"], "die drei verknüpften Aufgaben sind beim Reiterwechsel verschwunden");

  // Speichern aus einem beliebigen Reiter heraus — der Name zaehlt trotzdem.
  t.win.mhSavePerson("");
  const angelegt = Object.values(t.gespeichert)[0];
  ok(angelegt, "die Person wurde nicht angelegt");
  eq(angelegt.name, "Pius M. Süess-Bischof", "der Name wurde nicht übernommen");
  eq(angelegt.emails, ["pius@example.test"], "die E-Mail wurde nicht übernommen");
  eq(angelegt.phones, ["079 000 00 00"], "die Telefonnummer wurde nicht übernommen");
  eq(angelegt.address.city, "Zürich", "die Adresse wurde nicht übernommen");
  eq(angelegt.role, "Geschäftsführer", "die Rolle wurde nicht übernommen");
  eq(angelegt.organizationId, "org_spar", "die Organisation wurde nicht übernommen");
  eq(angelegt.linkedTasks, ["t1", "t2", "t3"], "die drei verknüpften Aufgaben gingen verloren");
  eq(t.gerufen.save, 1, "es wurde nicht gespeichert");
  eq(t.win._mhPersonDraft, null, "der Entwurf bleibt nach dem Speichern liegen");
  ok(t.meldungen.some((m) => m.typ === "ok"), "es wird keine Bestätigung gemeldet");
}

/* ══ 2. Der Pflichtfeldfehler ist SICHTBAR — am Feld ══════════════════════
   Frueher: kurze Einblendung, Fenster bleibt offen, das fehlende Feld liegt
   in einem Reiter, den man gerade nicht sieht. Es wirkte, als tue der Knopf
   gar nichts. */
{
  const t = bauen(JSON.parse(JSON.stringify(DATEN)));
  t.win.mhOpenPersonEditor();
  t.win.mhPersonSwitchTab("contact", "");
  t.tippe("mhpEmails", "ohne-name@example.test");
  t.win.mhSavePerson("");

  eq(Object.keys(t.gespeichert).length, 0, "eine Person ohne Namen wurde angelegt");
  eq(t.win._mhPersonTab, "basic", "der Editor führt nicht zum fehlenden Feld");
  const html = t.html();
  ok(/id="mhpNameFehler"/.test(html), "der Pflichtfeldfehler steht nicht am Feld");
  ok(/role="alert"/.test(html), "der Fehler ist für Bedienhilfen nicht erkennbar");
  ok(/aria-invalid="true"/.test(html), "das Feld ist nicht als fehlerhaft ausgezeichnet");
  ok(/Ohne Anzeigenamen/.test(html), "der Fehler sagt nicht, was fehlt");
  ok(/erhalten geblieben/.test(html), "der Fehler beruhigt nicht über das bereits Erfasste");
  ok(t.document.getElementById("mhpName").focused, "der Cursor steht nicht im fehlenden Feld");
  ok(t.meldungen.some((m) => m.typ === "warn" && /Basis/.test(m.text || "")),
    "die Meldung nennt den Reiter nicht");

  // Nichts Getipptes ist verloren — nur der Name fehlt noch.
  t.win.mhPersonSwitchTab("contact", "");
  eq(t.document.getElementById("mhpEmails").value, "ohne-name@example.test",
    "der Pflichtfeldfehler hat die schon erfassten Angaben verworfen");

  // Name nachtragen, fertig.
  t.win.mhPersonSwitchTab("basic", "");
  ok(!/id="mhpNameFehler"/.test(t.html()), "der Fehler bleibt nach dem Reiterwechsel stehen");
  t.tippe("mhpName", "Pius M. Süess-Bischof");
  t.win.mhSavePerson("");
  const angelegt = Object.values(t.gespeichert)[0];
  ok(angelegt, "die Person liess sich auch mit Namen nicht anlegen");
  eq(angelegt.emails, ["ohne-name@example.test"], "die zuvor erfasste E-Mail ging verloren");
}

/* ══ 3. Bestehende Person: der Entwurf schlaegt den alten Stand ═══════════
   Auch hier zeichnete der Reiterwechsel aus dem gespeicherten Datensatz —
   eine Korrektur, die man noch nicht gespeichert hatte, fiel zurueck. */
{
  const daten = JSON.parse(JSON.stringify(DATEN));
  daten.persons.prs_alt = {
    id: "prs_alt", name: "Pius Süess", firstName: "Pius", lastName: "Süess",
    emails: ["alt@example.test"], role: "Berater", createdAt: "2026-01-01T00:00:00.000Z",
  };
  const t = bauen(daten);
  t.win.mhOpenPersonEditor("prs_alt");
  ok(/Person bearbeiten/.test(t.html()), "der Editor öffnet nicht als „Person bearbeiten“");
  t.tippe("mhpName", "Pius M. Süess-Bischof");
  t.win.mhPersonSwitchTab("contact", "prs_alt");
  eq(t.document.getElementById("mhpEmails").value, "alt@example.test",
    "der gespeicherte Stand wird nicht mehr angezeigt");
  t.tippe("mhpEmails", "neu@example.test");
  t.win.mhPersonSwitchTab("basic", "prs_alt");
  eq(t.document.getElementById("mhpName").value, "Pius M. Süess-Bischof",
    "die noch ungespeicherte Korrektur fiel auf den alten Stand zurück");
  t.win.mhSavePerson("prs_alt");
  eq(t.gespeichert.prs_alt.name, "Pius M. Süess-Bischof", "der neue Name wurde nicht gespeichert");
  eq(t.gespeichert.prs_alt.emails, ["neu@example.test"], "die neue E-Mail wurde nicht gespeichert");
  eq(t.gespeichert.prs_alt.role, "Berater", "ein Feld eines nie geöffneten Reiters wurde gelöscht");
  eq(t.gespeichert.prs_alt.createdAt, "2026-01-01T00:00:00.000Z", "das Anlagedatum wurde überschrieben");
  eq(t.gerufen.navigate, [], "beim Bearbeiten wird unnötig weggesprungen");
}

/* ══ 4. Abbrechen heisst abbrechen ════════════════════════════════════════ */
{
  const t = bauen(JSON.parse(JSON.stringify(DATEN)));
  t.win.mhOpenPersonEditor();
  t.tippe("mhpName", "Wird verworfen");
  t.win.mhPersonSwitchTab("contact", "");
  t.win.mhClosePersonEditor();
  eq(t.win._mhPersonDraft, null, "der Entwurf überlebt das Abbrechen");
  eq(Object.keys(t.gespeichert).length, 0, "das Abbrechen hat etwas angelegt");
  // Und der naechste Aufruf faengt wirklich leer an.
  t.win._mhPersonTab = "basic";
  t.win.mhOpenPersonEditor();
  eq(t.document.getElementById("mhpName").value, "", "der verworfene Entwurf taucht wieder auf");
}

/* ══ 5. Quelltext: der Reiterwechsel geht nie am Einsammeln vorbei ════════ */
{
  ok(/window\.mhPersonSwitchTab\('\$\{t\}','\$\{personId \|\| ''\}'\)/.test(abschnitt),
    "die Reiter rufen weiterhin direkt mhOpenPersonEditor auf");
  ok(!/window\._mhPersonTab='\$\{t\}';mhOpenPersonEditor/.test(quelle),
    "der alte, verwerfende Reiterwechsel steht noch in index.html");
  ok(/if \(!entwurfBehalten\) window\._mhPersonDraft = null;/.test(abschnitt),
    "ein frisch geöffneter Editor übernimmt einen alten Entwurf");
}

console.log(`personen-editor reiterwechsel: ok (${checks} Pruefungen)`);
