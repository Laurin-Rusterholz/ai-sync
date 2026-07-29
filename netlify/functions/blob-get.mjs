import { readAppDataDocument } from "../lib/firebase-admin.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match, If-None-Match",
  "Access-Control-Expose-Headers": "ETag"
};

// Sync-Daten duerfen nie aus einem Zwischenspeicher kommen — Clients cachen
// selbst (per ETag) und entscheiden mit If-None-Match, ob sie Daten brauchen.
const noStore = { "Cache-Control": "no-store" };

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  if (!key) return Response.json({ error: "Missing key" }, { status: 400, headers: cors });

  const expectedToken = Netlify.env.get("SYNC_AUTH_TOKEN");
  if (expectedToken) {
    const provided = req.headers.get("Authorization") || "";
    if (provided !== expectedToken && provided !== "Bearer " + expectedToken) {
      return Response.json({ error: "Unauthorized" }, { status: 401, headers: cors });
    }
  }

  try {
    const stored = await readAppDataDocument(key);
    const { data, etag } = stored;
    if (!stored.exists) return Response.json({ error: "Not found" }, { status: 404, headers: { ...cors, ...noStore } });

    const currentEtag = etag || String(Date.now());

    // Bedingter Abruf: Wenn der Client den aktuellen Stand schon hat, reicht
    // ein leeres 304 — das spart bei jedem Polling den kompletten Datenkoerper.
    const ifNoneMatch = req.headers.get("If-None-Match");
    if (ifNoneMatch && etag && ifNoneMatch === etag) {
      return new Response(null, { status: 304, headers: { ...cors, ...noStore, "ETag": currentEtag } });
    }

    // Meta-Modus: nur ETag und Groesse liefern (fuer leichte Status-Checks),
    // ohne den kompletten Datenstand zu uebertragen.
    if (url.searchParams.get("meta") === "1") {
      return Response.json(
        { key, etag: currentEtag, size: new TextEncoder().encode(data).length },
        { status: 200, headers: { ...cors, ...noStore, "ETag": currentEtag } }
      );
    }

    return new Response(data, {
      status: 200,
      headers: { ...cors, ...noStore, "Content-Type": "application/json", "ETag": currentEtag },
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: cors });
  }
};

export const config = { path: "/.netlify/functions/blob-get" };
