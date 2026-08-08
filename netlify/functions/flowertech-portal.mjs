/* FlowerTech — Kundenportal-Eingang
 * ---------------------------------------------------------------------------
 * Nimmt zwei Arten von Kundeneingaben entgegen:
 *   kind = "briefing" → ausgefülltes Bedarfsformular (flowertech-formular.html)
 *   kind = "change"   → Änderungswunsch (flowertech-kunde.html)
 * und legt sie unter flowertech/submissions/<id> ab. Die Quantus-App ordnet sie
 * anhand des Freigabe-Tokens genau einem Projekt zu und erzeugt daraus
 * Projektfelder und ganz normale Quantus-Aufgaben.
 *
 * Der Token ist ein Freigabe-Geheimnis für ein Projekt, kein Zugang zu Quantus.
 * Es werden hier deshalb bewusst KEINE Projektdaten zurückgegeben.
 *
 * Sicherheit: Herkunftsprüfung, Grössenlimit, Honeypot, IP-Ratenlimit,
 * Idempotenz-Schlüssel gegen Doppeleinträge (Retries von n8n/Browser).
 * Ein optionales Shared Secret (FLOWERTECH_WEBHOOK_SECRET) erlaubt
 * server-zu-server-Aufrufe, z. B. aus n8n. Niemals im Client, niemals im Repo.
 */
import { createHash, randomUUID } from "node:crypto";
import { firebaseDbGet, firebaseDbSet } from "../lib/firebase-admin.mjs";
import {
  normalizeBriefing, briefingIsUsable,
  normalizeChangeRequest, changeRequestIsUsable,
  normalizeVisionSubmission, visionIsUsable,
  isShareToken, idempotencyKey,
} from "../../public/flowertech-workflow-core.js";

const MAX_BODY_BYTES = 64 * 1024;
const RATE_LIMIT_PER_HOUR = 12;

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
    .split(",").map((value) => value.trim()).filter(Boolean);
  return new Set([
    "https://flowertech.ch",
    "https://www.flowertech.ch",
    "https://management-xo2-pro.netlify.app",
    ...configured,
  ]);
}

function cors(req) {
  const origin = req.headers.get("Origin") || "";
  const allowed = allowedOrigins();
  return {
    "Access-Control-Allow-Origin": allowed.has(origin) ? origin : "https://flowertech.ch",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-FlowerTech-Signature",
    "Vary": "Origin",
    "Cache-Control": "no-store",
  };
}

function json(req, data, status = 200) {
  return Response.json(data, { status, headers: cors(req) });
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

// Server-zu-Server (n8n): geteiltes Geheimnis, nur aus Umgebungsvariablen.
// Fehlt die Variable, sind ausschliesslich Browser-Aufrufe von erlaubten
// Herkünften möglich.
function machineCallAuthorized(req) {
  const secret = env("FLOWERTECH_WEBHOOK_SECRET");
  if (!secret) return false;
  const provided = req.headers.get("X-FlowerTech-Signature") || "";
  if (provided.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= provided.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

export default async (req) => {
  const headers = cors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  // Ein Aufruf ist nur auf genau zwei Wegen zulässig:
  //   1. Browser-Aufruf mit einer erlaubten Herkunft (Origin-Header), oder
  //   2. Server-zu-Server mit gültiger Signatur (FLOWERTECH_WEBHOOK_SECRET).
  // Ein fehlender Origin-Header ist KEIN Freibrief: curl & Co. ohne Signatur
  // werden abgewiesen, statt die Herkunftsprüfung stillschweigend zu überspringen.
  const origin = req.headers.get("Origin") || "";
  const fromMachine = machineCallAuthorized(req);
  if (!fromMachine) {
    if (!origin) {
      return json(req, {
        error: "Aufrufe ohne Herkunft benötigen eine gültige Signatur.",
      }, 401);
    }
    if (!allowedOrigins().has(origin)) return json(req, { error: "Origin not allowed" }, 403);
  }

  if (Number(req.headers.get("Content-Length") || 0) > MAX_BODY_BYTES) {
    return json(req, { error: "Payload too large" }, 413);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json(req, { error: "Invalid JSON" }, 400);
  }

  // Honeypot: echte Menschen füllen dieses Feld nie aus.
  if (body.website || body.fax) return json(req, { ok: true }, 202);

  const kind = ["change", "vision", "briefing"].includes(body.kind) ? body.kind : "briefing";
  const token = String(body.token || "");

  // Der Vision Room auf flowertech.ch ist oeffentlich: dort gibt es keinen
  // Vorgang, an den ein Token haengen koennte. Eine Eingabe ohne Token wird
  // deshalb nur akzeptiert, wenn sie von einer erlaubten Herkunft kommt —
  // dieselbe Pruefung, die auch das Kontaktformular schuetzt. Mit Token haengt
  // die Ausarbeitung an genau der Offerte, zu der der Token gehoert.
  if (kind === "vision") {
    if (token && !isShareToken(token)) {
      return json(req, { error: "Ungültiger oder unvollständiger Link." }, 400);
    }
    if (!token && fromMachine) {
      return json(req, { error: "Vision-Eingaben ohne Token nur aus dem Browser." }, 400);
    }
  } else if (!isShareToken(token)) {
    return json(req, { error: "Ungültiger oder unvollständiger Link." }, 400);
  }

  const createdAt = new Date().toISOString();

  let payload;
  if (kind === "briefing") {
    payload = normalizeBriefing(body.payload || {}, { now: createdAt });
    payload.source = "portal";
    if (!briefingIsUsable(payload)) {
      return json(req, { error: "Bitte eine gültige E-Mail-Adresse und eine kurze Zielbeschreibung angeben." }, 400);
    }
  } else if (kind === "vision") {
    payload = normalizeVisionSubmission(body.payload || {}, { now: createdAt });
    if (!visionIsUsable(payload)) {
      return json(req, {
        error: "Bitte Idee, mindestens eine Funktion und eine gültige E-Mail angeben.",
      }, 400);
    }
  } else {
    payload = normalizeChangeRequest(
      Object.assign({}, body.payload || {}, { origin: "client" }), { now: createdAt });
    if (!changeRequestIsUsable(payload)) {
      return json(req, { error: "Bitte kurz beschreiben, was geändert werden soll." }, 400);
    }
  }

  // Idempotenz: derselbe Eingang zählt nur einmal, auch bei Wiederholungen.
  const key = String(body.idempotencyKey || idempotencyKey({ token, kind, ...payload })).slice(0, 80);
  const existing = await firebaseDbGet(`flowertech/submissionKeys/${key}`);
  if (existing) return json(req, { ok: true, duplicate: true, submissionId: existing }, 200);

  if (!fromMachine && !await enforceRateLimit(req)) {
    return json(req, { error: "Zu viele Anfragen. Bitte später erneut versuchen." }, 429);
  }

  const id = `sub_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  try {
    await firebaseDbSet(`flowertech/submissions/${id}`, {
      id, token: token || null, kind, payload, createdAt,
      via: fromMachine ? "machine" : "web",
      idempotencyKey: key,
    });
    await firebaseDbSet(`flowertech/submissionKeys/${key}`, id);
    return json(req, { ok: true, submissionId: id }, 201);
  } catch (e) {
    console.error("[flowertech-portal]", e.message);
    return json(req, { error: "Die Angaben konnten nicht gespeichert werden." }, 500);
  }
};

export const config = { path: "/.netlify/functions/flowertech-portal" };
