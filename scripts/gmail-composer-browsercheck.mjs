/* Gmail-Composer im ECHTEN Browser: Wo landet der Empfaenger wirklich?
   ---------------------------------------------------------------------------
   Gehoert NICHT zu `npm test` (das laeuft ohne Netz und ohne Abhaengigkeiten).
   Dies ist die Nachmessung zum Befund vom 11.09.2026, zum Wiederholen:

       npm i --no-save playwright-core          # einmalig
       node scripts/gmail-composer-browsercheck.mjs

   Der Pfad zu Chromium und der Ablageort fuer die Playwright-Zeile unten sind
   an diese Maschine angepasst; auf einem anderen Rechner beide anpassen.

   Es wird NICHTS gesendet: Der Gmail-Aufruf wird auf Netzebene abgefangen und
   nur die erzeugte MIME-Kopfzeile gelesen. Es werden keine echten Daten
   angefasst — Person und Aufgabe entstehen nur im Speicher dieses
   Testbrowsers.

   Ursprungsfrage:
   Eigenschaft (.value) und Attribut (getAttribute("value")) getrennt gelesen —
   genau die Unterscheidung, die eine Fernbedienung sichtbar macht.
   Rein lokal: gmApi wird abgefangen, es wird NICHTS gesendet. */
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { chromium } from "/tmp/claude-0/-home-user/18cbce41-cbe5-5300-9142-3055f6610cde/scratchpad/node_modules/playwright-core/index.mjs";
const ROOT="/home/user/ai-sync/public";
const T={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"};
const server=http.createServer((req,res)=>{ let u=decodeURIComponent(req.url.split("?")[0]); if(u==="/")u="/index.html";
  const p=path.join(ROOT,u); if(!p.startsWith(ROOT)||!fs.existsSync(p)||fs.statSync(p).isDirectory()){res.writeHead(404);return res.end();}
  res.writeHead(200,{"Content-Type":T[path.extname(p)]||"application/octet-stream"});res.end(fs.readFileSync(p)); });
await new Promise(r=>server.listen(8901,"127.0.0.1",r));
const browser=await chromium.launch({executablePath:"/opt/pw-browsers/chromium-1194/chrome-linux/chrome"});
const ctx=await browser.newContext({viewport:{width:1440,height:1000}}); const page=await ctx.newPage();
const fehler=[]; page.on("pageerror",e=>fehler.push(e.message));
// KEIN echter Versand: Der Gmail-Aufruf wird auf Netzebene abgefangen.
await page.route("**/.netlify/functions/gmail-api**", async route=>{
  const req=route.request();
  if (req.method()==="POST"){
    await page.evaluate(b=>{ window.__gesendet.push(b); }, req.postData()||"");
  }
  await route.fulfill({ status:200, contentType:"application/json", body:JSON.stringify({ id:"test", threadId:"test" }) });
});
await page.goto("http://127.0.0.1:8901/index.html",{waitUntil:"domcontentloaded"});
await page.waitForFunction(()=>window.APP&&window.APP.state&&typeof window.gmailCompose==="function",null,{timeout:20000});

await page.evaluate(()=>{
  const e=window.APP.state.data.entities;
  e.persons=e.persons||{};
  e.persons.p_silvia={ id:"p_silvia", name:"Silvia Taisch", emails:["silviataisch@bluewin.ch"], createdAt:"2026-01-01T00:00:00.000Z" };
  e.tasks=e.tasks||{};
  e.tasks.t_spar={ id:"t_spar", title:"SP AR Originalunterlagen an Silvan", status:"open", createdAt:"2026-01-01T00:00:00.000Z" };
  window.__gesendet=[];
  window.gmailCompose({ title:"Neue E-Mail" });
});
await page.waitForSelector("#gmlTo",{timeout:5000});
const lese = () => page.evaluate(()=>{
  const alle=document.querySelectorAll("#gmlTo");
  const e=document.getElementById("gmlTo");
  return { anzahl:alle.length, eigenschaft:e?e.value:null, attribut:e?e.getAttribute("value"):null,
    fokus:document.activeElement===e, sichtbar:!!(e&&e.offsetParent) };
});
const raus={};
raus.start = await lese();
await page.fill("#gmlTo","silviataisch@bluewin.ch");
await page.waitForTimeout(300);
raus.nachFill = await lese();
raus.autocomplete = await page.locator("#gmlTo_ac .gmlc-ac-item").allTextContents().catch(()=>[]);
// Option waehlen
if ((await page.locator("#gmlTo_ac .gmlc-ac-item").count())>0){
  await page.locator("#gmlTo_ac .gmlc-ac-item").first().click();
  await page.waitForTimeout(300);
}
raus.nachAuswahl = await lese();
// Blur
await page.locator("#gmlSubject").click();
await page.waitForTimeout(400);
raus.nachBlur = await lese();
// Betreff und Text
await page.fill("#gmlSubject","Mein Rücktritt aus dem Kantonalvorstand der SP AR");
await page.fill("#gmlBody","Liebe Silvia\n\nTestkörper.\n\nLaurin");
// Verknuepfung hinzufuegen
await page.evaluate(()=>{ window.gmlComposeAddLink("task:t_spar"); window.gmlComposeAddLink("person:p_silvia"); });
await page.waitForTimeout(400);
raus.nachLink = await lese();
raus.chips = await page.locator("#gmlLinkChips .gml-linkchip").allTextContents().catch(()=>[]);
// Senden (abgefangen)
await page.click("#gmlSendBtn");
await page.waitForTimeout(600);
raus.sendpayload = await page.evaluate(()=>{
  const roh=window.__gesendet.find(x=>/\"raw\"/.test(String(x)));
  if (!roh) return { anzahlAufrufe:window.__gesendet.length, roh:String(window.__gesendet[0]||"").slice(0,200) };
  const g={ opts:{ body: JSON.parse(roh).body || JSON.parse(roh) }, pfad:"send" };
  const raw=(g.opts&&g.opts.body&&g.opts.body.raw)||"";
  const mime=decodeURIComponent(escape(atob(raw.replace(/-/g,"+").replace(/_/g,"/"))));
  const to=(/^To:\s*(.+)$/m.exec(mime)||[])[1]||"";
  const subj=(/^Subject:\s*(.+)$/m.exec(mime)||[])[1]||"";
  return { anzahlAufrufe:window.__gesendet.length, pfad:g.pfad, to, subj };
});
raus.fehler=fehler.slice(0,3);
console.log(JSON.stringify(raus,null,1));
await browser.close(); server.close();
