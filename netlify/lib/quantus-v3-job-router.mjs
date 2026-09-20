/* ══ Quantus v3 — Paket G1: versionierter wirtschaftlicher Job-Router ═══════
 *
 * Reine, deterministische Planfunktion nach Konzept 12.1/12.2:
 *
 *     planJobRoute({ policy, facts, now }) → Plan
 *
 * Sie ruft KEINEN Provider, sendet nichts, mutiert nichts, kennt keine Uhr,
 * keinen Zufall und kein HTTP. Ein Plan ist KEINE Ausfuehrungsfreigabe und
 * kein Kostenanspruch: E1 reserviert spaeter die tatsaechlichen Kosten
 * atomar; ein positiver Budgetvergleich hier ist nur ein Vergleich.
 *
 * Eingaben:
 *   policy  versionierte Backend-Policy (job-router-policy/3). Nur sie sagt,
 *           welche Modelle es gibt (die Kennungen kommen aus der Backend-
 *           Konfiguration — hier wird keine Modell-ID und kein Preis
 *           erfunden oder hartkodiert), wofuer sie getestet/freigegeben
 *           sind, welche Kontextgrenzen gelten und in welcher Einheit
 *           gerechnet wird.
 *   facts   ausdruecklich SERVERBESTAETIGTE Auftrags-, Kontext-, Faehigkeits-,
 *           Budget- und Messfakten (job-router-facts/3) mit Attestierung.
 *           Freitext darin (goal, description) ist Datum, nie Regel: der
 *           Router liest daraus keine Policy, keine Freigabe, keine
 *           Klassifikation. Die Aufgabenklasse ist ein bestaetigtes Faktum,
 *           das deterministischer Code vorher bestimmt hat.
 *   now     vertrauenswuerdiger Zeitpunkt (ms), von aussen gestellt.
 *
 * Entscheidungsregeln (12.2):
 *   deterministic  Fristen, Dubletten, Berechtigungen, Zustandspruefung →
 *                  Code, kein Modell.
 *   short_context  kurzer kontextnaher Schritt / Ruecklaufkontrolle →
 *                  OpenAI-Leitung (self). Kein automatischer Fallback auf
 *                  ein anderes Modell, wenn Zugriff, Budget oder Messung
 *                  fehlen: dann blocked.
 *   bounded_text / bounded_code / bounded_file
 *                  abgegrenzte Text-/Code-/Dateiarbeit → Claude, wenn
 *                  verfuegbar (getestet, freigegeben, Daten freigegeben,
 *                  Kontext passt) UND — gemessen — Uebergabe + Ausfuehrung +
 *                  Pruefung guenstiger als Selbstausfuehrung, oder die
 *                  Leitung die Faehigkeit nachweislich nicht hat. Sonst
 *                  Selbstausfuehrung, sonst blocked. Codejobs nur in
 *                  isolierter Testumgebung ohne Produktionsgeheimnisse.
 *   ocr / audio / structured_extraction
 *                  → Gemini, wenn getestet und freigegeben; sonst blocked
 *                  mit konkretem Faehigkeitsblocker.
 *   risky_unclear  → begrenzte Zweitpruefung; bei ungeklaerter Befugnis
 *                  ENTWURF — hohe Konfidenz oder Mehrheit aendern das nicht.
 *
 * Ohne Messdaten keine Delegation "nach Bauchgefuehl"; ohne Budgetfaktum
 * kein Modellweg; fehlende Faehigkeit ist ein Blocker, keine geratene Route.
 * Jeder Kandidat wird VOR dem Ranking auf freigegebene Daten-IDs und
 * Werkzeuge, geprueftes Modell, Kontext-/Tokenlimit und Budget inkl.
 * Uebergabe und Pruefung geprueft.
 *
 * Vertrag 3.1 (nach der G1-Abnahme, fuenf Gegenbeispiele):
 *   1. Kosteneinheiten werden nie still gleichgesetzt: budget.unit und die
 *      Einheit jeder Messung muessen policy.costUnit entsprechen. Eine
 *      Umrechnung ist Sache des attestierenden Backends, nicht des Routers.
 *   2. Eine fehlende oder ungueltige Selbstmessung ist keine nachgewiesene
 *      Faehigkeitsluecke und kein Kostenbeweis. Delegation ohne Vergleich
 *      gibt es nur bei nachgewiesener Unfaehigkeit der Leitung
 *      (leadershipCanDo:false, Kontextgrenze gemessen ueberschritten,
 *      gemessene Selbstkosten ausserhalb des Budgets); sonst blocked.
 *   3. Frische ist ein begrenzter, versionierter Vertrag: attestation.at und
 *      jede measuredAt liegen nicht in der Zukunft, nicht nach der
 *      Attestierung und nicht aelter als policy.freshness erlaubt. Jede
 *      Messung ist an Modellschluessel, Policy-Version und Quellversion
 *      gebunden; passt eines nicht, ist sie wirtschaftlich ungueltig.
 *   4. Die Risikoschranke gilt unabhaengig von der Klassifikation: flagged
 *      ohne bestaetigte Befugnis ist Entwurf, flagged mit einer Nicht-
 *      Risikoklasse ist ein Widerspruch und blocked. Konfidenz und
 *      Mehrheiten aendern daran nichts.
 *   5. Die Form wird vollstaendig geprueft (Werkzeuglisten, Ruecklaufformat,
 *      Pruefkriterien, endliche Zahlen), bevor irgendetwas gerechnet wird.
 *      Ungueltige Form ist eine strukturierte Ablehnung, nie eine Ausnahme.
 * ═════════════════════════════════════════════════════════════════════════ */
import { canonicalJson, stringFingerprint, EXECUTORS } from "./assistant-schema.mjs";
import { ROUTING_SCHEMA } from "./assistant-buchhaltung.mjs";

export const ROUTER_VERSION = "job-router/3.1.0";
export const ROUTER_POLICY_SCHEMA = "job-router-policy/3.1";
export const ROUTER_FACTS_SCHEMA = "job-router-facts/3.1";
/* Obergrenzen des Frischevertrags: die Policy darf kuerzere Fristen setzen, keine laengeren. */
export const FRESHNESS_LIMITS = Object.freeze({ attestationMaxAgeMs: 7 * 24 * 3600 * 1000, measurementMaxAgeMs: 30 * 24 * 3600 * 1000 });
export const JOB_MANIFEST_SCHEMA = "job-manifest/3";

export const PROVIDERS = Object.freeze(["openai", "claude", "gemini"]);
export const LEITUNG = "openai";

export const TASK_CLASSES = Object.freeze({
  deterministic:         Object.freeze({ capability: null,                    preferred: [] }),
  short_context:         Object.freeze({ capability: "leadership",            preferred: ["openai"] }),
  bounded_text:          Object.freeze({ capability: "text_work",             preferred: ["claude"] }),
  bounded_code:          Object.freeze({ capability: "code_work",             preferred: ["claude"], sandbox: true }),
  bounded_file:          Object.freeze({ capability: "file_work",             preferred: ["claude"] }),
  ocr:                   Object.freeze({ capability: "ocr",                   preferred: ["gemini"] }),
  audio:                 Object.freeze({ capability: "audio",                 preferred: ["gemini"] }),
  structured_extraction: Object.freeze({ capability: "structured_extraction", preferred: ["gemini"] }),
  risky_unclear:         Object.freeze({ capability: "second_opinion",        preferred: ["claude", "gemini"] }),
});
export const ROUTE_KINDS = Object.freeze(["deterministic", "self", "delegate", "second_opinion", "draft", "blocked"]);
export const DETERMINISTIC_KINDS = Object.freeze(["deadline_check", "duplicate_check", "permission_check", "state_check"]);

function istKarte(v) { return v !== null && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v)); }
function istIso(s) { return typeof s === "string" && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s; }
function istZahl(v) { return typeof v === "number" && Number.isFinite(v) && v >= 0; }
function istId(v) { return typeof v === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(v); }
function idListe(v) { return Array.isArray(v) && v.every(istId) && new Set(v).size === v.length; }
function istText(v, max) { return typeof v === "string" && v.trim().length > 0 && v.length <= max; }
function istEinheit(v) { return typeof v === "string" && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(v); }
function istGanz(v, min, max) { return Number.isInteger(v) && v >= min && v <= max; }
function istVersion(v) { return typeof v === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(v); }
/* Messnachweis: Einheit, Zeitpunkt, Modellschluessel, Policy- und Quellversion — die Bindung wird spaeter geprueft. */
function messForm(m) { return istKarte(m) && istEinheit(m.unit) && istIso(m.measuredAt) && istId(m.modelKey) && istVersion(m.policyVersion) && istGanz(m.sourceVersion, 1, Number.MAX_SAFE_INTEGER); }

/* ── Policy ─────────────────────────────────────────────────────────────
 * Vollstaendig oder unbrauchbar. Modell-Eintraege tragen Provider, eine
 * Kennung aus der Backend-Konfiguration (opak), Test-/Freigabestand je
 * Faehigkeit, Kontextgrenze und optional gemessene Uebergabe-/Pruefkosten. */
export function validateRouterPolicy(policy) {
  const f = [];
  const p = istKarte(policy) ? policy : null;
  if (!p) return { ok: false, errors: ["POLICY_MISSING"] };
  if (p.schema !== ROUTER_POLICY_SCHEMA) f.push("POLICY_SCHEMA");
  if (!istVersion(p.version)) f.push("POLICY_VERSION");
  if (typeof p.tenant !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(p.tenant)) f.push("POLICY_TENANT");
  if (!istEinheit(p.costUnit)) f.push("POLICY_COST_UNIT");
  const fr = p.freshness;
  if (!istKarte(fr) || !istGanz(fr.attestationMaxAgeMs, 1, FRESHNESS_LIMITS.attestationMaxAgeMs) || !istGanz(fr.measurementMaxAgeMs, 1, FRESHNESS_LIMITS.measurementMaxAgeMs)) f.push("POLICY_FRESHNESS");
  if (!istKarte(p.models) || !Object.keys(p.models).length) f.push("POLICY_MODELS");
  else {
    for (const [key, m] of Object.entries(p.models)) {
      if (!istId(key) || !istKarte(m)) { f.push("POLICY_MODEL_SHAPE:" + key); continue; }
      if (!PROVIDERS.includes(m.provider)) f.push("POLICY_MODEL_PROVIDER:" + key);
      if (typeof m.modelId !== "string" || !m.modelId.trim()) f.push("POLICY_MODEL_ID:" + key);
      if (typeof m.tested !== "boolean") f.push("POLICY_MODEL_TESTED:" + key);
      if (!Array.isArray(m.approvedFor) || !m.approvedFor.every((c) => typeof c === "string" && c)) f.push("POLICY_MODEL_APPROVED_FOR:" + key);
      if (!istGanz(m.contextTokensMax, 1, Number.MAX_SAFE_INTEGER)) f.push("POLICY_MODEL_CONTEXT:" + key);
      if (m.revokedAt !== null && m.revokedAt !== undefined && !istIso(m.revokedAt)) f.push("POLICY_MODEL_REVOKED_AT:" + key);
      if (m.releasedAt !== undefined && !istIso(m.releasedAt)) f.push("POLICY_MODEL_RELEASED_AT:" + key);
    }
  }
  if (!istKarte(p.tools)) f.push("POLICY_TOOLS");
  else for (const [ex, liste] of Object.entries(p.tools)) if (!PROVIDERS.includes(ex) || !idListe(liste)) f.push("POLICY_TOOLS:" + ex);
  if (!istKarte(p.secondOpinion) || !(typeof p.secondOpinion.maxUnits === "number" && Number.isFinite(p.secondOpinion.maxUnits) && p.secondOpinion.maxUnits >= 0)) f.push("POLICY_SECOND_OPINION");
  if (!istKarte(p.sandbox) || typeof p.sandbox.isolatedAvailable !== "boolean") f.push("POLICY_SANDBOX");
  if (!istKarte(p.featureFlags) || p.featureFlags.providers !== "dry_run" && p.featureFlags.providers !== "live") f.push("POLICY_FEATURE_FLAGS");
  return { ok: f.length === 0, errors: f };
}

/* ── Fakten ─────────────────────────────────────────────────────────────
 * Serverbestaetigt heisst: attestation { by:"backend", at, fingerprint } und
 * die Attestierung passt zum Inhalt (fingerprint ueber alle Fakten ausser
 * der Attestierung selbst). Fehlt oder stimmt sie nicht, gibt es keinen
 * Plan — auch keinen deterministischen. */
export function factsFingerprint(facts) {
  const { attestation, ...rest } = facts;
  return stringFingerprint(canonicalJson(rest));
}

export function validateRouterFacts(facts) {
  const f = [];
  const x = istKarte(facts) ? facts : null;
  if (!x) return { ok: false, errors: ["FACTS_MISSING"] };
  if (x.schema !== ROUTER_FACTS_SCHEMA) f.push("FACTS_SCHEMA");
  const a = x.attestation;
  if (!istKarte(a) || a.by !== "backend" || !istIso(a.at) || typeof a.fingerprint !== "string") f.push("FACTS_NOT_ATTESTED");
  else if (a.fingerprint !== factsFingerprint(x)) f.push("FACTS_ATTESTATION_MISMATCH");
  const t = x.task;
  if (!istKarte(t)) f.push("FACTS_TASK");
  else {
    if (!istId(t.sourceType || "") || !istId(t.sourceId || "")) f.push("FACTS_TASK_SOURCE");
    if (!istGanz(t.sourceVersion, 1, Number.MAX_SAFE_INTEGER)) f.push("FACTS_SOURCE_VERSION");
    if (!Object.prototype.hasOwnProperty.call(TASK_CLASSES, t.taskClass)) f.push("FACTS_TASK_CLASS");
    if (t.taskClass === "deterministic" && !DETERMINISTIC_KINDS.includes(t.deterministicKind)) f.push("FACTS_DETERMINISTIC_KIND");
    if (!istText(t.goal, 4000)) f.push("FACTS_GOAL");
    if (!idListe(t.requiredTools)) f.push("FACTS_TASK_REQUIRED_TOOLS");
    if (!istKarte(t.expectedReturn) || !istText(t.expectedReturn.format, 64)) f.push("FACTS_RETURN_FORMAT");
    if (!Array.isArray(t.acceptanceCriteria) || t.acceptanceCriteria.length > 50 || !t.acceptanceCriteria.every((c) => istText(c, 1000))) f.push("FACTS_ACCEPTANCE_CRITERIA");
  }
  const c = x.context;
  if (!istKarte(c)) f.push("FACTS_CONTEXT");
  else {
    if (!idListe(c.requiredDataIds)) f.push("FACTS_REQUIRED_DATA_IDS");
    if (!istKarte(c.grants)) f.push("FACTS_GRANTS");
    else for (const [ex, g] of Object.entries(c.grants)) {
      if (!PROVIDERS.includes(ex) || !istKarte(g) || !idListe(g.dataIds) || !idListe(g.revokedDataIds) || !idListe(g.tools)) f.push("FACTS_GRANTS:" + ex);
    }
    if (c.tokensMeasured !== null && !istGanz(c.tokensMeasured, 0, Number.MAX_SAFE_INTEGER)) f.push("FACTS_TOKENS_MEASURED");
  }
  const cap = x.capabilities;
  if (!istKarte(cap) || typeof cap.leadershipCanDo !== "boolean") f.push("FACTS_CAPABILITIES");
  const b = x.budget;
  if (!istKarte(b) || !(b.availableUnits === null || istZahl(b.availableUnits)) || !istEinheit(b.unit)) f.push("FACTS_BUDGET");
  const m = x.measurements;
  if (!istKarte(m)) f.push("FACTS_MEASUREMENTS");
  else {
    if (m.self !== null && !(messForm(m.self) && istZahl(m.self.units))) f.push("FACTS_MEASUREMENT_SELF");
    if (!istKarte(m.delegation)) f.push("FACTS_MEASUREMENT_DELEGATION");
    else for (const [ex, d] of Object.entries(m.delegation)) {
      if (!PROVIDERS.includes(ex) || !messForm(d) || !istZahl(d.executionUnits) || !istZahl(d.handoverUnits) || !istZahl(d.reviewUnits)) f.push("FACTS_MEASUREMENT_DELEGATION:" + ex);
    }
  }
  const r = x.risk;
  if (!istKarte(r) || typeof r.flagged !== "boolean" || typeof r.authorityConfirmed !== "boolean") f.push("FACTS_RISK");
  else {
    if (r.confidence !== undefined && r.confidence !== null && !(typeof r.confidence === "number" && Number.isFinite(r.confidence) && r.confidence >= 0 && r.confidence <= 1)) f.push("FACTS_RISK_CONFIDENCE");
    if (r.votes !== undefined && r.votes !== null && !(istKarte(r.votes) && Object.keys(r.votes).length <= 16 && Object.values(r.votes).every((v) => istGanz(v, 0, Number.MAX_SAFE_INTEGER)))) f.push("FACTS_RISK_VOTES");
  }
  const d = x.deterministicChecks;
  if (!istKarte(d) || !["ok", "failed", "not_run"].includes(d.deadline) || !["ok", "failed", "not_run"].includes(d.duplicate) || !["ok", "failed", "not_run"].includes(d.permission) || !["ok", "failed", "not_run"].includes(d.state)) f.push("FACTS_DETERMINISTIC_CHECKS");
  return { ok: f.length === 0, errors: f };
}

/* ── Bindung Fakten ↔ Policy ↔ Uhr ──────────────────────────────────────
 * Formgueltige Fakten koennen trotzdem nicht zu dieser Policy und dieser
 * Uhr gehoeren: fremde Kosteneinheit, Attestierung aus der Zukunft oder
 * aelter als der Frischevertrag. Dann gibt es keinen Plan. */
export function validateFactsBinding({ facts, policy, now } = {}) {
  const f = [];
  if (facts.budget.unit !== policy.costUnit) f.push("BUDGET_UNIT_MISMATCH:" + facts.budget.unit + "/" + policy.costUnit);
  const at = Date.parse(facts.attestation.at);
  if (at > now) f.push("ATTESTATION_IN_FUTURE");
  else if (now - at > policy.freshness.attestationMaxAgeMs) f.push("ATTESTATION_STALE");
  return { ok: f.length === 0, errors: f };
}

/* Messnachweis an diesen Kandidaten binden: gleiche Einheit, gleiche
 * Policy-Version, gleiche Quellversion, genau dieses Modell, nicht in der
 * Zukunft, nicht nach der Attestierung, nicht aelter als erlaubt. Jede
 * Verletzung macht die Messung wirtschaftlich ungueltig — es wird nichts
 * gleichgesetzt, geschaetzt oder umgerechnet. */
function messungBinden({ policy, facts, now }, mess, modelKey, wer) {
  if (!mess) return ["MEASUREMENT_MISSING:" + wer];
  const g = [];
  if (mess.unit !== policy.costUnit) g.push("MEASUREMENT_UNIT_MISMATCH:" + wer);
  if (mess.policyVersion !== policy.version) g.push("MEASUREMENT_POLICY_MISMATCH:" + wer);
  if (mess.sourceVersion !== facts.task.sourceVersion) g.push("MEASUREMENT_SOURCE_MISMATCH:" + wer);
  if (mess.modelKey !== modelKey) g.push("MEASUREMENT_MODEL_MISMATCH:" + wer);
  const t = Date.parse(mess.measuredAt);
  if (t > now) g.push("MEASUREMENT_IN_FUTURE:" + wer);
  if (t > Date.parse(facts.attestation.at)) g.push("MEASUREMENT_AFTER_ATTESTATION:" + wer);
  if (now - t > policy.freshness.measurementMaxAgeMs) g.push("MEASUREMENT_STALE:" + wer);
  return g;
}
const nachweis = (m) => ({ modelKey: m.modelKey, measuredAt: m.measuredAt, unit: m.unit, policyVersion: m.policyVersion, sourceVersion: m.sourceVersion });

/* ── Kandidatenpruefung ─────────────────────────────────────────────────
 * Jeder Kandidat (Executor + Modell) wird VOR dem Ranking auf alles
 * geprueft. Jede Ablehnung ist ein benannter Grund, keiner ist ein
 * Fallback. */
function kandidatPruefen({ policy, facts, now }, executor, modelKey, capability, rolle) {
  const ablehnungen = [];
  const m = policy.models[modelKey];
  if (m.provider !== executor) ablehnungen.push("MODEL_PROVIDER_MISMATCH");
  if (!m.tested) ablehnungen.push("MODEL_NOT_TESTED");
  if (m.revokedAt && Date.parse(m.revokedAt) <= now) ablehnungen.push("MODEL_REVOKED");
  if (m.releasedAt && Date.parse(m.releasedAt) > now) ablehnungen.push("MODEL_NOT_RELEASED");
  if (capability && !m.approvedFor.includes(capability)) ablehnungen.push("MODEL_NOT_APPROVED_FOR:" + capability);
  const grant = facts.context.grants[executor];
  const benoetigt = facts.context.requiredDataIds;
  if (!grant) ablehnungen.push("DATA_GRANT_MISSING");
  else {
    const widerrufen = new Set(grant.revokedDataIds);
    const erlaubt = new Set(grant.dataIds.filter((id) => !widerrufen.has(id)));
    const fehlend = benoetigt.filter((id) => !erlaubt.has(id));
    if (fehlend.length) ablehnungen.push("DATA_NOT_GRANTED:" + fehlend.join(","));
    const widerrufenBenoetigt = benoetigt.filter((id) => widerrufen.has(id));
    if (widerrufenBenoetigt.length) ablehnungen.push("DATA_GRANT_REVOKED:" + widerrufenBenoetigt.join(","));
    const werkzeuge = new Set(policy.tools[executor] || []);
    const werkzeugeFehlen = (facts.task.requiredTools || []).filter((t) => !werkzeuge.has(t) || !grant.tools.includes(t));
    if (werkzeugeFehlen.length) ablehnungen.push("TOOL_NOT_ALLOWED:" + werkzeugeFehlen.join(","));
  }
  const tokens = facts.context.tokensMeasured;
  if (tokens === null) ablehnungen.push("CONTEXT_NOT_MEASURED");
  else if (tokens > m.contextTokensMax) ablehnungen.push("CONTEXT_LIMIT_EXCEEDED");
  const budget = facts.budget.availableUnits;
  let kosten = null;
  let evidence = null;
  if (rolle === "self") {
    const s = facts.measurements.self;
    const bindung = messungBinden({ policy, facts, now }, s, modelKey, "self");
    if (bindung.length) ablehnungen.push(...bindung);
    else { kosten = { execution: s.units, handover: 0, review: 0, total: s.units }; evidence = nachweis(s); }
  } else if (rolle === "delegate" || rolle === "second_opinion") {
    const d = facts.measurements.delegation[executor];
    const bindung = messungBinden({ policy, facts, now }, d, modelKey, executor);
    if (bindung.length) ablehnungen.push(...bindung);
    else { kosten = { execution: d.executionUnits, handover: d.handoverUnits, review: d.reviewUnits, total: d.executionUnits + d.handoverUnits + d.reviewUnits }; evidence = nachweis(d); }
  }
  if (budget === null) ablehnungen.push("BUDGET_UNKNOWN");
  else if (budget <= 0) ablehnungen.push("BUDGET_ZERO");
  else if (kosten && kosten.total > budget) ablehnungen.push("BUDGET_INSUFFICIENT");
  if (rolle === "second_opinion" && kosten && kosten.total > policy.secondOpinion.maxUnits) ablehnungen.push("SECOND_OPINION_CAP_EXCEEDED");
  return { executor, modelKey, provider: m.provider, modelId: m.modelId, role: rolle, cost: kosten, evidence, eligible: ablehnungen.length === 0, rejections: ablehnungen };
}

/* Nachgewiesene Unfaehigkeit der Leitung — nur diese rechtfertigt eine
 * Delegation ohne vollstaendigen Kostenvergleich. Fehlende, veraltete oder
 * fremd gebundene Messungen, ungemessener Kontext oder unbekanntes Budget
 * sind Abwesenheit von Beweis, nicht Beweis. */
const NACHGEWIESEN_UNFAEHIG = (r) => r.startsWith("LEADERSHIP_CANNOT_DO:") || r === "CONTEXT_LIMIT_EXCEEDED" || r === "BUDGET_INSUFFICIENT";

function kandidaten(input, executors, capability, rolle) {
  const out = [];
  for (const ex of executors) {
    for (const key of Object.keys(input.policy.models).sort()) {
      if (input.policy.models[key].provider !== ex) continue;
      out.push(kandidatPruefen(input, ex, key, capability, rolle));
    }
    if (!Object.values(input.policy.models).some((m) => m.provider === ex)) out.push({ executor: ex, modelKey: null, provider: ex, modelId: null, role: rolle, cost: null, evidence: null, eligible: false, rejections: ["MODEL_NOT_CONFIGURED"] });
  }
  return out;
}

const bester = (liste) => liste.filter((k) => k.eligible).sort((a, b) => (a.cost.total - b.cost.total) || a.modelKey.localeCompare(b.modelKey))[0] || null;

/* ── Der Plan ──────────────────────────────────────────────────────────── */
export function planJobRoute({ policy, facts, now } = {}) {
  if (typeof now !== "number" || !Number.isFinite(now)) return { ok: false, error: "NOW_MISSING", errors: ["NOW_MISSING"] };
  const pv = validateRouterPolicy(policy);
  if (!pv.ok) return { ok: false, error: "POLICY_INVALID", errors: pv.errors };
  const fv = validateRouterFacts(facts);
  if (!fv.ok) return { ok: false, error: "FACTS_INVALID", errors: fv.errors };
  const bv = validateFactsBinding({ facts, policy, now });
  if (!bv.ok) return { ok: false, error: "FACTS_NOT_BOUND", errors: bv.errors };

  const input = { policy, facts, now };
  const t = facts.task;
  const klasse = TASK_CLASSES[t.taskClass];
  const reasons = [];
  const alleKandidaten = [];
  let route = null;

  const dc = facts.deterministicChecks;
  const gescheitert = Object.entries(dc).filter(([, v]) => v === "failed").map(([k]) => k);
  const nichtGelaufen = Object.entries(dc).filter(([, v]) => v === "not_run").map(([k]) => k);

  if (t.taskClass === "deterministic") {
    reasons.push({ code: "CLASS_DETERMINISTIC", detail: t.deterministicKind });
    route = { kind: "deterministic", executor: null, modelKey: null, model: null, cost: null, sandbox: null };
  } else if (gescheitert.length) {
    // Deterministische Vorpruefungen (Fristen, Dubletten, Berechtigungen, Zustand)
    // gehen jedem Modellweg vor: ein Fehlschlag ist ein Blocker.
    reasons.push({ code: "DETERMINISTIC_CHECK_FAILED", detail: gescheitert });
    route = { kind: "blocked", executor: null, modelKey: null, model: null, cost: null, blockers: gescheitert.map((k) => "CHECK_FAILED:" + k) };
  } else if (nichtGelaufen.length) {
    reasons.push({ code: "DETERMINISTIC_CHECK_NOT_RUN", detail: nichtGelaufen });
    route = { kind: "blocked", executor: null, modelKey: null, model: null, cost: null, blockers: nichtGelaufen.map((k) => "CHECK_NOT_RUN:" + k) };
  } else if ((t.taskClass === "risky_unclear" || facts.risk.flagged) && !facts.risk.authorityConfirmed) {
    // Risikoschranke vor jeder Modellklasse: ungeklaerte Befugnis ist Entwurf,
    // egal wie die Aufgabe klassifiziert wurde. Konfidenz, Mehrheiten oder
    // Stimmen sind Daten und keine Freigabe.
    reasons.push({ code: "AUTHORITY_UNCONFIRMED_DRAFT", detail: { taskClass: t.taskClass, flagged: facts.risk.flagged, confidence: facts.risk.confidence ?? null, votes: facts.risk.votes ?? null } });
    route = { kind: "draft", executor: null, modelKey: null, model: null, cost: null, blockers: ["AUTHORITY_UNCONFIRMED"] };
  } else if (facts.risk.flagged && t.taskClass !== "risky_unclear") {
    // Risikomarke und Klassifikation widersprechen sich: der Router
    // klassifiziert nicht um und bereitet keine Route auf widerspruechlichen
    // Fakten vor. Das Backend muss den Widerspruch aufloesen.
    reasons.push({ code: "RISK_CLASS_CONTRADICTION", detail: { taskClass: t.taskClass, flagged: true, authorityConfirmed: true } });
    route = { kind: "blocked", executor: null, modelKey: null, model: null, cost: null, blockers: ["RISK_FLAGGED_CLASS_MISMATCH:" + t.taskClass] };
  } else if (t.taskClass === "risky_unclear") {
    {
      const ks = kandidaten(input, klasse.preferred, klasse.capability, "second_opinion");
      alleKandidaten.push(...ks);
      const b = bester(ks);
      if (b) { reasons.push({ code: "SECOND_OPINION_LIMITED", detail: { executor: b.executor, capUnits: policy.secondOpinion.maxUnits } }); route = { kind: "second_opinion", executor: b.executor, modelKey: b.modelKey, model: { provider: b.provider, modelId: b.modelId }, cost: b.cost, sandbox: null }; }
      else { reasons.push({ code: "SECOND_OPINION_UNAVAILABLE", detail: ks.map((k) => k.executor + ":" + k.rejections.join("|")) }); route = { kind: "blocked", executor: null, modelKey: null, model: null, cost: null, blockers: ks.flatMap((k) => k.rejections.map((r) => k.executor + ":" + r)) }; }
    }
  } else if (t.taskClass === "short_context") {
    const ks = kandidaten(input, [LEITUNG], klasse.capability, "self");
    alleKandidaten.push(...ks);
    const b = bester(ks);
    if (b) { reasons.push({ code: "CLASS_SHORT_CONTEXT_SELF", detail: b.executor }); route = { kind: "self", executor: b.executor, modelKey: b.modelKey, model: { provider: b.provider, modelId: b.modelId }, cost: b.cost, sandbox: null }; }
    else { reasons.push({ code: "LEADERSHIP_UNAVAILABLE_NO_FALLBACK", detail: ks.map((k) => k.rejections.join("|")) }); route = { kind: "blocked", executor: null, modelKey: null, model: null, cost: null, blockers: ks.flatMap((k) => k.rejections.map((r) => k.executor + ":" + r)) }; }
  } else if (["ocr", "audio", "structured_extraction"].includes(t.taskClass)) {
    const ks = kandidaten(input, klasse.preferred, klasse.capability, "delegate");
    alleKandidaten.push(...ks);
    const b = bester(ks);
    if (b) { reasons.push({ code: "CLASS_SPECIALIST_GEMINI", detail: { capability: klasse.capability, modelKey: b.modelKey } }); route = { kind: "delegate", executor: b.executor, modelKey: b.modelKey, model: { provider: b.provider, modelId: b.modelId }, cost: b.cost, sandbox: null }; }
    else { reasons.push({ code: "CAPABILITY_MISSING", detail: { capability: klasse.capability, rejections: ks.map((k) => k.modelKey + ":" + k.rejections.join("|")) } }); route = { kind: "blocked", executor: null, modelKey: null, model: null, cost: null, blockers: ks.flatMap((k) => k.rejections.map((r) => (k.modelKey || k.executor) + ":" + r)) }; }
  } else {
    // bounded_text / bounded_code / bounded_file: Claude gegen Selbstausfuehrung, gemessen.
    const sandboxNoetig = !!klasse.sandbox;
    const delegierte = kandidaten(input, klasse.preferred, klasse.capability, "delegate");
    const eigene = kandidaten(input, [LEITUNG], klasse.capability, "self");
    if (sandboxNoetig) {
      for (const k of delegierte) if (!policy.sandbox.isolatedAvailable) { k.eligible = false; k.rejections.push("SANDBOX_NOT_AVAILABLE"); }
      for (const k of eigene) if (!policy.sandbox.isolatedAvailable) { k.eligible = false; k.rejections.push("SANDBOX_NOT_AVAILABLE"); }
    }
    if (!facts.capabilities.leadershipCanDo) for (const k of eigene) { k.eligible = false; k.rejections.push("LEADERSHIP_CANNOT_DO:" + klasse.capability); }
    alleKandidaten.push(...delegierte, ...eigene);
    const d = bester(delegierte);
    const s = bester(eigene);
    const sandbox = sandboxNoetig ? { isolated: true, prodSecrets: false, deploy: false } : null;
    if (d && s) {
      if (d.cost.total < s.cost.total) { reasons.push({ code: "DELEGATION_MEASURED_CHEAPER", detail: { delegate: d.cost, self: s.cost, unit: policy.costUnit } }); route = { kind: "delegate", executor: d.executor, modelKey: d.modelKey, model: { provider: d.provider, modelId: d.modelId }, cost: d.cost, sandbox }; }
      else { reasons.push({ code: "SELF_MEASURED_NOT_MORE_EXPENSIVE", detail: { delegate: d.cost, self: s.cost, unit: policy.costUnit } }); route = { kind: "self", executor: s.executor, modelKey: s.modelKey, model: { provider: s.provider, modelId: s.modelId }, cost: s.cost, sandbox }; }
    } else if (d && !s) {
      const grund = eigene.flatMap((k) => k.rejections);
      if (!eigene.every((k) => k.rejections.some(NACHGEWIESEN_UNFAEHIG))) {
        // Keine Selbstmessung (oder eine ungueltige) ist kein Beweis fuer
        // geringere Gesamtkosten und keine Faehigkeitsluecke: ehrlich blocked.
        reasons.push({ code: "DELEGATION_REQUIRES_COMPARISON", detail: { self: grund, delegate: d.cost, unit: policy.costUnit } });
        route = { kind: "blocked", executor: null, modelKey: null, model: null, cost: null, blockers: eigene.flatMap((k) => k.rejections.map((r) => (k.modelKey || k.executor) + ":" + r)).concat(["self:NO_COST_COMPARISON"]) };
      } else {
        reasons.push({ code: grund.some((r) => r.startsWith("LEADERSHIP_CANNOT_DO")) ? "DELEGATION_LEADERSHIP_LACKS_CAPABILITY" : "DELEGATION_SELF_UNAVAILABLE", detail: grund });
        route = { kind: "delegate", executor: d.executor, modelKey: d.modelKey, model: { provider: d.provider, modelId: d.modelId }, cost: d.cost, sandbox };
      }
    } else if (!d && s) {
      reasons.push({ code: "SELF_DELEGATION_UNAVAILABLE", detail: delegierte.map((k) => (k.modelKey || k.executor) + ":" + k.rejections.join("|")) });
      route = { kind: "self", executor: s.executor, modelKey: s.modelKey, model: { provider: s.provider, modelId: s.modelId }, cost: s.cost, sandbox };
    } else {
      reasons.push({ code: "NO_ELIGIBLE_EXECUTOR", detail: [...delegierte, ...eigene].map((k) => (k.modelKey || k.executor) + ":" + k.rejections.join("|")) });
      route = { kind: "blocked", executor: null, modelKey: null, model: null, cost: null, blockers: [...delegierte, ...eigene].flatMap((k) => k.rejections.map((r) => (k.modelKey || k.executor) + ":" + r)) };
    }
  }

  if (route.modelKey) {
    const gewaehlt = alleKandidaten.find((k) => k.modelKey === route.modelKey && k.role === route.kind);
    route.evidence = gewaehlt ? gewaehlt.evidence : null;
  } else route.evidence = null;

  const decidedAt = new Date(now).toISOString();
  const manifest = manifestBauen({ policy, facts, route, reasons });
  const routing = route.executor && EXECUTORS.includes(route.executor) ? {
    schema: ROUTING_SCHEMA, routerVersion: ROUTER_VERSION, policyVersion: policy.version,
    executor: route.executor, decidedAt, reason: reasons[0].code,
    fingerprint: null,   // wird unten ueber den ganzen Plan gebildet
  } : null;
  const plan = {
    ok: true,
    routerVersion: ROUTER_VERSION, policyVersion: policy.version, factsFingerprint: facts.attestation.fingerprint,
    decidedAt, taskClass: t.taskClass,
    route, reasons, candidates: alleKandidaten, manifest, routing,
    isExecutionAuthorization: false, sendsNothing: true, mutatesNothing: true, spendClaim: false,
    providersMode: policy.featureFlags.providers,
  };
  const fp = stringFingerprint(canonicalJson({ ...plan, routing: routing ? { ...routing, fingerprint: null } : null }));
  plan.fingerprint = fp;
  if (routing) routing.fingerprint = fp;
  return plan;
}

/* ── Jobmanifest (12.1) ──────────────────────────────────────────────────
 * Bestehender Auftrag mit Lead-/Quellversion, Ziel, referenzierte Quellen
 * (nur freigegebene Daten-IDs — nie der Vollbestand, nie Geheimnisse),
 * erlaubte Werkzeuge, Ergebnisformat, Pruefkriterien, erwarteter Ruecklauf,
 * Budget (inkl. Uebergabe und Pruefung) und Routerbegruendung. accountable
 * bleibt chatgpt; der Executor ist getrennt. */
export function manifestBauen({ policy, facts, route, reasons }) {
  const t = facts.task;
  const ex = route.executor;
  const grant = ex ? facts.context.grants[ex] : null;
  const widerrufen = new Set(grant ? grant.revokedDataIds : []);
  const quellen = ex && grant ? facts.context.requiredDataIds.filter((id) => grant.dataIds.includes(id) && !widerrufen.has(id)) : [];
  return {
    schema: JOB_MANIFEST_SCHEMA,
    task: { sourceType: t.sourceType, sourceId: t.sourceId, sourceVersion: t.sourceVersion, goal: t.goal, taskClass: t.taskClass, deterministicKind: t.deterministicKind || null },
    accountable: "chatgpt",
    executor: ex,
    model: route.model,
    sources: quellen,
    fullDatasetAccess: false,
    secrets: "none",
    allowedTools: ex && grant ? facts.task.requiredTools.filter((tool) => (policy.tools[ex] || []).includes(tool) && grant.tools.includes(tool)) : [],
    resultFormat: t.expectedReturn.format,
    acceptanceCriteria: t.acceptanceCriteria.slice(),
    expectedReturn: { format: t.expectedReturn.format, maxUnits: route.cost ? route.cost.total : 0, resultHashRequired: true, reviewRequired: route.kind !== "deterministic" },
    budget: route.cost ? { unit: policy.costUnit, execution: route.cost.execution, handover: route.cost.handover, review: route.cost.review, total: route.cost.total, reservation: "pending_E1", spendClaim: false } : { unit: policy.costUnit, execution: 0, handover: 0, review: 0, total: 0, reservation: "none", spendClaim: false },
    measurementEvidence: route.evidence || null,
    sandbox: route.sandbox || null,
    routerReason: reasons.map((r) => r.code),
    blockers: route.blockers || [],
    executionAuthorized: false,
  };
}
