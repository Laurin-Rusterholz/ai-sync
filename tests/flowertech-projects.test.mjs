/*
 * FlowerTech: Projekte, Offerten, Planung und Gmail.
 *
 * 1) Projekte hatten in FlowerTech eine EIGENE, abgespeckte Detailansicht
 *    (renderProjectDetail) und wurden davor als Kachelraster gelistet. Dadurch
 *    war ein FlowerTech-Projekt deutlich duenner als jedes andere Projekt:
 *    keine Zeiterfassung, keine Verknuepfungen, kein Mailverlauf, kein
 *    Deckblatt. Jetzt gibt es nur noch EINE Projektseite — die normale unter
 *    #/projects/<id>. Der FlowerTech-Teil haengt als Block (ftProjectPanel)
 *    darin, die Kacheln sind einer Liste gewichen.
 *
 * 2) Offerten und Rechnungen waren auf Titel, Kunde, Positionen und zwei
 *    Textfelder beschraenkt. Ergaenzt: Referenz, Ansprechperson,
 *    Leistungszeitraum, Zahlungskonditionen, Konditionstext, interne Notiz,
 *    Positionsbeschreibung und Positionsrabatt, Kennzahlenstreifen,
 *    Statusverlauf sowie Fristwarnungen.
 *
 * 3) Planung: Meilensteine je Projekt plus eine Ansicht ueber alle Projekte,
 *    die Aufgaben, Meilensteine, Rechnungs- und Offertfristen nach
 *    Dringlichkeit gruppiert. Aufgaben bleiben dabei bewusst normale
 *    Quantus-Aufgaben — FlowerTech legt keine eigene Aufgabenart an.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ft = fs.readFileSync(path.join(root, "public/flowertech.js"), "utf8");
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

// ── 1. Eine Projektseite, keine Kacheln ────────────────────────────────────
assert.doesNotMatch(ft, /function renderProjectDetail\s*\(/,
  "die abgespeckte FlowerTech-Projektansicht ist wieder da — ein FlowerTech-Projekt muss auf der normalen Projektseite liegen");
assert.doesNotMatch(ft, /ft-project-card/,
  "die Projekt-Kacheln sind wieder da");
assert.match(ft, /function ftProjectPanel\(projectId\)\s*\{/, "ftProjectPanel() fehlt");
assert.match(ft, /window\.ftProjectPanel = ftProjectPanel;/, "ftProjectPanel() wird nicht exportiert");
// _ftOpenProject navigiert auf die echte Projektseite statt eine eigene zu oeffnen.
assert.match(ft, /location\.hash = "#\/projects\/" \+ projectId;/,
  "_ftOpenProject() oeffnet nicht mehr die normale Projektseite");
// Der Block haengt in viewProjectDetail und nur fuer FlowerTech-Projekte.
assert.match(index, /p\.projectType === "flowertech" && typeof window\.ftProjectPanel === "function" \? window\.ftProjectPanel\(id\) : ""/,
  "der FlowerTech-Block wird nicht in viewProjectDetail eingehaengt");
// Die Liste ersetzt das Kachelraster.
assert.match(ft, /function projectRow\(project\)\s*\{/, "die Projektliste (projectRow) fehlt");
assert.match(ft, /ft-plist-head/, "der Listenkopf der Projektliste fehlt");

// ── 2. Ausfuehrlichere Offerten und Rechnungen ─────────────────────────────
for (const field of ["reference", "contactPerson", "periodFrom", "periodTo", "paymentTerms", "terms", "notesInternal"]) {
  assert.ok(ft.includes(field), `Dokumentfeld ${field} fehlt`);
}
assert.match(ft, /function itemAmount\(item\)\s*\{/, "itemAmount() fehlt — Positionsrabatt wird nicht gerechnet");
assert.match(ft, /discountPercent/, "Positionsrabatt fehlt");
assert.match(ft, /function docFactsHtml\(kind, doc\)/, "der Kennzahlenstreifen im Dokument fehlt");
assert.match(ft, /function historyHtml\(doc\)/, "der Statusverlauf fehlt");
assert.match(ft, /function pushHistory\(doc, event, detail\)/, "pushHistory() fehlt");
assert.match(ft, /function offerExpired\(offer\)/, "abgelaufene Offerten werden nicht erkannt");
// itemAmount muss ueberall verwendet werden, wo frueher qty*price stand —
// sonst weicht der gedruckte Betrag vom gerechneten ab.
assert.match(ft, /money\(itemAmount\(item\)\)/, "der Druck rechnet den Positionsrabatt nicht mit");
assert.doesNotMatch(ft, /cell\.textContent = money\(num\(item\.qty\) \* num\(item\.price\)\)/,
  "die Betragszelle einer Position ignoriert den Positionsrabatt wieder");

// ── 3. Planung ─────────────────────────────────────────────────────────────
assert.match(ft, /ft\.milestones = Array\.isArray\(ft\.milestones\) \? ft\.milestones : \[\];/,
  "der Meilenstein-Zustand fehlt");
assert.match(ft, /window\._ftAddMilestone = function \(projectId\)/, "_ftAddMilestone() fehlt");
assert.match(ft, /function renderPlanning\(allProjects\)/, "die Planungsansicht fehlt");
// Die frueher horizontale Bereichsleiste ist entfernt; die Bereiche stehen in
// SECTIONS und sind ueber Deep Links erreichbar (tests/flowertech-topnav-runtime).
assert.match(ft, /\["planung", "Planung", /, "der Planungsbereich fehlt");
// Aufgaben aus einer Offerte sind echte Quantus-Aufgaben, keine eigene Art.
assert.match(ft, /window\._ftOfferToTasks = function \(offerId\)/, "_ftOfferToTasks() fehlt");
assert.match(ft, /window\.createEntity\("task", \{[\s\S]{0,600}?sourceOfferItemId: item\.id/,
  "aus Offertpositionen entstehen keine echten Quantus-Aufgaben");

// ── 4. Gmail ───────────────────────────────────────────────────────────────
assert.match(ft, /window\._ftMailDoc = function \(kind, docId\)/, "_ftMailDoc() fehlt");
assert.match(ft, /linkedEntity: doc\.projectId \? \{ kind: "project", id: doc\.projectId \} : null/,
  "der Mail-Thread wird nicht mit dem Projekt verknuepft");
assert.ok(ft.includes("window.gmailComposeToEntity(\\'project\\'"),
  "der Projektblock bietet kein Mailschreiben an");

// ── 5. Mail-Fan-outs der Element-Inbox laufen gedrosselt ───────────────────
// Gleiche Ursache wie beim „Failed to fetch": zu viele gleichzeitige Anfragen
// an dieselbe Netlify-Funktion.
const entityInbox = index.slice(index.indexOf("async function loadEntityInbox"), index.indexOf("async function loadEntityDrafts"));
assert.ok(entityInbox.length > 500, "loadEntityInbox() nicht gefunden");
assert.doesNotMatch(entityInbox, /await Promise\.all\(/,
  "loadEntityInbox() feuert wieder alle Mail-Anfragen gleichzeitig ab");
assert.match(entityInbox, /await gmMapPool\(/, "loadEntityInbox() nutzt den Anfrage-Pool nicht");

console.log("flowertech projects: ok");
