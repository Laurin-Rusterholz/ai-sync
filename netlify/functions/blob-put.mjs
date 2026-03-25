import { getStore } from "@netlify/blobs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match",
  "Access-Control-Expose-Headers": "ETag"
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "PUT" && req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: cors });
  }

  const key = new URL(req.url).searchParams.get("key");
  if (!key) return Response.json({ error: "Missing key" }, { status: 400, headers: cors });

  const expectedToken = Netlify.env.get("SYNC_AUTH_TOKEN");
  if (expectedToken) {
    const provided = req.headers.get("Authorization") || "";
    if (provided !== expectedToken && provided !== "Bearer " + expectedToken) {
      return Response.json({ error: "Unauthorized" }, { status: 401, headers: cors });
    }
  }

  try {
    const body = await req.text();
    try { JSON.parse(body); } catch (e) { return Response.json({ error: "Invalid JSON" }, { status: 400, headers: cors }); }

    const store = getStore("app-sync");
    const ifMatch = req.headers.get("If-Match");
    if (ifMatch) {
      try {
        const existing = await store.getWithMetadata(key, { type: "text" });
        if (existing.data !== null && existing.etag && existing.etag !== ifMatch) {
          return Response.json({ error: "ETag conflict" }, { status: 412, headers: cors });
        }
      } catch (e) { /* no existing data */ }
    }

    await store.set(key, body);
    const saved = await store.getWithMetadata(key, { type: "text" });
    const newEtag = saved.etag || String(Date.now());
    return Response.json({ ok: true, key: key, etag: newEtag }, {
      status: 200,
      headers: { ...cors, "ETag": newEtag },
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: cors });
  }
};

export const config = { path: "/.netlify/functions/blob-put" };
