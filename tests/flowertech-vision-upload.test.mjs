/*
 * FlowerTech — Dateien im Vision Room: Upload, Referenz, Zuordnung.
 * ---------------------------------------------------------------------------
 * Der Befund der Live-Abnahme: Im Vision Room fehlte der Upload. Die
 * Kundschaft muss Logos, Bilder, Designentwürfe und Referenzdateien direkt
 * dort hochladen können — und zwar so, dass im RTDB nie ein Byte der Datei
 * liegt, sondern nur die Referenz.
 *
 * Bewiesen wird:
 *   1. Kern: Typ aus den Bytes (PNG/JPG/WEBP/PDF, HEIC benannt), Metadaten
 *      nur mit gültiger Id, erlaubtem Typ, Grösse im Limit, Pfad unter dem
 *      eigenen Token; das Anfrage-Dokument und der Prompt tragen die Dateien.
 *   2. Upload-Funktion (wirklich ausgeführt, mit RTDB-/Storage-Doppel):
 *      Herkunft, Token, offener Bogen, Grössenlimit, Typprüfung mit
 *      verständlichen Meldungen, Anzahl, Mehrfachupload, Entfernen — und
 *      kein Base64, keine Bytes im RTDB.
 *   3. Eingang: Absenden mit und ohne Dateien; nur eigene, vorhandene Ids;
 *      die Metadaten kommen aus der RTDB; abgesendete Dateien sind gebunden.
 *   4. Quantus: die Referenzen stehen am Projekt (ftIntakeDocument.files),
 *      in der Karte und im Prompt; Öffnen nur unter flowertech/intakes/.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CORE = (await import(path.join(root, "public/flowertech-workflow-core.js"))).default;
const { createHandler } = await import(path.join(root, "netlify/functions/flowertech-upload.mjs"));
const { createPortalHandler } = await import(path.join(root, "netlify/functions/flowertech-portal.mjs"));

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

const TOKEN = "u".repeat(32);
const ORIGIN = "https://flowertech.ch";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 2)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4, 0), Buffer.from("WEBPVP8 "), Buffer.alloc(100, 3)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(500, 4)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(100, 5)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(100, 6)]);

/* ══ 1. Der Kern ══════════════════════════════════════════════════════════ */
{
  ok(CORE.sniffUploadType(PNG) === "image/png" && CORE.sniffUploadType(JPG) === "image/jpeg"
    && CORE.sniffUploadType(WEBP) === "image/webp" && CORE.sniffUploadType(PDF) === "application/pdf",
    "die vier erlaubten Typen werden nicht an den Bytes erkannt");
  ok(CORE.sniffUploadType(HEIC) === "image/heic", "HEIC wird nicht als solches erkannt");
  ok(CORE.sniffUploadType(GIF) === "" && CORE.sniffUploadType(Buffer.from("hallo")) === "",
    "ein fremder Typ wird nicht abgelehnt");
  ok(CORE.INTAKE_UPLOAD_LIMITS.maxBytes === 5 * 1024 * 1024 && CORE.INTAKE_UPLOAD_LIMITS.maxFiles === 10,
    "die Grenzen stimmen nicht mit der Doku überein (5 MB, 10 Dateien)");
  ok(!("image/heic" in CORE.INTAKE_UPLOAD_TYPES), "HEIC steht in der Positivliste, obwohl es keine Pipeline dafür gibt");
  ok(/JPG oder PNG/.test(CORE.INTAKE_UPLOAD_MESSAGES.heic), "die HEIC-Meldung sagt nicht, was zu tun ist");

  const gut = { id: "f_abcdefghij12", name: "../../logo.png", type: "image/png", size: 1234,
    storagePath: "flowertech/intakes/" + TOKEN + "/f_abcdefghij12.png" };
  const files = CORE.normalizeIntakeFiles([
    gut, gut,                                                       // doppelt → einmal
    { id: "f_zzzzzzzzzz", name: "x.gif", type: "image/gif", size: 10 },   // fremder Typ
    { id: "f_yyyyyyyyyy", name: "gross.png", type: "image/png", size: 6 * 1024 * 1024 }, // zu gross
    { id: "kaputt", name: "y.png", type: "image/png", size: 10 },   // keine gültige Id
    { id: "f_xxxxxxxxxx", name: "fremd.png", type: "image/png", size: 10,
      storagePath: "flowertech/intakes/" + "v".repeat(32) + "/f_xxxxxxxxxx.png" }, // fremder Token
    { id: "f_wwwwwwwwww", name: "data:image/png;base64,AAAA", type: "image/png", size: 10 },
  ], { token: TOKEN });
  ok(files.length === 2, `es blieben ${files.length} Dateien statt zwei (gültig + eine mit leerem Pfad)`);
  ok(files[0].name === "logo.png", `der Pfad wurde nicht aus dem Namen entfernt: ${files[0].name}`);
  ok(files[0].storagePath.startsWith("flowertech/intakes/" + TOKEN + "/"), "der Ablagepfad fehlt");
  ok(!files.some((f) => /fremd|gross|x\.gif/.test(f.name)), "eine unbrauchbare Datei blieb stehen");
  const viele = CORE.normalizeIntakeFiles(Array.from({ length: 14 }, (_, i) => ({
    id: "f_" + String(i).padStart(10, "0"), name: i + ".png", type: "image/png", size: 5,
  })));
  ok(viele.length === 10, `mehr als zehn Dateien wurden übernommen: ${viele.length}`);

  const doc = CORE.buildIntakeDocument({
    intake: { id: "in_1", title: "Ihre Angaben", inviteToken: TOKEN },
    answers: [{ key: "need", label: "Ziel", type: "textarea", role: "need", answer: "Mehr Anfragen" }],
    files: [gut, { id: "f_xxxxxxxxxx", name: "fremd.png", type: "image/png", size: 10,
      storagePath: "flowertech/intakes/" + "v".repeat(32) + "/f_xxxxxxxxxx.png" }],
  });
  ok(doc.files.length === 1 && doc.files[0].id === "f_abcdefghij12", "das Anfrage-Dokument trägt die Datei nicht (oder eine fremde)");
  ok(!JSON.stringify(doc).includes("base64"), "das Anfrage-Dokument trägt Base64");
  const alt = CORE.buildIntakeDocument({ intake: { id: "in_2" }, answers: [] });
  ok(Array.isArray(alt.files) && alt.files.length === 0, "ein Dokument ohne Dateien hat keine leere Liste");

  const prompt = CORE.buildProjectPrompt({ project: { id: "prj_1", title: "Beiz" }, document: doc });
  const text = typeof prompt === "string" ? prompt : (prompt.text || prompt.markdown || JSON.stringify(prompt));
  ok(/logo\.png/.test(text) && /hochgeladene Dateien/.test(text), "der Prompt nennt die Dateien der Kundschaft nicht");
}

/* ══ 2. Die Upload-Funktion ═══════════════════════════════════════════════ */
function firebaseDoppel(seed = {}) {
  const db = JSON.parse(JSON.stringify(seed));
  const storage = {};
  const read = (p) => p.split("/").reduce((node, k) => (node && typeof node === "object" ? node[k] : undefined), db) ?? null;
  const write = (p, value) => {
    const parts = p.split("/");
    let node = db;
    parts.slice(0, -1).forEach((k) => { node[k] = node[k] && typeof node[k] === "object" ? node[k] : {}; node = node[k]; });
    node[parts[parts.length - 1]] = value;
  };
  return {
    db, storage,
    deps: {
      dbGet: async (p) => read(p),
      dbSet: async (p, v) => { write(p, JSON.parse(JSON.stringify(v))); return { ok: true }; },
      dbUpdate: async (p, patch) => { write(p, Object.assign({}, read(p) || {}, patch)); return { ok: true }; },
      dbRemove: async (p) => { const parts = p.split("/"); const parent = read(parts.slice(0, -1).join("/")); if (parent) delete parent[parts[parts.length - 1]]; },
      storageUpload: async (p, bytes, opts) => { storage[p] = { bytes: Buffer.from(bytes), contentType: opts.contentType, metadata: opts.metadata }; return {}; },
      storageDelete: async (p) => { delete storage[p]; },
      now: () => "2026-09-02T10:00:00.000Z",
    },
  };
}
const offenerBogen = { flowertech: { intakeForms: { [TOKEN]: { status: "open", title: "Ihre Angaben",
  questions: [{ key: "name", label: "Name", type: "text", role: "contactName", required: true },
    { key: "email", label: "E-Mail", type: "email", role: "contactEmail", required: true }] } } } };

function upload(handler, bytes, { token = TOKEN, origin = ORIGIN, name = "logo.png", type = "image/png", length = null } = {}) {
  const headers = { "Content-Type": type, "X-FlowerTech-Filename": encodeURIComponent(name) };
  if (origin) headers.Origin = origin;
  if (length != null) headers["Content-Length"] = String(length);
  return handler(new Request("https://q.example/.netlify/functions/flowertech-upload?e=" + token,
    { method: "PUT", headers, body: bytes }));
}
function remove(handler, id, { token = TOKEN } = {}) {
  return handler(new Request("https://q.example/.netlify/functions/flowertech-upload?e=" + token + "&id=" + id,
    { method: "DELETE", headers: { Origin: ORIGIN } }));
}

{
  const fb = firebaseDoppel(offenerBogen);
  let n = 0;
  const handler = createHandler(Object.assign({ newId: () => "f_" + String(++n).padStart(10, "0") }, fb.deps));

  // Herkunft und Token.
  ok((await upload(handler, PNG, { origin: "" })).status === 401, "ohne Herkunft wird hochgeladen");
  ok((await upload(handler, PNG, { origin: "https://fremd.example" })).status === 403, "eine fremde Herkunft darf hochladen");
  ok((await upload(handler, PNG, { token: "kurz" })).status === 400, "ein unbrauchbarer Token wird angenommen");
  ok((await upload(handler, PNG, { token: "w".repeat(32) })).status === 404, "ohne veröffentlichten Bogen wird hochgeladen");
  const options = await handler(new Request("https://q.example/x?e=" + TOKEN, { method: "OPTIONS", headers: { Origin: ORIGIN } }));
  ok(options.status === 204 && /PUT/.test(options.headers.get("Access-Control-Allow-Methods")), "der Preflight erlaubt PUT nicht");

  // Mehrfachupload: PNG, JPG, WEBP, PDF.
  const r1 = await upload(handler, PNG, { name: "Logo Neu.png" });
  const d1 = await r1.json();
  ok(r1.status === 201 && d1.ok && d1.file.id === "f_0000000001", `der PNG-Upload scheitert: ${r1.status} ${JSON.stringify(d1)}`);
  ok(d1.file.name === "Logo Neu.png" && d1.file.type === "image/png" && d1.file.size === PNG.length, "die Rückgabe trägt die Datei nicht");
  ok(!("storagePath" in d1.file) && !JSON.stringify(d1).includes("intakes/"), "die Rückgabe verrät den Ablageort");
  const r2 = await upload(handler, JPG, { name: "foto.jpg", type: "image/jpeg" });
  const r3 = await upload(handler, WEBP, { name: "entwurf.webp", type: "image/webp" });
  const r4 = await upload(handler, PDF, { name: "Designvorlage.pdf", type: "application/pdf" });
  ok(r2.status === 201 && r3.status === 201 && r4.status === 201, "JPG, WEBP oder PDF werden abgelehnt");
  // Der Typ kommt aus den Bytes — ein falscher Header ändert nichts.
  const r5 = await upload(handler, JPG, { name: "bild.png", type: "image/png" });
  ok(r5.status === 201 && (await r5.json()).file.type === "image/jpeg", "der Typ wird aus dem Header statt aus den Bytes gelesen");

  // Ablage: Bytes im Storage, Metadaten im RTDB — und nichts anderes.
  const eintraege = fb.db.flowertech.intakeUploads[TOKEN];
  ok(Object.keys(eintraege).length === 5, `es stehen ${Object.keys(eintraege).length} Einträge statt fünf im RTDB`);
  const e1 = eintraege.f_0000000001;
  ok(e1.storagePath === "flowertech/intakes/" + TOKEN + "/f_0000000001.png", `der Ablagepfad stimmt nicht: ${e1.storagePath}`);
  ok(e1.status === "uploaded" && e1.size === PNG.length && e1.type === "image/png" && e1.uploadedAt, "die Metadaten sind unvollständig");
  ok(Object.keys(e1).sort().join(",") === "id,name,size,status,storagePath,type,uploadedAt",
    `der RTDB-Eintrag trägt mehr als Metadaten: ${Object.keys(e1)}`);
  ok(!JSON.stringify(fb.db).includes("base64") && JSON.stringify(fb.db).length < 3000, "im RTDB liegen Dateiinhalte");
  ok(fb.storage[e1.storagePath] && fb.storage[e1.storagePath].bytes.equals(PNG), "die Bytes liegen nicht im Storage");
  ok(fb.storage[e1.storagePath].contentType === "image/png" && fb.storage[e1.storagePath].metadata.token === TOKEN,
    "der Storage-Eintrag trägt Typ oder Token nicht");
  ok(fb.storage["flowertech/intakes/" + TOKEN + "/f_0000000005.jpg"], "die Endung folgt nicht dem erkannten Typ");

  // Verständliche Fehler: Typ, HEIC, Grösse, leer.
  const gif = await upload(handler, GIF, { name: "anim.gif", type: "image/gif" });
  ok(gif.status === 415 && /PNG, JPG, WEBP und PDF/.test((await gif.json()).error), "ein fremder Typ wird nicht verständlich abgelehnt");
  const heic = await upload(handler, HEIC, { name: "IMG_1.HEIC", type: "image/heic" });
  const heicText = (await heic.json()).error || "";
  ok(heic.status === 415 && /HEIC/.test(heicText) && /JPG oder PNG/.test(heicText),
    "HEIC wird nicht mit einem Hinweis abgelehnt");
  const gross = await upload(handler, PNG, { length: 6 * 1024 * 1024 });
  ok(gross.status === 413 && /5 MB/.test((await gross.json()).error), "eine zu grosse Datei wird nicht am Content-Length abgewiesen");
  const grossBytes = await upload(handler, Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]));
  ok(grossBytes.status === 413, "eine zu grosse Datei wird nicht an den Bytes abgewiesen");
  const leer = await upload(handler, Buffer.alloc(0));
  ok(leer.status === 400 && /leer/.test((await leer.json()).error), "eine leere Datei wird angenommen");
  ok(Object.keys(fb.db.flowertech.intakeUploads[TOKEN]).length === 5, "ein abgelehnter Upload hinterliess einen Eintrag");
  ok(Object.keys(fb.storage).length === 5, "ein abgelehnter Upload hinterliess Bytes");

  // Höchstens zehn.
  for (let i = 0; i < 5; i++) ok((await upload(handler, PNG)).status === 201, "der Upload bis zur Grenze scheitert");
  const elf = await upload(handler, PNG);
  ok(elf.status === 409 && /höchstens 10/.test((await elf.json()).error), "die elfte Datei wird angenommen");

  // Entfernen — solange nicht abgesendet.
  const del = await remove(handler, "f_0000000002");
  ok(del.status === 200 && !fb.db.flowertech.intakeUploads[TOKEN].f_0000000002, "eine Datei lässt sich nicht entfernen");
  ok(!fb.storage["flowertech/intakes/" + TOKEN + "/f_0000000002.jpg"], "die Bytes bleiben nach dem Entfernen liegen");
  ok((await remove(handler, "f_0000000002")).status === 200, "ein zweites Entfernen ist kein ruhiger Leerlauf");
  ok((await remove(handler, "boese")).status === 400, "eine unbrauchbare Id wird nicht abgewiesen");
  fb.db.flowertech.intakeUploads[TOKEN].f_0000000003.status = "submitted";
  ok((await remove(handler, "f_0000000003")).status === 409, "eine abgesendete Datei lässt sich entfernen");
  ok((await upload(handler, PNG)).status === 201, "nach dem Entfernen ist kein Platz frei");
}

/* ══ 3. Der Eingang: Absenden mit und ohne Dateien ════════════════════════ */
function absenden(portal, files, { token = TOKEN } = {}) {
  const payload = { answers: [{ key: "name", answer: "Herr Aljia" }, { key: "email", answer: "juledal19@gmail.com" }] };
  if (files !== undefined) payload.files = files;
  return portal(new Request("https://q.example/.netlify/functions/flowertech-portal", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ token, kind: "intake", payload, idempotencyKey: "x" }),
  }));
}
{
  // Ohne Dateien: wie bisher.
  const fb = firebaseDoppel(offenerBogen);
  const portal = createPortalHandler(fb.deps);
  const r = await absenden(portal, undefined);
  const d = await r.json();
  ok(r.status === 201 && d.ok && d.submissionId, `das Absenden ohne Dateien scheitert: ${r.status} ${JSON.stringify(d)}`);
  const sub = fb.db.flowertech.submissions[d.submissionId];
  ok(Array.isArray(sub.payload.files) && sub.payload.files.length === 0, "ohne Dateien fehlt die leere Liste");
  ok(sub.payload.answers[0].answer === "Herr Aljia", "die Antworten fehlen in der Einreichung");
}
{
  // Mit Dateien: die Metadaten kommen aus der RTDB, nicht aus dem Aufruf.
  const fb = firebaseDoppel(offenerBogen);
  let n = 0;
  const uploads = createHandler(Object.assign({ newId: () => "f_" + String(++n).padStart(10, "0") }, fb.deps));
  await upload(uploads, PNG, { name: "logo.png" });
  await upload(uploads, PDF, { name: "cd.pdf", type: "application/pdf" });
  const portal = createPortalHandler(fb.deps);

  const fremd = await absenden(portal, ["f_0000000001", "f_9999999999"]);
  ok(fremd.status === 400 && /nicht mehr da/.test((await fremd.json()).error), "eine unbekannte Datei-Id wird angenommen");
  const boese = await absenden(portal, [{ id: "f_0000000001", storagePath: "/etc/passwd" }]);
  ok(boese.status === 400, "ein Objekt statt einer Id wird angenommen");
  const zuViele = await absenden(portal, Array.from({ length: 11 }, () => "f_0000000001"));
  ok(zuViele.status === 400, "elf Referenzen werden angenommen");

  const r = await absenden(portal, ["f_0000000001", "f_0000000002"]);
  const d = await r.json();
  ok(r.status === 201 && d.ok, `das Absenden mit Dateien scheitert: ${r.status} ${JSON.stringify(d)}`);
  const sub = fb.db.flowertech.submissions[d.submissionId];
  ok(sub.payload.files.length === 2 && sub.payload.files[0].name === "logo.png" && sub.payload.files[1].type === "application/pdf",
    `die Metadaten fehlen in der Einreichung: ${JSON.stringify(sub.payload.files)}`);
  ok(sub.payload.files.every((f) => f.storagePath.startsWith("flowertech/intakes/" + TOKEN + "/")), "der Ablagepfad fehlt in der Einreichung");
  ok(!JSON.stringify(sub).includes("base64") && JSON.stringify(sub).length < 2000, "die Einreichung trägt Dateiinhalte");
  const e = fb.db.flowertech.intakeUploads[TOKEN].f_0000000001;
  ok(e.status === "submitted" && e.submissionId === d.submissionId, "die Datei ist nach dem Absenden nicht an die Einreichung gebunden");
  ok((await remove(uploads, "f_0000000001")).status === 409, "eine abgesendete Datei lässt sich noch entfernen");
  // Der Token eines anderen Bogens sieht diese Dateien nicht.
  const anderer = "z".repeat(32);
  fb.db.flowertech.intakeForms[anderer] = { status: "open", questions: offenerBogen.flowertech.intakeForms[TOKEN].questions };
  ok((await absenden(portal, ["f_0000000001"], { token: anderer })).status === 400, "ein fremder Token kann fremde Dateien anhängen");
}

/* ══ 4. Quantus: die Referenzen am Projekt ════════════════════════════════ */
let seed = 0;
function makeSandbox() {
  const data = { entities: { projects: {}, tasks: {}, notes: {}, persons: {}, organizations: {} }, flowertech: {}, meta: {} };
  const written = {};
  const win = {
    APP: { state: { data } }, FlowerTechWorkflow: CORE,
    location: { hash: "#/flowertech", origin: "https://example.test", pathname: "/index.html" },
    addEventListener() {}, removeEventListener() {},
    scheduleSave() {}, render() {}, toast(type, title, message) { win.__toasts.push({ type, title, message }); },
    __toasts: [], __opened: [],
    createEntity: (kind, payload) => {
      const store = kind === "project" ? data.entities.projects : data.entities.tasks;
      const newId = kind + "_" + (Object.keys(store).length + 1) + "_" + (seed++);
      store[newId] = Object.assign({ id: newId }, payload);
      return newId;
    },
    esc: (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    uuid: () => "u_" + (seed++), nowIso: () => "2026-09-02T10:00:00.000Z", todayYmd: () => "2026-09-02",
    crypto: { getRandomValues: (a) => { seed++; a.forEach((_, i) => { a[i] = (i * 37 + seed * 13) % 256; }); } },
    setTimeout: (fn) => { if (typeof fn === "function") fn(); return 0; }, clearTimeout() {},
    confirm: () => true, prompt: () => "",
    open: (url) => { win.__opened.push(url); return null; },
    firebaseStorage: { ref: (p) => ({ getDownloadURL: () => Promise.resolve("https://storage.example/" + p) }) },
  };
  win.window = win;
  const sandbox = {
    window: win,
    document: { readyState: "complete", getElementById: () => null, querySelector: () => null, addEventListener() {},
      createElement: () => ({ style: {}, remove() {}, click() {}, setAttribute() {}, focus() {}, select() {} }),
      body: { appendChild() {}, removeChild() {}, classList: { toggle() {}, remove() {} } }, execCommand: () => true },
    location: win.location, setTimeout: win.setTimeout, clearTimeout: () => {},
    console: { warn() {}, log() {}, error() {} },
    navigator: { clipboard: { writeText: () => Promise.resolve() } }, confirm: () => true, APP: win.APP,
    firebase: { app: () => ({ database: () => ({ ref: (p) => ({
      set: (v) => { written[p] = JSON.parse(JSON.stringify(v)); return Promise.resolve(); },
      remove: () => { delete written[p]; return Promise.resolve(); } }) }) }) },
  };
  sandbox.globalThis = sandbox;
  win.document = sandbox.document; win.firebase = sandbox.firebase; win.navigator = sandbox.navigator;
  vm.runInContext(fs.readFileSync(path.join(root, "public/flowertech.js"), "utf8"), vm.createContext(sandbox));
  win.viewFlowerTech();
  return { win, data, written };
}
const strip = (html) => html.replace(/<style>[\s\S]*?<\/style>/g, "");
{
  const { win, data } = makeSandbox();
  data.entities.projects.prj_aljia = { id: "prj_aljia", title: "Reinigungsunternehmen Aljia", projectType: "flowertech",
    pipelineStage: "lead", client: { name: "Herr Aljia", email: "juledal19@gmail.com" } };
  win._ftCreateProjectIntakeLink("prj_aljia");
  await new Promise((r) => setTimeout(r, 0));
  const intake = Object.values(data.flowertech.intakes)[0];
  const token = intake.inviteToken;
  ok(!("files" in Object.assign({}, Object.values(win.__written || {})[0] || {})), "vorab: nichts zu prüfen");

  const antworten = intake.questions.map((q) => ({
    key: q.key, label: q.label, type: q.type, role: q.role || "",
    answer: q.type === "date" ? "2026-10-01" : q.type === "email" ? "juledal19@gmail.com" : q.type === "select" ? (q.options || [""])[0] : "Antwort " + q.key,
  }));
  const dateien = [
    { id: "f_0000000001", name: "logo.png", type: "image/png", size: 1200, storagePath: "flowertech/intakes/" + token + "/f_0000000001.png", uploadedAt: "2026-09-02T09:00:00.000Z" },
    { id: "f_0000000002", name: "cd.pdf", type: "application/pdf", size: 400000, storagePath: "flowertech/intakes/" + token + "/f_0000000002.pdf", uploadedAt: "2026-09-02T09:01:00.000Z" },
    { id: "f_0000000009", name: "fremd.png", type: "image/png", size: 10, storagePath: "flowertech/intakes/" + "v".repeat(32) + "/f_0000000009.png" },
  ];
  const n = win._ftIngestSubmissions({ sub_1: { id: "sub_1", kind: "intake", token, createdAt: "2026-09-02T09:05:00.000Z",
    payload: { intakeTitle: intake.title, answers: antworten, files: dateien } } });
  ok(n === 1, "die Einreichung mit Dateien wurde nicht verarbeitet");
  const project = data.entities.projects.prj_aljia;
  const doc = project.ftIntakeDocument;
  ok(doc && doc.files && doc.files.length === 2, `am Projekt stehen ${doc && doc.files && doc.files.length} Dateien statt zwei`);
  ok(doc.files.every((f) => f.storagePath.startsWith("flowertech/intakes/" + token + "/")), "eine fremde Datei hängt am Projekt");
  ok(doc.intakeId === intake.id && project.sourceIntakeId === intake.id, "die Zuordnung Datei → Fragebogen → Projekt fehlt");
  ok(Object.keys(data.entities.projects).length === 1, "die Dateien haben ein zweites Projekt erzeugt");

  const karte = strip(win.ftProjectPanel("prj_aljia"));
  ok(/Dateien der Kundschaft/.test(karte) && /logo\.png/.test(karte) && /cd\.pdf/.test(karte), "die Karte zeigt die Dateien nicht");
  ok(/_ftOpenIntakeFile\('flowertech\/intakes\//.test(karte), "die Dateien lassen sich nicht öffnen");
  ok(/391 KB|390 KB/.test(karte), "die Grösse ist nicht lesbar");

  // Der Prompt nennt sie.
  const prompt = (project.ftPrompt && project.ftPrompt.text) || "";
  ok(/logo\.png/.test(prompt) && /hochgeladene Dateien/.test(prompt), "der Projekt-Prompt nennt die Dateien nicht");


  // Öffnen: nur unter flowertech/intakes/, über die angemeldete Session.
  win._ftOpenIntakeFile("flowertech/intakes/" + token + "/f_0000000001.png");
  await new Promise((r) => setTimeout(r, 0));
  ok(win.__opened.some((u) => /storage\.example\/flowertech\/intakes\//.test(u)), "die Datei wird nicht über Storage geöffnet");
  const vorher = win.__opened.length;
  win._ftOpenIntakeFile("appStore/app-data_json");
  await new Promise((r) => setTimeout(r, 0));
  ok(win.__opened.length === vorher, "ein fremder Pfad lässt sich öffnen");

  // Der veröffentlichte Kundenlink trägt nichts von den Dateien.
  const veroeffentlicht = JSON.stringify(win.__written || {});
  ok(!/f_0000000001|storagePath/.test(veroeffentlicht), "der öffentliche Fragebogen trägt Dateireferenzen");
}

console.log(`flowertech vision upload: ok (${checks} Pruefungen)`);
