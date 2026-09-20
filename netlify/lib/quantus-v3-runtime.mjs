/* ══ Quantus v3 — C3b: die tatsächliche Laufzeitverdrahtung ═══════════════
 *
 * Die vier Netlify-Funktionen bleiben Hüllen. Hier steht, WOHER ihre
 * Abhängigkeiten kommen — und was passiert, wenn eine fehlt: 503, und nichts
 * geschieht. Kein Ersatzpfad, kein Testmodell im Betrieb, kein Rückfall auf
 * „irgendein Objekt, das ungefähr passt".
 *
 * WAS SICH GEGENÜBER DER ERSTEN FASSUNG ÄNDERT (Review 1a8d08c)
 * -------------------------------------------------------------
 * 1. ECHTER CAS. `store` benutzt `readAppDataDocument` und `mutateAppData`
 *    aus firebase-admin — und prüft deren Schnittstelle, statt sie
 *    anzunehmen. Der Schlüssel ist festgenagelt: ausschliesslich
 *    `app-data.json`. Ein anderer Schlüssel wird abgewiesen, nicht
 *    „durchgereicht".
 * 2. KEIN ROHMODUL ALS FACHADAPTER. Früher galt `domaene?.default || domaene`
 *    als Adapter — ein Modul, das zufällig die richtigen Namen trägt, wäre
 *    damit zum Rechtegeber geworden. Jetzt gibt es genau einen Port: die
 *    benannte Fabrik `createQuantusV3DomainAdapter`, die mit
 *    serverseitiger Policy und der E1-Bindung aufgerufen wird. Fehlt sie oder
 *    liefert sie nicht alle Methoden: 503.
 * 3. WIDERRUFSPRÜFUNG ODER NICHTS. Der Lookup wird nur verdrahtet, wenn es
 *    einen scope-gebundenen Zugriffstoken-Weg gibt (siehe
 *    quantus-v3-identity-access.mjs). Sonst bleibt `userLookup` null, und C1
 *    antwortet 503 — ein ID-Token ohne Widerrufsprüfung gilt nie.
 * 4. ZEIT. `now` ist die echte Uhr. Die Prüfzeit holt der Dienst bei JEDEM
 *    Versuch frisch; die Dokumentzeit (im Beleg) steht getrennt davon fest.
 *    Diese Datei liefert nur die Uhr, keine gemerkte Zeit.
 *
 * Firebase wird hier BENUTZT, nicht verändert. Die Zugangslogik bleibt in
 * firebase-admin.mjs; C3b legt keine zweite an.
 * ═══════════════════════════════════════════════════════════════════════ */

import { randomUUID } from "node:crypto";
import { envRead, createGooglePublicKeySource, createIdentityToolkitUserLookup } from "./quantus-v3-auth.mjs";
import { createCasRateLimiter } from "./quantus-v3-rate-limiter.mjs";
import { CORE_KEY } from "./quantus-v3-service.mjs";
import {
  createAccessTokenProvider, identityAccessAvailability, resetIdentityAccessCacheForTests,
} from "./quantus-v3-identity-access.mjs";

/* Der Fachadapter-Port. C3a liefert genau diese Fabrik; C2 verlangt genau
   diese Methoden. Beides steht hier zusammen, damit niemand raten muss. */
export const DOMAIN_FACTORY_EXPORT = "createQuantusV3DomainAdapter";
/* Die EINZIGEN Gründe, die ein Fachadapter-Port nach aussen nennen darf.
   BEFUND (Release-Review): ein Grund, der aus einem fremden Fehler stammt,
   wäre ein Kanal für fremden Text in unsere Diagnose. Was nicht auf dieser
   Liste steht, wird zu `domain_factory_failed` — die Fabrik hat nicht
   geliefert, und mehr sagt niemand. */
export const DOMAIN_FACTORY_REASONS = Object.freeze([
  "domain_factory_missing",      // keine benannte Fabrik verdrahtet
  "domain_factory_failed",       // die Fabrik hat nicht geliefert (auch: sie warf)
  "domain_adapter_incomplete",   // geliefert, aber nicht alle Methoden
]);
const ERLAUBTE_DOMAIN_GRUENDE = new Set(DOMAIN_FACTORY_REASONS);

/* Kein fremder Text, keine fremde Kennung — nur die Liste oben. */
function domainGrund(kandidat) {
  return ERLAUBTE_DOMAIN_GRUENDE.has(kandidat) ? kandidat : "domain_factory_failed";
}

export const DOMAIN_ADAPTER_METHODS = Object.freeze([
  "resolveTarget",        // Ressource + Anker aus dem autoritativen Bestand
  "assertActiveBinding",  // aktive Leitungs-Lease bzw. Auftragszuweisung (E1)
  "applyVerb",            // die Wirkung, synchron, im CAS-Mutator
  "loadObject",           // Scope-Objekt für den Leseweg
  "listPage",             // eine Seite einer benannten Abfrage
]);

/* Der Schlüsselbezug lebt über Aufrufe hinweg (Cache, Abkühlzeit). */
let keySourceSingleton = null;

async function optionalModule(spezifizierer) {
  try {
    return await import(spezifizierer);
  } catch {
    return null;
  }
}

/* Hat das Modul die Schnittstelle, die wir annehmen? Geprüft, nicht gehofft. */
function hatFunktionen(modul, namen) {
  return Boolean(modul) && namen.every((name) => typeof modul[name] === "function");
}

/*
 * Der Speicher: echter CAS auf dem Kerndatensatz.
 *
 * `readSnapshot` gibt den GEPARSTEN Kern zurück oder scheitert — ein leerer
 * oder unlesbarer Kern ist ein Restore-Fall, keine leere Arbeitsgrundlage.
 * `mutate` reicht ausschliesslich `app-data.json` weiter.
 */
export function createCoreStore(firebase, { write = false } = {}) {
  if (!hatFunktionen(firebase, ["readAppDataDocument"])) return null;
  if (write && !hatFunktionen(firebase, ["mutateAppData"])) return null;

  const store = {
    async readSnapshot() {
      const doc = await firebase.readAppDataDocument(CORE_KEY);
      if (!doc || doc.exists !== true || !doc.parsed || typeof doc.parsed !== "object") {
        throw Object.assign(new Error("core_unavailable"), { code: "core_unavailable", status: 503 });
      }
      return doc.parsed;
    },
  };
  if (write) {
    store.mutate = async (key, mutator, opts = {}) => {
      // Festgenagelt: dieser Weg schreibt NUR den Kerndatensatz. Ein anderer
      // Schlüssel wäre ein Seitenweg an der Schlüsselpolitik vorbei.
      if (key !== CORE_KEY) {
        throw Object.assign(new Error("key_denied"), { code: "key_denied", status: 403 });
      }
      if (typeof mutator !== "function") {
        throw Object.assign(new Error("mutation_invalid"), { code: "mutation_invalid", status: 500 });
      }
      return firebase.mutateAppData(CORE_KEY, mutator, { savedBy: opts.savedBy || "quantus-v3" });
    };
  }
  return store;
}

/*
 * Der Fachadapter: NUR über die benannte Fabrik, mit serverseitiger Policy
 * und der E1-Bindung. Was sie liefert, wird auf Vollständigkeit geprüft.
 */
export function buildDomainAdapter({ factory, policy, now }) {
  if (typeof factory !== "function") return { ok: false, reason: domainGrund("domain_factory_missing") };
  let adapter = null;
  try {
    adapter = factory({
      policyVersion: policy.policyVersion,
      tenantId: policy.tenantId,
      mode: policy.mode,
      now,
    });
  } catch {
    // Der Fehler der Fabrik wird NICHT gelesen: keine Nachricht, kein Code,
    // kein `cause`. Er könnte alles enthalten.
    return { ok: false, reason: domainGrund("domain_factory_failed") };
  }
  if (!hatFunktionen(adapter, DOMAIN_ADAPTER_METHODS)) return { ok: false, reason: domainGrund("domain_adapter_incomplete") };
  return { ok: true, adapter };
}

/*
 * Die Abhängigkeiten einer Route.
 *
 * Die Einspeisepunkte (`firebaseModule`, `idempotencyModule`, `domainFactory`,
 * `obtainAccessToken`, `fetchImpl`, `now`) sind der Übergangsvertrag: Tests
 * und — bis C3a liegt — die Integration können sie setzen, ohne dass hier
 * irgendwo ein Ersatzmodell einzieht. Ohne sie wird das echte Modul geladen.
 */
export async function buildRuntimeDeps({
  write = false,
  read = envRead,
  firebaseModule = null,
  idempotencyModule = null,
  domainFactory = null,
  obtainAccessToken = null,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const firebase = firebaseModule || await optionalModule("./firebase-admin.mjs");
  const idempotenz = idempotencyModule || await optionalModule("./quantus-v3-idempotency.mjs");
  const domaeneModul = domainFactory ? null : await optionalModule("./quantus-v3-domain-adapter.mjs");

  if (!keySourceSingleton) keySourceSingleton = createGooglePublicKeySource({ fetchImpl, now });

  /* ── Widerrufsprüfung: nur mit scope-gebundenem Token ────────────────
   *
   * BEFUND (Review a422670): Der Tokencache lag im Abschluss des Providers.
   * Die Handler bauen ihre Abhängigkeiten aber PRO REQUEST — der Cache war
   * damit je Aufruf neu, und zwei gleichzeitige Anfragen holten zwei Token.
   * Der Speicher liegt jetzt im Identity-Access-Modul, gebunden an Projekt,
   * Mandant, Scope, Quelle und die aktuelle Zugangskonfiguration. Hier wird
   * nichts gecacht — und der Widerrufslookup selbst NIE. */
  const zugang = identityAccessAvailability({ read, firebaseModule: firebase, obtainAccessToken });
  const provider = zugang.available
    ? createAccessTokenProvider({ read, fetchImpl, now, obtainAccessToken, firebaseModule: firebase })
    : null;
  const userLookup = provider
    ? createIdentityToolkitUserLookup({
        fetchImpl,
        getAccessToken: provider,
        projectId: provider.projectId,
        tenantId: provider.tenantId,
      })
    : null;

  /* ── Ratenzähler: CAS auf dem gemeinsamen Schutzknoten ─────────────── */
  const rateLimiter = hatFunktionen(firebase, ["firebaseDbGetWithEtag", "firebaseDbSet"])
    ? createCasRateLimiter({
        getWithEtag: firebase.firebaseDbGetWithEtag,
        set: firebase.firebaseDbSet,
        now,
      })
    : null;

  /* ── Fachadapter über die benannte Fabrik ──────────────────────────── */
  const fabrik = domainFactory || (typeof domaeneModul?.[DOMAIN_FACTORY_EXPORT] === "function"
    ? domaeneModul[DOMAIN_FACTORY_EXPORT]
    : null);
  const domaene = buildDomainAdapter({
    factory: fabrik,
    policy: {
      policyVersion: String(read("QUANTUS_V3_POLICY_VERSION") || ""),
      tenantId: String(read("QUANTUS_V3_FIREBASE_TENANT") || "") || null,
      mode: String(read("QUANTUS_V3_MODE") || "dry_run"),
    },
    now,
  });

  return {
    now,
    newRequestId: () => randomUUID(),
    env: read,
    keySource: keySourceSingleton,
    userLookup,
    rateLimiter,
    store: createCoreStore(firebase, { write }),
    idempotency: hatFunktionen(idempotenz, ["prepareIdempotentCommand", "applyIdempotentCommand"])
      ? { prepare: idempotenz.prepareIdempotentCommand, apply: idempotenz.applyIdempotentCommand }
      : null,
    domain: domaene.ok ? domaene.adapter : null,
    /* Diagnose — Namen und Gründe, nie Werte. Was hier `false` ist, wird zu
       einer 503 des Dienstes; das macht eine Fehlersuche im Betrieb möglich,
       ohne irgendetwas offenzulegen. */
    wiring: Object.freeze({
      firebase: Boolean(firebase),
      store: Boolean(createCoreStore(firebase, { write })),
      idempotency: hatFunktionen(idempotenz, ["prepareIdempotentCommand", "applyIdempotentCommand"]),
      domain: domaene.ok,
      domainReason: domaene.ok ? null : domainGrund(domaene.reason),
      rateLimiter: Boolean(rateLimiter),
      identityAccess: zugang.available,
      identityAccessReason: zugang.available ? null : zugang.reason,
      identityAccessSource: provider ? provider.source : null,
    }),
  };
}

/* Die Antwortform des Dienstes → eine echte Response. */
export function toResponse(result) {
  const headers = { ...(result?.headers || {}) };
  if (result?.body == null) return new Response(null, { status: result?.status || 204, headers });
  return new Response(JSON.stringify(result.body), { status: result.status || 200, headers });
}

/* Nur für Tests: die geteilten Speicher zurücksetzen, damit ein Lauf nicht
   den Cache des vorigen erbt. Beides liegt bewusst im MODUL — der
   Schlüsselbezug und der Zugriffstoken müssen über Requests hinweg wirken,
   weil die Handler ihre Abhängigkeiten pro Request bauen. Genau deshalb
   braucht ein Test einen ausdrücklichen Schnitt. */
export function resetRuntimeCachesForTests() {
  keySourceSingleton = null;
  resetIdentityAccessCacheForTests();
}

export default {
  buildRuntimeDeps, toResponse, createCoreStore, buildDomainAdapter,
  DOMAIN_FACTORY_EXPORT, DOMAIN_ADAPTER_METHODS, DOMAIN_FACTORY_REASONS,
};
