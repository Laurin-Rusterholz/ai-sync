export default async (req, context) => {
  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, OPTIONS" } });
  }

  const url = new URL(req.url);
  const fileUrl = url.searchParams.get("url");
  const fileName = url.searchParams.get("name") || "download";

  if (!fileUrl) return new Response("Missing url param", { status: 400 });

  try {
    const resp = await fetch(fileUrl);
    if (!resp.ok) return new Response("Fetch failed: " + resp.status, { status: 502 });
    const blob = await resp.blob();

    return new Response(blob, {
      headers: {
        "Content-Type": resp.headers.get("content-type") || "application/octet-stream",
        "Content-Disposition": 'attachment; filename="' + fileName + '"',
        "Access-Control-Allow-Origin": "*",
      }
    });
  } catch (err) {
    return new Response("Error: " + err.message, { status: 500 });
  }
};
