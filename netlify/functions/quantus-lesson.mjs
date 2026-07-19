/* ────────────────────────────────────────────────────────────────────────
   quantus-lesson — oeffentlicher Lese-Endpunkt fuer die BM-Tageslektion.

   Liest den Blob (Store „app-sync", Key „quantus-tageslektion"), den der
   n8n-Workflow „BM Tageslektion" per PUT auf /.netlify/functions/blob-put
   schreibt. Bewusst OHNE Auth-Gate: die Tageslektion ist nicht sensibel und
   muss von der statischen Quantus-BM-App gelesen werden koennen — auch dann,
   wenn der Schreib-Endpunkt (blob-put) via SYNC_AUTH_TOKEN geschuetzt ist.
   ──────────────────────────────────────────────────────────────────────── */
import { getStore } from "@netlify/blobs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const LESSON_KEY = "quantus-tageslektion";

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") return Response.json({ error: "Method not allowed" }, { status: 405, headers: cors });
  try {
    const store = getStore("app-sync");
    const data = await store.get(LESSON_KEY, { type: "text" });
    if (data == null) return Response.json({ error: "Not found" }, { status: 404, headers: cors });
    return new Response(data, { status: 200, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: cors });
  }
};

export const config = { path: "/.netlify/functions/quantus-lesson" };
