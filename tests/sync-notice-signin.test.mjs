/*
 * Der Anmeldeknopf im Hinweisstreifen tat nichts.
 *
 * BEFUND (Bildschirmfoto vom Livelauf, im Browser nachgestellt): oben stand
 * "Sign-in required — data is not being synchronised" mit einem Knopf
 * "Sign in". Der Knopf liess sich anklicken — elementFromPoint in seiner
 * Mitte trifft ihn, das pointer-events:auto auf .sn-link greift durch das
 * pointer-events:none des Streifens —, nur passierte nichts.
 *
 * Er war ein Link auf die Ansicht, in die er schickt:
 *
 *     el.innerHTML = … + '<a class="sn-link" href="#/drive"></a>';
 *
 * Der Streifen fuehrt nach #/drive, und wer ihn dort anklickt, steht schon
 * dort. Ein Link auf denselben Hash loest kein hashchange aus. Gemessen:
 * Hash vorher #/drive, Hash nachher #/drive, kein Rendern, nichts.
 *
 * Und selbst von anderswo meldete er nicht an. Er brachte einen in die
 * Drive-Ansicht, wo der eigentliche Login unten links in einem IFRAME sitzt —
 * der schlechtesten denkbaren Stelle. drive.html vermerkt das selbst:
 *
 *     // Redirect-Fallback nur top-level — im eingebetteten Iframe verweigert
 *     // Google die Darstellung (X-Frame-Options).
 *
 * Ein blockiertes Popup endet dort also in einer Sackgasse
 * (auth/operation-not-supported-in-this-environment).
 *
 * Die Hauptapp laedt firebase-auth-compat ohnehin und laeuft top-level. Der
 * Streifen meldet jetzt selbst an: Popup, bei Blockade Redirect. Geprueft
 * wird die ECHTE Funktion quantusSignIn aus index.html gegen Attrappen.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const drive = fs.readFileSync(path.join(root, "public/drive.html"), "utf8");

let checks = 0;
const luecken = [];
const ok = (b, t) => { checks++; if (!b) luecken.push(t); };

// ═══ 1. Der Streifen traegt einen Knopf, keinen Link auf sich selbst ═══
{
  const a = index.indexOf("function updateSyncChip() {");
  ok(a > 0, "updateSyncChip wurde nicht gefunden");
  const rumpf = index.slice(a, index.indexOf("\n}\n", a));
  ok(!/<a class="sn-link" href="#\/drive">/.test(rumpf),
    'DER BEFUND: der Streifen zeichnet wieder <a href="#/drive"> — auf #/drive, wohin er selbst schickt, tut das nichts');
  ok(/<button type="button" class="sn-link">/.test(rumpf),
    "der Anmeldeknopf ist kein <button> — ein Link kann nur navigieren, und zwar dorthin, wo man schon ist");
  ok(/addEventListener\('click'/.test(rumpf), "am Knopf haengt kein Klick-Hoerer");
  ok(/quantusSignIn\(\)/.test(rumpf), "der Knopf ruft nicht quantusSignIn — er tut wieder nichts");
  ok(/link\.disabled = true/.test(rumpf), "der Knopf sperrt sich waehrend der Anmeldung nicht — zwei Klicks, zwei Popups");
  // Der Streifen bleibt sonst, was er war.
  ok(/authRequiredSticky\(\)/.test(rumpf), "der Streifen liest den Anmeldemangel nicht mehr aus dem eigenen Flag");
  ok(/sn-dot/.test(rumpf) && /sn-text/.test(rumpf), "Punkt oder Text des Streifens fehlen");
}

// ═══ 2. Der Knopf ist auch als <button> anklickbar und lesbar ═══════════
{
  const css = index.slice(index.indexOf("#syncNotice{"), index.indexOf("#syncNotice.sn-warn"));
  ok(/#syncNotice\{[^}]*pointer-events:none/.test(css),
    "der Streifen faengt wieder Klicks fuer die ganze Breite ab");
  const linkRegel = (/#syncNotice \.sn-link\{([^}]*)\}/.exec(css) || [])[1] || "";
  ok(/pointer-events:auto/.test(linkRegel),
    "DER BEFUND WAERE ZURUECK: ohne pointer-events:auto ist der Knopf im pointer-events:none-Streifen wirklich nicht klickbar");
  ok(/font-family:inherit/.test(linkRegel) && /font-size:inherit/.test(linkRegel),
    "ein <button> erbt die Schrift nicht von selbst — er faellt sonst auf die Systemschrift zurueck");
  ok(/cursor:pointer/.test(linkRegel), "der Knopf sieht nicht nach Knopf aus");
  ok(/background:transparent/.test(linkRegel), "der Knopf traegt den grauen Vorgabe-Hintergrund des Browsers");
  ok(/#syncNotice \.sn-link\[disabled\]/.test(css), "der gesperrte Zustand ist nicht sichtbar");
}

// ═══ 3. Die ECHTE quantusSignIn gegen Attrappen ════════════════════════
{
  const a = index.indexOf("function signInFehlerText(e) {");
  const b = index.indexOf("window.quantusSignIn = quantusSignIn;");
  ok(a > 0 && b > a, "DER BEFUND: es gibt keine Anmeldefunktion — der Streifen kann nur weiterleiten");
  ok(/window\.quantusSignIn = quantusSignIn;/.test(index),
    "quantusSignIn haengt nicht an window — aus einem anderen Script-Block waere sie unsichtbar");

  if (a > 0 && b > a) {
    const quelle = index.slice(a, b);
    const bau = (opts) => {
      const ruf = [];
      const nutzer = { uid: "u1", email: "a@b.ch" };
      const auth = {
        currentUser: null,
        signInWithPopup: async () => {
          ruf.push("popup");
          if (opts.wirft) { const e = new Error("x"); e.code = opts.wirft; throw e; }
          return { user: nutzer };
        },
        signInWithRedirect: async () => { ruf.push("redirect"); },
      };
      const fenster = {
        firebase: opts.keinSdk ? undefined : Object.assign(
          { auth: Object.assign(() => auth, { GoogleAuthProvider: function () {} }) }, {}),
        location: { hash: opts.hash || "#/drive" },
      };
      const gerufen = { note: [], chip: 0, resync: [], toast: [], render: 0, navigate: [] };
      const fn = new Function(
        "window", "firebase", "location", "console", "toast", "initFirebaseNow",
        "noteCoreAuthState", "updateSyncChip", "resyncAfterAuth", "render", "navigate",
        quelle + "\nreturn quantusSignIn;"
      )(
        fenster, fenster.firebase, fenster.location, { error() {}, warn() {} },
        (...x) => gerufen.toast.push(x), () => {},
        (u) => gerufen.note.push(u), () => { gerufen.chip++; },
        (r) => gerufen.resync.push(r), () => { gerufen.render++; },
        (r) => { gerufen.navigate.push(r); fenster.location.hash = "#/" + r; }
      );
      return { fn, ruf, gerufen, fenster };
    };

    // a) Normalfall: Popup, danach faellt der Hinweis
    {
      const u = bau({});
      const r = await u.fn();
      ok(r && r.ok === true, "die Anmeldung meldet keinen Erfolg: " + JSON.stringify(r));
      ok(u.ruf.join(",") === "popup", "es wird nicht per Popup angemeldet, sondern: " + u.ruf.join(","));
      ok(u.gerufen.note.length === 1 && u.gerufen.note[0], "der Anmeldezustand wird nicht nachgetragen — der Hinweis bliebe stehen");
      ok(u.gerufen.chip === 1, "der Streifen wird nach der Anmeldung nicht neu gezeichnet");
      ok(u.gerufen.resync.length === 1, "der Kern-Abgleich wird nicht nachgeholt — angemeldet, aber weiter ohne Daten");
      ok(u.gerufen.toast.length === 1 && u.gerufen.toast[0][0] === "ok", "kein Erfolgshinweis");
    }

    // b) Popup blockiert -> Redirect. GENAU das kann drive.html im Iframe nicht.
    {
      const u = bau({ wirft: "auth/popup-blocked" });
      const r = await u.fn();
      ok(u.ruf.join(",") === "popup,redirect",
        "DER BEFUND: bei blockiertem Popup gibt es keinen Ausweg — der Aufrufweg: " + u.ruf.join(","));
      ok(r && r.ok === true && r.reason === "redirect", "der Redirect wird nicht als Erfolg gemeldet");
      ok(u.gerufen.toast.length === 0, "ein Redirect ist kein Fehler und braucht keine Fehlermeldung");
    }

    // c) Bewusst abgebrochen ist kein Fehler
    {
      const u = bau({ wirft: "auth/popup-closed-by-user" });
      const r = await u.fn();
      ok(r && r.ok === false && r.reason === "cancelled", "ein Abbruch wird nicht als Abbruch gemeldet");
      ok(u.gerufen.toast.length === 0, "wer das Fenster schliesst, bekommt eine Fehlermeldung vorgesetzt");
    }

    // d) Echter Fehler: Meldung, aber kein Absturz
    {
      const u = bau({ wirft: "auth/unauthorized-domain" });
      const r = await u.fn();
      ok(r && r.ok === false, "ein Fehler wird als Erfolg gemeldet");
      ok(u.gerufen.toast.length === 1 && u.gerufen.toast[0][0] === "error", "der Fehler wird verschwiegen");
      ok(/Autorisierte Domains/.test(u.gerufen.toast[0][2] || ""),
        "die Meldung nennt die Ursache nicht: " + JSON.stringify(u.gerufen.toast[0]));
    }

    // e) Ohne SDK der alte Weg — und auf #/drive muss neu gezeichnet werden,
    //    sonst ist der Knopf genau so tot wie vorher.
    {
      const u = bau({ keinSdk: true, hash: "#/drive" });
      const r = await u.fn();
      ok(r && r.reason === "no_sdk", "ohne SDK wird nicht der alte Weg gegangen");
      ok(u.gerufen.render === 1,
        "DER BEFUND IN KLEIN: ohne SDK und schon auf #/drive passiert wieder nichts — es wird nicht neu gezeichnet");
    }
    {
      const u = bau({ keinSdk: true, hash: "#/tasks" });
      await u.fn();
      ok(u.gerufen.navigate.join(",") === "drive", "ohne SDK fuehrt der Knopf nicht in die Drive-Ansicht");
      ok(u.gerufen.render === 0, "nach echtem Routenwechsel wird zusaetzlich von Hand gerendert");
    }

    // f) Zwei Klicks, ein Popup
    {
      const u = bau({});
      const beide = await Promise.all([u.fn(), u.fn()]);
      ok(u.ruf.filter((x) => x === "popup").length === 1,
        "zwei Klicks oeffnen zwei Anmeldefenster");
      ok(beide.some((r) => r && r.reason === "busy"), "der zweite Aufruf meldet nicht, dass schon einer laeuft");
    }
  }
}

// ═══ 4. Die Rueckkehr aus dem Redirect wird abgeschlossen ══════════════
{
  const a = index.indexOf("function initFirebaseNow() {");
  const rumpf = index.slice(a, index.indexOf("\n}\n", a));
  ok(/getRedirectResult\(\)/.test(rumpf),
    "DER BEFUND: der Redirect-Rueckweg wird nicht abgeschlossen — ein Fehler von dort verschwindet still, und man steht wieder vor demselben Streifen");
  ok(/onAuthStateChanged/.test(rumpf), "der Anmeldezustand wird nicht mehr mitgeschrieben");
}

// ═══ 5. Die Annahmen ueber drive.html stimmen noch ═════════════════════
{
  ok(/X-Frame-Options/.test(drive),
    "die Annahme stimmt nicht mehr: drive.html kennt die Iframe-Grenze des Redirects nicht");
  ok(/signInWithPopup/.test(drive), "drive.html meldet sich nicht mehr per Popup an");
  ok(/viewDrive\(\)[\s\S]{0,200}<iframe/.test(index),
    "die Annahme stimmt nicht mehr: die Drive-Ansicht ist kein Iframe mehr — dann waere der Umweg dorthin wieder gangbar");
}

if (luecken.length) {
  console.error("SYNC-NOTICE ANMELDUNG — " + luecken.length + " von " + checks + " Pruefungen:");
  luecken.forEach((l) => console.error("   - " + l));
  process.exit(1);
}
console.log(`sync-notice anmeldung: ok (${checks} Pruefungen)`);
