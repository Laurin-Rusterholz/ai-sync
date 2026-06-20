import { cors, json, unauthorized, getBriefingStore, storeBriefing } from "../lib/briefings-store.mjs";

// ============================================================================
//  BRIEFING — Upload endpoint (delivery into Quantus)
//  ---------------------------------------------------------------------------
//  Accepts an ALREADY-RENDERED briefing file (PDF) and stores it in the
//  "briefings" blob store so it shows up in the in-app Briefings mailbox.
//  (To have the PDF rendered server-side from plain text, use briefing-deliver.)
//
//  Two ways to send the file (whichever is easier in n8n):
//   1) Raw binary body  — Content-Type: application/pdf, metadata in query:
//        POST /.netlify/functions/briefing-put?title=Morning%20Briefing&date=2026-06-20
//   2) JSON body        — Content-Type: application/json:
//        { "pdfBase64": "<base64>", "title": "...", "date": "YYYY-MM-DD", "filename": "..." }
//
//  Auth: same optional SYNC_AUTH_TOKEN bearer as the existing sync endpoints.
// ============================================================================

function base64ToArrayBuffer(b64) {
  const clean = String(b64).replace(/^data:[^;]+;base64,/, "");
  const bin = atob(clean);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST" && req.method !== "PUT") return json({ error: "Method not allowed" }, 405);

  const denied = unauthorized(req);
  if (denied) return denied;

  const qp = new URL(req.url).searchParams;
  const ct = (req.headers.get("Content-Type") || "").toLowerCase();

  let data = null; // ArrayBuffer
  let title = qp.get("title") || "";
  let date = qp.get("date") || "";
  let filename = qp.get("filename") || "";
  let contentType = "application/pdf";

  try {
    if (ct.includes("application/json")) {
      const body = await req.json();
      const b64 = body.pdfBase64 || body.base64 || body.pdf || body.data;
      if (!b64) return json({ error: "Missing pdfBase64 in JSON body" }, 400);
      data = base64ToArrayBuffer(b64);
      title = body.title || title;
      date = body.date || date;
      filename = body.filename || filename;
      contentType = body.contentType || contentType;
    } else {
      data = await req.arrayBuffer();
      if (ct) contentType = ct.split(";")[0].trim() || contentType;
    }
  } catch (e) {
    return json({ error: "Could not read body: " + e.message }, 400);
  }

  if (!data || data.byteLength === 0) return json({ error: "Empty body — no file received" }, 400);

  try {
    const store = getBriefingStore();
    const meta = await storeBriefing(store, { data, title, date, filename, contentType });
    return json({ ok: true, ...meta }, 200);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};

export const config = { path: "/.netlify/functions/briefing-put" };
