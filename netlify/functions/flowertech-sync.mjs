import { firebaseDbGet, mutateAppData } from "../lib/firebase-admin.mjs";
import { mergeInquiryTasks } from "../lib/flowertech-core.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function env(name) {
  try {
    if (typeof Netlify !== "undefined" && Netlify.env) return Netlify.env.get(name);
  } catch {
    // Ignore.
  }
  return typeof process !== "undefined" ? process.env?.[name] : undefined;
}

function denied(req) {
  const expected = env("SYNC_AUTH_TOKEN");
  if (!expected) return null;
  const provided = req.headers.get("Authorization") || "";
  if (provided === expected || provided === `Bearer ${expected}`) return null;
  return Response.json({ error: "Unauthorized" }, { status: 401, headers: cors });
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const auth = denied(req);
  if (auth) return auth;
  if (req.method !== "GET" && req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: cors });
  }

  try {
    const inquiriesMap = await firebaseDbGet("flowertech/inquiries") || {};
    const videosMap = await firebaseDbGet("flowertech/videos") || {};
    const inquiries = Object.entries(inquiriesMap).map(([id, value]) => ({ id, ...(value || {}) }));
    const videos = Object.entries(videosMap).map(([id, value]) => ({ id, ...(value || {}) }));
    let createdTasks = 0;

    if (req.method === "POST") {
      await mutateAppData("app-data.json", (current) => {
        const merged = mergeInquiryTasks(current, inquiries);
        const data = merged.data;
        createdTasks = merged.createdTasks;
        data.flowertech = data.flowertech || {};
        data.flowertech.inquiries = Object.fromEntries(inquiries.map((item) => [item.id, item]));
        data.flowertech.videos = Object.fromEntries(videos.map((item) => [item.id, item]));
        return data;
      }, { savedBy: "flowertech-sync" });
    }

    return Response.json({
      ok: true,
      inquiryCount: inquiries.length,
      videoCount: videos.length,
      createdTasks,
    }, { headers: cors });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: cors });
  }
};

export const config = { path: "/.netlify/functions/flowertech-sync" };
