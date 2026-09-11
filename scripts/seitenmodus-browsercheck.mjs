/* Seitenmodus im Computermodus — Abnahme nach der Reparatur.
   Rein lokal, ohne Netz, ausschliesslich mit erfundenen Testdaten.
   Es werden keine echten Daten gelesen, geschrieben oder versendet. */
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { chromium } from "playwright-core";   // npm i --no-save playwright-core
const SP=process.env.SEITEN_AUSGABE || "/tmp/seitenmodus-abnahme";  // Ablage fuer die Bildschirmfotos
const ROOT=process.env.SEITEN_WURZEL || new URL("../public", import.meta.url).pathname;
const T={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".svg":"image/svg+xml"};
const server=http.createServer((req,res)=>{ let u=decodeURIComponent(req.url.split("?")[0]); if(u==="/")u="/index.html";
  const p=path.join(ROOT,u); if(!p.startsWith(ROOT)||!fs.existsSync(p)||fs.statSync(p).isDirectory()){res.writeHead(404);return res.end();}
  res.writeHead(200,{"Content-Type":T[path.extname(p)]||"application/octet-stream"});res.end(fs.readFileSync(p)); });
fs.mkdirSync(SP,{recursive:true});
await new Promise(r=>server.listen(8906,"127.0.0.1",r));
const browser=await chromium.launch({ executablePath: process.env.CHROME_PFAD || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });

async function neu(breite,hoehe,vorlauf){
  const ctx=await browser.newContext({viewport:{width:breite,height:hoehe}});
  if (vorlauf) await ctx.addInitScript(vorlauf);
  const page=await ctx.newPage();
  const fehler=[]; page.on("pageerror",e=>fehler.push(e.message));
  await page.route("**://*/**", r => r.request().url().startsWith("http://127.0.0.1:8906/")
    ? r.continue() : r.fulfill({status:200,contentType:"application/json",body:"{}"}));
  return { ctx, page, fehler };
}
const COMPUTER = () => { try { localStorage.setItem("quantusLayoutMode","computer"); } catch(e){} };

async function saat(page){
  await page.evaluate(()=>{
    const e=window.APP.state.data.entities;
    e.tasks=e.tasks||{}; e.projects=e.projects||{}; e.notes=e.notes||{};
    e.tasks.t_pruef={ id:"t_pruef", title:"Testaufgabe für die Abnahme", status:"todo", priority:2,
      description:"Eine Beschreibung, lang genug um Umbruch zu sehen. ".repeat(6),
      dueDate:"2026-12-01", createdAt:"2026-09-01T07:00:00.000Z", updatedAt:"2026-09-01T07:00:00.000Z" };
    e.projects.p_pruef={ id:"p_pruef", title:"Testprojekt für die Abnahme", status:"active",
      description:"Projektbeschreibung", createdAt:"2026-09-01T07:00:00.000Z" };
    e.notes.n_pruef={ id:"n_pruef", title:"Testnotiz", content:"Inhalt", createdAt:"2026-09-01T07:00:00.000Z" };
  });
}
const messe = (page) => page.evaluate(()=>{
  const q=s=>document.querySelector(s);
  const box=el=>{ if(!el) return null; const r=el.getBoundingClientRect();
    return { b:Math.round(r.width), h:Math.round(r.height), oben:Math.round(r.top), links:Math.round(r.left) }; };
  const panel=q("#slidePanel");
  const top=q(".topbar");
  const ps = panel ? getComputedStyle(panel) : null;
  let obenDrauf=null;
  if (top){ const r=top.getBoundingClientRect();
    const el=document.elementFromPoint(Math.round(r.left+r.width/2), Math.round(r.top+r.height/2));
    obenDrauf = el ? (el.id || el.className || el.tagName) : null; }
  // Fokussierbares im (geschlossenen) Panel — das ist der Kern des Befunds.
  const fokussierbar = panel ? Array.from(panel.querySelectorAll(
    "input,select,textarea,button,a[href],[tabindex]:not([tabindex='-1'])")).filter(el=>{
      const s=getComputedStyle(el);
      return s.visibility!=="hidden" && s.display!=="none" && el.offsetParent!==null; }).length : 0;
  const statusImPanel = panel ? panel.querySelectorAll('select[data-field="status"]').length : 0;
  const statusImMain  = document.querySelectorAll('#main select[data-field="status"]').length;
  return {
    route: location.hash,
    querlauf: document.documentElement.scrollWidth > window.innerWidth+1,
    scrollBreite: document.documentElement.scrollWidth, fenster: window.innerWidth,
    modus: (document.body.className.match(/mode-\w+/)||[""])[0],
    main: box(q("#main")),
    panelOffen: !!(panel && panel.classList.contains("open")),
    panelSichtbarkeit: ps ? ps.visibility : null,
    panelInert: !!(panel && panel.hasAttribute("inert")),
    panelRumpfLeer: !(q("#slidePanelBody") && q("#slidePanelBody").children.length),
    panelFokussierbar: fokussierbar,
    statusImPanel, statusImMain, statusGesamt: statusImPanel + statusImMain,
    noteflowAktiv: !!(q("#noteflowContainer") && q("#noteflowContainer").classList.contains("active")),
    kopfVerdecktVon: String(obenDrauf||"").slice(0,60),
  };
});
// Zaehlt, wie viele Formularfelder in der breitesten Zeile nebeneinander stehen.
const spalten = (page) => page.evaluate(()=>{
  const form = document.querySelector("#main .card > .form");
  if (!form) return null;
  const reihen = {};
  Array.from(form.children).forEach(k=>{
    const r=k.getBoundingClientRect(); if(!r.width) return;
    const y=Math.round(r.top/8)*8; (reihen[y]=reihen[y]||[]).push(Math.round(r.width));
  });
  const werte=Object.values(reihen);
  const feld = form.querySelector('label input[type="text"]');
  return { reihen: werte.length, maxProReihe: Math.max(...werte.map(r=>r.length)),
           formBreite: Math.round(form.getBoundingClientRect().width),
           titelFeldBreite: feld ? Math.round(feld.getBoundingClientRect().width) : null };
});

const raus={};
// ── A) Aufgabe: Schnellansicht → „Vollständig öffnen" (open-entity-full) ──
{
  const { ctx, page, fehler } = await neu(1440,1000,COMPUTER);
  await page.goto("http://127.0.0.1:8906/index.html#/tasks",{waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>window.APP&&window.APP.state&&typeof window.render==="function",null,{timeout:20000});
  await saat(page);
  await page.evaluate(()=>{ location.hash="#/tasks"; window.render(); });
  await page.waitForTimeout(500);
  raus.A_vorher = await messe(page);
  await page.evaluate(()=>window.openSlidePanel("task","t_pruef"));
  await page.waitForTimeout(300);
  raus.A_panelAuf = await messe(page);
  await page.screenshot({ path:`${SP}/A1-panel-offen.png` });
  const knopf = page.locator('#slidePanel [data-action="open-entity-full"]');
  raus.A_knopfDa = await knopf.count();
  if (await knopf.count()) await knopf.click();
  await page.waitForTimeout(800);
  raus.A_nachher = await messe(page);
  await page.screenshot({ path:`${SP}/A2-nach-vollstaendig.png` });
  raus.A_spalten = await spalten(page);
  raus.A_fehler = fehler.slice(0,3);
  await ctx.close();
}
// ── A2) Projekt: Schnellansicht → „Vollständig öffnen" (open-entity) ──────
{
  const { ctx, page, fehler } = await neu(1440,1000,COMPUTER);
  await page.goto("http://127.0.0.1:8906/index.html#/projects",{waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>window.APP&&window.APP.state&&typeof window.render==="function",null,{timeout:20000});
  await saat(page);
  await page.evaluate(()=>{ location.hash="#/projects"; window.render(); });
  await page.waitForTimeout(400);
  await page.evaluate(()=>window.openSlidePanel("project","p_pruef"));
  await page.waitForTimeout(300);
  raus.A2_panelAuf = await messe(page);
  const k2 = page.locator('#slidePanel [data-action="open-entity"]');
  raus.A2_knopfDa = await k2.count();
  if (await k2.count()) await k2.first().click();
  await page.waitForTimeout(800);
  raus.A2_nachher = await messe(page);
  await page.screenshot({ path:`${SP}/A3-projekt-nach-vollstaendig.png` });
  raus.A2_fehler = fehler.slice(0,3);
  await ctx.close();
}
// ── A3) Tastatur: Esc schliesst, danach kein Sprung ins Panel ────────────
{
  const { ctx, page, fehler } = await neu(1440,1000,COMPUTER);
  await page.goto("http://127.0.0.1:8906/index.html#/tasks",{waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>window.APP&&window.APP.state&&typeof window.render==="function",null,{timeout:20000});
  await saat(page);
  await page.evaluate(()=>{ location.hash="#/tasks/t_pruef"; window.render(); });
  await page.waitForTimeout(400);
  await page.evaluate(()=>window.openSlidePanel("task","t_pruef"));
  await page.waitForTimeout(300);
  raus.A3_offen = await messe(page);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  raus.A3_nachEsc = await messe(page);
  // 40x Tab — landet der Fokus je im geschlossenen Panel?
  let imPanel=0;
  for (let i=0;i<40;i++){ await page.keyboard.press("Tab");
    imPanel += await page.evaluate(()=> document.activeElement && document.activeElement.closest("#slidePanel") ? 1 : 0); }
  raus.A3_tabsImPanel = imPanel;
  raus.A3_fehler = fehler.slice(0,3);
  await ctx.close();
}
// ── B) Tabwiederherstellung: frischer Tab vs. Neuladen ───────────────────
const TABSAAT = () => { try {
  localStorage.setItem("quantusLayoutMode","computer");
  localStorage.setItem("quantusTabs", JSON.stringify({ tabs:[
    { id:"tab_dash", kind:"hash", ref:"#/dashboard", title:"Dashboard", icon:"◫", pinned:true },
    { id:"tab_nf", kind:"noteflow", ref:"", title:"NoteFlow", icon:"📝" }
  ], activeId:"tab_nf" }));
} catch(e){} };
{
  const { ctx, page, fehler } = await neu(1440,1000,TABSAAT);
  await page.goto("http://127.0.0.1:8906/index.html",{waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>window.APP&&window.APP.state,null,{timeout:20000});
  await page.waitForTimeout(2600);   // laenger als die 1500ms Auto-Wiederherstellung
  raus.B_frischerTab = await messe(page);
  await page.screenshot({ path:`${SP}/B1-frischer-tab.png` });
  // Jetzt ein echtes Neuladen aus NoteFlow heraus.
  await page.evaluate(()=>{ if (window.openNoteFlow) window.openNoteFlow(); });
  await page.waitForTimeout(500);
  raus.B_nfOffen = await messe(page);
  await page.reload({waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>window.APP&&window.APP.state,null,{timeout:20000});
  await page.waitForTimeout(2600);
  raus.B_nachNeuladen = await messe(page);
  await page.screenshot({ path:`${SP}/B2-nach-neuladen.png` });
  raus.B_fehler = fehler.slice(0,3);
  await ctx.close();
}
// ── C) Breiten im Computermodus ──────────────────────────────────────────
raus.C = [];
for (const b of [1440,1280,1024,768,390]){
  const { ctx, page, fehler } = await neu(b, 900, COMPUTER);
  await page.goto("http://127.0.0.1:8906/index.html#/tasks",{waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>window.APP&&window.APP.state,null,{timeout:20000});
  await saat(page);
  await page.evaluate(()=>{ location.hash="#/tasks/t_pruef"; window.render(); });
  await page.waitForTimeout(600);
  const m = await messe(page); const sp = await spalten(page);
  raus.C.push({ breite:b, modus:m.modus, main:m.main, querlauf:m.querlauf, scrollBreite:m.scrollBreite,
                spalten:sp, fehler:fehler.slice(0,2) });
  await page.screenshot({ path:`${SP}/C-${b}-taskdetail.png` });
  await ctx.close();
}
await browser.close(); server.close();
console.log(JSON.stringify(raus,null,1));
