// ============================================================================
//  BRIEFING PDF RENDERER
//  ---------------------------------------------------------------------------
//  Pure-JS, dependency-light renderer (pdf-lib + StandardFonts only — no font
//  files on disk, no native bindings → robust to bundle in a Netlify Function).
//
//  Produces a fixed, print-ready briefing PDF (A4):
//    • dark-blue header band on every page
//    • golden accent line directly beneath the header
//    • golden vertical accent bar on the left of every page
//    • calm typography (Helvetica display / Times body), generous leading
//    • the 9th section is the centerpiece: its own page, centered & vertically
//      balanced, set in larger type for emphasis (the "longest & central" one)
//    • always at least 5 pages (short briefings get trailing template pages)
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
const MIN_PAGES = 5;

// ── typography ──
const BODY_SIZE = 11, BODY_LEAD = 16.5;
const HEAD_SIZE = 13.5;
const SECTION_GAP = 15;
const FEATURE_HEAD = 18, FEATURE_BODY = 13, FEATURE_LEAD = 21;
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

export async function renderBriefingPdf({ briefingText, date, title } = {}) {
  const doc = await PDFDocument.create();
  const safeTitle = sanitize(title || "Morning Briefing") || "Morning Briefing";
  const safeDate = sanitize(date || "");
  doc.setTitle(safeTitle);
  doc.setCreator("Quantus");
  doc.setProducer("Quantus Briefing Renderer");

  const fontTitle = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontHead  = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontBody  = await doc.embedFont(StandardFonts.TimesRoman);
  const fontMeta  = await doc.embedFont(StandardFonts.Helvetica);

  const pages = [];
  const ctx = { page: null, y: 0 };

  function drawTemplate(page, isFirst) {
    const headerH = isFirst ? HEADER_H_FIRST : HEADER_H_REST;
    page.drawRectangle({ x: 0, y: PAGE_H - headerH, width: PAGE_W, height: headerH, color: DARK_BLUE });
    page.drawRectangle({ x: 0, y: PAGE_H - headerH - ACCENT_H, width: PAGE_W, height: ACCENT_H, color: GOLD });
    const barTop = PAGE_H - headerH - ACCENT_H - 10;
    page.drawRectangle({ x: BAR_X, y: CONTENT_BOTTOM, width: BAR_W, height: barTop - CONTENT_BOTTOM, color: GOLD });

    if (isFirst) {
      const eyebrow = "MORNING BRIEFING".split("").join(" ");
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

  function newPage() {
    const isFirst = pages.length === 0;
    const page = doc.addPage([PAGE_W, PAGE_H]);
    drawTemplate(page, isFirst);
    pages.push(page);
    ctx.page = page;
    ctx.y = contentTop(isFirst);
  }

  function ensureSpace(h) { if (ctx.y - h < CONTENT_BOTTOM) newPage(); }

  function drawWrapped(text, font, size, leading, color, align) {
    for (const ln of wrapLine(text, font, size, CONTENT_W)) {
      ensureSpace(leading);
      let x = CONTENT_L;
      if (align === "center") x = CONTENT_L + (CONTENT_W - font.widthOfTextAtSize(ln, size)) / 2;
      ctx.page.drawText(ln, { x, y: ctx.y - size, size, font, color });
      ctx.y -= leading;
    }
  }

  function drawHeading(text, size) {
    ctx.y -= 4;
    drawWrapped(text, fontHead, size, size + 5, GOLD, "left");
    ctx.y -= 4;
  }

  function drawItems(items, { bodySize, bodyLead, align }) {
    for (const it of items) {
      if (it.type === "li" && align !== "center") {
        const indent = 16;
        const lines = wrapLine(it.text, fontBody, bodySize, CONTENT_W - indent);
        ensureSpace(bodyLead);
        ctx.page.drawText(BULLET, { x: CONTENT_L + 2, y: ctx.y - bodySize, size: bodySize, font: fontBody, color: GOLD });
        lines.forEach((ln, idx) => {
          if (idx > 0) ensureSpace(bodyLead);
          ctx.page.drawText(ln, { x: CONTENT_L + indent, y: ctx.y - bodySize, size: bodySize, font: fontBody, color: INK });
          ctx.y -= bodyLead;
        });
        ctx.y -= 2;
      } else {
        const text = (it.type === "li" ? BULLET + " " : "") + it.text;
        drawWrapped(text, fontBody, bodySize, bodyLead, INK, align);
        ctx.y -= 6;
      }
    }
  }

  function featureHeight(sec) {
    let h = 16;
    if (sec.heading) h += wrapLine(sec.heading, fontHead, FEATURE_HEAD, CONTENT_W).length * (FEATURE_HEAD + 6) + 10;
    for (const it of sec.items) {
      const text = (it.type === "li" ? BULLET + " " : "") + it.text;
      h += wrapLine(text, fontBody, FEATURE_BODY, CONTENT_W).length * FEATURE_LEAD + 6;
    }
    return h;
  }

  function renderFeature(sec) {
    newPage();
    const top = ctx.y;
    const avail = top - CONTENT_BOTTOM;
    const blockH = featureHeight(sec);
    if (blockH < avail) ctx.y = top - (avail - blockH) / 2;
    const ruleW = 64;
    ctx.page.drawRectangle({ x: CONTENT_L + (CONTENT_W - ruleW) / 2, y: ctx.y + 4, width: ruleW, height: 2, color: GOLD });
    ctx.y -= 18;
    if (sec.heading) { drawWrapped(sec.heading, fontHead, FEATURE_HEAD, FEATURE_HEAD + 6, DARK_BLUE, "center"); ctx.y -= 8; }
    drawItems(sec.items, { bodySize: FEATURE_BODY, bodyLead: FEATURE_LEAD, align: "center" });
  }

  const sections = parseSections(briefingText);
  newPage(); // page 1

  sections.forEach((sec, i) => {
    if (i === 8) { renderFeature(sec); return; } // 9th section = centerpiece
    if (sec.heading) drawHeading(sec.heading, HEAD_SIZE);
    drawItems(sec.items, { bodySize: BODY_SIZE, bodyLead: BODY_LEAD, align: "left" });
    ctx.y -= SECTION_GAP;
  });

  while (pages.length < MIN_PAGES) newPage();

  // footer pass (total page count is now known)
  const total = pages.length;
  const footerMeta = safeTitle + (safeDate ? "  ·  " + formatDateLong(safeDate) : "");
  pages.forEach((page, idx) => {
    page.drawRectangle({ x: CONTENT_L, y: 58, width: CONTENT_W, height: 0.6, color: HAIRLINE });
    page.drawText(footerMeta, { x: CONTENT_L, y: 44, size: 9, font: fontMeta, color: MUTED });
    const label = "Seite " + (idx + 1) + " / " + total;
    const w = fontMeta.widthOfTextAtSize(label, 9);
    page.drawText(label, { x: CONTENT_R - w, y: 44, size: 9, font: fontMeta, color: MUTED });
  });

  return await doc.save(); // Uint8Array
}
