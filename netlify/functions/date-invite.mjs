import { getStore } from "@netlify/blobs";
import { sanitizeInvite, validateInvite, applyInvite } from "../lib/date-invite-core.mjs";

// Nimmt die von Cati gewählte Date-Einladung (Datum + Uhrzeit) entgegen und legt
// daraus serverseitig eine Aufgabe im app-data.json-Blob an — genau dort, wo die
// Quantus-App ihre Tasks erwartet (data.entities.tasks). Beim nächsten Sync der App
// taucht die Aufgabe automatisch auf.
//
// Bewusst eine eigene Function (kein direkter blob-put von außen): so braucht die
// öffentliche FlirtAi-Seite KEIN Auth-Token — der Zugriff auf den Store passiert
// hier serverseitig.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const STORE = "app-sync";
const KEY = "app-data.json"; // Standard-blobKey der Quantus-App

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: cors });
  }

  // Optionaler Schutz: nur aktiv, wenn DATE_INVITE_TOKEN gesetzt ist.
  const expected = Netlify.env.get("DATE_INVITE_TOKEN");
  if (expected) {
    const provided = req.headers.get("Authorization") || "";
    if (provided !== expected && provided !== "Bearer " + expected) {
      return Response.json({ error: "Unauthorized" }, { status: 401, headers: cors });
    }
  }

  let body;
  try { body = await req.json(); }
  catch { return Response.json({ error: "Invalid JSON" }, { status: 400, headers: cors }); }

  const invite = sanitizeInvite(body);
  const err = validateInvite(invite);
  if (err) return Response.json({ error: err }, { status: 400, headers: cors });

  try {
    const store = getStore(STORE);

    // Read-modify-write: bestehenden App-Stand laden, Task ergänzen, zurückschreiben.
    const existing = await store.get(KEY, { type: "text" });
    let current = null;
    if (existing) { try { current = JSON.parse(existing); } catch { current = null; } }

    const { data, task } = applyInvite(current, invite);
    await store.set(KEY, JSON.stringify(data));

    return Response.json(
      { ok: true, taskId: task.id, dueDate: invite.date, time: invite.time, title: task.title },
      { status: 200, headers: cors }
    );
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: cors });
  }
};

export const config = { path: "/.netlify/functions/date-invite" };
