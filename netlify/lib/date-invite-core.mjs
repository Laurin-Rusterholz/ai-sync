// Reiner, abhängigkeitsfreier Kern der Date-Einladung:
// Eingaben säubern/prüfen, Aufgabe bauen und in den App-Stand (app-data.json)
// einfügen. Bewusst ohne @netlify/blobs, damit die Logik isoliert testbar ist.

export const WEEKDAYS = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
export const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli",
  "August", "September", "Oktober", "November", "Dezember"];

export function uuid() {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : "di_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// Aus "YYYY-MM-DD" einen deutschen Klartext bauen — bewusst aus den Teilen,
// damit es keinen Zeitzonen-Versatz gibt, egal wo die Function läuft.
export function formatDateDe(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
  if (!m) return ymd || "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${WEEKDAYS[d.getUTCDay()]}, ${+m[3]}. ${MONTHS[+m[2] - 1]} ${m[1]}`;
}

// Roh-Body → saubere, längenbegrenzte Felder.
export function sanitizeInvite(body = {}) {
  return {
    date: String(body?.date || "").slice(0, 10),
    time: String(body?.time || "").slice(0, 5),
    name: (String(body?.name || "").trim() || "Cati").slice(0, 80),
    note: String(body?.message || "").slice(0, 500),
  };
}

// Gibt eine Fehlermeldung zurück, oder null wenn alles passt.
export function validateInvite({ date, time }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "Ungültiges Datum (erwartet YYYY-MM-DD)";
  if (time && !/^\d{2}:\d{2}$/.test(time)) return "Ungültige Uhrzeit (erwartet HH:MM)";
  return null;
}

// Baut ein Task-Objekt im Schema der Quantus-App (data.entities.tasks[id]).
export function buildTask({ date, time, name, note }, { now = new Date().toISOString(), id = uuid() } = {}) {
  const pretty = formatDateDe(date);
  const timePart = time ? ` um ${time} Uhr` : "";
  return {
    id,
    title: `💖 Date mit ${name} – ${pretty}${timePart}`,
    description:
      `${name} hat zugesagt! 🎉\n\n` +
      `Wunschtermin: ${pretty}${timePart}.` +
      (note ? `\n\nNachricht: ${note}` : "") +
      `\n\n(Automatisch erstellt über die Date-Einladung.)`,
    status: "todo",
    priority: 1,
    dueDate: date,
    startDate: null,
    category: "Privat",
    tags: ["date", "flirtai"],
    // Link-Arrays leer initialisieren, damit die Task-Karte sauber rendert,
    // auch bevor die Client-Normalisierung greift.
    linkedProjects: [], linkedTasks: [], linkedNotes: [], linkedOrganizations: [],
    linkedStrategies: [], linkedGoals: [], linkedIdeas: [], linkedMeetings: [],
    linkedCalendarEvents: [], linkedProgramLinks: [],
    comments: [], externalLinks: [], workflow: [], emails: [], documents: [],
    measures: [], programButtons: [],
    estimatedMinutes: null, recurrence: null, recurrenceEndDate: null,
    // Rohdaten zur Sicherheit mitspeichern (unbekannte Felder ignoriert die UI).
    dateInvite: { date, time, name, message: note, submittedAt: now },
    createdAt: now,
    updatedAt: now,
  };
}

// Fügt die Aufgabe in den (ggf. leeren/fehlenden) App-Stand ein und hebt
// meta.updatedAt an, damit die App den Server-Stand als neuer erkennt.
export function applyInvite(rawData, invite, opts = {}) {
  let data = rawData;
  if (!data || typeof data !== "object") {
    data = { version: 1, meta: {}, entities: {} };
  }
  data.entities = data.entities || {};
  data.entities.tasks = data.entities.tasks || {};

  const task = buildTask(invite, opts);
  data.entities.tasks[task.id] = task;

  data.meta = data.meta || {};
  data.meta.updatedAt = new Date().toISOString();
  data.meta.lastSavedBy = "flirtai-date-invite";

  return { data, task };
}
