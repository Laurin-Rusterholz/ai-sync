/* FlowerTech — Dateien aus dem Vision Room
 * ---------------------------------------------------------------------------
 * Die Kundschaft laedt Logos, Bilder, Designentwuerfe und andere Referenzen
 * direkt im Vision Room des Fragebogens hoch. Diese Funktion nimmt EINE Datei
 * pro Aufruf als Roh-Bytes entgegen (kein Base64, kein Multipart), legt sie in
 * Firebase Storage ab und schreibt ausschliesslich Metadaten in die RTDB:
 *
 *   PUT    /.netlify/functions/flowertech-upload?e=<token>
 *          Body: die Datei · Content-Type: image/png|image/jpeg|image/webp|application/pdf
 *          X-FlowerTech-Filename: encodeURIComponent(originalname)
 *          → 201 { ok, file: { id, name, type, size } }
 *   DELETE /.netlify/functions/flowertech-upload?e=<token>&id=<fileId>
 *          → 200 { ok }   (nur, solange die Datei noch nicht abgesendet ist)
 *
 * Ablage:
 *   Storage  flowertech/intakes/<token>/<fileId>.<ext>
 *   RTDB     flowertech/intakeUploads/<token>/<fileId>
 *            { id, name, type, size, storagePath, uploadedAt, status }
 *
 * Grenzen (INTAKE_UPLOAD_LIMITS im Kern, gespiegelt auf der Seite):
 *   5 MB pro Datei, 10 Dateien pro Einladung, PNG/JPG/WEBP/PDF. Der Typ wird
 *   aus den ersten Bytes gelesen, nicht aus dem Header. HEIC wird mit einer
 *   verstaendlichen Meldung abgelehnt — es gibt keine Umwandlung.
 *
 * Sicherheit: dieselbe Herkunftspruefung wie der Eingang (Origin-Allowlist),
 * nur mit gueltigem, OFFENEM Fragebogen-Token, IP-Ratenlimit, keine
 * Rueckgabe von Projektdaten, kein Pfad aus dem Aufruf. Der Token ist die
 * Zuordnung — Datei → Fragebogen → Projekt/Anfrage/Offerte.
 *
 * `createHandler()` nimmt die Firebase-Zugriffe als Abhaengigkeit entgegen,
 * damit der Test die Funktion ohne Netz wirklich ausfuehren kann.
 */
import { createHash, randomUUID } from "node:crypto";
import * as admin from "../lib/firebase-admin.mjs";
import {
  INTAKE_UPLOAD_LIMITS, INTAKE_UPLOAD_TYPES, INTAKE_UPLOAD_MESSAGES,
  sniffUploadType, intakeFileName, isIntakeFileId, isShareToken,
} from "../../public/flowertech-workflow-core.js";

const RATE_LIMIT_PER_HOUR = 60;

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
  return {
    "Access-Control-Allow-Origin": allowedOrigins().has(origin) ? origin : "https://flowertech.ch",
    "Access-Control-Allow-Methods": "PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-FlowerTech-Filename",
    "Vary": "Origin",
    "Cache-Control": "no-store",
  };
}

function clientHash(req) {
  const forwarded = req.headers.get("x-forwarded-for") || req.headers.get("x-nf-client-connection-ip") || "unknown";
  const ip = forwarded.split(",")[0].trim();
  return createHash("sha256").update(`${ip}:${env("FLOWERTECH_RATE_SALT") || "flowertech"}`).digest("hex").slice(0, 24);
}

export function createHandler(deps = {}) {
  const db = {
    get: deps.dbGet || admin.firebaseDbGet,
    set: deps.dbSet || admin.firebaseDbSet,
    remove: deps.dbRemove || admin.firebaseDbRemove,
  };
  const storage = {
    upload: deps.storageUpload || admin.firebaseStorageUpload,
    remove: deps.storageDelete || admin.firebaseStorageDelete,
  };
  const now = deps.now || (() => new Date().toISOString());
  const newId = deps.newId || (() => "f_" + randomUUID().replace(/-/g, "").slice(0, 20));

  const json = (req, data, status = 200) => Response.json(data, { status, headers: cors(req) });

  async function rateLimited(req) {
    const hour = now().slice(0, 13).replace(/[-T:]/g, "");
    const path = `flowertech/rateLimits/${clientHash(req)}/upload_${hour}`;
    const current = Number(await db.get(path) || 0);
    if (current >= RATE_LIMIT_PER_HOUR) return true;
    await db.set(path, current + 1);
    return false;
  }

  return async (req) => {
    const headers = cors(req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (req.method !== "PUT" && req.method !== "DELETE") return json(req, { error: "Method not allowed" }, 405);

    // Nur aus dem Browser, nur von erlaubten Herkuenften — wie der Eingang.
    const origin = req.headers.get("Origin") || "";
    if (!origin) return json(req, { error: "Aufrufe ohne Herkunft sind nicht möglich." }, 401);
    if (!allowedOrigins().has(origin)) return json(req, { error: "Origin not allowed" }, 403);

    const url = new URL(req.url);
    const token = String(url.searchParams.get("e") || "");
    if (!isShareToken(token)) return json(req, { error: "Ungültiger oder unvollständiger Link." }, 400);

    // Dateien gibt es nur zu einem offenen Fragebogen: ohne veroeffentlichten,
    // offenen Bogen existiert kein Vorgang, dem sie gehoeren koennten.
    const published = await db.get(`flowertech/intakeForms/${token}`);
    if (!published || published.status !== "open") {
      return json(req, { error: "Dieser Fragebogen ist nicht (mehr) verfügbar." }, 404);
    }

    const base = `flowertech/intakeUploads/${token}`;

    if (req.method === "DELETE") {
      const id = String(url.searchParams.get("id") || "");
      if (!isIntakeFileId(id)) return json(req, { error: "Die Datei ist unbekannt." }, 400);
      const entry = await db.get(`${base}/${id}`);
      if (!entry) return json(req, { ok: true, gone: true }, 200);
      if (entry.status === "submitted") {
        return json(req, { error: "Diese Datei wurde bereits mit dem Fragebogen abgesendet." }, 409);
      }
      try {
        if (entry.storagePath) await storage.remove(String(entry.storagePath));
        await db.remove(`${base}/${id}`);
        return json(req, { ok: true }, 200);
      } catch (e) {
        console.error("[flowertech-upload]", e.message);
        return json(req, { error: "Die Datei konnte nicht entfernt werden." }, 500);
      }
    }

    // PUT — die Grenzen zuerst, bevor ein Byte gelesen wird.
    const declared = Number(req.headers.get("Content-Length") || 0);
    if (declared > INTAKE_UPLOAD_LIMITS.maxBytes) return json(req, { error: INTAKE_UPLOAD_MESSAGES.size }, 413);

    const existing = await db.get(base) || {};
    const count = Object.keys(existing).filter((k) => existing[k] && existing[k].status !== "removed").length;
    if (count >= INTAKE_UPLOAD_LIMITS.maxFiles) return json(req, { error: INTAKE_UPLOAD_MESSAGES.count }, 409);

    if (await rateLimited(req)) {
      return json(req, { error: "Zu viele Uploads. Bitte in einer Stunde erneut versuchen." }, 429);
    }

    let bytes;
    try {
      bytes = Buffer.from(await req.arrayBuffer());
    } catch {
      return json(req, { error: "Die Datei konnte nicht gelesen werden." }, 400);
    }
    if (!bytes.length) return json(req, { error: INTAKE_UPLOAD_MESSAGES.empty }, 400);
    if (bytes.length > INTAKE_UPLOAD_LIMITS.maxBytes) return json(req, { error: INTAKE_UPLOAD_MESSAGES.size }, 413);

    // Der Typ kommt aus den Bytes. Der Header darf ihn hoechstens bestaetigen.
    const type = sniffUploadType(bytes);
    if (type === "image/heic") return json(req, { error: INTAKE_UPLOAD_MESSAGES.heic }, 415);
    if (!INTAKE_UPLOAD_TYPES[type]) return json(req, { error: INTAKE_UPLOAD_MESSAGES.type }, 415);

    let rawName = "";
    try { rawName = decodeURIComponent(req.headers.get("X-FlowerTech-Filename") || ""); } catch { rawName = ""; }
    const name = intakeFileName(rawName, type);
    const id = newId();
    const storagePath = `flowertech/intakes/${token}/${id}.${INTAKE_UPLOAD_TYPES[type]}`;
    const uploadedAt = now();

    try {
      await storage.upload(storagePath, bytes, {
        contentType: type,
        metadata: { token, fileId: id, originalName: encodeURIComponent(name), source: "vision-room" },
      });
      await db.set(`${base}/${id}`, {
        id, name, type, size: bytes.length, storagePath, uploadedAt, status: "uploaded",
      });
    } catch (e) {
      console.error("[flowertech-upload]", e.message);
      return json(req, { error: "Die Datei konnte nicht gespeichert werden. Bitte versuchen Sie es gleich nochmals." }, 500);
    }
    return json(req, { ok: true, file: { id, name, type, size: bytes.length } }, 201);
  };
}

export default createHandler();

export const config = { path: "/.netlify/functions/flowertech-upload" };
