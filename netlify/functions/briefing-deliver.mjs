import { cors, json, unauthorized, getBriefingStore, storeBriefing } from "../lib/briefings-store.mjs";
import { renderBriefingPdf } from "../lib/briefing-pdf.mjs";

// ============================================================================
//  BRIEFING — Deliver endpoint (text in → rendered PDF in the mailbox)
//  ---------------------------------------------------------------------------
//  So n8n does NOT have to render a PDF itself. POST plain JSON; this function
//  renders the fixed 5-page print-ready briefing PDF server-side (pdf-lib) and
//  stores it via the SAME "briefings" infrastructure as briefing-put, so it
//  shows up in the in-app Briefings mailbox.
//
//  POST /.netlify/functions/briefing-deliver
//  Content-Type: application/json
//  Body: { "briefingText": "<text>", "date": "YYYY-MM-DD", "title"?: "<title>", "label"?: "<label>" }
//    briefingText : required. Sections separated by BLANK LINES; a short first
//                   line in a section becomes its heading; lines starting with
//                   -, *, • or "1." become bullets. The 9th section is rendered
//                   as the centered centerpiece.
//    date         : optional, defaults to today (UTC). Shown in the header.
//    title        : optional, defaults to "Morgen-Briefing".
//    label        : optional, the letter-spaced eyebrow above the title.
//                   Defaults to "MORGEN-BRIEFING".
//
//  Auth: same optional SYNC_AUTH_TOKEN bearer as the existing sync endpoints.
//  Returns: { ok, id, title, date, filename, contentType, size, createdAt }
// ============================================================================

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const denied = unauthorized(req);
  if (denied) return denied;

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const briefingText = body && typeof body.briefingText === "string" ? body.briefingText : "";
  if (!briefingText.trim()) {
    return json({ error: "Missing 'briefingText' (non-empty string required)" }, 400);
  }

  const date = (body.date && /^\d{4}-\d{2}-\d{2}/.test(String(body.date)))
    ? String(body.date).slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const title = (body.title && String(body.title).trim()) ? String(body.title).trim() : "Morgen-Briefing";
  const label = (body.label && String(body.label).trim()) ? String(body.label).trim() : "MORGEN-BRIEFING";
  const filename = "briefing-" + date + ".pdf";

  try {
    const pdf = await renderBriefingPdf({ briefingText, date, title, label });
    // Hand Firebase Storage a clean, exact ArrayBuffer.
    const data = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength);
    const store = getBriefingStore();
    const meta = await storeBriefing(store, { data, title, date, filename, contentType: "application/pdf" });
    return json({ ok: true, ...meta }, 200);
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
};

export const config = { path: "/.netlify/functions/briefing-deliver" };
