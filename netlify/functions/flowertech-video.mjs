import { firebaseDbGet, firebaseDbSet, firebaseStorageUpload } from "../lib/firebase-admin.mjs";

const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Cache-Control": "no-store",
};

function env(name) {
  try {
    if (typeof Netlify !== "undefined" && Netlify.env) return Netlify.env.get(name);
  } catch {
    // Fall through for local tests.
  }
  return typeof process !== "undefined" ? process.env?.[name] : undefined;
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: cors });
}

function denied(req) {
  const expected = env("SYNC_AUTH_TOKEN");
  if (!expected) return null;
  const provided = req.headers.get("Authorization") || "";
  if (provided === expected || provided === `Bearer ${expected}`) return null;
  return json({ error: "Unauthorized" }, 401);
}

function clean(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function validPostKey(value) {
  return /^[a-z0-9][a-z0-9_-]{5,100}$/i.test(value);
}

async function archiveVideo(postKey, videoUrl) {
  let url;
  try {
    url = new URL(videoUrl);
  } catch {
    throw new Error("Ungültige Video-URL.");
  }
  if (url.protocol !== "https:") throw new Error("Die Video-URL muss HTTPS verwenden.");

  const response = await fetch(url, {
    headers: { Accept: "video/mp4,video/*;q=0.9,application/octet-stream;q=0.5" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`Video-Download fehlgeschlagen (HTTP ${response.status}).`);

  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > MAX_VIDEO_BYTES) throw new Error("Das Video ist grösser als 250 MB.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error("Der Videoanbieter lieferte eine leere Datei.");
  if (bytes.length > MAX_VIDEO_BYTES) throw new Error("Das Video ist grösser als 250 MB.");

  const contentType = response.headers.get("content-type") || "video/mp4";
  const storagePath = `flowertech/videos/${postKey}.mp4`;
  await firebaseStorageUpload(storagePath, bytes, {
    contentType,
    metadata: { postKey, source: "n8n-instagram" },
  });
  return { storagePath, archiveBytes: bytes.length, archiveContentType: contentType };
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const auth = denied(req);
  if (auth) return auth;

  try {
    if (req.method === "GET") {
      const postKey = clean(new URL(req.url).searchParams.get("postKey"), 100);
      if (!validPostKey(postKey)) return json({ error: "postKey fehlt oder ist ungültig." }, 400);
      const video = await firebaseDbGet(`flowertech/videos/${postKey}`);
      return json({ ok: true, exists: video !== null, video });
    }

    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "Invalid JSON" }, 400);
    const postKey = clean(body.postKey, 100);
    if (!validPostKey(postKey)) return json({ error: "postKey fehlt oder ist ungültig." }, 400);

    const current = await firebaseDbGet(`flowertech/videos/${postKey}`) || {};
    const now = new Date().toISOString();
    let archive = {};
    if (body.archive === true && body.videoUrl) {
      archive = await archiveVideo(postKey, clean(body.videoUrl, 2000));
    }

    const allowed = [
      "topic",
      "hook",
      "caption",
      "cta",
      "scenes",
      "status",
      "videoUrl",
      "instagramMediaId",
      "instagramCreationId",
      "permalink",
      "scheduledAt",
      "publishedAt",
      "metrics",
      "error",
    ];
    const patch = {};
    for (const key of allowed) {
      if (body[key] !== undefined) patch[key] = body[key];
    }

    const video = {
      ...current,
      ...patch,
      ...archive,
      id: postKey,
      postKey,
      source: "flowertech-instagram-n8n",
      createdAt: current.createdAt || now,
      updatedAt: now,
    };
    await firebaseDbSet(`flowertech/videos/${postKey}`, video);
    return json({ ok: true, video }, current.id ? 200 : 201);
  } catch (error) {
    console.error("[flowertech-video]", error.message);
    return json({ error: error.message || "FlowerTech-Video konnte nicht gespeichert werden." }, 500);
  }
};

export const config = { path: "/.netlify/functions/flowertech-video" };
