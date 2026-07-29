import { createHash, randomUUID } from "node:crypto";
import { firebaseDbGet, firebaseDbSet, mutateAppData } from "../lib/firebase-admin.mjs";
import { mergeInquiryTasks } from "../lib/flowertech-core.mjs";

const MAX_BODY_BYTES = 32 * 1024;
const RATE_LIMIT_PER_HOUR = 8;

function env(name) {
  try {
    if (typeof Netlify !== "undefined" && Netlify.env) return Netlify.env.get(name);
  } catch {
    // Ignore.
  }
  return typeof process !== "undefined" ? process.env?.[name] : undefined;
}

function allowedOrigins() {
  const configured = String(env("FLOWERTECH_ALLOWED_ORIGINS") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([
    "https://flowertech.ch",
    "https://www.flowertech.ch",
    ...configured,
  ]);
}

function cors(req) {
  const origin = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins().has(origin) ? origin : "https://flowertech.ch",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
    "Cache-Control": "no-store",
  };
}

function json(req, data, status = 200) {
  return Response.json(data, { status, headers: cors(req) });
}

function clean(value, max) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
}

function validEmail(value) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) && value.length <= 160;
}

function clientHash(req) {
  const forwarded = req.headers.get("x-forwarded-for") || req.headers.get("x-nf-client-connection-ip") || "unknown";
  const ip = forwarded.split(",")[0].trim();
  return createHash("sha256").update(`${ip}:${env("FLOWERTECH_RATE_SALT") || "flowertech"}`).digest("hex").slice(0, 24);
}

async function enforceRateLimit(req) {
  const hour = new Date().toISOString().slice(0, 13).replace(/[-T:]/g, "");
  const path = `flowertech/rateLimits/${clientHash(req)}/${hour}`;
  const current = Number(await firebaseDbGet(path) || 0);
  if (current >= RATE_LIMIT_PER_HOUR) return false;
  await firebaseDbSet(path, current + 1);
  return true;
}

export default async (req) => {
  const headers = cors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  const origin = req.headers.get("Origin") || "";
  if (origin && !allowedOrigins().has(origin)) return json(req, { error: "Origin not allowed" }, 403);

  const length = Number(req.headers.get("Content-Length") || 0);
  if (length > MAX_BODY_BYTES) return json(req, { error: "Payload too large" }, 413);

  let body;
  try {
    body = await req.json();
  } catch {
    return json(req, { error: "Invalid JSON" }, 400);
  }
  if (body.website || body.fax || body.address2) return json(req, { ok: true }, 202);

  const name = clean(body.name, 120);
  const email = clean(body.email, 160).toLowerCase();
  const phone = clean(body.phone, 60);
  const company = clean(body.company, 160);
  const service = clean(body.service, 120);
  const message = clean(body.message, 4000);
  if (name.length < 2 || !validEmail(email) || message.length < 10) {
    return json(req, { error: "Name, gültige E-Mail und Nachricht sind erforderlich." }, 400);
  }
  if (!await enforceRateLimit(req)) return json(req, { error: "Zu viele Anfragen. Bitte später erneut versuchen." }, 429);

  const createdAt = new Date().toISOString();
  const id = `inq_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const inquiry = {
    id,
    name,
    email,
    phone,
    company,
    service,
    message,
    status: "new",
    source: "flowertech.ch",
    createdAt,
    updatedAt: createdAt,
  };

  try {
    await firebaseDbSet(`flowertech/inquiries/${id}`, inquiry);
    await mutateAppData("app-data.json", (current) => {
      return mergeInquiryTasks(current, [inquiry], { updatedAt: createdAt }).data;
    }, { savedBy: "flowertech-inquiry" });
    return json(req, { ok: true, inquiryId: id }, 201);
  } catch (e) {
    console.error("[flowertech-inquiry]", e.message);
    return json(req, { error: "Anfrage konnte nicht gespeichert werden." }, 500);
  }
};

export const config = { path: "/.netlify/functions/flowertech-inquiry" };
