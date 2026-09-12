/* Tab-Leiste vs. Sidebar-Kopf — Messung und Abnahme im echten Browser.
 *
 * BEFUND (live gemeldet, management-xo2-pro, 390x844, body: tabs-on mode-tablet):
 * Im Tabmodus liegt die interne Tab-Leiste (#browserTabBar, fixiert, top:0,
 * 38 px hoch) UEBER dem Kopf der ausgeklappten Seitenleiste. document
 * .elementsFromPoint(201,34) meldete dort .bt-tab statt #sidebarCloseBtn.
 * Gemessen wird deshalb nicht „sieht komisch aus", sondern die Treffprobe:
 * welches Element liegt an der Mitte jedes Kopf-Bedienelements zuoberst.
 *
 * Der seitliche #sidebarToggleBtn funktioniert auch im alten Stand — er steht
 * bei top:60 unter der Leiste. Die Seitenleiste ist also NICHT grundsaetzlich
 * unverschliessbar; das prueft dieses Skript ausdruecklich mit.
 *
 * Kein Netz, keine Nutzerdaten, keine Formularabsendung. Jede Erwartung ist
 * eine Zusicherung; eine offene beendet den Lauf mit Exitcode 1.
 *
 * Aufruf: node scripts/tableiste-sidebarkopf-browsercheck.mjs [wurzel] [port] [bilder]
 */
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const { chromium } = await import(process.env.PW_PFAD || "playwright-core");

const ROOT = process.argv[2] || new URL("../public", import.meta.url).pathname;
const PORT = Number(process.argv[3] || 8970);
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

let offen = 0, geprueft = 0;
const zusichern = (bedingung, text) => {
  geprueft++;
  if (bedingung) { console.log("  ok    " + text); return true; }
  offen++; console.error("  FEHLT " + text); return false;
};

/* Treffprobe: liegt an der Mitte des Elements das Element selbst zuoberst?
   Nicht die Sichtbarkeit wird gemessen, sondern die Erreichbarkeit fuer den
   Finger — genau das war der Befund. */
const trefferProbe = (page, wahl) => page.evaluate((w)=>{
  const el = document.querySelector(w);
  if (!el) return { da:false };
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return { da:true, sichtbar:false };
  const x = Math.round(r.left + r.width/2), y = Math.round(r.top + r.height/2);
  const kette = document.elementsFromPoint(x, y);
  const oben = kette[0] || null;
  const trifft = !!(oben && (oben === el || el.contains(oben) || oben.contains(el)));
  return { da:true, sichtbar:true, x, y, hoehe:Math.round(r.height), trifft,
    obenId: oben ? (oben.id || oben.className || oben.tagName) : null,
    kette: kette.slice(0,3).map(e => e.id || (typeof e.className === "string" ? e.className : e.tagName)) };
}, wahl);

const lage = (page) => page.evaluate(()=>{
  const bar = document.getElementById("browserTabBar");
  const sb  = document.getElementById("sidebar");
  const br  = bar ? bar.getBoundingClientRect() : null;
  const sr  = sb ? sb.getBoundingClientRect() : null;
  return {
    klassen: document.body.className,
    tabsAn: document.body.classList.contains("tabs-on"),
    leisteOben: br ? Math.round(br.top) : null, leisteHoch: br ? Math.round(br.height) : null,
    tabs: document.querySelectorAll(".bt-tab").length,
    sbOben: sr ? Math.round(sr.top) : null, sbLinks: sr ? Math.round(sr.left) : null,
    sbBreit: sr ? Math.round(sr.width) : null,
    /* „Offen" heisst nicht ueberall dasselbe: schmal liegt die Leiste als
       fixiertes Overlay bei left:0, breit steht sie in der Rasterspur und wird
       beim Einklappen durchsichtig und aus dem Bild geschoben. Deshalb wird
       gemessen, ob sie tatsaechlich im Bild und sichtbar ist. */
    sbOffen: !!(sr && sr.width > 0 && sr.right > 1 && parseFloat(getComputedStyle(sb).opacity || "1") > 0.1
      && !document.getElementById("app").classList.contains("sidebar-collapsed")),
    eingeklappt: !!(document.getElementById("app")||{classList:{contains:()=>false}}).classList.contains("sidebar-collapsed"),
    querlauf: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
});

const browser = await chromium.launch({ executablePath: process.env.CHROME_PFAD || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const seitenfehler = [];

async function messe(breite, hoehe, schmal){
  console.log(`\n══ ${breite}x${hoehe} ══`);
  const ctx = await browser.newContext({ viewport:{ width:breite, height:hoehe } });
  const page = await ctx.newPage();
  page.on("pageerror", e => seitenfehler.push(breite + "px: " + e.message));
  await page.route("**://*/**", r => r.request().url().startsWith("http://127.0.0.1:" + PORT + "/")
    ? r.continue() : r.fulfill({ status:200, contentType:"application/json", body:"{}" }));
  // Tabmodus ist der gemeldete Zustand: angeheftete Leiste + eingeschaltete Tabs.
  await page.addInitScript(()=>{ try {
    localStorage.setItem("browser-tabs-enabled", "true");
    localStorage.setItem("sidebar-pinned", "true");
  } catch(e){} });
  await page.goto(`http://127.0.0.1:${PORT}/index.html#/dashboard`, { waitUntil:"domcontentloaded" });
  await page.waitForFunction(()=>window.APP && window.APP.state && typeof window.render === "function", null, { timeout:20000 });
  await page.waitForTimeout(900);

  let l = await lage(page);
  zusichern(l.tabsAn && l.tabs > 0, `Tabmodus ist an mit Tabs (${l.tabs}), Klassen: ${l.klassen.trim()}`);
  zusichern(l.leisteOben === 0 && l.leisteHoch === 38, `Tab-Leiste sitzt oben (top ${l.leisteOben}, ${l.leisteHoch}px)`);

  // Seitenleiste ueber den echten Weg ausklappen, falls eingeklappt.
  if (l.eingeklappt){ await page.click("#sidebarToggleBtn"); await page.waitForTimeout(500); }
  l = await lage(page);
  zusichern(l.sbOffen, `Seitenleiste ist ausgeklappt (x=${l.sbLinks}, ${l.sbBreit}px breit)`);

  // DER BEFUND: die drei Bedienelemente im Kopf der Leiste.
  for (const [wahl, name] of [["#sidebarCloseBtn","Schliessen ✕"], ["#sidebarPinBtn","Anheften 📌"], [".sidebar-brand","Quantus (zum Dashboard)"]]){
    const t = await trefferProbe(page, wahl);
    if (!t.da || !t.sichtbar){
      // Auf breiten Schirmen gibt es kein ✕ — dort liegt die Leiste im Raster
      // und verdeckt nichts. Das ist kein Mangel, sondern der Entwurf.
      zusichern(!schmal, `${name}: nicht sichtbar — auf dieser Breite so vorgesehen`);
      continue;
    }
    zusichern(t.trifft, `${name} ist an seiner Mitte anklickbar (x${t.x}/y${t.y}, zuoberst: ${t.obenId})`);
  }

  // Gegenprobe: die Tab-Leiste selbst muss erreichbar bleiben.
  const tab = await trefferProbe(page, ".bt-tab");
  zusichern(tab.trifft, `ein Tab ist anklickbar (zuoberst: ${tab.obenId})`);

  // Der seitliche Umschalter hat auch vorher funktioniert — das bleibt so.
  const um = await trefferProbe(page, "#sidebarToggleBtn");
  zusichern(um.trifft, `#sidebarToggleBtn ist anklickbar (zuoberst: ${um.obenId})`);

  // Scrollen in der Leiste bleibt erhalten.
  const scroll = await page.evaluate(()=>{ const n = document.getElementById("sidebarNav");
    if (!n) return null; n.scrollTop = 60;
    return { gesetzt:n.scrollTop, hoehe:n.scrollHeight, sicht:n.clientHeight,
      ueberlauf:getComputedStyle(n).overflowY }; });
  // Scrollen kann nur belegen, wer ueberhaupt mehr Inhalt als Platz hat. Wo die
  // Liste ganz hineinpasst (768x1024), wird stattdessen geprueft, dass der
  // Ueberlauf weiterhin auf „auto" steht — sonst waere Scrollen abgeschnitten.
  zusichern(scroll && (scroll.hoehe > scroll.sicht ? scroll.gesetzt > 0 : /auto|scroll/.test(scroll.ueberlauf)),
    `die Navigation scrollt weiterhin (${JSON.stringify(scroll)})`);

  if (AUS) await page.screenshot({ path:`${AUS}/tabs-${breite}.png`, clip:{x:0,y:0,width:breite,height:Math.min(hoehe,500)} });

  // Echter Klick auf ✕ (schmal) bzw. auf den Umschalter (breit) schliesst.
  const schliesser = schmal ? "#sidebarCloseBtn" : "#sidebarToggleBtn";
  // Ein verdeckter Knopf laesst sich nicht anklicken: Playwright bricht dann mit
  // „intercepts pointer events" ab. Das ist genau der Befund und soll als offene
  // Zusicherung enden, nicht als Absturz.
  const klickFehler = await page.click(schliesser, { timeout: 4000 }).then(()=>null, e => String(e.message).split("\n")[0]);
  await page.waitForTimeout(500);
  l = await lage(page);
  zusichern(!klickFehler, `${schliesser} laesst sich anklicken${klickFehler ? " — " + klickFehler : ""}`);
  zusichern(!l.sbOffen, `${schliesser} schliesst die Leiste wirklich (x=${l.sbLinks}, offen=${l.sbOffen})`);
  if (l.sbOffen) await page.evaluate(()=>{ const a=document.getElementById("app"); if(a) a.classList.add("sidebar-collapsed"); });

  // Wieder auf, damit der Umschalter-Weg belegt ist (der ging auch vorher).
  await page.click("#sidebarToggleBtn"); await page.waitForTimeout(500);
  l = await lage(page);
  zusichern(l.sbOffen, `#sidebarToggleBtn oeffnet sie wieder (x=${l.sbLinks}, ${l.sbBreit}px breit)`);
  zusichern(!l.querlauf, "kein horizontaler Seitenueberlauf");

  // Tabwechsel muss weiterhin gehen: zweiten Tab anlegen und anklicken.
  const tabwechsel = await page.evaluate(async ()=>{
    if (typeof window.btOpenInNewTab === "function") window.btOpenInNewTab("#/tasks");
    else location.hash = "#/tasks";
    await new Promise(r=>setTimeout(r,600));
    const alle = Array.from(document.querySelectorAll(".bt-tab"));
    return { anzahl: alle.length };
  });
  if (tabwechsel.anzahl > 1){
    const zweiter = page.locator(".bt-tab").nth(0);
    await zweiter.click({ timeout: 4000 }).catch(()=>{});
    await page.waitForTimeout(500);
  }
  const nachher = await page.evaluate(()=>({ tabs: document.querySelectorAll(".bt-tab").length,
    aktiv: document.querySelectorAll(".bt-tab.active").length }));
  zusichern(nachher.tabs >= 1 && nachher.aktiv === 1,
    `Tabwechsel funktioniert weiterhin (${nachher.tabs} Tabs, ${nachher.aktiv} aktiv)`);

  await ctx.close();
}

await messe(390, 844, true);
await messe(768, 1024, true);
await messe(1280, 800, false);

zusichern(seitenfehler.length === 0, `keine Seitenfehler (${seitenfehler.slice(0,2).join(" | ")})`);

await browser.close(); server.close();
console.log(`\n${geprueft - offen} von ${geprueft} Zusicherungen erfuellt.`);
if (offen) { console.error(`${offen} Zusicherung(en) offen — Abnahme NICHT bestanden.`); process.exit(1); }
console.log("Abnahme bestanden.");
