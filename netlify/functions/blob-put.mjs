import { writeAppDataText } from "../lib/firebase-admin.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match, If-None-Match",
  "Access-Control-Expose-Headers": "ETag"
};

// Obergrenze fuer einen Datenstand: schuetzt den Blob-Store vor versehentlich
// riesigen Uploads (z. B. eingebettete Binaerdaten) — der normale App-Datenstand
// liegt weit darunter.
const MAX_BODY_BYTES = 20 * 1024 * 1024;

// Der Kerndatensatz darf ausschliesslich bedingt geschrieben werden. Ein PUT
// ohne If-Match ist ein unbedingtes Ersetzen — genau der Weg, auf dem fremde
// Aenderungen samt ihrer Grabsteine verschwanden (F-25). Der Client hat dafuer
// eigene Riegel; dieser hier greift auch bei einem ALTEN Client, der noch aus
// einem zwischengespeicherten Stand laeuft und die Riegel nicht kennt.
// Massgeblich ist der Schluessel des Datenstands selbst, nicht die Nebenkeys
// (readinghub, recalllab, Anhangstexte) — die haben kein Mehrgeraeteproblem.
const CORE_KEY = "app-data.json";
function isCoreKey(key) {
  return String(key || "") === CORE_KEY;
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "PUT" && req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: { ...cors, "Allow": "PUT, POST, OPTIONS" } });
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
    const bodyBytes = new TextEncoder().encode(body).length;
    if (bodyBytes > MAX_BODY_BYTES) {
      return Response.json(
        { error: "Payload too large", size: bodyBytes, max: MAX_BODY_BYTES },
        { status: 413, headers: cors }
      );
    }
    try { JSON.parse(body); } catch (e) { return Response.json({ error: "Invalid JSON" }, { status: 400, headers: cors }); }

    const ifMatch = req.headers.get("If-Match");
    if (isCoreKey(key) && !ifMatch) {
      return Response.json(
        {
          error: "Precondition Required",
          detail: "Der Kerndatensatz wird nur bedingt geschrieben. Zuerst lesen, dann mit If-Match schreiben.",
          key,
        },
        { status: 428, headers: { ...cors, "Allow": "PUT, POST, OPTIONS" } }
      );
    }
    const saved = await writeAppDataText(key, body, { ifMatch });
    if (saved.conflict) {
      return Response.json({ error: "ETag conflict" }, { status: 412, headers: cors });
    }
    if (!saved.ok) throw new Error("Firebase hat den Datenstand nicht gespeichert.");
    const newEtag = saved.etag;

    return Response.json({ ok: true, key: key, etag: newEtag, size: bodyBytes }, {
      status: 200,
      headers: { ...cors, "ETag": newEtag },
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: cors });
  }
};

export const config = { path: "/.netlify/functions/blob-put" };
