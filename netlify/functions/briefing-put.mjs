import { getStore } from "@netlify/blobs";

// ============================================================================
//  BRIEFING — Upload endpoint (delivery into Quantus)
//  ---------------------------------------------------------------------------
//  Accepts a briefing file (PDF) from an external job (e.g. an n8n morning
//  workflow) and stores it as a BINARY Netlify Blob in the "briefings" store.
//  A small JSON index (key "__index__") keeps the list + ordering so the
//  frontend can show a mailbox without scanning every blob.
//
//  Two ways to send the file (whichever is easier in n8n):
//   1) Raw binary body  — Content-Type: application/pdf, metadata in query:
//        POST /.netlify/functions/briefing-put?title=Morning%20Briefing&date=2026-06-20
//   2) JSON body        — Content-Type: application/json:
//        { "pdfBase64": "<base64>", "title": "...", "date": "YYYY-MM-DD", "filename": "..." }
//
//  Auth: same optional SYNC_AUTH_TOKEN bearer as the existing sync endpoints.
// ============================================================================

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match",
  "Access-Control-Expose-Headers": "ETag",
};

const STORE = "briefings";
const INDEX_KEY = "__index__";
const MAX_ITEMS = 200;

function unauthorized(req) {
  const expected = Netlify.env.get("SYNC_AUTH_TOKEN");
  if (!expected) return null; // no token configured → open (same as blob-get/blob-put)
  const provided = req.headers.get("Authorization") || "";
  if (provided === expected || provided === "Bearer " + expected) return null;
  return Response.json({ error: "Unauthorized" }, { status: 401, headers: cors });
}

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
  if (req.method !== "POST" && req.method !== "PUT") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: cors });
  }

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
      if (!b64) return Response.json({ error: "Missing pdfBase64 in JSON body" }, { status: 400, headers: cors });
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
    return Response.json({ error: "Could not read body: " + e.message }, { status: 400, headers: cors });
  }

  if (!data || data.byteLength === 0) {
    return Response.json({ error: "Empty body — no file received" }, { status: 400, headers: cors });
  }

  const now = new Date();
  const id = "b_" + now.getTime().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  if (!date) date = now.toISOString().slice(0, 10);
  if (!title) title = "Briefing " + date;
  // Keep the metadata object well under the Netlify Blobs metadata size limit.
  title = String(title).slice(0, 200);
  date = String(date).slice(0, 40);
  if (!filename) filename = title.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) + ".pdf";
  filename = String(filename).slice(0, 120);

  const meta = { id, title, date, filename, contentType, size: data.byteLength, createdAt: now.toISOString() };

  try {
    const store = getStore(STORE);
    await store.set(id, data, { metadata: meta });

    // Read-modify-write the index (newest first). For a once-a-day delivery the
    // write window is tiny, so a simple last-writer-wins is acceptable here.
    let index = [];
    try {
      const raw = await store.get(INDEX_KEY, { type: "text" });
      if (raw) index = JSON.parse(raw);
      if (!Array.isArray(index)) index = [];
    } catch (e) { index = []; }

    index = index.filter((x) => x && x.id !== id);
    index.unshift(meta);

    if (index.length > MAX_ITEMS) {
      const removed = index.slice(MAX_ITEMS);
      index = index.slice(0, MAX_ITEMS);
      for (const r of removed) { try { await store.delete(r.id); } catch (e) { /* best effort */ } }
    }
    await store.set(INDEX_KEY, JSON.stringify(index));

    return Response.json({ ok: true, ...meta }, { status: 200, headers: cors });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: cors });
  }
};

export const config = { path: "/.netlify/functions/briefing-put" };
