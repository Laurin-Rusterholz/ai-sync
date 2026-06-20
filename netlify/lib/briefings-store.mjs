// ============================================================================
//  BRIEFINGS — Shared storage helpers
//  ---------------------------------------------------------------------------
//  Lives OUTSIDE netlify/functions so Netlify does NOT expose it as its own
//  endpoint (esbuild bundles it into each importing function).
//
//  Single source of truth for the "briefings" blob store used by:
//    briefing-put     (upload a pre-rendered file)
//    briefing-deliver (render a PDF server-side, then store it here)
//    briefing-list / briefing-get (read side)
//
//  Layout in the store:
//    key "__index__"  → JSON array of metadata (newest first):
//                       { id, title, date, filename, contentType, size, createdAt }
//    key "<id>"       → the binary file, with the same metadata attached.
//
//  Auth mirrors blob-get / blob-put: optional SYNC_AUTH_TOKEN bearer.
// ============================================================================
import { getStore } from "@netlify/blobs";

export const STORE = "briefings";
export const INDEX_KEY = "__index__";
export const MAX_ITEMS = 200;

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match",
  "Access-Control-Expose-Headers": "ETag, Content-Disposition",
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json", ...extraHeaders },
  });
}

function env(name) {
  try { if (typeof Netlify !== "undefined" && Netlify.env) return Netlify.env.get(name); } catch (e) { /* ignore */ }
  return (typeof process !== "undefined" && process.env) ? process.env[name] : undefined;
}

// Returns a 401 Response if the bearer token is required and wrong, else null.
export function unauthorized(req) {
  const expected = env("SYNC_AUTH_TOKEN");
  if (!expected) return null; // no token configured → open (same as blob-get/blob-put)
  const provided = req.headers.get("Authorization") || "";
  if (provided === expected || provided === "Bearer " + expected) return null;
  return json({ error: "Unauthorized" }, 401);
}

export function getBriefingStore() {
  return getStore(STORE);
}

export async function readIndex(store) {
  try {
    const raw = await store.get(INDEX_KEY, { type: "text" });
    const idx = raw ? JSON.parse(raw) : [];
    return Array.isArray(idx) ? idx : [];
  } catch (e) {
    return [];
  }
}

export async function writeIndex(store, index) {
  await store.set(INDEX_KEY, JSON.stringify(index));
}

function byteLengthOf(data) {
  if (data == null) return 0;
  if (typeof data.byteLength === "number") return data.byteLength; // ArrayBuffer / TypedArray
  if (typeof data.length === "number") return data.length;
  return 0;
}

// Store a briefing binary + update the index (newest first). Returns the
// metadata entry. `data` may be an ArrayBuffer / Uint8Array. For a once-a-day
// delivery the read-modify-write window is tiny, so last-writer-wins is fine.
export async function storeBriefing(store, { data, title, date, filename, contentType }) {
  const now = new Date();
  const id = "b_" + now.getTime().toString(36) + "_" + Math.random().toString(36).slice(2, 8);

  date = String(date || now.toISOString().slice(0, 10)).slice(0, 40);
  title = String(title || ("Briefing " + date)).slice(0, 200);
  contentType = contentType || "application/pdf";
  if (!filename) filename = title.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) + ".pdf";
  filename = String(filename).slice(0, 120);

  const meta = { id, title, date, filename, contentType, size: byteLengthOf(data), createdAt: now.toISOString() };

  await store.set(id, data, { metadata: meta });

  let index = await readIndex(store);
  index = index.filter((x) => x && x.id !== id);
  index.unshift(meta);
  if (index.length > MAX_ITEMS) {
    const removed = index.slice(MAX_ITEMS);
    index = index.slice(0, MAX_ITEMS);
    for (const r of removed) { try { await store.delete(r.id); } catch (e) { /* best effort */ } }
  }
  await writeIndex(store, index);

  return meta;
}
