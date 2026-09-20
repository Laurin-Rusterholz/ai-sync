/* ══ E2 — strikte JSON-Schemata ════════════════════════════════════════════
 *
 * Absichtlich klein und ausdruecklich: kein Schemadialekt, keine
 * Typumwandlung, keine Vorgabewerte, keine unbekannten Felder. Was nicht
 * im Schema steht, ist ein Fehler — nicht "wird ignoriert". Genau ueber ein
 * ignoriertes Feld kaeme sonst morgen eine Identitaetsbehauptung herein.
 * ═════════════════════════════════════════════════════════════════════════ */
import { badRequest } from "./errors.mjs";

function isRecord(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

/* Felder, die ausschliesslich der Server bestimmt. Sie duerfen in KEINEM
 * Rumpf vorkommen — auch nicht tiefer verschachtelt, auch nicht "nur zur
 * Information". Ein Aufrufer, der sie mitschickt, bekommt 400. */
export const SERVER_CONTROLLED_FIELDS = Object.freeze([
  // Identitaet und Rechte
  "principal", "principalId", "principalKind", "role", "roles", "kind", "issuedVia",
  "tenant", "tenantId", "scopes", "permissions", "grants", "iam", "iamRole",
  "serviceAccount", "serviceAccountEmail", "audience", "issuer", "email",
  // Zeit und Fencing
  "now", "nowMs", "serverNow", "fence", "leaseFence", "policyVersion",
  // Kosten und Freigaben
  "costPolicy", "budget", "budgetMicros", "maxMicros", "approval", "approved",
  "featureFlags", "mode",
]);
const SERVER_CONTROLLED = new Set(SERVER_CONTROLLED_FIELDS);

export function findServerControlledFields(value, path = "", found = [], depth = 0) {
  if (depth > 12 || value === null || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    value.forEach((v, i) => findServerControlledFields(v, `${path}[${i}]`, found, depth + 1));
    return found;
  }
  for (const key of Object.keys(value)) {
    const here = path ? `${path}.${key}` : key;
    if (SERVER_CONTROLLED.has(key)) found.push(here);
    findServerControlledFields(value[key], here, found, depth + 1);
  }
  return found;
}

export function assertNoServerControlledFields(body) {
  const found = findServerControlledFields(body);
  if (found.length) throw badRequest("server_controlled_field_in_payload", { fields: found.slice(0, 8) });
}

/* Schema: { type: "object", required: [...], properties: { k: rule } }
 * rule: { type: "string"|"integer"|"boolean"|"object"|"array",
 *         enum, pattern, minLength, maxLength, minimum, maximum, items, schema } */
export function validateSchema(value, schema, path = "body") {
  const errors = [];
  check(value, schema, path, errors);
  return { ok: errors.length === 0, errors };
}

function check(value, rule, path, errors) {
  if (rule.type === "object") {
    if (!isRecord(value)) { errors.push(`${path}: object erwartet`); return; }
    if (Object.hasOwn(value, "__proto__")) { errors.push(`${path}: __proto__ unzulaessig`); return; }
    const props = rule.properties || {};
    for (const key of rule.required || []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: fehlt`);
    }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(props, key)) { errors.push(`${path}.${key}: unbekanntes Feld`); continue; }
      if (Object.hasOwn(value, key)) check(value[key], props[key], `${path}.${key}`, errors);
    }
    return;
  }
  if (rule.type === "array") {
    if (!Array.isArray(value)) { errors.push(`${path}: array erwartet`); return; }
    if (rule.maxItems !== undefined && value.length > rule.maxItems) errors.push(`${path}: zu viele Eintraege`);
    value.forEach((item, i) => check(item, rule.items, `${path}[${i}]`, errors));
    return;
  }
  if (rule.type === "string") {
    if (typeof value !== "string") { errors.push(`${path}: string erwartet`); return; }
    if (rule.enum && !rule.enum.includes(value)) errors.push(`${path}: unzulaessiger Wert`);
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) errors.push(`${path}: Muster verletzt`);
    if (rule.minLength !== undefined && value.length < rule.minLength) errors.push(`${path}: zu kurz`);
    if (rule.maxLength !== undefined && value.length > rule.maxLength) errors.push(`${path}: zu lang`);
    return;
  }
  if (rule.type === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) { errors.push(`${path}: ganze Zahl erwartet`); return; }
    if (rule.minimum !== undefined && value < rule.minimum) errors.push(`${path}: zu klein`);
    if (rule.maximum !== undefined && value > rule.maximum) errors.push(`${path}: zu gross`);
    return;
  }
  if (rule.type === "boolean") {
    if (typeof value !== "boolean") errors.push(`${path}: boolean erwartet`);
    return;
  }
  errors.push(`${path}: unbekannte Regel`);
}

export function requireSchema(value, schema, error = "schema_invalid") {
  assertNoServerControlledFields(value);
  const verdict = validateSchema(value, schema);
  if (!verdict.ok) throw badRequest(error, { errors: verdict.errors.slice(0, 8) });
  return value;
}
