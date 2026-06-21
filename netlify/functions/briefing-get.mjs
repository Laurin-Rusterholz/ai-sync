import { getStore } from "@netlify/blobs";

// ============================================================================
//  BRIEFING — Binary download endpoint
//  ---------------------------------------------------------------------------
//  GET /.netlify/functions/briefing-get?id=<id>[&download=1]
//    → streams the stored PDF back with its original Content-Type / filename.
//      download=1 forces "attachment" disposition; default is "inline" so the
//      browser can preview the PDF in a new tab.
//
//  The frontend fetches this with the auth header, turns the response into a
//  Blob and opens / downloads it via an object URL (so the bearer token never
//  has to live in a plain <a>/<iframe> src).
//
//  Auth: same optional SYNC_AUTH_TOKEN bearer as the existing sync endpoints.
// ============================================================================

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match",
  "Access-Control-Expose-Headers": "ETag, Content-Disposition",
};

const STORE = "briefings";

function unauthorized(req) {
  const expected = Netlify.env.get("SYNC_AUTH_TOKEN");
  if (!expected) return null;
  const provided = req.headers.get("Authorization") || "";
  if (provided === expected || provided === "Bearer " + expected) return null;
  return Response.json({ error: "Unauthorized" }, { status: 401, headers: cors });
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: cors });
  }

  const denied = unauthorized(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return Response.json({ error: "Missing id" }, { status: 400, headers: cors });

  try {
    const store = getStore(STORE);
    const { data, metadata } = await store.getWithMetadata(id, { type: "arrayBuffer" });
    if (data === null) return Response.json({ error: "Not found" }, { status: 404, headers: cors });

    const meta = metadata || {};
    const contentType = meta.contentType || "application/pdf";
    const filename = meta.filename || id + ".pdf";
    const download = url.searchParams.get("download");
    const disposition = (download === "1" || download === "true") ? "attachment" : "inline";
    const safeName = String(filename).replace(/[^\x20-\x7E]/g, "_");
    const encodedName = encodeURIComponent(filename);

    return new Response(data, {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": contentType,
        "Content-Disposition": disposition + "; filename=\"" + safeName + "\"; filename*=UTF-8''" + encodedName,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: cors });
  }
};

export const config = { path: "/.netlify/functions/briefing-get" };
