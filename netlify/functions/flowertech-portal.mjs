/* FlowerTech — Kundenportal-Eingang
 * ---------------------------------------------------------------------------
 * Nimmt die Kundeneingaben entgegen:
 *   kind = "briefing" → ausgefülltes Bedarfsformular (flowertech-formular.html)
 *   kind = "change"   → Änderungswunsch (Kundenseite auf flowertech.ch)
 *   kind = "quote"    → Offertenanfrage (Kundenseite oder Vision Room)
 *   kind = "inquiry"  → Anfrage aus dem öffentlichen Vision Room (ohne Einladung).
 *                       Sie erzeugt in Quantus eine ANFRAGE, kein Projekt: Erst
 *                       ein abgesendeter Fragebogen legt einen Vorgang an.
 *   kind = "vision"   → Vision-Room-Beitrag zu einer bestehenden Einladung oder Offerte
 *   kind = "intake"   → ausgefüllter Fragebogen samt Vision Room (fragebogen.html,
 *                       Einladungstoken). Genau EIN Absenden = genau EIN Projekt.
 *   kind = "terms"    → AGB-Zustimmung im Kundenportal
 *   kind = "answer"   → Antwort auf eine Rückfrage im Kundenportal
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
  normalizeQuoteRequest, quoteRequestIsUsable,
  normalizeIntakeQuestions, normalizeIntakeAnswers, intakeAnswersUsable,
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

  const kind = ["change", "vision", "quote", "inquiry", "intake", "terms", "answer", "briefing"]
    .includes(body.kind) ? body.kind : "briefing";
  const token = String(body.token || "");

  // Der Vision Room auf flowertech.ch ist oeffentlich: dort gibt es keinen
  // Vorgang, an den ein Token haengen koennte. Eine Eingabe ohne Token wird
  // deshalb nur akzeptiert, wenn sie von einer erlaubten Herkunft kommt —
  // dieselbe Pruefung, die auch das Kontaktformular schuetzt. Mit Token haengt
  // die Ausarbeitung an genau der Offerte, zu der der Token gehoert.
  // Dieselbe Regel gilt fuer die Offertenanfrage aus dem Vision Room: dort
  // gibt es noch keinen Vorgang, an dem ein Token haengen koennte.
  if (kind === "vision" || kind === "quote" || kind === "inquiry") {
    if (token && !isShareToken(token)) {
      return json(req, { error: "Ungültiger oder unvollständiger Link." }, 400);
    }
    if (!token && fromMachine) {
      return json(req, { error: "Eingaben ohne Token nur aus dem Browser." }, 400);
    }
  } else if (!isShareToken(token)) {
    return json(req, { error: "Ungültiger oder unvollständiger Link." }, 400);
  }
  // Fragebogen, Zustimmung und Antwort gibt es nur zu einem konkreten Vorgang:
  // ohne gültigen Token existiert kein Kontext, dem sie gehören könnten.
  if (["intake", "terms", "answer"].includes(kind) && !isShareToken(token)) {
    return json(req, { error: "Ungültiger oder unvollständiger Link." }, 400);
  }

  const createdAt = new Date().toISOString();

  let payload;
  if (kind === "intake") {
    // Der Fragebogen wird gegen SEINE Fragen geprüft, nicht gegen ein festes
    // Schema: Der veröffentlichte Fragebogen ist die Wahrheit. Was nicht
    // gefragt wurde, kommt nicht durch — das ist die serverseitige Grenze.
    const published = await firebaseDbGet(`flowertech/intakeForms/${token}`);
    if (!published || published.status === "closed") {
      return json(req, { error: "Dieser Fragebogen ist nicht (mehr) verfügbar." }, 404);
    }
    const questions = normalizeIntakeQuestions(published.questions || []);
    if (!questions.length) {
      return json(req, { error: "Dieser Fragebogen enthält keine Fragen." }, 409);
    }
    const normalized = normalizeIntakeAnswers(questions, body.payload || {}, { now: createdAt });
    const check = intakeAnswersUsable(questions, normalized.answers);
    if (!check.usable) {
      return json(req, {
        error: "Bitte noch ergänzen: " + check.missing.join(", ") + ".",
        missing: check.missing,
      }, 400);
    }
    payload = {
      // Bewusst KEINE interne ID: Der Token ist die Zuordnung, und der
      // veröffentlichte Fragebogen soll nichts Internes tragen.
      intakeTitle: String(published.title || ""),
      answers: normalized.answers,
      submittedAt: createdAt,
      source: "kundenanfrage",
    };
  } else if (kind === "terms") {
    // Eine Zustimmung ist ein Ereignis mit Fassung und Zeitpunkt.
    const version = String(body.payload?.version || "").trim().slice(0, 40);
    if (!version) return json(req, { error: "Die Fassung fehlt." }, 400);
    if (body.payload?.accepted !== true) {
      return json(req, { error: "Bitte den Bedingungen ausdrücklich zustimmen." }, 400);
    }
    payload = { version, accepted: true, acceptedAt: createdAt };
  } else if (kind === "answer") {
    const questionId = String(body.payload?.questionId || "").trim().slice(0, 60);
    const answer = String(body.payload?.answer || "").replace(/\r\n/g, "\n").trim().slice(0, 4000);
    if (!questionId) return json(req, { error: "Die Frage fehlt." }, 400);
    if (!answer) return json(req, { error: "Bitte eine Antwort eintragen." }, 400);
    payload = { questionId, answer, answeredAt: createdAt };
  } else if (kind === "briefing") {
    payload = normalizeBriefing(body.payload || {}, { now: createdAt });
    payload.source = "portal";
    if (!briefingIsUsable(payload)) {
      return json(req, { error: "Bitte eine gültige E-Mail-Adresse und eine kurze Zielbeschreibung angeben." }, 400);
    }
  } else if (kind === "vision") {
    payload = normalizeVisionSubmission(body.payload || {}, { now: createdAt });
    if (!visionIsUsable(payload)) {
      return json(req, {
        error: "Bitte Ihre Idee beschreiben und eine gültige E-Mail angeben.",
      }, 400);
    }
  } else if (kind === "quote" || kind === "inquiry") {
    // Ohne Token kennt FlowerTech die anfragende Person noch nicht — dann ist
    // die E-Mail der einzige Rueckkanal und deshalb Pflicht. Mit Token haengt
    // die Anfrage an einem bekannten Vorgang; dort ist sie freiwillig.
    payload = normalizeQuoteRequest(
      Object.assign({}, body.payload || {}, {
        // Die Quelle ist eine Herkunftsangabe, kein Recht: sie entscheidet
        // nichts ausser der Beschriftung. Ohne Token gibt es nur den Vision Room.
        source: body.source === "vision-room" ? "vision-room" : (token ? "portal" : "vision-room"),
      }),
      { now: createdAt });
    if (!quoteRequestIsUsable(payload, { requireEmail: !token })) {
      return json(req, {
        error: token
          ? "Bitte kurz beschreiben, was Sie brauchen."
          : "Bitte kurz beschreiben, was Sie brauchen, und eine gültige E-Mail angeben.",
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
  // Ein Fragebogen gehört zu genau EINER Einladung: Der Schlüssel haengt am
  // Token, nicht am Inhalt. Ein Reload oder ein zweites Absenden liefert damit
  // dieselbe Einreichung zurück, statt einen zweiten Vorgang zu erzeugen — und
  // zwar unabhaengig davon, was der Browser als idempotencyKey mitschickt.
  const key = kind === "intake"
    ? `ft_intake_${token}`.slice(0, 80)
    : String(body.idempotencyKey
      || idempotencyKey({ token, kind, ...payload, title: payload.title || payload.need || payload.idea }))
      .slice(0, 80);
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
