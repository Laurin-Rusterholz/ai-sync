/* Dokumentbereich an einer PERSON — Abnahme im echten Browser.
 *
 * Bewusst OHNE Abkuerzungen:
 *  · Die Drive-Referenz wird ueber den echten Klickpfad angelegt: Knopf
 *    „Aus Drive“ in der Karte → Dialog → Felder → „Verknuepfen“.
 *  · Gespeichert wird ueber den echten Weg der App (pagehide → flushLocalSave
 *    → localStorage), und danach folgt ein ECHTES page.reload(). Nach dem
 *    Neuladen wird NICHTS neu gesaet — was da ist, kommt aus dem Speicher.
 *  · Jede Erwartung ist eine Zusicherung: schlaegt eine fehl, endet das
 *    Skript mit Exitcode 1.
 *
 * GRENZEN, damit die Aussage nicht mehr behauptet, als sie zeigt:
 *  · Geprueft ist die LOKALE Persistenz (localStorage) und der Wiederaufbau
 *    daraus. Der Wolken-Abgleich (doSave/mergeData gegen Firebase) laeuft hier
 *    nicht — ohne Anmeldung gibt es keinen Server. Fuer das Zusammenfuehren
 *    gilt der bestehende Vertrag: files[] ist eine gewoehnliche Entity-Liste
 *    wie bei Aufgabe und Projekt, dafuer sorgt mergeEntity.
 *  · Die INDEXIERUNG wird NICHT als gelungen ausgewiesen. Geprueft ist, dass
 *    der Knopf da ist und dass ein Klick bei einer privaten Drive-Adresse die
 *    ehrliche Auskunft aus PR253 liefert — nicht, dass ein Inhalt gelesen
 *    wurde. Das kann er ohne angemeldeten Drive-Zugriff auch gar nicht.
 *
 * Kein Netz, keine echten Personen-, Datei- oder Habitdaten; die Testperson
 * ist erfunden, die Drive-Id ebenso.
 *
 * Aufruf: node scripts/person-dokumente-browsercheck.mjs [wurzel] [port] [bilder]
 */
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const { chromium } = await import(process.env.PW_PFAD || "playwright-core");

const ROOT = process.argv[2] || new URL("../public", import.meta.url).pathname;
const PORT = Number(process.argv[3] || 8990);
const AUS  = process.argv[4] || "";
const T = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8",
            ".css":"text/css; charset=utf-8", ".svg":"image/svg+xml" };
const server = http.createServer((req,res)=>{
  let u = decodeURIComponent(req.url.split("?")[0]); if (u === "/") u = "/index.html";
  const p = path.join(ROOT, u);
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": T[path.extname(p)] || "application/octet-stream" });
  res.end(fs.readFileSync(p));
});
if (AUS) fs.mkdirSync(AUS, { recursive: true });
await new Promise(r => server.listen(PORT, "127.0.0.1", r));

// ── Zusicherungen ─────────────────────────────────────────────────────────
let offen = 0, geprueft = 0;
const zusichern = (bedingung, text) => {
  geprueft++;
  if (bedingung) { console.log("  ok    " + text); return true; }
  offen++; console.error("  FEHLT " + text); return false;
};

const DRIVE_ID = "TESTBELEG0000000000000000000000";   // erfunden, existiert nicht
const SAAT = () => {
  const e = window.APP.state.data.entities;
  e.persons = e.persons || {};
  e.persons.prs_test = { id:"prs_test", name:"Testperson Muster", firstName:"Test", lastName:"Muster",
    emails:["test.muster@example.invalid"], phones:["+41 00 000 00 00"], role:"Beispielrolle",
    howWeMet:"Erfunden für die Abnahme", notes:"Nur Testdaten.",
    createdAt:"2026-09-01T07:00:00.000Z", updatedAt:"2026-09-01T07:00:00.000Z" };
};
const zurPerson = async (page) => {
  await page.evaluate(()=>{ location.hash = "#/persons/prs_test"; window.render(); });
  await page.waitForTimeout(600);
};
// Echter Speicherweg der App: pagehide loest flushLocalSave aus (index.html:15693).
const echtSpeichern = async (page) => {
  await page.evaluate(()=>{ if (typeof window.scheduleSave === "function") window.scheduleSave();
    window.dispatchEvent(new Event("pagehide")); });
  await page.waitForTimeout(400);
  return page.evaluate(()=>{ try { return (localStorage.getItem("mgmt-v4-data")||"").length; } catch(e){ return 0; } });
};
const lies = (page) => page.evaluate(()=>{
  const main = document.getElementById("main");
  const txt = main ? (main.textContent || "") : "";
  const karte = main && Array.from(main.querySelectorAll(".mh-detail-section"))
    .find(el => el.querySelector("[onclick*=\"_attachFromDrive('person'\"]"));
  const p = (window.APP.state.data.entities.persons || {}).prs_test;
  return {
    personDa: !!p,
    bereichDa: !!karte,
    driveKnopf: !!(main && main.querySelector("[onclick*=\"_attachFromDrive('person'\"]")),
    indexKnopf: !!(main && main.querySelector("[onclick*=\"_reindexFile('person'\"]")),
    dateien: ((p && p.files) || []).map(f => ({ name:f.name, quelle:f.source, driveId:f.driveFileId })),
    dateiImText: /Testbeleg\.md/.test(txt),
    name: p && p.name, mail: (p && (p.emails||[])[0]) || null, rolle: p && p.role,
    wieKennen: p && p.howWeMet, notizen: p && p.notes, telefon: (p && (p.phones||[])[0]) || null,
    querlauf: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
});

/* Netz nachstellen. Zwei Punkte muessen der Live-Lage entsprechen, sonst misst
   Abschnitt 5 etwas anderes als den gemeldeten Fall:
   - Ein direkter Browserzugriff auf drive.google.com scheitert (CORS/kein
     Zugriff). Nachgestellt als abgebrochene Anfrage.
   - Der Download-Proxy liefert fuer eine PRIVATE Drive-Datei nicht die Datei,
     sondern Googles Anmeldeseite (text/html). Genau daran haengt die
     PR253-Auskunft. Der Inhalt hier ist erfunden, keine echte Seite.
   Alles uebrige Fremde wird mit einer leeren Antwort abgefangen, damit der
   Lauf ohne Netz bleibt. */
const ANMELDESEITE = "<html><head><title>Anmeldung</title></head><body>"
  + "<h1>Melde dich an</h1><p>Weiter zu Google Drive</p></body></html>";
async function netzNachstellen(seite){
  await seite.route("**://*/**", r => {
    const u = r.request().url();
    if (u.includes("/.netlify/functions/download-proxy"))
      return r.fulfill({ status:200, contentType:"text/html; charset=utf-8", body:ANMELDESEITE });
    if (/drive\.google\.com|googleusercontent\.com/.test(u)) return r.abort("failed");
    if (u.startsWith("http://127.0.0.1:" + PORT + "/")) return r.continue();
    return r.fulfill({ status:200, contentType:"application/json", body:"{}" });
  });
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PFAD || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const seitenfehler = [];
page.on("pageerror", e => seitenfehler.push(e.message));
await netzNachstellen(page);

console.log("\n── 1) Bereich vorhanden (erfundene Person, 1440px) ──");
await page.goto(`http://127.0.0.1:${PORT}/index.html#/persons`, { waitUntil:"domcontentloaded" });
await page.waitForFunction(()=>window.APP && window.APP.state && typeof window.render === "function", null, { timeout:20000 });
await page.evaluate(SAAT);
await zurPerson(page);
let s = await lies(page);
zusichern(s.bereichDa, "Dokumentbereich wird an der Person gezeigt");
zusichern(s.driveKnopf, "Knopf „Aus Drive“ ist da und traegt den Typ person");
zusichern(!s.querlauf, "kein seitlicher Querlauf bei 1440px");

console.log("\n── 2) Drive-Referenz ueber den echten Klickpfad ──");
await page.click("[onclick*=\"_attachFromDrive('person'\"]");
await page.waitForTimeout(500);
zusichern(await page.locator("#drvLinkId").count() > 0, "der Dialog „Aus Drive anhaengen“ ist offen");
await page.fill("#drvLinkId", `https://drive.google.com/file/d/${DRIVE_ID}/view`);
await page.fill("#drvLinkName", "Testbeleg.md");
await page.click("button:has-text('Verknüpfen')");
await page.waitForTimeout(400);
const hinweis = await page.locator("#drvLinkHinweis").textContent().catch(()=> "");
zusichern(/Verkn/i.test(hinweis || ""), "der Dialog bestaetigt die Verknuepfung: " + String(hinweis || "").trim());
await page.evaluate(()=>{ if (window.closeModal) window.closeModal(); });
await zurPerson(page);
s = await lies(page);
zusichern(s.dateien.length === 1, `genau eine Datei an der Person (${s.dateien.length})`);
zusichern(s.dateien[0] && s.dateien[0].quelle === "gdrive" && s.dateien[0].driveId === DRIVE_ID,
  "die Datei ist als Drive-Referenz mit Id hinterlegt");
zusichern(s.dateiImText, "die Datei steht sichtbar in der Karte");
zusichern(s.indexKnopf, "der Indexierungsknopf ist da (ob er Inhalt liest, sagt Abschnitt 5)");
if (AUS) await page.screenshot({ path: `${AUS}/person-1440.png`, clip:{x:0,y:0,width:1440,height:900} });

console.log("\n── 3) Echtes Speichern und echtes Neuladen ──");
const groesse = await echtSpeichern(page);
zusichern(groesse > 0, `der Stand liegt im lokalen Speicher (${groesse} Zeichen)`);
await page.reload({ waitUntil:"domcontentloaded" });
await page.waitForFunction(()=>window.APP && window.APP.state && typeof window.render === "function", null, { timeout:20000 });
await page.waitForTimeout(800);
// AUSDRUECKLICH KEINE neue Saat — was jetzt da ist, kommt aus dem Speicher.
await zurPerson(page);
s = await lies(page);
zusichern(s.personDa, "die Person kommt nach dem Neuladen aus dem Speicher zurueck");
zusichern(s.dateien.length === 1 && s.dateien[0].driveId === DRIVE_ID,
  `die Drive-Referenz ueberlebt das Neuladen (${JSON.stringify(s.dateien)})`);
zusichern(s.bereichDa && s.dateiImText, "sie wird nach dem Neuladen auch wieder angezeigt");
zusichern(s.mail === "test.muster@example.invalid" && s.rolle === "Beispielrolle",
  "die Kontaktfelder ueberleben das Neuladen");

console.log("\n── 4) Bearbeiten darf nichts wegnehmen ──");
await page.evaluate(()=>window.mhOpenPersonEditor("prs_test"));
await page.waitForTimeout(500);
zusichern(await page.locator("#mhpName").count() > 0, "der Bearbeitungsdialog ist offen");
const reiter = await page.evaluate(()=>Array.from(document.querySelectorAll("[onclick*='mhPersonSwitchTab']"))
  .map(b => (b.textContent||"").trim()));
zusichern(reiter.length === 6, `es gibt weiterhin sechs Reiter (${reiter.length}: ${reiter.join(" | ")})`);
zusichern(!reiter.some(r => /datei|dokument/i.test(r)), "kein neuer Dokument-Reiter");
await page.fill("#mhpName", "Testperson Muster (geändert)");
await page.click("button:has-text('Aktualisieren')");
await page.waitForTimeout(600);
await echtSpeichern(page);
await page.reload({ waitUntil:"domcontentloaded" });
await page.waitForFunction(()=>window.APP && window.APP.state, null, { timeout:20000 });
await page.waitForTimeout(800);
await zurPerson(page);
s = await lies(page);
zusichern(s.name === "Testperson Muster (geändert)", `die Aenderung ist gespeichert (${s.name})`);
zusichern(s.dateien.length === 1, `die Datei ist nach dem Bearbeiten noch da (${s.dateien.length})`);
zusichern(s.mail === "test.muster@example.invalid", "E-Mail erhalten");
zusichern(s.telefon === "+41 00 000 00 00", "Telefon erhalten");
zusichern(s.rolle === "Beispielrolle", "Rolle erhalten");
zusichern(s.wieKennen === "Erfunden für die Abnahme", "„Wie wir uns kennen“ erhalten");
zusichern(s.notizen === "Nur Testdaten.", "Notizen erhalten");

console.log("\n── 5) Indexierung: was wirklich passiert ──");
// Der Klick fuehrt bei einer privaten Drive-Adresse NICHT zu einem Index. Er
// muss die ehrliche Auskunft aus PR253 liefern — mehr wird hier nicht behauptet.
// Beobachtet wird die Zeile an der Datei selbst: toast() lebt in der Huelle von
// Block 1 und laesst sich von aussen nicht abfangen, die Zeile im DOM schon —
// und sie ist ohnehin das, was der Nutzer liest.
const nachIndex = await page.evaluate(async ()=>{
  const p = window.APP.state.data.entities.persons.prs_test;
  const fid = (p.files[0]||{}).id;
  const b = document.querySelector("[onclick*=\"_reindexFile('person'\"]");
  if (!b) return { geklickt:false };
  b.click();
  await new Promise(r => setTimeout(r, 2500));
  const zeile = document.querySelector('[data-text-extract="' + fid + '"]');
  const p2 = window.APP.state.data.entities.persons.prs_test;
  return { geklickt:true, zeilenText: zeile ? (zeile.textContent||"").trim() : null,
    status: (p2.files[0]||{}).textExtractStatus, dateien: (p2.files||[]).length,
    wiederholenDa: !!(zeile && zeile.querySelector("[onclick*='_reindexFile']")) };
});
zusichern(nachIndex.geklickt, "der Indexierungsknopf liess sich anklicken");
zusichern(!!nachIndex.zeilenText, "an der Datei steht danach eine Auskunft");
zusichern(/Drive-Zugriff|Anmeldeseite/i.test(nachIndex.zeilenText || ""),
  "die Auskunft nennt den fehlenden angemeldeten Drive-Zugriff: " + (nachIndex.zeilenText||""));
zusichern(!/neu hochladen/i.test(nachIndex.zeilenText || ""),
  "die Auskunft raet NICHT zum Neuhochladen (PR253)");
zusichern(nachIndex.wiederholenDa, "der Weg fuer einen spaeteren Versuch bleibt stehen");
zusichern(nachIndex.dateien === 1, "die Verknuepfung bleibt trotz misslungener Indexierung bestehen");
console.log("  info  Die Indexierung ist NICHT gelungen, und das ist das erwartete Ergebnis: "
  + "ohne angemeldeten Drive-Zugriff ist der Inhalt nicht lesbar. Status der Datei: "
  + nachIndex.status + ". Dieser Lauf zeigt also NICHT, dass Indexierung funktioniert — "
  + "nur, dass der Weg da ist und ehrlich meldet, woran es liegt.");

console.log("\n── 6) Schmal (390px) ──");
const ctx2 = await browser.newContext({ viewport:{ width:390, height:900 } });
const page2 = await ctx2.newPage();
page2.on("pageerror", e => seitenfehler.push(e.message));
await netzNachstellen(page2);
await page2.goto(`http://127.0.0.1:${PORT}/index.html#/persons`, { waitUntil:"domcontentloaded" });
await page2.waitForFunction(()=>window.APP && window.APP.state && typeof window.render === "function", null, { timeout:20000 });
await page2.evaluate(SAAT);
await page2.evaluate((id)=>{ const p = window.APP.state.data.entities.persons.prs_test;
  p.files = [{ id:"f1", name:"Testbeleg.md", url:"https://drive.google.com/uc?export=download&id="+id,
    driveFileId:id, source:"gdrive", uploadedAt:"2026-09-12T08:00:00.000Z" }]; }, DRIVE_ID);
await zurPerson(page2);
const s2 = await lies(page2);
zusichern(s2.bereichDa && s2.dateiImText, "der Bereich und die Datei sind auch bei 390px da");
zusichern(!s2.querlauf, "kein seitlicher Querlauf bei 390px");
if (AUS) await page2.screenshot({ path:`${AUS}/person-390.png`, clip:{x:0,y:0,width:390,height:900} });

zusichern(seitenfehler.length === 0, `keine Seitenfehler (${seitenfehler.slice(0,2).join(" | ")})`);

await browser.close(); server.close();
console.log(`\n${geprueft - offen} von ${geprueft} Zusicherungen erfuellt.`);
if (offen) { console.error(`${offen} Zusicherung(en) offen — Abnahme NICHT bestanden.`); process.exit(1); }
console.log("Abnahme bestanden.");
