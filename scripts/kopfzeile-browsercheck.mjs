/* Kopfzeile auf Handy und Tablet — Messung im Browser.
   Rein lokal, ohne Netz, ausschliesslich mit erfundenen Testdaten.
   Es werden keine echten Daten gelesen, geschrieben oder versendet.

   Aufruf:  node scripts/kopfzeile-browsercheck.mjs
   Umgebung: SEITEN_WURZEL (Standard: ../public), SEITEN_AUSGABE (Bildschirm-
             fotos), CHROME_PFAD, PORT.  npm i --no-save playwright-core  */
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
// playwright-core liegt je nach Umgebung woanders; PW_PFAD erlaubt einen
// ausdruecklichen Pfad, sonst die normale Aufloesung.
const { chromium } = await import(process.env.PW_PFAD || "playwright-core");
const ROOT = process.env.SEITEN_WURZEL || new URL("../public", import.meta.url).pathname;
const SP   = process.env.SEITEN_AUSGABE || "/tmp/kopfzeile-abnahme";
const PORT = Number(process.env.PORT || 8951);
const T={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".svg":"image/svg+xml"};
const server=http.createServer((req,res)=>{ let u=decodeURIComponent(req.url.split("?")[0]); if(u==="/")u="/index.html";
  const p=path.join(ROOT,u); if(!p.startsWith(ROOT)||!fs.existsSync(p)||fs.statSync(p).isDirectory()){res.writeHead(404);return res.end();}
  res.writeHead(200,{"Content-Type":T[path.extname(p)]||"application/octet-stream"});res.end(fs.readFileSync(p)); });
fs.mkdirSync(SP,{recursive:true});
await new Promise(r=>server.listen(PORT,"127.0.0.1",r));
const browser=await chromium.launch({ executablePath: process.env.CHROME_PFAD || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });

async function seite(breite){
  const ctx=await browser.newContext({viewport:{width:breite,height:900}});
  const page=await ctx.newPage(); const fehler=[]; page.on("pageerror",e=>fehler.push(e.message));
  await page.route("**://*/**", r => r.request().url().startsWith("http://127.0.0.1:"+PORT+"/")
    ? r.continue() : r.fulfill({status:200,contentType:"application/json",body:"{}"}));
  await page.goto(`http://127.0.0.1:${PORT}/index.html#/tasks`,{waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>window.APP&&window.APP.state,null,{timeout:20000});
  await page.evaluate(()=>{ const e=window.APP.state.data.entities; e.tasks=e.tasks||{};
    e.tasks.t_pruef={id:"t_pruef",title:"Testaufgabe für die Abnahme",status:"todo",priority:2,
      description:"Beschreibung",createdAt:"2026-09-01T07:00:00.000Z"};
    location.hash="#/tasks/t_pruef"; window.render(); });
  await page.waitForTimeout(700);
  return { ctx, page, fehler };
}

// ── 1) Ragt der Inhalt aus dem Kasten der Kopfzeile? ──────────────────────
const ueberlauf = (page) => page.evaluate(()=>{
  const top=document.querySelector(".topbar"), main=document.querySelector("#main");
  const tr=top.getBoundingClientRect(), mr=main.getBoundingClientRect();
  let tief=tr.top; Array.from(top.children).forEach(k=>{ const r=k.getBoundingClientRect();
    if((r.width||r.height) && r.bottom>tief) tief=r.bottom; });
  const h1=main.querySelector("h1,.page-title"); let ueberTitel=null;
  if(h1){ const hr=h1.getBoundingClientRect();
    const el=document.elementFromPoint(Math.round(hr.left+10),Math.round(hr.top+hr.height/2));
    ueberTitel = el ? (el.closest(".topbar") ? "KOPFZEILE" : "Seiteninhalt") : null; }
  return { kopfHoehe:Math.round(tr.height), inhaltBis:Math.round(tief),
    ueberlaufPx:Math.round(tief-tr.bottom), mainOben:Math.round(mr.top),
    ueberDemTitel:ueberTitel, querlauf:document.documentElement.scrollWidth>window.innerWidth+1 };
});
// ── 2) Sind alle Schalter erreichbar, notfalls durch Scrollen der Reihe? ──
const schalter = (page) => page.evaluate(()=>{
  const rechts=document.querySelector(".topbar-right");
  const knoepfe=Array.from(rechts.querySelectorAll(".topbar-btn")).filter(x=>getComputedStyle(x).display!=="none");
  const treffer=new Set();
  const pruefe=()=>{ const rb=rechts.getBoundingClientRect();
    knoepfe.forEach((x,i)=>{ const r=x.getBoundingClientRect(); const mx=r.left+r.width/2, my=r.top+r.height/2;
      if(r.width>=34 && mx>=Math.max(0,rb.left)-0.5 && mx<=Math.min(window.innerWidth,rb.right)+0.5
        && my>=0 && my<=window.innerHeight
        && document.elementFromPoint(Math.round(mx),Math.round(my))?.closest(".topbar-btn")===x) treffer.add(i); }); };
  pruefe();
  const schritte=Math.ceil((rechts.scrollWidth-rechts.clientWidth)/Math.max(1,rechts.clientWidth))+1;
  for(let s=1;s<=schritte;s++){ rechts.scrollLeft=s*rechts.clientWidth; pruefe(); }
  rechts.scrollLeft=0;
  return { gesamt:knoepfe.length, erreichbar:treffer.size,
    reiheBreite:Math.round(rechts.getBoundingClientRect().width), inhaltsbreite:rechts.scrollWidth };
});
// ── 3) Liegen die Aufklappmenues auf dem Bildschirm und sind sie klickbar? ─
const menues = (page) => page.evaluate(()=>{
  const raus=[];
  const pruefe=(id,oeffner)=>{ try{ oeffner(); }catch(e){}
    const el=document.getElementById(id); if(!el) return raus.push({id,da:false});
    const r=el.getBoundingClientRect();
    const mx=Math.round(r.left+r.width/2), my=Math.round(r.top+Math.min(r.height,30)/2);
    const t=document.elementFromPoint(mx,my);
    raus.push({ id, da:true, position:getComputedStyle(el).position,
      imBild: r.left>=-0.5 && r.right<=window.innerWidth+0.5 && r.top>=-0.5,
      klickbar: !!(t && (el===t || el.contains(t))) });
    el.style.display="none"; };
  pruefe("layoutModeMenu", ()=>window.toggleLayoutModeMenu&&window.toggleLayoutModeMenu());
  pruefe("dockMenu",       ()=>window.toggleDockMenu&&window.toggleDockMenu());
  pruefe("pinnedDropdown", ()=>window.togglePinnedDropdown&&window.togglePinnedDropdown());
  return raus;
});

const raus=[];
for (const b of [1440,1280,1024,900,768,600,390]){
  const { ctx, page, fehler } = await seite(b);
  const eintrag = { breite:b, ...(await ueberlauf(page)), schalter: await schalter(page), menues: await menues(page), fehler:fehler.slice(0,2) };
  raus.push(eintrag);
  await page.screenshot({ path:`${SP}/kopf-${b}.png`, clip:{x:0,y:0,width:b,height:260} });
  await ctx.close();
}
await browser.close(); server.close();
for (const m of raus) {
  console.log(String(m.breite).padStart(5)+"px  Kopf "+String(m.kopfHoehe).padStart(3)+"px"+
    "  Ueberlauf "+String(m.ueberlaufPx).padStart(4)+"px  main ab "+String(m.mainOben).padStart(3)+
    "  Querlauf "+m.querlauf+"  ueber dem Titel: "+m.ueberDemTitel+
    "  Schalter "+m.schalter.erreichbar+"/"+m.schalter.gesamt+
    "  Menues klickbar "+m.menues.filter(x=>x.klickbar).length+"/"+m.menues.length);
}
console.log(JSON.stringify(raus,null,1));
