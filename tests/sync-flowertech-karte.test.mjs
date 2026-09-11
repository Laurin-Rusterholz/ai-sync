/*
 * Der wiederhergestellte Fragebogen verschwand beim Abgleich.
 * ---------------------------------------------------------------------------
 * Befund (11.09.2026, 06:07): Sitzungsstart mit erfolgreichem Merge (1004
 * Entities, 129 Aufgaben, 16 Projekte, 50 Notizen), danach in FlowerTech
 * „Jetzt synchronisieren". Ergebnis: „Kundenanfragen" enthielt nur noch vier
 * Formulare, und die Auskunft zum Token pf-kXRwq0T1lOUcH7fsknz_b sagte wieder
 * „kein Fragebogen in dieser Quantus-Fassung". Am 11.09. 00:04 war genau
 * dieser Token dem Projekt e543fc2e-064a-4b93-a75e-2f543ef3263d zugeordnet
 * und der Originalstand-Schutz nach Reload bestätigt. Es wurde nichts
 * gelöscht, nichts ersetzt, nichts wiederhergestellt — nur gemergt und
 * gelesen.
 *
 * Die Ursache liegt in der Vereinigung der übrigen Bereiche. Sie ging nur
 * EINE Ebene tief. `data.flowertech` ist eine Karte von Karten — intakes,
 * docs, clients, videos —, und keine dieser inneren Karten trägt selbst ein
 * updatedAt. Der Zeitstempelvergleich lieferte auf beiden Seiten 0, also
 * blieb der LOKALE Wert stehen: die ganze Karte, samt allem, was nur die
 * Gegenseite kannte. Ein Tab, dessen lokales `flowertech` den
 * wiederhergestellten Bogen nicht kannte, setzte damit seine Karte durch —
 * und der anschliessende Push entfernte den Eintrag auch auf dem Server.
 *
 * Das ist eine ANDERE Datenklasse als der Kommentarverlust: Kommentare und
 * Verknüpfungen hängen an `entities` und haben dort seit dem 11.09. ihre
 * eigene Vereinigung. `flowertech` hing am Auffangzweig.
 *
 * Geprüft wird die ECHTE mergeData aus index.html.
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
  return index.slice(a, b > a ? b : a + 12000);
}

function lader(deleteLog) {
  const speicher = {
    _delete_log: JSON.stringify(deleteLog || {}),
    getItem(k) { return Object.prototype.hasOwnProperty.call(this, k) ? this[k] : null; },
    setItem(k, v) { this[k] = String(v); },
    removeItem(k) { delete this[k]; },
  };
  return new Function(
    "idbBackup", "localStorage", "normalizeData", "console", "JSON", "Date", "Number", "Object",
    "Set", "Array", "Map",
    index.slice(index.indexOf("const TRANSPORT_ROOTS = new Set(["),
      index.indexOf("]);", index.indexOf("const TRANSPORT_ROOTS = new Set([")) + 3) + "\n"
    + ["getDeleteLog", "mergeAndPersistDeleteLog", "flattenDeleteLog", "entityTimestamp", "mergeEntity"]
      .map(funktion).join("\n") + "\n"
    + funktion("mergeData")
    + "\nreturn { mergeData };")(
    () => {}, speicher, (d) => d, { log() {}, warn() {} }, JSON, Date, Number, Object,
    Set, Array, Map).mergeData;
}

const PROJEKT = "e543fc2e-064a-4b93-a75e-2f543ef3263d";
const PF = "pf-kXRwq0T1lOUcH7fsknz_b";
const YS = "YsJLRllvKkIT3f03O4WzrS49";

const bogen = (id, token, extra) => Object.assign({
  id, title: "Ihre Angaben", inviteToken: token, boundProjectId: PROJEKT,
  status: "open", createdAt: "2026-09-01T07:00:00.000Z", updatedAt: "2026-09-01T07:00:00.000Z",
}, extra || {});

// Vier Formulare kennen beide Seiten; den fuenften kennt nur der Server.
const VIER = {
  in_a: bogen("in_a", "aaaaaaaaaaaaaaaaaaaaaaaa"),
  in_b: bogen("in_b", "bbbbbbbbbbbbbbbbbbbbbbbb"),
  in_c: bogen("in_c", "cccccccccccccccccccccccc"),
  in_karte: bogen("in_karte", YS),
};
const WIEDERHERGESTELLT = bogen("in_wh", PF, {
  restoredFrom: "published-intake-form", restoredAt: "2026-09-11T00:04:00.000Z",
  createdAt: "2026-09-11T00:04:00.000Z", updatedAt: "2026-09-11T00:04:00.000Z",
  publishedAt: "2026-09-02T06:59:00.000Z", formGeneration: 1,
});

const stand = (intakes, extra) => ({
  entities: { projects: {}, tasks: {} },
  flowertech: Object.assign({
    intakes: JSON.parse(JSON.stringify(intakes)),
    docs: [], clients: [], videos: {}, counters: { offer_2026: 7 },
    company: { name: "FlowerTech" }, ui: {},
  }, extra || {}),
});

/* ══ 1. Genau der Fall: der Server kennt ihn, dieser Tab nicht ════════════ */
{
  const mergeData = lader();
  const hier = stand(VIER);                                        // Tab ohne den Bogen
  const dort = stand(Object.assign({}, VIER, { in_wh: WIEDERHERGESTELLT }));  // Server

  const raus = mergeData(hier, dort).flowertech.intakes;
  eq(Object.keys(raus).length, 5,
    "der wiederhergestellte Fragebogen ist beim Abgleich verschwunden");
  ok(raus.in_wh, "der Bogen zum pf-Token fehlt");
  eq(raus.in_wh.inviteToken, PF, "der Token wurde verändert");
  eq(raus.in_wh.boundProjectId, PROJEKT, "die Zuordnung zum Aljia-Projekt ging verloren");
  eq(raus.in_wh.restoredFrom, "published-intake-form", "die Herkunft ging verloren");
  // Die vier bekannten bleiben unangetastet.
  eq(Object.keys(raus).filter((k) => k !== "in_wh").sort(), ["in_a", "in_b", "in_c", "in_karte"],
    "die bereits bekannten Formulare wurden verändert");

  // Andersherum gerechnet genauso — die Seiten sind vertauschbar.
  const anders = mergeData(dort, hier).flowertech.intakes;
  eq(Object.keys(anders).length, 5, "andersherum gerechnet fehlt der Bogen");
}

/* ══ 2. Die Nachbarbereiche desselben Bereichs ════════════════════════════ */
{
  const mergeData = lader();
  const hier = stand(VIER, { docs: [{ id: "d1", title: "Offerte A", updatedAt: "2026-09-01T00:00:00.000Z" }] });
  const dort = stand(VIER, {
    docs: [{ id: "d2", title: "Offerte B", updatedAt: "2026-09-10T00:00:00.000Z" }],
    videos: { v1: { id: "v1", url: "https://x", updatedAt: "2026-09-10T00:00:00.000Z" } },
    company: { name: "FlowerTech", vatRate: 8.1 },
  });
  const raus = mergeData(hier, dort).flowertech;
  eq(raus.docs.map((d) => d.id).sort(), ["d1", "d2"], "ein Dokument der Gegenseite ging verloren");
  ok(raus.videos.v1, "ein Video der Gegenseite ging verloren");
  eq(raus.company.vatRate, 8.1, "ein Feld der Gegenseite ging verloren");
  eq(raus.company.name, "FlowerTech", "der lokale Firmenname wurde überschrieben");
  eq(raus.counters.offer_2026, 7, "eine laufende Nummer wurde verändert");
}

/* ══ 3. Eine echte Löschung bleibt eine Löschung ══════════════════════════
   Sonst wäre die Vereinigung eine Wiederauferstehungsmaschine: Der Rückweg
   „Wiederherstellung zurücknehmen" schreibt deshalb einen Grabstein. */
{
  const mergeData = lader({ ftIntake: { in_wh: Date.parse("2026-09-11T05:00:00.000Z") } });
  const hier = stand(VIER);                                        // hier zurückgenommen
  const dort = stand(Object.assign({}, VIER, { in_wh: WIEDERHERGESTELLT }));
  const raus = mergeData(hier, dort).flowertech.intakes;
  eq(Object.keys(raus).length, 4, "der zurückgenommene Bogen ist wiederauferstanden");
  ok(!raus.in_wh, "in_wh kam zurück, obwohl er ausdrücklich zurückgenommen wurde");

  // Ein Grabstein, der ÄLTER ist als der Eintrag, wirkt nicht: Der Bogen wurde
  // danach neu angelegt.
  const spaeter = lader({ ftIntake: { in_wh: Date.parse("2026-09-10T00:00:00.000Z") } });
  const raus2 = spaeter(stand(VIER), dort).flowertech.intakes;
  eq(Object.keys(raus2).length, 5, "ein alter Grabstein löscht einen neueren Eintrag");
}

/* ══ 4. Alles andere bleibt, wie es war ═══════════════════════════════════ */
{
  const mergeData = lader();
  // Reihenfolgen, Zahlen und Schalter gehören weiterhin dem lokalen Stand.
  const hier = { entities: {}, flowertech: { ui: { projectId: "p_hier" }, counters: { offer_2026: 9 } },
    todaySelectedTasks: ["t1", "t2"] };
  const dort = { entities: {}, flowertech: { ui: { projectId: "p_dort" }, counters: { offer_2026: 3 } },
    todaySelectedTasks: ["t9"] };
  const raus = mergeData(hier, dort);
  eq(raus.flowertech.ui.projectId, "p_hier", "ein lokaler Schalter wurde überschrieben");
  eq(raus.flowertech.counters.offer_2026, 9, "eine lokale Zahl wurde überschrieben");
  // Und ein Bereich, den es nur auf der Gegenseite gibt, kommt weiterhin mit.
  const neu = mergeData({ entities: {} }, { entities: {}, handbook: { h1: { id: "h1" } } });
  ok(neu.handbook && neu.handbook.h1, "ein Bereich der Gegenseite ging verloren");
}

/* ══ 5. Quelltext: die Tiefe ist begrenzt und der Rückweg vermerkt ════════ */
{
  const md = funktion("mergeData");
  ok(/unionMap\(lv, rv, stufe \+ 1\)/.test(md), "die Vereinigung geht nicht tiefer als eine Ebene");
  ok(/stufe < 2/.test(md), "die Vereinigung hat keine Tiefenbegrenzung");
  ok(/const begraben =/.test(md), "die Grabsteine werden im Auffangzweig nicht beachtet");
  const ft = fs.readFileSync(path.join(root, "public/flowertech.js"), "utf8");
  const undo = ft.slice(ft.indexOf("window._ftUndoRestoredIntake"),
    ft.indexOf("function tokenAuskunftHtml"));
  ok(/logDeletion\("ftIntake", intakeId\)/.test(undo),
    "das Zurücknehmen schreibt keinen Grabstein — der Bogen käme beim nächsten Abgleich zurück");
  ok(undo.indexOf("logDeletion") < undo.indexOf("save()"),
    "der Grabstein wird erst nach dem Speichern geschrieben");
}

console.log(`sync flowertech-karte: ok (${checks} Pruefungen)`);
