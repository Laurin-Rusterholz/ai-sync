# Quantus No-Braine — Weekly Meal Planner

Single-File-Modul **`public/nobraine.html`** (CSS + JS inline, kein Build, keine
Frameworks ausser dem Firebase-SDK via CDN). Der Wochen-Menüplaner verwaltet
eine durchsuchbare Rezept-Bibliothek, plant je Wochentag Mittag- und
Abendessen (Frühstück bleibt Routine), aggregiert daraus eine Einkaufsliste,
trackt tägliche Gewohnheiten und stösst die automatische
Wochen-Generierung über einen **n8n-Webhook** an. Alle Daten liegen unter dem
RTDB-Pfad-Root **`/nobraine/`**.

Konventionen exakt wie `public/drive.html`: IIFE-Scope (kein globaler
Namespace), Event-Delegation über `data-action`-Attribute, `toast()` für
sämtliches Feedback, Design-System „Schiefer/Leinen", Firebase compat v10.8.0,
Anonymous Auth, Sprache Hochdeutsch mit Schweizer Schreibweise (ss statt ß),
responsive & mobile-first.

- Firebase-Projekt: `jupidu-36804`
- RTDB: `https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app`
- SDK: Firebase **compat v10.8.0** (`app`, `auth`, `database`)
- Auth: **Anonymous Auth** (`firebase.auth().signInAnonymously()`), Regel-Gate `auth != null`
- Navigation: registriert in `public/index.html` unter `getAllApps()`
  (`key: "nobraine"`, Icon 🍽️, Label „No-Braine") sowie im Routing-`switch`
  von `renderMain()` (`case "nobraine": window.location.href = "nobraine.html"`).

## Datenmodell (RTDB)

Rezepte (`nobraine/recipes`), Gewohnheits-Definitionen (`nobraine/habitdefs`)
und das tägliche Gewohnheits-Log (`nobraine/habits`) liegen global; alle
wochenbezogenen Daten sind je Kalenderwoche unter `nobraine/weeks/<jahr-kw>/`
gruppiert.

| Pfad | Inhalt |
|---|---|
| `nobraine/recipes/<id>` | `{ name, kategorie ("mittag"\|"abend"), portionen, kochzeitMin, zutaten:[{ menge, einheit, name }], schritte:[…], tags:[…], lastUsed (ISO-Datum\|null), erstellt, aktualisiert }` |
| `nobraine/habitdefs/<id>` | `{ name, icon, sort, aktiv, erstellt }` — Definition einer Gewohnheit |
| `nobraine/habits/<datum>/<habitId>` | `true` — Tages-Log: an diesem Tag (ISO-Datum `YYYY-MM-DD`) erledigte Gewohnheit |
| `nobraine/weeks/<weekKey>/meals/<tag>/<slotKey>` | `recipeId` (String) — Zuweisung eines Rezepts zu einem Mahlzeiten-Slot |
| `nobraine/weeks/<weekKey>/freeblocks/<tag>/<slotKey>` | `{ label, erstellt }` — bewusst freigehaltener Slot (auswärts, Resten, kein Kochen); wird bei der Generierung übersprungen und liefert nichts an die Einkaufsliste |
| `nobraine/weeks/<weekKey>/shoppinglist/<key>` | `{ checked, manuell, name, einheit, menge }` — Check-Zustand aggregierter Positionen sowie manuell ergänzte Artikel |
| `nobraine/weeks/<weekKey>/generation` | `{ status ("pending"\|"running"\|"done"\|"error"), typ ("woche"\|"slot"), angefragt, finishedAt, message, tag?, slot? }` |

- `weekKey` (= `<jahr-kw>`): ISO-Woche, Format `YYYY-Www` (z. B. `2026-W27`). Wochenbeginn Montag.
- `<tag>`: Wochentags-Key `montag` … `sonntag`.
- `slotKey`: `mittag` · `abend` — nur Mittag- und Abendessen werden geplant.

### Ableitungen im Frontend (kein zusätzlicher Persistenz-Zweig)

- **Einkaufsliste** wird bei jedem Render aus dem Wochenplan berechnet: alle
  Zutaten der eingeplanten Rezepte werden nach `Name + Einheit` **dedupliziert**
  und die Mengen summiert (`num()`-Parser inkl. Komma und Brüchen wie `1/2`).
  Persistiert wird nur der Abhak-Zustand (`checked`) je aggregiertem Schlüssel
  sowie manuell ergänzte Artikel (`manuell: true`).
- **`lastUsed`** wird beim Einplanen auf das Datum des jeweiligen Slots gesetzt.
  Die Bibliothek sortiert selten/nie verwendete Rezepte nach vorne und markiert
  kürzlich (≤ 10 Tage) verwendete rot — so werden Wiederholungen sichtbar
  vermieden. Im Tausch-/Slot-Dialog erscheinen zur Slot-Kategorie passende
  Rezepte zuerst.
- **Freiblöcke** sind der dritte Slot-Zustand neben „Rezept" und „leer": ein
  Slot lässt sich bewusst freihalten (auswärts, Resten, Einladung, kein Kochen;
  Grund frei editierbar). Rezept und Freiblock schliessen sich gegenseitig aus
  (das Setzen des einen entfernt das andere). Freigehaltene Slots werden im
  Generierungs-Payload (`freeblocks: [{ tag, slot, label }]`) mitgeschickt, von
  n8n übersprungen und tragen nichts zur Einkaufsliste bei.
- **Gewohnheiten** sind ein tagesbasierter Habit-Tracker, unabhängig vom
  Menüplan. Die Ansicht zeigt eine Matrix (Zeilen = Gewohnheiten, Spalten = Mo–So
  der gewählten Woche); eine Zelle abhaken schreibt `habits/<datum>/<habitId> =
  true`, erneutes Tippen entfernt den Eintrag. Je Gewohnheit wird die aktuelle
  Serie (aufeinanderfolgende erledigte Tage bis heute, `🔥 N`) aus dem Log
  berechnet. Gewohnheiten sind frei anlegbar/bearbeitbar/löschbar (`habitdefs`);
  beim Löschen werden auch die zugehörigen Tages-Log-Einträge aufgeräumt. Beim
  ersten Start werden vier Standard-Gewohnheiten geseedet (nur falls leer).

## Generierung via n8n-Webhook

Im Gegensatz zum Drive-Modul (RTDB-Queue) nutzt No-Braine einen **push-basierten
Webhook**. Die Konstante `WEBHOOK_URL` in `nobraine.html` ist ein **Platzhalter**
und muss auf den eigenen n8n-Webhook gesetzt werden.

Ablauf „Woche generieren" bzw. „Slot neu generieren":

1. Frontend schreibt `nobraine/weeks/<weekKey>/generation` mit `status: "pending"`.
2. Frontend `POST`et an `WEBHOOK_URL` mit JSON-Payload:
   - Woche: `{ weekKey, startDatum, tage: 7, slots: ["mittag","abend"], freeblocks: [{ tag, slot, label }], typ: "woche" }`
   - Einzelner Slot: `{ …, typ: "slot", tag: <0-6>, slot: "<slotKey>", tagName }`
3. n8n verarbeitet die Anfrage, wählt/erzeugt Rezepte, schreibt sie nach
   `nobraine/weeks/<weekKey>/meals/…` (fehlende Rezepte zusätzlich nach
   `nobraine/recipes`) und aktualisiert `nobraine/weeks/<weekKey>/generation`
   auf `running` und schliesslich `done` (mit `finishedAt`).
4. Das Frontend zeigt den Fortschritt live über `on('value')` auf `plan`,
   `recipes` und `generation` der aktiven Woche — Ladezustand (Spinner +
   Statuszeile) inklusive.

Schlägt der `POST` fehl (z. B. weil `WEBHOOK_URL` noch der Platzhalter ist),
setzt das Frontend `generation.status = "error"` mit erklärender `message` und
zeigt einen Toast — nichts bleibt stumm hängen. Der Service-Account von n8n
umgeht die `auth != null`-Regeln; das Frontend meldet sich anonym an.

## Firebase-Security-Rules

Block aus `firebase/database.rules.json` übernehmen. Der gesamte
`nobraine`-Teilbaum wird mit `auth != null` gegated (analog zum Drive-Block).
Wie dort gilt: **kein** `.read`/`.write` auf Wurzelebene stehen lassen — eine
Erlaubnis am Elternknoten vererbt sich in der RTDB nach unten und würde das Gate
aushebeln. `nobraine/recipes` trägt `.indexOn: ["kategorie","lastUsed"]` als
Vorbereitung für spätere gefilterte REST-Queries.

**Anonymous Auth** muss im Firebase-Projekt aktiviert sein (Konsole →
Authentication → Sign-in method → „Anonym"). Ohne diesen Schritt bleibt das
Modul bei „Anmeldung fehlgeschlagen" stehen.

## Erst-Seed der Bibliothek

Beim allerersten Start (nur falls `nobraine/recipes` **leer** ist) legt das
Frontend einmalig zehn Starter-Rezepte an (je fünf Mittag- und Abendgerichte,
mit Zutaten samt Mengen und Schritten). Bestehende Daten werden nie
überschrieben oder migriert.

## Sicherheit

- Im Frontend liegt ausschliesslich die öffentliche Firebase-Web-Config (wie in
  `index.html`/`drive.html`); es gibt keine Secrets im Client.
- Der n8n-Webhook-Endpunkt (`WEBHOOK_URL`) und dessen Service-Account/API-Keys
  existieren nur in n8n, nicht im Repo.

## Testanleitung

1. `public/nobraine.html` öffnen (lokal via `npx serve public` oder über das
   Netlify-Deployment; oder in der Hauptapp über die App „No-Braine"). Unten
   links muss „Verbunden (anonym)" mit grünem Punkt stehen. Beim ersten Start
   erscheinen die Starter-Rezepte in der Bibliothek.
2. **Rezepte:** In „Rezepte" ein Rezept anklicken → Drawer mit vollständigem
   Rezept (Zutaten mit Mengen, nummerierte Schritte, Portionen, Kochzeit).
   Suche nach Name/Zutat/Tag testen; Kategorie-Filter testen. „＋ Neues Rezept"
   anlegen und wieder bearbeiten/löschen.
3. **Wochenplan:** Leeren Slot antippen → Rezept aus der Bibliothek wählen
   (passende Kategorie zuerst), „🚫 Freihalten" oder „Slot generieren". Gefüllten
   Slot antippen → Drawer mit „Rezept tauschen", „Neu generieren", „Freihalten",
   „Aus Plan entfernen". Wochennavigation (‹ ›, „Aktuelle Woche") prüfen —
   Plan/Einkauf/Status folgen der gewählten Woche live.
4. **Freiblöcke:** Slot freihalten (Grund per Preset oder frei eingeben) → Slot
   zeigt „🚫 Frei · <Grund>". Erneut antippen öffnet den Dialog zum Ändern oder
   „Freigabe aufheben". Ein danach gesetztes Rezept ersetzt den Freiblock und
   umgekehrt; freigehaltene Slots erscheinen nicht in der Einkaufsliste.
5. **Generierung:** „🎲 Woche generieren" → Statuszeile „Anfrage gesendet …"
   und `nobraine/weeks/<weekKey>/generation.status == "pending"` in der RTDB. Mit gesetztem
   `WEBHOOK_URL` schreibt n8n den Plan; das Gitter aktualisiert sich live. Ohne
   gültige URL erscheint der Fehlerhinweis (kein stilles Verschlucken).
6. **Einkaufsliste:** Nach dem Befüllen des Plans zeigt „Einkaufsliste" die
   aggregierte, deduplizierte Wochenliste. Positionen abhaken (Zustand
   persistiert, Badge in der Navigation zählt offene Posten), manuell Artikel
   ergänzen (Enter oder „＋ Hinzufügen"), „Erledigte entfernen".
7. **Gewohnheiten:** In „Gewohnheiten" erscheinen die Standard-Gewohnheiten als
   Matrix über die Woche. Zellen abhaken (Schreiben nach `habits/<datum>/…`,
   Serie `🔥 N` aktualisiert sich), „＋ Gewohnheit" anlegen (Name + Symbol),
   Namen anklicken zum Bearbeiten/Löschen. Wochennavigation (‹ ›) blättert die
   Matrix durch die Wochen.
