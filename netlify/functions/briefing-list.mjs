import {
  cors,
  deleteBriefing,
  json,
  listBriefings,
  unauthorized,
} from "../lib/briefings-store.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const denied = unauthorized(req);
  if (denied) return denied;

  const url = new URL(req.url);
  if (req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "Missing id" }, 400);
    try {
      await deleteBriefing(id);
      return json({ ok: true });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  try {
    return json({ items: await listBriefings() });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};

export const config = { path: "/.netlify/functions/briefing-list" };
