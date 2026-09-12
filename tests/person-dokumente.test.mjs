/*
 * Dokumente am Kontakt selbst.
 *
 * PRODUKTIONSBEFUND (12.09.2026, Person prs_mtw0v2fhdpj7): In der
 * Personenansicht und im Bearbeitungsdialog (Basis, Kontakt, Beruf, Beziehung,
 * Persönlich, Verknüpfungen) fehlte jede Dokumentablage. Ein Originalbeleg
 * liess sich nur über eine verknüpfte Aufgabe ablegen — zwei Klicks vom
 * Kontakt entfernt.
 *
 * BEFUND AUS DEM CODE: nichts war ausgeblendet, es war halb verdrahtet.
 *   · ATTACHMENT_KIND_STORES kannte 16 Typen, `person` nicht. Alles daran
 *     (Anzeige, Upload, Umbenennen, Löschen, _reindexFile) stieg für eine
 *     Person still aus.
 *   · viewPersonDetail rief renderFileAttachments nie auf — die Funktion wird
 *     an 16 anderen Stellen benutzt.
 *   · _DRV_KINDMAP enthielt `person:'persons'` aber längst. Der einzige
 *     Einstieg in den Drive-Dialog sitzt jedoch INNERHALB von
 *     renderFileAttachments — ohne die Karte gab es keinen Knopf, die Zeile
 *     war toter Eintrag.
 *   Im Browser nachgemessen: eine per _attachDriveByLink angehängte Referenz
 *   landete am alten Stand tatsächlich in person.files, war aber nirgends zu
 *   sehen (Bereich vorhanden: nein).
 *
 * MODULGRENZE: viewPersonDetail steht in Script-Block 23, renderFileAttachments
 * in Block 5. Ein blanker Aufruf wäre ein ReferenceError gewesen und hätte die
 * ganze Personenseite zerlegt (CLAUDE.md, Fallstrick 1). Der Draht ist window.
 *
 * Geprüft wird gegen die ECHTEN Quellen aus public/index.html. Kein Browser,
 * kein Netz, keine Datei wird geschrieben; die Browserabnahme lief getrennt
 * mit einer erfundenen Testperson (scripts/person-dokumente-browsercheck.mjs).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

let checks = 0;
const luecken = [];
const ok = (bedingung, text) => { checks++; if (!bedingung) luecken.push(text); };

function schneide(start, ende) {
  const a = index.indexOf(start);
  if (a < 0) return null;
  const b = index.indexOf(ende, a);
  return b < 0 ? null : index.slice(a, b);
}

// ═══ 1. Die Anhang-Registry kennt Personen ════════════════════════════════
const regQuelle = schneide("const ATTACHMENT_KIND_STORES", "function attachmentEntity");
ok(!!regQuelle, "ATTACHMENT_KIND_STORES / attachmentStoreFor nicht gefunden");
if (regQuelle) {
  const meldungen = [];
  const api = new Function("console",
    regQuelle + "\nreturn { ATTACHMENT_KIND_STORES, attachmentStoreFor };")(
    { error: (...a) => meldungen.push(a.join(" ")) });
  ok(api.ATTACHMENT_KIND_STORES.person === "persons",
    `person fehlt in ATTACHMENT_KIND_STORES (${api.ATTACHMENT_KIND_STORES.person})`);
  ok(api.attachmentStoreFor("person", "test") === "persons",
    "attachmentStoreFor('person') löst die Sammlung nicht auf");
  ok(meldungen.length === 0, `attachmentStoreFor meldet einen Fehler: ${meldungen[0]}`);
  // Die bestehenden Typen bleiben unangetastet.
  for (const [kind, store] of Object.entries({ task: "tasks", project: "projects", note: "notes",
    organization: "organizations", meeting: "meetings", email: "emails", chatgptLead: "chatgptLeads" })) {
    ok(api.ATTACHMENT_KIND_STORES[kind] === store, `${kind} zeigt nicht mehr auf ${store}`);
  }
  ok(api.attachmentStoreFor("habit", "test") === null,
    "ein unbekannter Typ wird plötzlich aufgelöst");
}

// ═══ 2. Beide Typlisten sagen dasselbe ════════════════════════════════════
// Genau diese Abweichung war die Ursache: _DRV_KINDMAP kannte person, die
// Anhang-Registry nicht. Was in beiden steht, muss auf dieselbe Sammlung zeigen.
const drvZeile = /var _DRV_KINDMAP = \{([^}]*)\}/.exec(index);
ok(!!drvZeile, "_DRV_KINDMAP nicht gefunden");
if (drvZeile && regQuelle) {
  const drv = new Function("return {" + drvZeile[1] + "};")();
  const att = new Function(regQuelle + "\nreturn ATTACHMENT_KIND_STORES;")();
  ok(drv.person === "persons", "_DRV_KINDMAP kennt person nicht mehr");
  const abweichend = Object.keys(drv).filter((k) => att[k] && att[k] !== drv[k]);
  ok(abweichend.length === 0, `die Typlisten widersprechen sich bei: ${abweichend.join(", ")}`);
}

// ═══ 3. Die Personenansicht zeichnet den Bereich — über window ════════════
const pQuelle = schneide("window.viewPersonDetail = function(id)", "window.mhOpenPersonEditor");
ok(!!pQuelle, "viewPersonDetail nicht gefunden");
if (pQuelle) {
  ok(/typeof window\.renderFileAttachments === "function"/.test(pQuelle),
    "der Aufruf ist nicht gegen die fehlende Funktion abgesichert");
  ok(/window\.renderFileAttachments\("person", p\.id\)/.test(pQuelle),
    "die Personenansicht ruft den Dokumentbereich nicht auf");
  ok(!/[^.]\brenderFileAttachments\("person"/.test(pQuelle),
    "der Aufruf läuft ohne window — über die Modulgrenze wäre das ein ReferenceError");
  // Reihenfolge: Dokumente stehen vor den Verknüpfungen.
  ok(pQuelle.indexOf('renderFileAttachments("person"') < pQuelle.indexOf("🔗 Verknüpfungen"),
    "der Dokumentbereich steht nicht vor den Verknüpfungen");
  ok(/class="mh-detail-section"/.test(pQuelle.slice(pQuelle.indexOf("renderFileAttachments(\"person\"") - 200,
    pQuelle.indexOf("renderFileAttachments(\"person\"") + 60)),
    "der Bereich sitzt nicht in einem mh-detail-section-Abschnitt");
}
ok(/window\.renderFileAttachments = renderFileAttachments;/.test(index),
  "renderFileAttachments ist nicht mehr global erreichbar — der Draht über die Modulgrenze fehlt");

// ═══ 4. Kein neuer Reiter im Bearbeitungsdialog ═══════════════════════════
const editorQuelle = schneide("<!-- Tab-Navigation -->", "].map(([key, label])");
ok(!!editorQuelle, "die Reiterliste des Personen-Editors nicht gefunden");
if (editorQuelle) {
  const reiter = [...editorQuelle.matchAll(/\['([a-z]+)',/g)].map((m) => m[1]);
  ok(reiter.join(",") === "basic,contact,work,relationship,personal,links",
    `die Reiter haben sich geändert: ${reiter.join(",")}`);
  ok(!/datei|dokument/i.test(editorQuelle), "es ist doch ein Dokument-Reiter dazugekommen");
}

// ═══ 5. Bearbeiten darf Dateien und Felder nicht verlieren ════════════════
// mhSavePerson baut den neuen Stand als { ...existing, ...w }. Alles, was
// mhReadPersonFields NICHT liefert, überlebt damit — files gehört dazu.
const leseQuelle = schneide("function mhReadPersonFields(basis)", "window.mhPersonSwitchTab");
ok(!!leseQuelle, "mhReadPersonFields nicht gefunden");
if (leseQuelle) {
  ok(!/\bfiles\s*:/.test(leseQuelle),
    "mhReadPersonFields liefert jetzt ein files-Feld — beim Speichern gingen angehängte Dokumente verloren");
  for (const feld of ["emails", "phones", "address", "role", "howWeMet", "notes"]) {
    ok(new RegExp("\\b" + feld + "\\s*:").test(leseQuelle), `das Feld ${feld} wird nicht mehr gelesen`);
  }
}
const saveQuelle = schneide("window.mhSavePerson = function(existingId)", "window.mhDeletePerson");
ok(!!saveQuelle, "mhSavePerson nicht gefunden");
if (saveQuelle) {
  const bau = /APP\.state\.data\.entities\.persons\[id\] = \{\s*\.\.\.existing,\s*\.\.\.w,/.test(saveQuelle);
  ok(bau, "mhSavePerson übernimmt den bestehenden Stand nicht mehr zuerst — Dateien fielen weg");
  ok(/interactions: existing\.interactions/.test(saveQuelle),
    "die bestehende Interaktionsliste wird nicht mehr übernommen");
}

// ═══ 6. Der Weg zur Datei ist derselbe wie überall ════════════════════════
const anhangQuelle = schneide("function renderFileAttachments(kind, entityId)", "window.renderFileAttachments =");
ok(!!anhangQuelle, "renderFileAttachments nicht gefunden");
if (anhangQuelle) {
  ok(/_attachFromDrive\('\$\{kind\}','\$\{entityId\}'\)/.test(anhangQuelle),
    "der Drive-Knopf trägt nicht mehr den Typ der Entität — für Personen käme der falsche Weg");
  ok(/_reindexAllFiles\(/.test(anhangQuelle) || /_reindexFile\(/.test(anhangQuelle),
    "die Indexierung ist aus dem Bereich verschwunden");
}

ok(/name="quantus-build"[^>]*person-dokumente/.test(index),
  "die Bau-Kennung nennt die Änderung nicht");

if (luecken.length) {
  console.error(`person dokumente: ${luecken.length} von ${checks} Pruefungen offen`);
  for (const l of luecken) console.error("  - " + l);
  process.exit(1);
}
console.log(`person dokumente: ${checks} Pruefungen bestanden`);
