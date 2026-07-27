// Blockt Ziele, die nie ein legitimer Download sind: lokale/interne Adressen
// und alles ausser http(s). Schuetzt die Funktion davor, als offener Proxy in
// interne Netze missbraucht zu werden.
function isBlockedTarget(fileUrl) {
  let parsed;
  try { parsed = new URL(fileUrl); } catch (e) { return true; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return true;
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "0.0.0.0" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host === "[::1]" || host.startsWith("fd") || host.startsWith("fe80")) return true;
  return false;
}

export default async (req, context) => {
  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, OPTIONS" } });
  }

  const url = new URL(req.url);
  const fileUrl = url.searchParams.get("url");
  const rawName = url.searchParams.get("name") || "download";

  if (!fileUrl) return new Response("Missing url param", { status: 400 });
  if (isBlockedTarget(fileUrl)) return new Response("Target not allowed", { status: 400 });

  try {
    // Timeout, damit ein haengendes Ziel die Funktion nicht bis zum harten
    // Netlify-Limit blockiert.
    const resp = await fetch(fileUrl, { signal: AbortSignal.timeout(25000) });
    if (!resp.ok) return new Response("Fetch failed: " + resp.status, { status: 502 });

    const safeName = rawName.replace(/[^\x20-\x7E]/g, "_");
    const encodedName = encodeURIComponent(rawName);

    const headers = {
      "Content-Type": resp.headers.get("content-type") || "application/octet-stream",
      "Content-Disposition": "attachment; filename=\"" + safeName + "\"; filename*=UTF-8''" + encodedName,
      "Access-Control-Allow-Origin": "*",
    };
    // Content-Length durchreichen: Der Browser kann einen echten
    // Download-Fortschritt anzeigen.
    const length = resp.headers.get("content-length");
    if (length) headers["Content-Length"] = length;

    return new Response(resp.body, { headers });
  } catch (err) {
    const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
    return new Response("Error: " + err.message, { status: timedOut ? 504 : 500 });
  }
};
