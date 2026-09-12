/* Dokumentbereich an einer PERSON — isoliert, erfundene Testperson.
   Kein Netz, keine echten Personen-, Datei- oder Habitdaten. */
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
// playwright-core liegt je nach Umgebung woanders; PW_PFAD erlaubt einen
// ausdruecklichen Pfad, sonst die normale Aufloesung.
const { chromium } = await import(process.env.PW_PFAD || "playwright-core");
const ROOT=process.argv[2] || new URL("../public", import.meta.url).pathname;
const PORT=Number(process.argv[3] || 8990);
const AUS=process.argv[4] || "";
const T={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".svg":"image/svg+xml"};
const server=http.createServer((req,res)=>{ let u=decodeURIComponent(req.url.split("?")[0]); if(u==="/")u="/index.html";
  const p=path.join(ROOT,u); if(!p.startsWith(ROOT)||!fs.existsSync(p)||fs.statSync(p).isDirectory()){res.writeHead(404);return res.end();}
  res.writeHead(200,{"Content-Type":T[path.extname(p)]||"application/octet-stream"});res.end(fs.readFileSync(p)); });
if (AUS) fs.mkdirSync(AUS,{recursive:true});
await new Promise(r=>server.listen(PORT,"127.0.0.1",r));
const browser=await chromium.launch({ executablePath: process.env.CHROME_PFAD || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });

const SAAT = () => {
  const e = window.APP.state.data.entities;
  e.persons = e.persons || {};
  e.persons.prs_test = { id:"prs_test", name:"Testperson Muster", firstName:"Test", lastName:"Muster",
    emails:["test.muster@example.invalid"], phones:["+41 00 000 00 00"], role:"Beispielrolle",
    howWeMet:"Erfunden für die Abnahme", notes:"Nur Testdaten.",
    createdAt:"2026-09-01T07:00:00.000Z", updatedAt:"2026-09-01T07:00:00.000Z" };
};

async function seite(breite){
  const ctx=await browser.newContext({viewport:{width:breite,height:900}});
  const page=await ctx.newPage(); const fehler=[]; page.on("pageerror",e=>fehler.push(e.message));
  await page.route("**://*/**", r => r.request().url().startsWith("http://127.0.0.1:"+PORT+"/") ? r.continue()
    : r.fulfill({status:200,contentType:"application/json",body:"{}"}));
  await page.goto(`http://127.0.0.1:${PORT}/index.html#/persons`,{waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>window.APP&&window.APP.state&&typeof window.render==="function",null,{timeout:20000});
  await page.evaluate(SAAT);
  await page.evaluate(()=>{ location.hash="#/persons/prs_test"; window.render(); });
  await page.waitForTimeout(600);
  return { ctx, page, fehler };
}
const lies = (page) => page.evaluate(()=>{
  const main=document.getElementById("main");
  const txt = main.textContent || "";
  const karte = Array.from(main.querySelectorAll(".mh-detail-section"))
    .find(el => /Dateien|Dokument/i.test(el.textContent||"") && el.querySelector("[onclick*='_attachFromDrive'],[onclick*='FileInput'],input[type=file]"));
  const e=window.APP.state.data.entities.persons.prs_test;
  return {
    bereichDa: !!karte,
    driveKnopf: !!main.querySelector("[onclick*=\"_attachFromDrive('person'\"]"),
    hochladenDa: !!main.querySelector("input[type=file]") || /hochladen|Datei/i.test(txt),
    dateien: (e.files||[]).map(f=>({name:f.name, quelle:f.source, hatId:!!f.driveFileId})),
    kontaktfelderDa: /test\.muster@example\.invalid/.test(txt) && /Beispielrolle/.test(txt),
    querlauf: document.documentElement.scrollWidth > window.innerWidth+1,
    kartePosition: karte ? Math.round(karte.getBoundingClientRect().top) : null,
  };
});

const raus={};
// ── 1) Desktop: Bereich vorhanden, Drive-Referenz anhängen, Speichern/Reload
{
  const { ctx, page, fehler } = await seite(1440);
  raus.vorher = await lies(page);
  // Drive-Referenz auf dem vorhandenen Weg anhängen (kein Upload, keine Datei).
  raus.anhaengen = await page.evaluate(()=>{
    if (typeof window._attachDriveByLink !== "function") return "Funktion fehlt";
    const d=document.createElement("div");
    d.innerHTML='<input id="drvLinkId" value="https://drive.google.com/file/d/TESTBELEG0000000000000000000000/view"><input id="drvLinkName" value="Testbeleg.md">';
    document.body.appendChild(d);
    try { window._attachDriveByLink("person","prs_test"); } catch(e){ return "Fehler: "+e.message; }
    return "ok";
  });
  await page.waitForTimeout(400);
  await page.evaluate(()=>window.render());
  await page.waitForTimeout(400);
  raus.nachAnhaengen = await lies(page);
  if (AUS) await page.screenshot({ path:`${AUS}/person-1440.png`, clip:{x:0,y:0,width:1440,height:900} });

  // Bearbeiten: Name ändern, speichern — Dateien und Kontaktfelder müssen bleiben.
  raus.bearbeiten = await page.evaluate(async ()=>{
    if (typeof window.mhOpenPersonEditor !== "function") return "Editor fehlt";
    window.mhOpenPersonEditor("prs_test");
    await new Promise(r=>setTimeout(r,400));
    const f=document.getElementById("mhpName"); if(!f) return "Namensfeld fehlt";
    f.value = "Testperson Muster (geändert)";
    window.mhSavePerson("prs_test");
    await new Promise(r=>setTimeout(r,400));
    const e=window.APP.state.data.entities.persons.prs_test;
    return { name:e.name, dateien:(e.files||[]).length, mail:(e.emails||[])[0], rolle:e.role,
             wieKennen:e.howWeMet, notizen:e.notes };
  });
  // „Reload": Zustand über den echten Speicherweg und neu aufbauen
  raus.nachReload = await page.evaluate(async ()=>{
    const roh = JSON.stringify(window.APP.state.data);
    window.APP.state.data = JSON.parse(roh);           // wie nach dem Laden
    location.hash="#/persons/prs_test"; window.render();
    await new Promise(r=>setTimeout(r,400));
    const e=window.APP.state.data.entities.persons.prs_test;
    const txt=document.getElementById("main").textContent||"";
    return { dateien:(e.files||[]).length, imText:/Testbeleg\.md/.test(txt), name:e.name };
  });
  raus.fehler1 = fehler.slice(0,3);
  await ctx.close();
}
// ── 2) Schmal
{
  const { ctx, page, fehler } = await seite(390);
  await page.evaluate(()=>{ const e=window.APP.state.data.entities.persons.prs_test;
    e.files=[{id:"f1",name:"Testbeleg.md",url:"https://drive.google.com/uc?export=download&id=TESTBELEG0000000000000000000000",driveFileId:"TESTBELEG0000000000000000000000",source:"gdrive",uploadedAt:"2026-09-12T08:00:00.000Z"}];
    window.render(); });
  await page.waitForTimeout(500);
  raus.schmal = await lies(page);
  if (AUS) await page.screenshot({ path:`${AUS}/person-390.png`, clip:{x:0,y:0,width:390,height:900} });
  raus.fehler2 = fehler.slice(0,3);
  await ctx.close();
}
await browser.close(); server.close(); console.log(JSON.stringify(raus,null,1));
