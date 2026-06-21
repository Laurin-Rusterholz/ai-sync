import { getStore } from "@netlify/blobs";

// ============================================================================
//  BRIEFING — List + delete endpoint
//  ---------------------------------------------------------------------------
//  GET    /.netlify/functions/briefing-list           → { items: [ meta, … ] }
//  DELETE /.netlify/functions/briefing-list?id=<id>    → removes one briefing
//
//  "items" is the index maintained by briefing-put (newest first). Each entry:
//    { id, title, date, filename, contentType, size, createdAt }
//  The binary PDF itself is fetched separately via briefing-get?id=<id>.
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

function unauthorized(req) {
  const expected = Netlify.env.get("SYNC_AUTH_TOKEN");
  if (!expected) return null;
  const provided = req.headers.get("Authorization") || "";
  if (provided === expected || provided === "Bearer " + expected) return null;
  return Response.json({ error: "Unauthorized" }, { status: 401, headers: cors });
}

async function readIndex(store) {
  try {
    const raw = await store.get(INDEX_KEY, { type: "text" });
    const idx = raw ? JSON.parse(raw) : [];
    return Array.isArray(idx) ? idx : [];
  } catch (e) {
    return [];
  }
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const denied = unauthorized(req);
  if (denied) return denied;

  const store = getStore(STORE);
  const url = new URL(req.url);

  if (req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return Response.json({ error: "Missing id" }, { status: 400, headers: cors });
    try {
      const index = (await readIndex(store)).filter((x) => x && x.id !== id);
      await store.set(INDEX_KEY, JSON.stringify(index));
      try { await store.delete(id); } catch (e) { /* best effort */ }
      return Response.json({ ok: true }, { status: 200, headers: cors });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500, headers: cors });
    }
  }

  if (req.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: cors });
  }

  try {
    const items = await readIndex(store);
    return Response.json({ items }, { status: 200, headers: cors });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: cors });
  }
};

export const config = { path: "/.netlify/functions/briefing-list" };
