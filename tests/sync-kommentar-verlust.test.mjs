/*
 * Ein Kommentar verschwand beim Abgleich — lautlos.
 * ---------------------------------------------------------------------------
 * Befund (11.09.2026, 05:02, Aufgabe „Originalunterlagen Silvan",
 * 2f0dc251-e534-4b33-bd26-c4bbbd4d0a07): Kommentar zum bestaetigten
 * Silvia-Versand erfasst, die Oberflaeche zeigte 5 Kommentare. Danach die
 * Person Silvia und ein externer Gmail-Link angehaengt. Nach dem Neuladen
 * wieder 4 Kommentare, keine Person, kein Link. Ein spaeterer Abgleich (1001
 * Entities, 129 Aufgaben, 16 Projekte, 50 Notizen) holte den Kommentar nicht
 * zurueck. Die vier alten Kommentare waren unversehrt, ein neuer Notizeintrag
 * hielt sich — was zum Bild passt: eine NEUE Id kollidiert mit niemandem.
 *
 * Die Ursache steckte in mergeEntity: Bei einer Kollision gewann schlicht die
 * Fassung mit dem juengeren updatedAt — GANZ. Fuer einen Titel ist das
 * richtig; fuer einen Kommentar nicht. Ein Kommentar ist kein Feld, das man
 * ueberschreibt, sondern ein Eintrag in einer Liste, die nur waechst. Beruehrte
 * irgendein anderer Tab dieselbe Aufgabe auch nur nebenbei, trug dessen
 * Fassung den juengeren Zeitstempel — und nahm die ganze Aufgabe mit, samt des
 * Kommentars, den sie nie gesehen hatte.
 *
 * Geprueft wird die ECHTE mergeData/mergeEntity aus index.html.
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

function funktion(name) {
  const a = index.indexOf(`function ${name}(`);
  assert.ok(a > -1, `${name} wurde in index.html nicht gefunden`);
  const b = index.indexOf("\nfunction ", a + 10);
  checks++;
  return index.slice(a, b > a ? b : a + 9000);
}

const speicher = { getItem: () => null, setItem() {}, removeItem() {} };
const laden = new Function(
  "idbBackup", "localStorage", "normalizeData", "console", "JSON", "Date", "Number", "Object", "Set", "Array",
  index.slice(index.indexOf("const TRANSPORT_ROOTS = new Set(["),
    index.indexOf("]);", index.indexOf("const TRANSPORT_ROOTS = new Set([")) + 3) + "\n"
  + ["getDeleteLog", "mergeAndPersistDeleteLog", "flattenDeleteLog", "entityTimestamp", "mergeEntity"]
    .map(funktion).join("\n") + "\n"
  + funktion("mergeData")
  + "\nreturn { mergeData, mergeEntity };")(
  () => {}, speicher, (d) => d, { log() {}, warn() {} }, JSON, Date, Number, Object, Set, Array);

const TASK = "2f0dc251-e534-4b33-bd26-c4bbbd4d0a07";
const alt = (n) => Array.from({ length: n }, (_, i) => ({
  id: "k" + i, text: "Alter Kommentar " + (i + 1),
  createdAt: new Date(Date.UTC(2026, 8, 10, 12, i)).toISOString(),
}));

/* ══ 1. Genau der Fall: der neue Kommentar überlebt ═══════════════════════ */
{
  // Hier, im aktiven Tab: um 05:02 ein Kommentar dazu, dann Person und Link.
  const hier = {
    entities: { tasks: { [TASK]: {
      id: TASK, title: "SP AR Originalunterlagen an Silvan", status: "todo",
      createdAt: "2026-09-01T07:00:00.000Z",
      updatedAt: "2026-09-11T05:02:30.000Z",
      comments: [{ id: "k_neu", text: "Mail an Silvia bestätigt gesendet.",
        createdAt: "2026-09-11T05:02:00.000Z" }].concat(alt(4).reverse()),
      externalLinks: [{ id: "x_neu", label: "Gmail-Thread", url: "https://mail.google.com/x",
        createdAt: "2026-09-11T05:02:20.000Z" }],
      linkedPersons: ["p_silvia"],
    } } },
  };
  // Dort, im anderen Tab: dieselbe Aufgabe OHNE den Kommentar, aber spaeter
  // nebenbei beruehrt — irgendetwas hat updatedAt hochgezogen.
  const dort = {
    entities: { tasks: { [TASK]: {
      id: TASK, title: "SP AR Originalunterlagen an Silvan", status: "todo",
      createdAt: "2026-09-01T07:00:00.000Z",
      updatedAt: "2026-09-11T05:03:00.000Z",
      comments: alt(4).reverse(),
      externalLinks: [],
      linkedPersons: [],
    } } },
  };

  const raus = laden.mergeData(hier, dort).entities.tasks[TASK];
  eq(raus.comments.length, 5, "der um 05:02 erfasste Kommentar ist beim Abgleich verschwunden");
  ok(raus.comments.some((c) => c.id === "k_neu"), "der neue Kommentar fehlt");
  eq(raus.comments[0].id, "k_neu", "der neue Kommentar steht nicht oben");
  eq(raus.comments.filter((c) => /^k[0-3]$/.test(c.id)).length, 4, "die vier alten Kommentare gingen verloren");
  eq(raus.externalLinks.map((x) => x.id), ["x_neu"], "der externe Gmail-Link ist verschwunden");
  eq(raus.linkedPersons, ["p_silvia"], "die verknüpfte Person ist verschwunden");
  // Und die juengere Fassung bleibt sonst die Grundlage.
  eq(raus.updatedAt, "2026-09-11T05:03:00.000Z", "der jüngere Stand hat nicht gewonnen");

  // Dieselbe Rechnung andersherum — die Seiten dürfen vertauschbar sein.
  const anders = laden.mergeData(dort, hier).entities.tasks[TASK];
  eq(anders.comments.length, 5, "andersherum gerechnet fehlt der Kommentar");
  eq(anders.linkedPersons, ["p_silvia"], "andersherum gerechnet fehlt die Person");
}

/* ══ 2. Eine Löschung bleibt eine Löschung ════════════════════════════════
   Das ist die Kehrseite des Vereinigens: Ein bewusst geloeschter Kommentar
   darf nicht wiederkehren. Dafuer sorgt der Grabstein, den deleteComment
   schreibt — nicht ein Zeitstempelvergleich. */
{
  const geloescht = {
    entities: { tasks: { [TASK]: {
      id: TASK, title: "T", createdAt: "2026-09-01T07:00:00.000Z",
      updatedAt: "2026-09-11T06:00:00.000Z",
      comments: alt(4).reverse().filter((c) => c.id !== "k2"),
      deletedComments: { k2: "2026-09-11T06:00:00.000Z" },
    } } },
  };
  const altbestand = {
    entities: { tasks: { [TASK]: {
      id: TASK, title: "T", createdAt: "2026-09-01T07:00:00.000Z",
      updatedAt: "2026-09-10T13:00:00.000Z",
      comments: alt(4).reverse(),                                 // hier ist k2 noch da
    } } },
  };
  const raus = laden.mergeData(geloescht, altbestand).entities.tasks[TASK];
  eq(raus.comments.length, 3, "der gelöschte Kommentar ist wiederauferstanden");
  ok(!raus.comments.some((c) => c.id === "k2"), "k2 kam zurück, obwohl er gelöscht wurde");
  eq(raus.deletedComments.k2, "2026-09-11T06:00:00.000Z", "der Grabstein ging verloren");

  // Auch andersherum: Der Grabstein der ÄLTEREN Seite wirkt genauso.
  const umgekehrtStand = laden.mergeData(altbestand, geloescht);
  const umgekehrt = umgekehrtStand.entities.tasks[TASK];
  eq(umgekehrt.comments.length, 3, "der Grabstein der älteren Fassung wirkte nicht");
  ok(umgekehrt.deletedComments && umgekehrt.deletedComments.k2,
    "der Grabstein wurde nicht in den gemergten Stand übernommen");
  // Und er überlebt eine weitere Runde, in der nur noch die alte Seite spricht.
  const runde2 = laden.mergeData(umgekehrtStand, altbestand).entities.tasks[TASK];
  eq(runde2.comments.length, 3, "in der nächsten Runde kam der gelöschte Kommentar zurück");
}

/* ══ 3. Keine Löschabsicht aus blossem Fehlen ═════════════════════════════
   Genau daran waere der erste Anlauf gescheitert: Der Kommentar von 05:02
   ist AELTER als der Stand der Gegenseite (05:03) — trotzdem hat sie ihn nie
   gesehen. Ohne Grabstein wird nichts entfernt. */
{
  const bauen = (updatedAt, kommentare, tote) => ({
    entities: { tasks: { [TASK]: Object.assign({ id: TASK, title: "T",
      createdAt: "2026-09-01T07:00:00.000Z", updatedAt, comments: kommentare },
      tote ? { deletedComments: tote } : {}) } },
  });
  const juenger = bauen("2026-09-11T05:03:00.000Z", []);
  const aelterMitNeuem = bauen("2026-09-11T05:02:30.000Z",
    [{ id: "n1", text: "gleichzeitig", createdAt: "2026-09-11T05:02:00.000Z" }]);
  eq(laden.mergeData(juenger, aelterMitNeuem).entities.tasks[TASK].comments.length, 1,
    "ein gleichzeitig entstandener Kommentar wurde als gelöscht behandelt");
  // Mit Grabstein dagegen bleibt er weg.
  const juengerMitGrab = bauen("2026-09-11T05:03:00.000Z", [], { n1: "2026-09-11T05:03:00.000Z" });
  eq(laden.mergeData(juengerMitGrab, aelterMitNeuem).entities.tasks[TASK].comments.length, 0,
    "der Grabstein wurde übergangen");
  // Ein Eintrag ohne Id lässt sich nicht zuordnen und wird nicht übernommen.
  const ohneId = bauen("2026-09-11T05:02:30.000Z", [{ text: "ohne Id" }]);
  eq(laden.mergeData(juenger, ohneId).entities.tasks[TASK].comments.length, 0,
    "ein Eintrag ohne Id wurde übernommen — er wäre bei jedem Abgleich ein neuer");
}

/* ══ 4. Alles andere bleibt, wie es war ═══════════════════════════════════ */
{
  const hier = { entities: { notes: { n1: { id: "n1", title: "Alt", text: "A",
    updatedAt: "2026-09-10T10:00:00.000Z" } } } };
  const dort = { entities: { notes: { n1: { id: "n1", title: "Neu", text: "B",
    updatedAt: "2026-09-11T10:00:00.000Z" } } } };
  const raus = laden.mergeData(hier, dort).entities.notes.n1;
  eq(raus.title, "Neu", "ein gewöhnliches Feld wird nicht mehr von der jüngeren Fassung bestimmt");
  eq(raus.text, "B", "ein gewöhnliches Feld wird nicht mehr von der jüngeren Fassung bestimmt");
  ok(!("comments" in raus), "es wurden Felder erfunden, die es gar nicht gab");

  // Eine Entität, die es nur auf einer Seite gibt, bleibt unangetastet.
  const nurHier = laden.mergeData(
    { entities: { notes: { n2: { id: "n2", title: "Nur hier", updatedAt: "2026-09-11T10:00:00.000Z" } } } },
    { entities: { notes: {} } }).entities.notes.n2;
  eq(nurHier.title, "Nur hier", "eine Entität ohne Gegenstück ging verloren");
}

/* ══ 5. Quelltext: die Regel steht an EINER Stelle ════════════════════════ */
{
  const me = funktion("mergeEntity");
  ok(/NACHTRAGSLISTEN/.test(me) && /comments/.test(me) && /externalLinks/.test(me),
    "die Nachtragslisten stehen nicht in mergeEntity");
  ok(/linkListenVereinen/.test(me), "die linked…-Listen werden nicht vereinigt");
  // Sie muss in sich geschlossen sein: die Tests schneiden sie namentlich heraus.
  ok(/function listenVereinen/.test(me) && /function grabsteineVereinen/.test(me)
    && /function linkListenVereinen/.test(me),
    "mergeEntity braucht Hilfsfunktionen von aussen — beim Herausschneiden fehlen sie");
  // Und die Grabsteine werden auch wirklich geschrieben.
  const dc = funktion("deleteComment");
  ok(/deletedComments\[commentId\] = nowIso\(\)/.test(dc),
    "deleteComment schreibt keinen Grabstein — der Kommentar käme beim nächsten Abgleich zurück");
  const rl = funktion("removeExternalLink");
  ok(/deletedExternalLinks\[linkId\] = nowIso\(\)/.test(rl),
    "removeExternalLink schreibt keinen Grabstein");
}

console.log(`sync kommentar-verlust: ok (${checks} Pruefungen)`);
