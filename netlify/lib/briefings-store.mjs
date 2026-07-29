// Briefing metadata lives in Firebase RTDB; binaries live in Firebase Storage.
import {
  firebaseDbGet,
  firebaseDbRemove,
  firebaseDbSet,
  firebaseStorageDelete,
  firebaseStorageDownload,
  firebaseStorageUpload,
} from "./firebase-admin.mjs";

export const MAX_ITEMS = 200;
export const BRIEFINGS_PATH = "briefings/items";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match",
  "Access-Control-Expose-Headers": "ETag, Content-Disposition",
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json", ...extraHeaders },
  });
}

function env(name) {
  try {
    if (typeof Netlify !== "undefined" && Netlify.env) return Netlify.env.get(name);
  } catch {
    // Ignore and use process.env for local tests.
  }
  return typeof process !== "undefined" ? process.env?.[name] : undefined;
}

export function unauthorized(req) {
  const expected = env("SYNC_AUTH_TOKEN");
  if (!expected) return null;
  const provided = req.headers.get("Authorization") || "";
  if (provided === expected || provided === "Bearer " + expected) return null;
  return json({ error: "Unauthorized" }, 401);
}

// Kept as a compatibility shim for existing callers.
export function getBriefingStore() {
  return { provider: "firebase" };
}

function byteLengthOf(data) {
  if (data == null) return 0;
  if (typeof data.byteLength === "number") return data.byteLength;
  if (typeof data.length === "number") return data.length;
  return 0;
}

function safeFilename(value) {
  return String(value || "briefing.pdf")
    .replace(/[\u0000-\u001f/\\]+/g, "_")
    .slice(0, 120);
}

export async function listBriefings() {
  const value = await firebaseDbGet(BRIEFINGS_PATH) || {};
  return Object.values(value)
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

export async function getBriefing(id) {
  return firebaseDbGet(`${BRIEFINGS_PATH}/${id}`);
}

export async function deleteBriefing(id) {
  const meta = await getBriefing(id);
  if (!meta) return false;
  await firebaseDbRemove(`${BRIEFINGS_PATH}/${id}`);
  if (meta.storagePath) {
    try {
      await firebaseStorageDelete(meta.storagePath);
    } catch {
      // Metadata deletion is authoritative; orphan cleanup can be retried later.
    }
  }
  return true;
}

export async function readBriefingBinary(meta) {
  if (!meta?.storagePath) return null;
  return firebaseStorageDownload(meta.storagePath);
}

export async function storeBriefing(_store, { data, title, date, filename, contentType }) {
  const now = new Date();
  const id = "b_" + now.getTime().toString(36) + "_" + Math.random().toString(36).slice(2, 8);

  date = String(date || now.toISOString().slice(0, 10)).slice(0, 40);
  title = String(title || ("Briefing " + date)).slice(0, 200);
  contentType = contentType || "application/pdf";
  if (!filename) filename = title.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) + ".pdf";
  filename = safeFilename(filename);

  const storagePath = `briefings/${id}/${filename}`;
  const buffer = Buffer.isBuffer(data)
    ? data
    : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
  const meta = {
    id,
    title,
    date,
    filename,
    contentType,
    size: byteLengthOf(buffer),
    createdAt: now.toISOString(),
    storagePath,
  };

  await firebaseStorageUpload(storagePath, buffer, {
    contentType,
    metadata: { briefingId: id, createdAt: meta.createdAt },
  });
  await firebaseDbSet(`${BRIEFINGS_PATH}/${id}`, meta);

  const items = await listBriefings();
  for (const stale of items.slice(MAX_ITEMS)) {
    await deleteBriefing(stale.id);
  }
  return meta;
}
