/* ══ Quantus v3 — C2: Laufzeit-Verdrahtung der vier Routen ════════════════
 *
 * Die vier Netlify-Funktionen sollen dünn sein. Hier steht, woher ihre
 * Abhängigkeiten kommen — und was passiert, wenn eine fehlt: dann antwortet
 * die Route 503 und tut NICHTS. Kein Ersatzpfad, kein Schein-Erfolg, kein
 * „dann eben ohne".
 *
 * Absichtlich über `import()` geladen, nicht statisch:
 *   • quantus-v3-idempotency.mjs  — gehört dem Integrationsstand
 *   • quantus-v3-domain-adapter.mjs — gehört dem Fachpaket, existiert noch nicht
 * Ein statischer Import würde die Datei beim Laden sprengen; ein dynamischer
 * lässt die Route sagen, was fehlt. Genau das ist der Zustand, in dem dieses
 * Paket ausgeliefert wird: die Routen sind vorhanden, aber ohne Fachadapter
 * antworten sie 503.
 *
 * Firebase wird hier nur BENUTZT (mutateAppData, readAppDataDocument,
 * firebaseDbGetWithEtag/firebaseDbSet für den Schutzzähler) — nicht verändert.
 * ═══════════════════════════════════════════════════════════════════════ */

import { randomUUID } from "node:crypto";
import { envRead, createGooglePublicKeySource, createIdentityToolkitUserLookup } from "./quantus-v3-auth.mjs";
import { createCasRateLimiter } from "./quantus-v3-rate-limiter.mjs";
import { CORE_KEY } from "./quantus-v3-service.mjs";

/* Der Schlüsselbezug lebt über Aufrufe hinweg (Cache, Abkühlzeit). */
let keySourceSingleton = null;

async function optionalModule(spezifizierer) {
  try {
    return await import(spezifizierer);
  } catch {
    return null;
  }
}

export async function buildRuntimeDeps({ write = false, read = envRead } = {}) {
  const firebase = await optionalModule("./firebase-admin.mjs");
  const idempotenz = await optionalModule("./quantus-v3-idempotency.mjs");
  const domaene = await optionalModule("./quantus-v3-domain-adapter.mjs");

  if (!keySourceSingleton) keySourceSingleton = createGooglePublicKeySource();

  /* Die Sperrprüfung braucht ein Zugriffstoken für accounts:lookup. Es kommt
     aus einem eigenen, optionalen Anbieter — solange er fehlt, kann ein
     Nutzer-Token NICHT geprüft werden, und der Dienst antwortet 503. Ein
     ID-Token ohne Widerrufsprüfung durchzulassen wäre die Alternative, und
     die gibt es hier nicht. */
  const zugriff = await optionalModule("./quantus-v3-identity-access.mjs");
  const userLookup = zugriff?.createAccessTokenProvider
    ? createIdentityToolkitUserLookup({
        getAccessToken: zugriff.createAccessTokenProvider(),
        projectId: String(read("QUANTUS_V3_FIREBASE_PROJECT_ID") || ""),
        tenantId: String(read("QUANTUS_V3_FIREBASE_TENANT") || "") || null,
      })
    : null;

  const rateLimiter = firebase
    ? createCasRateLimiter({
        getWithEtag: firebase.firebaseDbGetWithEtag,
        set: firebase.firebaseDbSet,
      })
    : null;

  const store = firebase
    ? {
        async readSnapshot() {
          const doc = await firebase.readAppDataDocument(CORE_KEY);
          if (!doc?.exists || !doc.parsed) throw Object.assign(new Error("core_unavailable"), { code: "core_unavailable" });
          return doc.parsed;
        },
        mutate: write ? firebase.mutateAppData : undefined,
      }
    : null;

  return {
    now: () => Date.now(),
    newRequestId: () => randomUUID(),
    env: read,
    keySource: keySourceSingleton,
    userLookup,
    rateLimiter,
    store,
    idempotency: idempotenz?.prepareIdempotentCommand && idempotenz?.applyIdempotentCommand
      ? { prepare: idempotenz.prepareIdempotentCommand, apply: idempotenz.applyIdempotentCommand }
      : null,
    domain: domaene?.default || domaene || null,
  };
}

/* Die Antwortform des Dienstes → eine echte Response. */
export function toResponse(result) {
  const headers = { ...(result?.headers || {}) };
  if (result?.body == null) return new Response(null, { status: result?.status || 204, headers });
  return new Response(JSON.stringify(result.body), { status: result.status || 200, headers });
}

export default { buildRuntimeDeps, toResponse };
