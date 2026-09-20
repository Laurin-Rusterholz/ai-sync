/* ══ E2 — stabile Cloud-Tasks-Namen ═══════════════════════════════════════
 *
 * Cloud Tasks dedupliziert ueber den Task-Namen: ein Name, der schon
 * existiert oder in der Grabsteinfrist liegt (bei ueber die Cloud-Tasks-API
 * angelegten Queues standardmaessig etwa eine Stunde nach Ausfuehrung oder
 * Loeschung), wird mit ALREADY_EXISTS abgewiesen. Erlaubt sind nur
 * [A-Za-z0-9_-], hoechstens 500 Zeichen.
 *
 * Der Laufschluessel enthaelt `:` und `.` — beides ist nicht erlaubt.
 * Deshalb eine UMKEHRBARE Kodierung: jedes Zeichen ausserhalb
 * [A-Za-z0-9-] wird zu `_` plus zwei Hexziffern, `_` selbst zu `_5f`.
 * Damit koennen zwei verschiedene Schluessel nie denselben Namen ergeben —
 * ein naives Ersetzen von `.` durch `_` koennte das.
 *
 * WICHTIG: der Task-Name ist die ERSTE Verteidigungslinie, nicht die
 * massgebliche. Nach Ablauf der Grabsteinfrist kann derselbe Name wieder
 * entstehen; die verbindliche Genau-einmal-Regel liegt in E1
 * (`startRunSection` verbraucht eine Fortsetzung genau einmal).
 * ═════════════════════════════════════════════════════════════════════════ */

export const MAX_TASK_ID_LENGTH = 500;
export const TASK_ID_RE = /^[A-Za-z0-9_-]{1,500}$/;

export function encodeTaskSegment(value) {
  if (typeof value !== "string" || !value.length) throw new TypeError("encodeTaskSegment: Zeichenkette erwartet");
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code > 0x7f) throw new TypeError("encodeTaskSegment: nur ASCII");
    if (/[A-Za-z0-9-]/.test(ch)) { out += ch; continue; }
    out += `_${code.toString(16).padStart(2, "0")}`;
  }
  return out;
}

export function decodeTaskSegment(value) {
  if (typeof value !== "string") throw new TypeError("decodeTaskSegment: Zeichenkette erwartet");
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== "_") { out += ch; continue; }
    const hex = value.slice(i + 1, i + 3);
    if (!/^[0-9a-f]{2}$/.test(hex)) throw new TypeError("decodeTaskSegment: kaputte Kodierung");
    out += String.fromCharCode(parseInt(hex, 16));
    i += 2;
  }
  return out;
}

/* Ein Lauf, eine Fortsetzung, ein Name. Zweimal dieselbe Fortsetzung ergibt
 * zweimal denselben Namen — genau darum geht es. */
export function continuationTaskId(runKey, continuationId) {
  const id = `c-${encodeTaskSegment(runKey)}--${encodeTaskSegment(continuationId)}`;
  if (!TASK_ID_RE.test(id)) throw new TypeError("continuationTaskId: unzulaessiger Name");
  if (id.length > MAX_TASK_ID_LENGTH) throw new TypeError("continuationTaskId: zu lang");
  return id;
}

export function parseContinuationTaskId(taskId) {
  if (!TASK_ID_RE.test(taskId) || !taskId.startsWith("c-")) throw new TypeError("parseContinuationTaskId: unbekannte Form");
  const rest = taskId.slice(2);
  const cut = rest.indexOf("--");
  if (cut < 0) throw new TypeError("parseContinuationTaskId: kein Trenner");
  return {
    runKey: decodeTaskSegment(rest.slice(0, cut)),
    continuationId: decodeTaskSegment(rest.slice(cut + 2)),
  };
}

export function taskName(queuePath, taskId) {
  if (!/^projects\/[a-z0-9-]{1,64}\/locations\/[a-z0-9-]{1,32}\/queues\/[A-Za-z0-9-]{1,100}$/.test(String(queuePath))) {
    throw new TypeError("taskName: unzulaessiger Queue-Pfad");
  }
  if (!TASK_ID_RE.test(taskId)) throw new TypeError("taskName: unzulaessige Task-Id");
  return `${queuePath}/tasks/${taskId}`;
}
