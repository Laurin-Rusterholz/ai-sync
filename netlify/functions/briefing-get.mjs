import {
  cors,
  getBriefing,
  json,
  readBriefingBinary,
  unauthorized,
} from "../lib/briefings-store.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const denied = unauthorized(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "Missing id" }, 400);

  try {
    const meta = await getBriefing(id);
    if (!meta) return json({ error: "Not found" }, 404);
    const data = await readBriefingBinary(meta);
    if (!data) return json({ error: "File not found" }, 404);

    const contentType = meta.contentType || "application/pdf";
    const filename = meta.filename || id + ".pdf";
    const download = url.searchParams.get("download");
    const disposition = (download === "1" || download === "true") ? "attachment" : "inline";
    const safeName = String(filename).replace(/[^\x20-\x7E]/g, "_");

    return new Response(data, {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": contentType,
        "Content-Disposition": `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};

export const config = { path: "/.netlify/functions/briefing-get" };
