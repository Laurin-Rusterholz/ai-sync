/* ────────────────────────────────────────────────────────────────────────
   quantus-chat — serverseitiger Proxy zur Anthropic Messages API.

   Der API-Key wird NIE im Client ausgeliefert oder hartkodiert. Er wird
   ausschliesslich aus der Netlify-Umgebungsvariable ANTHROPIC_API_KEY
   gelesen (Owner traegt ihn im Netlify-UI unter Site settings → Environment
   variables ein — analog zu SYNC_AUTH_TOKEN bei blob-get/blob-put).

   Aufruf (vom Quantus-BM-Client, same-origin):
     POST /.netlify/functions/quantus-chat
     Body: { "messages":[{role,content}], "system":"…", "max_tokens":1024 }
   Antwort: { "text":"…", "model":"…", "stop_reason":"…" }
   ──────────────────────────────────────────────────────────────────────── */

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-opus-4-8";
const MAX_TOKENS_CAP = 4096;

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: cors });
  }

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    // Bewusst deutliche Meldung, damit der Owner weiss, was zu tun ist.
    return Response.json({
      error: "not_configured",
      message: "ANTHROPIC_API_KEY ist in den Netlify-Umgebungsvariablen nicht gesetzt. " +
               "Bitte unter Site settings → Environment variables eintragen, dann neu deployen.",
    }, { status: 503, headers: cors });
  }

  let payload;
  try { payload = await req.json(); }
  catch { return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: cors }); }

  const messages = Array.isArray(payload.messages) ? payload.messages : null;
  if (!messages || messages.length === 0) {
    return Response.json({ error: "Missing 'messages' array" }, { status: 400, headers: cors });
  }

  const model = (typeof payload.model === "string" && payload.model.trim())
    || Netlify.env.get("ANTHROPIC_MODEL") || DEFAULT_MODEL;
  const maxTokens = Math.min(Math.max(parseInt(payload.max_tokens, 10) || 1024, 64), MAX_TOKENS_CAP);

  const body = { model, max_tokens: maxTokens, messages };
  if (typeof payload.system === "string" && payload.system.trim()) body.system = payload.system;

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });

    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = (data && data.error && data.error.message) || ("Anthropic HTTP " + r.status);
      return Response.json({ error: "anthropic_error", status: r.status, message: msg },
        { status: r.status === 401 ? 502 : r.status, headers: cors });
    }

    const text = Array.isArray(data.content)
      ? data.content.filter((b) => b && b.type === "text").map((b) => b.text).join("").trim()
      : "";

    return Response.json({
      text,
      model: data.model || model,
      stop_reason: data.stop_reason || null,
      usage: data.usage || null,
    }, { status: 200, headers: cors });
  } catch (e) {
    return Response.json({ error: "proxy_error", message: e.message }, { status: 502, headers: cors });
  }
};

export const config = { path: "/.netlify/functions/quantus-chat" };
