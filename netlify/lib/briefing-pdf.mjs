// ============================================================================
//  BRIEFING PDF RENDERER
//  ---------------------------------------------------------------------------
//  Pure-JS, dependency-light renderer (pdf-lib + StandardFonts only — no font
//  files on disk, no native bindings → robust to bundle in a Netlify Function).
//
//  Produces a fixed, print-ready briefing PDF (A4) that ALWAYS fills EXACTLY
//  5 pages, regardless of how long or short the text is:
//    • dark-blue header band on every page
//    • golden accent line directly beneath the header
//    • golden vertical accent bar on the left of every page
//    • calm typography (Helvetica display / Times body)
//    • AUTO-FIT: a binary search picks the body font size (9–13pt) and a
//      line-height / spacing "stretch" so the whole text fills the 5 pages
//      evenly — short text is set larger & airier, long text more compact.
//      No forced page breaks, so no half-empty pages.
//    • the 9th section gets a subtle inline accent (gold rule + centered
//      heading) WITHOUT a page break.
//
//  Input: plain text. Sections are separated by BLANK LINES. A section may begin
//  with a short heading line (<= 64 chars, not ending in . ! ?). Lines that
//  start with -, *, • or "1." are rendered as bullet items.
// ============================================================================
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// ── palette ──
const DARK_BLUE = rgb(0.043, 0.122, 0.227); // #0B1F3A
const GOLD      = rgb(0.788, 0.635, 0.153);  // #C9A227
const SOFT_GOLD = rgb(0.93, 0.86, 0.62);
const INK       = rgb(0.129, 0.145, 0.169);  // #21252B
const MUTED     = rgb(0.46, 0.49, 0.54);
const HAIRLINE  = rgb(0.85, 0.85, 0.88);
const WHITE     = rgb(1, 1, 1);

// ── geometry (A4) ──
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const HEADER_H_FIRST = 124;
const HEADER_H_REST  = 60;
const ACCENT_H = 3;
const BAR_X = 40, BAR_W = 6;
const CONTENT_L = 76;
const CONTENT_R = PAGE_W - 56;
const CONTENT_W = CONTENT_R - CONTENT_L;
const CONTENT_BOTTOM = 72;

// ── auto-fit bounds ──
const TARGET_PAGES = 5;
const SIZE_MIN = 9, SIZE_MAX = 14;   // 9–13 is the sweet spot; 14 gives a little headroom to fill short briefings
const SIZE_EMERGENCY_MIN = 5;        // only used for pathologically long input
const STRETCH_MIN = 1.0, STRETCH_MAX = 2.6;
const LEAD_RATIO = 1.5;
const BULLET = "•";

const MONTHS_DE = ["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];

function formatDateLong(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ""));
  if (!m) return String(d || "");
  const mo = MONTHS_DE[parseInt(m[2], 10) - 1] || "";
  return parseInt(m[3], 10) + ". " + mo + " " + m[1];
}

// Map / strip characters that the StandardFonts (WinAnsi) cannot encode so
// drawText never throws on emoji, smart punctuation, CJK, etc.
function sanitize(str) {
  if (str == null) return "";
  let s = String(str).replace(/\r\n?/g, "\n");
  s = s.replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, " ").replace(/\t/g, "  ");
  const map = {
    "‘": "'", "’": "'", "‚": "'", "′": "'",
    "“": '"', "”": '"', "„": '"', "″": '"',
    "–": "-", "—": "-", "−": "-", "‐": "-", "‑": "-",
    "…": "...",
    "·": BULLET, "●": BULLET, "▪": BULLET, "‣": BULLET, "⁃": BULLET, "∙": BULLET,
    "→": "->", "←": "<-", "↔": "<->", "⇒": "=>",
    "×": "x", "✕": "x",
  };
  s = s.replace(/[‘’‚′“”„″–—−‐‑…·●▪‣⁃∙→←↔⇒×✕]/g, (ch) => map[ch] || "");
  const extras = new Set([0x152,0x153,0x160,0x161,0x178,0x17D,0x17E,0x192,0x2C6,0x2DC,0x2020,0x2021,0x2022,0x2026,0x2030,0x2039,0x203A,0x20AC,0x2122]);
  let out = "";
  for (const ch of s) {
    if (ch === "\n") { out += ch; continue; }
    const cp = ch.codePointAt(0);
    if (cp === 0x09) { out += " "; continue; }
    if (cp < 0x20) continue;
    if (cp <= 0xFF) { out += ch; continue; }
    if (extras.has(cp)) { out += ch; continue; }
    // emoji / CJK / other → drop
  }
  return out;
}

// Greedy word-wrap; hard-breaks single words longer than the column.
function wrapLine(text, font, size, maxWidth) {
  const words = String(text).split(/ +/);
  const lines = [];
  let line = "";
  const breakLong = (w) => {
    if (font.widthOfTextAtSize(w, size) <= maxWidth) return [w];
    const parts = []; let cur = "";
    for (const c of w) {
      if (!cur || font.widthOfTextAtSize(cur + c, size) <= maxWidth) cur += c;
      else { parts.push(cur); cur = c; }
    }
    if (cur) parts.push(cur);
    return parts;
  };
  for (const raw of words) {
    if (raw === "") continue;
    for (const w of breakLong(raw)) {
      const test = line ? line + " " + w : w;
      if (!line || font.widthOfTextAtSize(test, size) <= maxWidth) line = test;
      else { lines.push(line); line = w; }
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function parseSections(text) {
  const blocks = sanitize(text).split(/\n[ \t]*\n+/).map((b) => b.trim()).filter((b) => b.length);
  return blocks.map((block) => {
    const rawLines = block.split("\n").map((l) => l.trim()).filter((l) => l.length);
    let heading = null;
    let bodyLines = rawLines;
    if (rawLines.length > 1 && rawLines[0].length <= 64 && !/[.!?]$/.test(rawLines[0])) {
      heading = rawLines[0];
      bodyLines = rawLines.slice(1);
    }
    const items = [];
    let para = [];
    const flush = () => { if (para.length) { items.push({ type: "p", text: para.join(" ") }); para = []; } };
    for (const ln of bodyLines) {
      const m = ln.match(/^([-*•]|\d+[.)])\s+(.*)$/);
      if (m) { flush(); items.push({ type: "li", text: m[2] }); }
      else para.push(ln);
    }
    flush();
    return { heading, items };
  });
}

export async function renderBriefingPdf({ briefingText, date, title, label } = {}) {
  const doc = await PDFDocument.create();
  const safeTitle = sanitize(title || "Morgen-Briefing") || "Morgen-Briefing";
  const safeLabel = (sanitize(label || "MORGEN-BRIEFING") || "MORGEN-BRIEFING").toUpperCase();
  const safeDate = sanitize(date || "");
  doc.setTitle(safeTitle);
  doc.setCreator("Quantus");
  doc.setProducer("Quantus Briefing Renderer");

  const fontTitle = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontHead  = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontBody  = await doc.embedFont(StandardFonts.TimesRoman);
  const fontMeta  = await doc.embedFont(StandardFonts.Helvetica);

  function drawTemplate(page, isFirst) {
    const headerH = isFirst ? HEADER_H_FIRST : HEADER_H_REST;
    page.drawRectangle({ x: 0, y: PAGE_H - headerH, width: PAGE_W, height: headerH, color: DARK_BLUE });
    page.drawRectangle({ x: 0, y: PAGE_H - headerH - ACCENT_H, width: PAGE_W, height: ACCENT_H, color: GOLD });
    const barTop = PAGE_H - headerH - ACCENT_H - 10;
    page.drawRectangle({ x: BAR_X, y: CONTENT_BOTTOM, width: BAR_W, height: barTop - CONTENT_BOTTOM, color: GOLD });

    if (isFirst) {
      const eyebrow = safeLabel.split("").join(" ");
      page.drawText(eyebrow, { x: CONTENT_L, y: PAGE_H - 42, size: 9, font: fontMeta, color: SOFT_GOLD });
      const titleLines = wrapLine(safeTitle, fontTitle, 25, CONTENT_W).slice(0, 2);
      let ty = PAGE_H - 68;
      for (const ln of titleLines) { page.drawText(ln, { x: CONTENT_L, y: ty, size: 25, font: fontTitle, color: WHITE }); ty -= 29; }
      if (safeDate) page.drawText(formatDateLong(safeDate), { x: CONTENT_L, y: PAGE_H - headerH + 14, size: 11.5, font: fontMeta, color: SOFT_GOLD });
    } else {
      page.drawText(safeTitle, { x: CONTENT_L, y: PAGE_H - 38, size: 12, font: fontTitle, color: WHITE });
      if (safeDate) {
        const dt = formatDateLong(safeDate);
        const w = fontMeta.widthOfTextAtSize(dt, 10);
        page.drawText(dt, { x: CONTENT_R - w, y: PAGE_H - 37, size: 10, font: fontMeta, color: SOFT_GOLD });
      }
    }
  }

  function contentTop(isFirst) { return PAGE_H - (isFirst ? HEADER_H_FIRST : HEADER_H_REST) - ACCENT_H - 30; }

  const sections = parseSections(briefingText);

  // Build a flat list of layout "atoms" for a given body size + stretch factor.
  // Atom: { h: vertical advance, gap?: true, draw?: (page, yTop) => void }.
  // Gaps at the very top of a fresh page are dropped, so pages have no wasted
  // top space. Every atom is a single line / small gap → fine-grained
  // pagination, which lets the stretch search fill pages precisely.
  function buildAtoms(size, stretch) {
    const lead     = size * LEAD_RATIO * stretch;
    const hSize    = size + 2.5;
    const hLead    = hSize * 1.35 * stretch;
    const gSection = size * 1.10 * stretch;
    const gHeadTop = size * 0.45 * stretch;
    const gHeadBot = size * 0.30 * stretch;
    const gPara    = size * 0.55 * stretch;
    const gBullet  = size * 0.18 * stretch;
    const ruleH    = size * 0.90 * stretch;
    const indent   = Math.max(14, size * 1.5);
    const atoms = [];
    const gap = (h) => atoms.push({ h, gap: true });

    sections.forEach((sec, si) => {
      if (si > 0) gap(gSection);
      const isFeature = (si === 8); // 9th section: subtle inline accent (no break)

      if (isFeature) {
        gap(gHeadTop);
        atoms.push({ h: ruleH, draw: (page, y) => {
          const w = 64;
          page.drawRectangle({ x: CONTENT_L + (CONTENT_W - w) / 2, y: y - ruleH * 0.5, width: w, height: 2, color: GOLD });
        }});
      }

      if (sec.heading) {
        if (!isFeature) gap(gHeadTop);
        const hs = isFeature ? hSize + 1.5 : hSize;
        const hColor = isFeature ? DARK_BLUE : GOLD;
        const center = isFeature;
        for (const ln of wrapLine(sec.heading, fontHead, hs, CONTENT_W)) {
          atoms.push({ h: hLead, draw: (page, y) => {
            let x = CONTENT_L;
            if (center) x = CONTENT_L + (CONTENT_W - fontHead.widthOfTextAtSize(ln, hs)) / 2;
            page.drawText(ln, { x, y: y - hs, size: hs, font: fontHead, color: hColor });
          }});
        }
        gap(gHeadBot);
      }

      sec.items.forEach((it) => {
        if (it.type === "li") {
          const lines = wrapLine(it.text, fontBody, size, CONTENT_W - indent);
          lines.forEach((ln, idx) => {
            atoms.push({ h: lead, draw: (page, y) => {
              if (idx === 0) page.drawText(BULLET, { x: CONTENT_L + 2, y: y - size, size, font: fontBody, color: GOLD });
              page.drawText(ln, { x: CONTENT_L + indent, y: y - size, size, font: fontBody, color: INK });
            }});
          });
          gap(gBullet);
        } else {
          for (const ln of wrapLine(it.text, fontBody, size, CONTENT_W)) {
            atoms.push({ h: lead, draw: (page, y) => {
              page.drawText(ln, { x: CONTENT_L, y: y - size, size, font: fontBody, color: INK });
            }});
          }
          gap(gPara);
        }
      });
    });

    while (atoms.length && atoms[atoms.length - 1].gap) atoms.pop();
    return atoms;
  }

  // Paginate atoms. Returns the page count; when commit=true, also draws.
  // Measurement and committing share this exact logic, so the page count is
  // identical between the dry-run search and the final render.
  function layout(atoms, commit) {
    let pageCount = 0, y = 0, page = null, atTop = true;
    const startPage = () => {
      pageCount++;
      const isFirst = pageCount === 1;
      if (commit) { page = doc.addPage([PAGE_W, PAGE_H]); drawTemplate(page, isFirst); }
      y = contentTop(isFirst);
      atTop = true;
    };
    startPage();
    for (const a of atoms) {
      if (a.gap) {
        if (atTop) continue;
        if (y - a.h < CONTENT_BOTTOM) { startPage(); continue; }
        y -= a.h; continue;
      }
      if (y - a.h < CONTENT_BOTTOM) startPage();
      if (commit) a.draw(page, y);
      y -= a.h;
      atTop = false;
    }
    return pageCount;
  }

  const fits = (sz, st) => layout(buildAtoms(sz, st), false) <= TARGET_PAGES;

  // ── Auto-fit step 1: largest body size that fits in <= 5 pages ──
  let size;
  if (fits(SIZE_MAX, STRETCH_MIN)) {
    size = SIZE_MAX;
  } else {
    let lo, hi;
    if (fits(SIZE_MIN, STRETCH_MIN)) { lo = SIZE_MIN; hi = SIZE_MAX; }      // normal: shrink within 9–13
    else { lo = SIZE_EMERGENCY_MIN; hi = SIZE_MIN; }                         // pathological: shrink below 9
    size = lo;
    for (let i = 0; i < 14; i++) { const m = (lo + hi) / 2; if (fits(m, STRETCH_MIN)) { size = m; lo = m; } else hi = m; }
  }

  // ── Auto-fit step 2: largest stretch that still fits in <= 5 pages (fills them) ──
  let stretch = STRETCH_MIN;
  if (fits(size, STRETCH_MAX)) {
    stretch = STRETCH_MAX;
  } else {
    let lo = STRETCH_MIN, hi = STRETCH_MAX;
    for (let i = 0; i < 16; i++) { const m = (lo + hi) / 2; if (fits(size, m)) { stretch = m; lo = m; } else hi = m; }
  }

  // ── commit ──
  let pageCount = layout(buildAtoms(size, stretch), true);
  // Guarantee EXACTLY 5 pages. (Padding only triggers for near-empty input that
  // even the maximum stretch cannot fill; the template still renders fully.)
  while (pageCount < TARGET_PAGES) { drawTemplate(doc.addPage([PAGE_W, PAGE_H]), false); pageCount++; }

  // footer pass (page x / total)
  const all = doc.getPages();
  const total = all.length;
  const footerMeta = safeTitle + (safeDate ? "  ·  " + formatDateLong(safeDate) : "");
  all.forEach((page, idx) => {
    page.drawRectangle({ x: CONTENT_L, y: 58, width: CONTENT_W, height: 0.6, color: HAIRLINE });
    page.drawText(footerMeta, { x: CONTENT_L, y: 44, size: 9, font: fontMeta, color: MUTED });
    const label = "Seite " + (idx + 1) + " / " + total;
    const w = fontMeta.widthOfTextAtSize(label, 9);
    page.drawText(label, { x: CONTENT_R - w, y: 44, size: 9, font: fontMeta, color: MUTED });
  });

  return await doc.save(); // Uint8Array
}
