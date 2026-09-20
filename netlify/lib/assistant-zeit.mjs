/* ══ Tagesbriefing v3 — Zeit in Europe/Zurich ═══════════════════════════════
 *
 * Alles, was mit "welcher Tag ist es" und "welcher Slot laeuft" zu tun hat,
 * steht hier — und NUR hier. Es gibt keine feste UTC-Verschiebung: die
 * Umrechnung laeuft ueber Intl mit der IANA-Zone Europe/Zurich, damit
 * Sommer- und Winterzeit (letzter Sonntag im Maerz / Oktober) von selbst
 * stimmen. Node 22 traegt die volle ICU-Datenbank mit; die Tests pruefen
 * beide Umstellungstage von 2026 mit konkreten Millisekunden.
 *
 * Der Assistententag beginnt um 04:00 Ortszeit: 02:30 am 20. gehoert noch
 * zum 19. Vier Slots, jeder mit fester Ortszeit:
 *
 *   briefing04  04:00  neuer Tag, Startnotiz
 *   process09   09:00  bearbeiten
 *   continue14  14:00  fortsetzen
 *   close23     23:00  heutiger Abschluss
 *
 * Reine Funktionen: Eingabe ist immer ein Zeitpunkt in Millisekunden (UTC),
 * Ausgabe sind Zeichenketten oder Millisekunden. Keine Uhr, kein Date.now().
 * ═════════════════════════════════════════════════════════════════════════ */

export const ZEITZONE = "Europe/Zurich";
export const TAGESBEGINN_STUNDE = 4;

export const SLOTS = Object.freeze([
  Object.freeze({ key: "briefing04", hour: 4, minute: 0, label: "neuer Tag" }),
  Object.freeze({ key: "process09", hour: 9, minute: 0, label: "bearbeiten" }),
  Object.freeze({ key: "continue14", hour: 14, minute: 0, label: "fortsetzen" }),
  Object.freeze({ key: "close23", hour: 23, minute: 0, label: "heutiger Abschluss" }),
]);
export const SLOT_KEYS = Object.freeze(SLOTS.map((s) => s.key));

const MINUTE = 60 * 1000;
const STUNDE = 60 * MINUTE;
const TAG = 24 * STUNDE;

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ZEITZONE,
  hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

function pruefeMs(ms, name = "ms") {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    throw new TypeError(`${name}: Zeitpunkt in Millisekunden erwartet, erhalten ${typeof ms}`);
  }
  return ms;
}

/* Wandzeit-Bestandteile in Europe/Zurich fuer einen UTC-Zeitpunkt. */
export function zurichParts(ms) {
  pruefeMs(ms);
  const teile = {};
  for (const p of formatter.formatToParts(new Date(ms))) {
    if (p.type !== "literal") teile[p.type] = Number(p.value);
  }
  // hourCycle h23 liefert 0..23; einzelne ICU-Staende geben trotzdem "24" aus.
  if (teile.hour === 24) teile.hour = 0;
  return {
    year: teile.year, month: teile.month, day: teile.day,
    hour: teile.hour, minute: teile.minute, second: teile.second,
  };
}

/* Versatz der Zone zu UTC in Minuten fuer den gegebenen Zeitpunkt. */
export function zurichOffsetMinutes(ms) {
  const p = zurichParts(ms);
  const alsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((alsUtc - Math.floor(ms / 1000) * 1000) / MINUTE);
}

const pad2 = (n) => String(n).padStart(2, "0");

export function ymd(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

export function istLokalDatum(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
}

/* Kalenderdatum (Ortszeit) — ohne die 04:00-Regel. */
export function lokalDatum(ms) {
  return ymd(zurichParts(ms));
}

/* Der ASSISTENTENTAG: vor 04:00 Ortszeit gehoert der Zeitpunkt zum Vortag. */
export function assistentenTag(ms) {
  const p = zurichParts(ms);
  if (p.hour >= TAGESBEGINN_STUNDE) return ymd(p);
  // Vortag im Kalender, unabhaengig von der Zonenlaenge des Tages.
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day) - TAG);
  return ymd({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
}

export function datumPlusTage(lokal, tage) {
  if (!istLokalDatum(lokal)) throw new TypeError(`datumPlusTage: ungueltiges Datum ${lokal}`);
  const d = new Date(Date.parse(lokal + "T00:00:00Z") + tage * TAG);
  return ymd({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
}

/* UTC-Millisekunden fuer eine Wandzeit (Ortszeit Zuerich) an einem Datum.
 * Loest die Zone auf, indem beide in Frage kommenden Versaetze probiert
 * werden (der von zwoelf Stunden davor und der von zwoelf Stunden danach —
 * damit sind Winter- und Sommerversatz rund um eine Umstellung beide dabei).
 * Ist die Wandzeit doppelt (02:xx am Herbstsonntag), gilt der FRUEHERE
 * Zeitpunkt. Faellt sie in die Luecke (02:xx am Fruehjahrssonntag), wird sie
 * wie in JavaScript ueblich um die Lueckenlaenge nach vorn geschoben (02:30 →
 * 03:30). Die vier Slots liegen nie in einer Luecke oder Doppelung — die
 * Regel ist trotzdem festgeschrieben, damit sie nachvollziehbar und getestet ist. */
export function wandzeitZuMs(lokal, hour, minute = 0) {
  if (!istLokalDatum(lokal)) throw new TypeError(`wandzeitZuMs: ungueltiges Datum ${lokal}`);
  const [y, m, d] = lokal.split("-").map(Number);
  const wunsch = Date.UTC(y, m - 1, d, hour, minute, 0);
  const versaetze = new Set([
    zurichOffsetMinutes(wunsch - 12 * STUNDE),
    zurichOffsetMinutes(wunsch),
    zurichOffsetMinutes(wunsch + 12 * STUNDE),
  ]);
  const kandidaten = [...versaetze].map((v) => wunsch - v * MINUTE).sort((a, b) => a - b);
  const passend = kandidaten.filter((ms) => {
    const p = zurichParts(ms);
    return p.year === y && p.month === m && p.day === d && p.hour === hour && p.minute === minute;
  });
  if (passend.length) return passend[0];
  // Luecke: der spaetere Kandidat liegt hinter der Umstellung (nach vorn geschoben).
  return kandidaten[kandidaten.length - 1];
}

export function slotDefinition(slotKey) {
  const s = SLOTS.find((x) => x.key === slotKey);
  if (!s) throw new RangeError(`unbekannter Slot: ${slotKey}`);
  return s;
}

/* Beginn eines Slots an einem Assistententag, in UTC-Millisekunden.
 * close23 liegt am Kalendertag selbst, briefing04 auch — der Assistententag
 * "2026-09-19" laeuft von 19.09. 04:00 bis 20.09. 04:00. */
export function slotBeginnMs(assistTag, slotKey) {
  const s = slotDefinition(slotKey);
  return wandzeitZuMs(assistTag, s.hour, s.minute);
}

export function tagesEndeMs(assistTag) {
  return wandzeitZuMs(datumPlusTage(assistTag, 1), TAGESBEGINN_STUNDE, 0);
}

/* Welcher Slot ist zum Zeitpunkt der zuletzt begonnene? */
export function aktuellerSlot(ms) {
  pruefeMs(ms);
  const tag = assistentenTag(ms);
  let aktiv = SLOTS[0];
  for (const s of SLOTS) {
    if (slotBeginnMs(tag, s.key) <= ms) aktiv = s;
  }
  return { date: tag, slot: aktiv.key, slotStartMs: slotBeginnMs(tag, aktiv.key), dayEndMs: tagesEndeMs(tag) };
}

/* Naechste Slotgrenze NACH dem Zeitpunkt (inkl. 04:00 des Folgetages). */
export function naechsteSlotGrenzeMs(ms) {
  const { date } = aktuellerSlot(ms);
  for (const s of SLOTS) {
    const b = slotBeginnMs(date, s.key);
    if (b > ms) return b;
  }
  return tagesEndeMs(date);
}

/* Alle Slots, die an einem Assistententag bis zum Zeitpunkt begonnen haben. */
export function faelligeSlots(assistTag, ms) {
  return SLOTS.filter((s) => slotBeginnMs(assistTag, s.key) <= ms).map((s) => s.key);
}

/* Stabiler Slot-Schluessel: tenant:localdate:slot:policyVersion. Keine
 * Zeitstempel, keine Zufallsanteile — derselbe Slot ergibt immer denselben
 * Schluessel, egal wann und von welchem Laeufer er gebildet wird. */
export function slotKey(tenant, assistTag, slotKeyName, policyVersion) {
  const t = String(tenant == null ? "" : tenant).trim();
  const pv = String(policyVersion == null ? "" : policyVersion).trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(t)) throw new TypeError(`slotKey: unzulaessiger Mandant "${t}"`);
  if (!istLokalDatum(assistTag)) throw new TypeError(`slotKey: ungueltiges Datum ${assistTag}`);
  slotDefinition(slotKeyName);
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(pv)) throw new TypeError(`slotKey: unzulaessige Policy-Version "${pv}"`);
  return `${t}:${assistTag}:${slotKeyName}:${pv}`;
}

export function isoAus(ms) {
  return new Date(pruefeMs(ms)).toISOString();
}

export function msAus(iso) {
  if (typeof iso === "number") return Number.isFinite(iso) ? iso : NaN;
  if (typeof iso !== "string" || !iso) return NaN;
  return Date.parse(iso);
}

export const ZEIT = Object.freeze({ MINUTE, STUNDE, TAG });
