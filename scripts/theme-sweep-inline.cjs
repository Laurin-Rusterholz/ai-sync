#!/usr/bin/env node
/* ============================================================================
 * Teil B — Schiefer/Leinen Inline-Style-Sweep.
 * Fortsetzung von theme-sweep.cjs (Teil A behandelte die <style>-Blöcke).
 * Dieser Pass tokenisiert die UI-Chrome-Farbliterale in INLINE-`style="…"`-
 * Attributen (inkl. JS-generierter Templates) → var(--token). Damit erhält die
 * gesamte App durchgängig die matte Schiefer/Leinen-Palette statt Neon.
 *
 * Sicherheitsregeln:
 *   • NUR Inhalt von style="…" / style='…' wird angefasst (kein <style>-Block,
 *     kein JS-Logik-Code, kein Markup).
 *   • Spans innerhalb von ${…}-Interpolationen werden ÜBERSPRUNGEN
 *     (schützt z.B. `${h.color||'#a855f7'}33` und `${shade('#6366f1',…)}`).
 *   • Reines Weiß/Schwarz (#fff/#000/white/black) bleibt unangetastet
 *     (themeneutral, Kontrast-/Kontext-Risiko bei Button-Text).
 *   • Komponenten-Paletten (Dracula, Galaxy, Erd-/Holztöne, Pergament, Neon-
 *     Terminal) bleiben via EXCLUDE erhalten — identisch zu Teil A.
 *   • 7-/8-stellige Hex (#rrggbbaa) und 4-stellige (#rgba) bleiben unangetastet.
 * Dry-run per default; mit `--write` wird public/index.html überschrieben.
 * ==========================================================================*/
const fs = require("fs");
const path = require("path");
const FILE = path.join(__dirname, "..", "public", "index.html");
const WRITE = process.argv.includes("--write");

// ── Farb-Helfer ────────────────────────────────────────────────────────────
function expand3(h){ return h.length===4 ? "#"+h[1]+h[1]+h[2]+h[2]+h[3]+h[3] : h; }
function hexToRgb(h){ h=expand3(h.toLowerCase()); const n=parseInt(h.slice(1,7),16);
  return { r:(n>>16)&255, g:(n>>8)&255, b:n&255 }; }
function rgbToHsl(r,g,b){ r/=255;g/=255;b/=255; const mx=Math.max(r,g,b),mn=Math.min(r,g,b);
  let h=0,s=0,l=(mx+mn)/2; const d=mx-mn;
  if(d){ s=l>0.5?d/(2-mx-mn):d/(mx+mn);
    if(mx===r) h=((g-b)/d+(g<b?6:0)); else if(mx===g) h=(b-r)/d+2; else h=(r-g)/d+4; h*=60; }
  return { h, s, l }; }

// ── Komponenten-Paletten, die NICHT angefasst werden (identisch zu Teil A) ──
const EXCLUDE = new Set([
  // Dracula / Code-Syntax-Highlighting
  "#50fa7b","#8be9fd","#f1fa8c","#bd93f9","#ff79c6","#ffb86c","#6272a4",
  // Neon-Terminal-Widget
  "#00f0ff","#00ff88","#33f5ff","#00d4aa",
  // Deep-Blue / Galaxy-Widgets
  "#1a1a2e","#16213e","#0f3460","#0d1b2a","#1b2838","#2c3e50","#0f1b3d","#1a3a6b","#3a6ea5","#1e1e2e","#14141f","#0a0a12","#1a1a28","#222233","#12121c","#0e0e16","#44445a","#6b6b80","#9090a8","#a8a8b8","#7a7a90","#6a6a80","#b0b0c0","#d0d0e0",
  // Erd-/Brauntöne (Map/Holz/Buch)
  "#5d3a1a","#8b5a2b","#8b4513","#2d2418","#6b5d3f","#5a3a1a","#e8956a","#f0a050",
  // Dunkelgrün-Komponenten
  "#1a472a","#234d32","#2d5a3a",
  // Pergament/Beige (Reader)
  "#f4ecd8","#f5f5dc","#e8d5a3","#fbe8a6","#fff7a8","#f5c16c","#fde68a",
  // Schiefer/Leinen-Tokenwerte selbst (NICHT erneut ersetzen)
  "#262a2e","#2d3237","#353b41","#3c434a","#454c54","#dadbde","#878d96","#86a895","#324039","#1d2622","#c8836f","#c2a866","#7e94b0","#b9bcc1","#c08aa0","#d8d3c7","#e3dfd5","#ebe7de","#c6c0b2","#bcb6a6","#3a3733","#8a8478","#cdd8d1","#eef2ef","#b06a52","#a8852f","#4f6f8a","#55514a","#9d6a7e",
]);

// reines Weiß/Schwarz bewusst auslassen (themeneutral, kontextabhängig)
const SKIP_LITERAL = new Set(["#fff","#ffffff","#000","#000000","white","black"]);

// ── Explizite chromatische Chrome-Zuordnung (identisch zu Teil A) ──
const CHROMA = {
  "#6366f1":"--accent","#5558e3":"--accent","#5e5ce6":"--accent","#818cf8":"--accent",
  "#7c3aed":"--accent","#8b5cf6":"--accent","#a78bfa":"--accent","#a5b4fc":"--accent",
  "#a855f7":"--accent","#c084fc":"--accent","#c4b5fd":"--accent","#c7d2fe":"--accent",
  "#d8b4fe":"--accent","#bf5af2":"--accent","#9333ea":"--accent","#7e22ce":"--accent",
  "#0a84ff":"--accent","#0070e0":"--accent","#0077ed":"--accent","#0a66ff":"--accent",
  "#1d4ed8":"--accent","#2563eb":"--accent","#3b82f6":"--accent",
  "#38bdf8":"--info","#5ac8fa":"--info","#60a5fa":"--info","#70d7ff":"--info","#4da6ff":"--info","#64d2ff":"--teal","#06b6d4":"--teal",
  "#ff453a":"--danger","#ef4444":"--danger","#f87171":"--danger","#dc2626":"--danger",
  "#b91c1c":"--danger","#c0392b":"--danger","#fca5a5":"--danger","#fecaca":"--danger",
  "#ff5555":"--danger","#ff6b6b":"--danger","#ff6b60":"--danger","#f43f5e":"--danger",
  "#ff3b5c":"--danger","#ee5a24":"--danger","#d4556b":"--danger","#ff6482":"--danger",
  "#ff375f":"--pink","#ec4899":"--pink","#f472b6":"--pink","#f9a8d4":"--pink","#8e4585":"--pink",
  "#ff9f0a":"--warn","#f59e0b":"--warn","#fbbf24":"--warn","#d97706":"--warn","#fb923c":"--warn",
  "#f97316":"--warn","#ff8c00":"--warn","#ffb347":"--warn","#ffb340":"--warn","#fcd34d":"--warn",
  "#ffe066":"--warn","#fef3c7":"--warn","#c9a962":"--warn","#b8944d":"--warn","#ff9500":"--warn","#fb8c00":"--warn","#ffb800":"--warn",
  "#30d158":"--ok","#22c55e":"--ok","#16a34a":"--ok","#34d399":"--ok","#4ade80":"--ok",
  "#86efac":"--ok","#2bd4a8":"--ok","#10b981":"--ok","#34c759":"--ok","#4cd964":"--ok","#d1fae5":"--ok",
};

// ── Bekannte kühle Neutral-Rampen (Tailwind Slate/Zinc/Gray, Apple-Grautöne) ──
// leicht getönte UI-Grautöne, die der reine Sättigungsfilter (<0.10) verfehlt.
const NEUTRAL = new Set([
  // Slate
  "#f8fafc","#f1f5f9","#e2e8f0","#cbd5e1","#94a3b8","#64748b","#475569","#334155","#1e293b","#0f172a",
  // Zinc/Neutral/Gray (kühl)
  "#fafafa","#f4f4f5","#e4e4e7","#d4d4d8","#a1a1aa","#71717a","#52525b","#3f3f46","#27272a","#18181b",
  "#e5e7eb","#9ca3af","#6b7280","#4b5563","#374151","#1f2937","#111827",
  // diverse kühl getönte Grautöne, die in der App vorkommen
  "#99a3b8","#8794a0","#6b7480","#1a1a24","#f5f5f7","#fafbfc","#e4e4eb","#f5f5f7",
]);

// ── Graustufen-Zuordnung nach Helligkeit (identisch zu Teil A) ──
function grayToken(l){
  if(l<0.085) return "--bg";
  if(l<0.16)  return "--panel";
  if(l<0.235) return "--panel2";
  if(l<0.32)  return "--panel3";
  if(l<0.58)  return "--muted";
  if(l<0.80)  return "--text2";
  return "--text";
}

function mapAlpha(raw){
  const m = raw.match(/^rgba?\(([^)]*)\)$/i); if(!m) return null;
  const parts = m[1].split(",").map(s=>s.trim());
  if(parts.length<3) return null;
  const r=+parts[0], g=+parts[1], b=+parts[2]; const a = parts.length>3 ? parseFloat(parts[3]) : 1;
  if([r,g,b].some(x=>isNaN(x))) return null;
  const white = r>=250&&g>=250&&b>=250;
  const black = r<=8&&g<=8&&b<=8;
  if(a>=1){ // solide rgb() → wie hex behandeln
    const {s,l}=rgbToHsl(r,g,b);
    if(s<0.10) return "var("+grayToken(l)+")";
    const hx="#"+[r,g,b].map(x=>x.toString(16).padStart(2,"0")).join("");
    if(EXCLUDE.has(hx)) return null;
    return CHROMA[hx] ? "var("+CHROMA[hx]+")" : null;
  }
  if(white){ if(a<=0.07) return "var(--hover)"; if(a<=0.14) return "var(--border)"; return "var(--border2)"; }
  if(black) return null; // Schwarz-Overlays (Schatten/Scrim) bleiben
  const {h,s}=rgbToHsl(r,g,b);
  if(s>0.25 && h>=200 && h<=290) return "var(--accent-soft)"; // Neon-Indigo/Violett-Tints
  return null; // andere farbige Tints (Status) unangetastet lassen
}

function mapColor(raw){
  const c = raw.toLowerCase().replace(/\s+/g,"");
  if(SKIP_LITERAL.has(c)) return null;
  if(/^rgba?\(/.test(c) || /^hsla?\(/.test(c)) return mapAlpha(c);
  const hx = expand3(c);
  if(!/^#[0-9a-f]{6}$/.test(hx)) return null; // 4-/7-/8-stellige & ungültige lassen
  if(EXCLUDE.has(hx) || EXCLUDE.has(c)) return null;
  if(CHROMA[hx]) return "var("+CHROMA[hx]+")";
  const {r,g,b}=hexToRgb(hx); const {s,l}=rgbToHsl(r,g,b);
  if(s<0.10) return "var("+grayToken(l)+")";            // echte Graustufe
  if(NEUTRAL.has(hx)) return "var("+grayToken(l)+")";   // bekannte kühle Neutral-Rampe
  return null; // chromatische Nicht-Chrome-Farbe → bewahren
}

// ── Inline-style-Wert verarbeiten: ${…}-Spans überspringen ──
const colorRe = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;
let replaced=0, left=0; const leftCounts={}; const samples=[];

function transformCssSpan(text){
  return text.replace(colorRe, (col)=>{
    if(/^#[0-9a-fA-F]{7,8}$/.test(col)){ left++; tally(col); return col; } // #rrggbb(aa) alpha
    const mapped = mapColor(col);
    if(mapped){ replaced++; if(samples.length<40 && Math.random()<0.06) samples.push(col+" → "+mapped); return mapped; }
    left++; tally(col); return col;
  });
}
function tally(col){ const k=col.toLowerCase().replace(/\s+/g,""); leftCounts[k]=(leftCounts[k]||0)+1; }

// Wert in CSS- und ${…}-Interpolations-Segmente zerlegen; nur CSS transformieren.
function transformStyleValue(val){
  let out="", i=0, n=val.length;
  while(i<n){
    const dollar = val.indexOf("${", i);
    if(dollar===-1){ out += transformCssSpan(val.slice(i)); break; }
    out += transformCssSpan(val.slice(i, dollar));      // CSS vor der Interpolation
    // balancierte ${…}-Span finden
    let depth=0, j=dollar+1;
    for(; j<n; j++){ const ch=val[j]; if(ch==="{") depth++; else if(ch==="}"){ depth--; if(depth===0){ j++; break; } } }
    out += val.slice(dollar, j);                         // Interpolation unverändert
    i = j;
  }
  return out;
}

// ── Nur Inline-style-Attribute treffen (doppelt & einfach gequotet) ──
let src = fs.readFileSync(FILE,"utf8");
const attrRe = /style=("(?:[^"]*)"|'(?:[^']*)')/g;
const out = src.replace(attrRe, (m, q)=>{
  const quote = q[0];
  const inner = q.slice(1, -1);
  const nv = transformStyleValue(inner);
  return "style="+quote+nv+quote;
});

console.log("Replaced literals:", replaced);
console.log("Left untouched   :", left);
console.log("\nSample replacements:");
samples.forEach(s=>console.log("  "+s));
console.log("\nTop 30 LEFT (untouched) literals — verify these are component/intentional/white-black:");
Object.entries(leftCounts).sort((a,b)=>b[1]-a[1]).slice(0,30).forEach(([c,n])=>console.log("  "+String(n).padStart(4)+" "+c));

if(WRITE){ fs.writeFileSync(FILE, out); console.log("\n✓ WROTE "+FILE); }
else console.log("\n(dry-run — rerun with --write to apply)");
