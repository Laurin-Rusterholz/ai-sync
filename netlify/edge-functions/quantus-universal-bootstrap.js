const UNIVERSAL_MARKER = "data-quantus-universal";
const UNIVERSAL_ASSETS = [
  '<link rel="stylesheet" href="/quantus-universal.css" data-quantus-universal>',
  '<script src="/quantus-bundle-loader.js" data-quantus-universal></script>',
  '<script src="/quantus-device-sync.js" data-quantus-universal></script>',
  '<script src="/quantus-universal-ui.js" data-quantus-universal></script>'
].join("\n");

export function injectUniversalAssets(html) {
  const source = String(html == null ? "" : html);
  if (!source || source.includes(UNIVERSAL_MARKER) || source.includes("/quantus-device-sync.js")) return source;
  if (/<\/head\s*>/i.test(source)) return source.replace(/<\/head\s*>/i, `${UNIVERSAL_ASSETS}\n</head>`);
  if (/<\/body\s*>/i.test(source)) return source.replace(/<\/body\s*>/i, `${UNIVERSAL_ASSETS}\n</body>`);
  return `${UNIVERSAL_ASSETS}\n${source}`;
}

export default async function quantusUniversalBootstrap(request, context) {
  const response = await context.next();
  if (request.method !== "GET" || [204, 205, 304].includes(response.status) || !response.body) return response;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("text/html")) return response;

  const html = await response.text();
  const transformed = injectUniversalAssets(html);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("etag");
  if (transformed !== html) {
    headers.set("cache-control", "no-cache");
    headers.set("x-quantus-universal", "device-sync-v2");
  }
  return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export const config = { path: "/*" };
