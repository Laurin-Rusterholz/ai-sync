# Quantus No-Braine — Weekly Meal Planner

Single-File-Modul **`public/nobraine.html`** (CSS + JS inline, kein Build, keine
Frameworks ausser dem Firebase-SDK via CDN). Der Wochen-Menüplaner verwaltet
eine durchsuchbare Rezept-Bibliothek (KI-generiert **oder von Hand erfasst**),
plant je Wochentag Mittag- und Abendessen sowie einen **täglichen Smoothie**
(Frühstück bleibt Routine), aggregiert daraus eine Einkaufsliste,
führt je Tag eine Termin-Agenda, trackt tägliche Gewohnheiten und stösst die
automatische
Wochen-Generierung über einen **n8n-Webhook** an. Alle Daten liegen unter dem
RTDB-Pfad-Root **`/nobraine/`**.

Konventionen exakt wie `public/drive.html`: IIFE-Scope (kein globaler
Namespace), Event-Delegation über `data-action`-Attribute, `toast()` für
sämtliches Feedback, Design-System „Schiefer/Leinen", Firebase compat v10.8.0,
Google-Login (`signInWithPopup`) mit UID-gegateten Rules, Sprache Hochdeutsch mit
Schweizer Schreibweise (ss statt ß), responsive & mobile-first.

- Firebase-Projekt: `jupidu-36804`
- RTDB: `https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app`
- SDK: Firebase **compat v10.8.0** (`app`, `auth`, `database`)
- Auth: **kein erzwungener Login** — `/nobraine` ist offen (`.read/.write: true`), die App bootet und liest/schreibt ohne User. Optionaler Google-Login (Footer) nur für die auth-geschützten Quantus-Daten (`appStore`).
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
| `nobraine/recipes/<id>` | `{ name, kategorie ("mittag"\|"abend"\|"smoothie"), portionen, kochzeitMin, zutaten:[{ menge, einheit, name }], schritte:[…], tags:[…], lastUsed (ISO-Datum\|null), erstellt, aktualisiert }` |
| `nobraine/habitdefs/<id>` | `{ name, icon, sort, aktiv, erstellt }` — Definition einer Gewohnheit |
| `nobraine/habits/<datum>/<habitId>` | `true` — Tages-Log: an diesem Tag (ISO-Datum `YYYY-MM-DD`) erledigte Gewohnheit |
| `nobraine/weeks/<weekKey>/meals/<tag>/<slotKey>` | `recipeId` (String) — Zuweisung eines Rezepts zu einem Mahlzeiten-Slot |
| `nobraine/weeks/<weekKey>/calendar/<tag>/<id>` | `{ zeit, titel, notiz, erledigt, erstellt }` — Termin/Agenda-Eintrag des Tages (Zeit optional = ganztags) |
| `nobraine/weeks/<weekKey>/freeblocks/<tag>/<slotKey>` | `{ label, erstellt }` — bewusst freigehaltener Slot (auswärts, Resten, kein Kochen); wird bei der Generierung übersprungen und liefert nichts an die Einkaufsliste |
| `nobraine/weeks/<weekKey>/shoppinglist/<key>` | `{ checked, manuell, name, einheit, menge }` — Check-Zustand aggregierter Positionen sowie manuell ergänzte Artikel |
| `nobraine/weeks/<weekKey>/generation` | `{ status ("pending"\|"running"\|"done"\|"error"), typ ("woche"\|"slot"), angefragt, finishedAt, message, tag?, slot? }` |
| `nobraine/weeks/<weekKey>/prefs` | `{ goal ("lose"\|"maintain"\|"gain"), calorieTrend ("less"\|"normal"\|"more"), trainingDays: [<kurz-key>…] }` — Steuer-Eingaben der Generierung je Woche. `trainingDays` sind Kurz-Keys `mon`…`sun`. Defaults (fehlend): `maintain` / `normal` / `[]`. |

- `weekKey` (= `<jahr-kw>`): ISO-Woche, Format `YYYY-Www` (z. B. `2026-W27`). Wochenbeginn Montag.
- `<tag>`: Wochentags-Key `montag` … `sonntag`.
- `slotKey`: `smoothie` · `mittag` · `abend`. Nur `mittag`/`abend` werden von der
  KI generiert (Konstante `SLOTS`); `smoothie` ist ein rein manueller Slot. Alle
  drei erscheinen im Wochenplan (`PLAN_SLOTS`) und liefern Zutaten an die
  Einkaufsliste.

### Ableitungen im Frontend (kein zusätzlicher Persistenz-Zweig)

- **Generierungs-Einstellungen (`prefs`)** steuern, wie die KI plant. Ein kompakter
  Block direkt über dem „Woche generieren"-Button bietet drei Eingaben: **Ziel**
  (Abnehmen / Halten / Zunehmen → `goal`), **Kalorien**-Tendenz (Weniger / Normal /
  Mehr → `calorieTrend`) und **Trainingstage** (Mehrfachauswahl Mo–So →
  `trainingDays`, Kurz-Keys `mon`…`sun`). Jede Auswahl schreibt **sofort** nach
  `nobraine/weeks/<weekKey>/prefs/<feld>` (optimistisch auch im State) und wird beim
  Wochenwechsel über den `prefs`-Listener korrekt nachgeladen. An Trainingstagen
  plant die KI bewusst **mehr Protein und mehr Kalorien**; `goal`/`calorieTrend`
  verschieben Portionsgrösse und Kaloriendichte insgesamt.
- **Einkaufsliste** wird bei jedem Render aus dem Wochenplan berechnet: alle
  Zutaten der eingeplanten Rezepte werden nach `Name + Einheit` **dedupliziert**
  und die Mengen summiert (`num()`-Parser inkl. Komma und Brüchen wie `1/2`).
  Persistiert wird nur der Abhak-Zustand (`checked`) je aggregiertem Schlüssel
  sowie manuell ergänzte Artikel (`manuell: true`). Weil über **alle Tage und
  Slots** summiert wird, ergibt derselbe Smoothie an 7 Tagen automatisch die
  7-fache Menge jeder Smoothie-Zutat.
- **Manuelle Artikel** werden im Kopf der Einkaufsliste erfasst (Menge · Einheit ·
  Artikel). Menge und Einheit sind optional und werden — falls leer — aus dem
  Artikelfeld abgetrennt (`„2 kg Mehl"` → `2` · `kg` · `Mehl`, gleiche Logik wie
  die Zutaten-Zeilen im Rezept-Formular). `Enter` in einem der drei Felder fügt
  hinzu; danach werden die Felder geleert und der Fokus springt zurück ins
  Artikelfeld. Manuelle Artikel sind mit „manuell" markiert und einzeln löschbar;
  der Gewürz-/Kleinstmengen-Filter gilt für sie nicht.
- **Täglicher Smoothie:** Über der Wochen-Grid liegt die Smoothie-Karte. Sie
  setzt **ein** selbst erfasstes Rezept auf die gewählten Tage (Vorauswahl: alle
  sieben) — die Mengen für *einen* Smoothie werden pro Tag einmal gerechnet, bei
  7 Tagen also 7× auf der Einkaufsliste. Der Dialog erlaubt Tages-Auswahl,
  „Alle 7 Tage" und „＋ Neues Smoothie-Rezept" (legt das Rezept mit Kategorie
  `smoothie` an und setzt es direkt auf alle sieben Tage). „Entfernen" leert den
  Smoothie-Slot aller Tage. Die Einkaufsliste zeigt einen Hinweis, an wie vielen
  Tagen der Smoothie geplant und damit wie oft er eingerechnet ist.
  Für Smoothie-Zutaten greift der **Einheiten**-Filter (`EL`/`TL`/`Prise`)
  bewusst **nicht** (`ekAusschlussSlot`) — Löffelmengen wie Haferflocken, Nussmus
  oder Proteinpulver sind dort echte Einkäufe; der Namens-Filter (Zimt, Salz …)
  gilt weiterhin.
- **Eigene Rezepte** lassen sich an drei Stellen erfassen: „＋ Neues Rezept" im
  Kopf der Bibliothek (auch im Leer-Hinweis), „＋ Eigenes Rezept" direkt im
  Slot-Dialog des Wochenplans (Kategorie = Slot, wird nach dem Anlegen sofort in
  diesen Slot eingeplant) und „＋ Neues Smoothie-Rezept" im Smoothie-Dialog.
  Zutaten werden zeilenweise eingegeben (`„200 g Mehl"`, `„2 Eier"`, `„Salz"`).
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
- **Termin-Agenda** je Tag: im Fuss jeder Tages-Karte des Wochenplans liegt eine
  kleine Agenda. Einträge (`{ zeit, titel, notiz, erledigt }`) werden nach Zeit
  sortiert (ohne Zeit = ganztags, ans Ende), lassen sich abhaken, anklicken zum
  Bearbeiten und löschen. So vereint der Wochenplan Mahlzeiten und Termine je Tag.
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
2. Frontend `POST`et an `WEBHOOK_URL` mit JSON-Payload (immer inkl. `prefs`):
   - Woche: `{ weekKey, startDatum, tage: 7, slots: ["mittag","abend"], freeblocks: [{ tag, slot, label }], prefs: { goal, calorieTrend, trainingDays }, typ: "woche" }`
   - Einzelner Slot: `{ …, typ: "slot", tag: "<tag-key>", slot: "<slotKey>", tagName }` — **`tag` ist der Wochentags-Key** (`montag`…`sonntag`), damit n8n den Slot eindeutig adressieren kann.
   - Der `fetch` läuft mit **`keepalive: true`** und einem 20-s-`AbortController`:
     Schliesst der Nutzer den Tab direkt nach dem Klick, wird der POST trotzdem
     zu Ende gesendet und n8n startet serverseitig.
3. n8n verarbeitet die Anfrage, berücksichtigt `prefs` (Ziel/Kalorien →
   Portionsgrösse & Kaloriendichte; `trainingDays` → mehr Protein/Kalorien an
   diesen Tagen; Kurz-Keys werden intern auf `montag`…`sonntag` gemappt), wählt/
   erzeugt Rezepte, schreibt sie nach `nobraine/weeks/<weekKey>/meals/…` (fehlende
   Rezepte zusätzlich nach `nobraine/recipes`) und aktualisiert
   `nobraine/weeks/<weekKey>/generation` auf `running` und schliesslich `done`
   (mit `finishedAt`).
   - **`typ: "slot"`** regeneriert **nur den angefragten `tag`+`slot`** — der
     Aggregations-Node verwirft alle übrigen Tage/Slots und schreibt in diesem
     Modus **keine** Einkaufsliste (das Frontend aggregiert sie ohnehin live aus
     den Meals). `typ: "woche"` schreibt die ganze Woche.
4. Das Frontend zeigt den Fortschritt live über `on('value')` auf `meals`,
   `recipes` und `generation` der aktiven Woche — Ladezustand (Spinner +
   Statuszeile) inklusive.

Schlägt der `POST` fehl (z. B. weil `WEBHOOK_URL` noch der Platzhalter ist),
setzt das Frontend `generation.status = "error"` mit erklärender `message` und
zeigt einen Toast — nichts bleibt stumm hängen. n8n selbst schreibt per
Service-Account (umgeht die Regeln).

**Robustheit gegen „ewig running":**

- **Frontend:** `GEN_TIMEOUT_MS` (5 min) ist das letzte Sicherheitsnetz — bleibt
  der Status länger auf `pending`/`running`, zeigt die Karte „Generierung hängt"
  und der Button wird wieder freigegeben (auch nach Neuladen).
- **n8n:** Alle RTDB-Nodes haben ein `onError` gesetzt. Fehler beim Laden
  (`RTDB: Rezepte laden`) oder Statusschreiben degradieren, ohne den Lauf
  hart abzubrechen; scheitert `RTDB: Plan speichern`, läuft der Fehler-Ausgang
  gezielt in `RTDB: Status → error` (mit aussagekräftiger `message`), sodass der
  Status zuverlässig auf `error` statt dauerhaft auf `running` steht.
- **Leeres/abgeschnittenes KI-Ergebnis:** `max_tokens` ist auf **16000** erhöht
  (verhindert Abschneiden). Liefert Claude keinen verwertbaren Plan
  (`zaehler === 0`, kein `days`-Array, JSON-Parse-Fehler), setzt der Workflow
  sauber `status: "error"` mit Grund — nie ein stilles Leer-Ergebnis.

## Auth: kein erzwungener Login (offene /nobraine-Rules)

`/nobraine` ist in den Rules **offen** (`.read/.write: true`), daher erzwingt
`nobraine.html` **keinen** Login. Die App bootet sofort und liest/schreibt
`/nobraine` **ohne** eingeloggten User (`boot()` → `listenerStarten()` läuft
unbedingt). Kein `permission_denied`.

**Optionaler Login** (Footer-Button „Anmelden"): öffnet
`signInWithPopup(GoogleAuthProvider)` und stellt die Firebase-Session **nur für
die auth-geschützten Quantus-Daten** (`appStore`, s. Sync-Koordinator) her —
die `/nobraine`-Nutzung wird davon **nicht** blockiert. Bei aktiver Session zeigt
der Footer die E-Mail + „⎋" (Abmelden); der Login-Overlay erscheint nur noch als
kurzer Spinner während der Anmeldung.

Für den Login im Firebase-Projekt: Authentication → Sign-in method → **Google**
aktivieren; Netlify-Domain unter **Authorized domains** eintragen. (Nur nötig,
wenn die auth-geschützten Quantus-Daten aus dem Weekly Planner heraus angemeldet
werden sollen — der Planer selbst funktioniert auch ohne.)

## Firebase-Security-Rules

Finaler Stand in `firebase/database.rules.json` (identisch zur deployten
Console):

```json
{
  "rules": {
    "appStore":           { ".read": "auth != null", ".write": "auth != null" },
    "settings":           { ".read": "auth != null", ".write": "auth != null" },
    "driveInbox":         { ".read": true, ".write": true, ".indexOn": ["status"] },
    "communicator_inbox": { ".read": true, ".write": true },
    "quantus_task_inbox": { ".read": true, ".write": true },
    "nobraine": {
      ".read": true, ".write": true,
      "recipes": { ".indexOn": ["kategorie", "lastUsed"] }
    },
    "$andere":            { ".read": true, ".write": true }
  }
}
```

- **`/nobraine` und `/quantus_task_inbox` sind offen** (kein Auth-Gate) — der
  Weekly Planner und der n8n-Task-Ingest funktionieren ohne Login. Keine
  hartcodierte UID mehr.
- **`/appStore` und `/settings` bleiben `auth != null`** (enthalten den
  Quantus-Zustand inkl. API-Keys). Deshalb muss der **Sync-Koordinator**
  (index.html), der nach `dailyBriefing.routines`/`timeBlocks` im
  `appStore`-Blob schreibt, weiterhin auf eine **Firebase-Session warten** — das
  blockiert aber die offene `/nobraine`-Nutzung nicht.

## Integration in Quantus (Daily Planner & Habits)

Die Weekly-Planner-Daten erscheinen **nativ** in der bestehenden Habits-App und
im Daily Planner — es wird keine neue Anzeige erfunden. Da der gesamte
Quantus-Zustand als **ein JSON-Blob** unter `appStore/app-data_json` liegt
(Last-Write-Wins, nur `.once`-Reads, kein Live-Merge), darf eine externe Seite
diesen Blob **nicht** schreiben. Deshalb ist **`index.html` der Koordinator**
(es besitzt Blob-Zugriff *und* authentifizierten `/nobraine`-Zugriff); auf
`/nobraine` wird nur **gelesen**.

**Koordinator-Block in `index.html`** (`NO-BRAINE → QUANTUS SYNC-KOORDINATOR`,
eigener `<script>`-Block, startet erst mit Firebase-Session):

| No-Braine-Quelle | Ziel-Store (bestehend) | Mapping |
|---|---|---|
| `nobraine/habitdefs/<id>` | `dailyBriefing.routines[]` | Upsert einer Routine je Definition, markiert per `nbHabitId`; Schema `{ id:"rt_nb_…", text, icon, frequency:"daily", target:1, completions:[], subCompletions:[], archived, nbHabitId, source:"nobraine" }`. Gelöschte/inaktive Defs → Routine `archived:true`. |
| `nobraine/habits/<datum>/<id>=true` | `routine.completions[]` | Autorität für die Completions der nb-Routine: je erledigtem Datum ein `{ id:"hc_nb_…", date:"YYYY-MM-DD", value:target }`; nicht (mehr) erledigte Daten werden entfernt. |
| `nobraine/weeks/<jahr-kw>/meals/<tag>/<smoothie\|mittag\|abend>` + `nobraine/recipes` | `dailyBriefing.timeBlocks[<datum>][]` | Je Slot ein Block `{ id:"tb_nb_…", nbMealKey, startTime, endTime, title:"🍽️ Mittagessen: <Rezept>" }`. Smoothie 07:30–07:45, Mittag 12:00–13:00, Abend 18:30–19:30. Erscheint in der „Tagesplanung"-Timeline. |

Abgedeckte Wochen: **aktuelle + nächste** (deckt die Daily-Planner-Range
heute…+7). Der Upsert ist idempotent (kein Duplizieren bei Re-Sync).

**Abhaken konsistent in beiden Apps (eine Wahrheit):** `/nobraine/habits` ist die
Autorität für nb-Habit-Completions. Abhaken im Weekly Planner schreibt dorthin →
der Koordinator spiegelt es in `routine.completions`. Abhaken in Quantus
(`toggleHabitToday`/`incHabitToday`) schreibt für nb-Routinen (`nbHabitId`)
**zusätzlich** nach `/nobraine/habits/<heute>/<nbHabitId>` zurück → beide Seiten
bleiben konsistent.

> Grenze: Der Koordinator läuft **client-seitig in index.html** (wie der
> bestehende `quantus_task_inbox`-Importer). Die Spiegelung passiert also, während
> eine Quantus-Session offen ist; ohne offene Quantus-Session bleibt der Weekly
> Planner für sich (eigene `/nobraine`-Daten) und Quantus zieht beim nächsten
> Öffnen nach. Meals werden für die aktuelle + nächste Woche gespiegelt.

Bestehende Quantus-Konventionen, die exakt übernommen wurden: Task-Ingest via
Root-Queue `quantus_task_inbox` (Schema `{ title, text?, description?, priority?,
status?, dueDate?, tags?, source?, type? }`, wird konsumiert und gelöscht); Habits
in `dailyBriefing.routines` mit `completions:[{id,date,value}]` (Datum
`YYYY-MM-DD`); Tages-Timeline aus `dailyBriefing.timeBlocks[<datum>]`.

**n8n Meal-Prep-Task:** Ein n8n-Workflow kann die Samstags-Vorkoch-Aufgabe direkt
nach `/quantus_task_inbox` pushen (offene Rules, kein Auth nötig), z. B.
`{ title:"Vorkochen fürs Wochenende", dueDate:"2026-07-11", source:"nobraine",
type:"meal-prep", priority:2 }`. Der bestehende Importer (index.html) legt daraus
einen Task mit **`dueDate`** an → er erscheint am Fälligkeitstag im Daily Planner
(und in den fälligen Aufgaben). `source`/`type` werden übernommen; Nicht-
Communicator-Quellen bekommen **nicht** mehr fälschlich den Tag „WhatsApp".

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

> **Hinweis zum Testen mit echtem Firebase:** In der CI-/Sandbox-Umgebung sind die
> Firebase-Hosts (gstatic-CDN, RTDB) durch die Netzwerk-Policy blockiert und ein
> echter Google-Popup-Login ist nicht automatisierbar. Die App-Logik (Login-Flow,
> Wochenanzeige, Freihalten, Habit-Abhaken, Generieren-POST) sowie die Koordinator-
> Reconcile-Logik sind daher mit Firebase-Stubs end-to-end verifiziert. Der finale
> Real-Firebase-Test (echter Google-Login) erfolgt auf dem Netlify-Deployment.

1. `public/nobraine.html` öffnen (lokal via `npx serve public` oder über das
   Netlify-Deployment; oder in der Hauptapp über die App „Weekly Planner"). Die
   App startet **direkt ohne Login** (offene `/nobraine`-Rules); Footer unten
   links „Verbunden" mit grünem Punkt. Beim ersten Start erscheinen die Starter-
   Rezepte in der Bibliothek. Optional „Anmelden" im Footer (für den Quantus-Sync,
   der die auth-geschützten `appStore`-Daten schreibt).
2. **Rezepte:** In „Rezepte" ein Rezept anklicken → Drawer mit vollständigem
   Rezept (Zutaten mit Mengen, nummerierte Schritte, Portionen, Kochzeit).
   Suche nach Name/Zutat/Tag testen; Kategorie-Filter testen (inkl. „Smoothie").
   „＋ Neues Rezept" von Hand anlegen (Name, Kategorie, Portionen, Kochzeit,
   Zutaten zeilenweise, Schritte, Tags) und wieder bearbeiten/löschen.
3. **Wochenplan:** Leeren Slot antippen → Rezept aus der Bibliothek wählen
   (passende Kategorie zuerst), „🚫 Freihalten" oder „Slot generieren". Gefüllten
   Slot antippen → Drawer mit „Rezept tauschen", „Neu generieren", „Freihalten",
   „Aus Plan entfernen". Wochennavigation (‹ ›, „Aktuelle Woche") prüfen —
   Plan/Einkauf/Status folgen der gewählten Woche live. Im Fuss jeder Tages-Karte
   „＋ Termin" anlegen (Zeit optional, Titel, Notiz) → nach Zeit sortiert;
   abhaken, anklicken zum Bearbeiten/Löschen.
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
   ergänzen (Enter oder „＋ Hinzufügen"; auch „2 kg Mehl" nur im Artikelfeld →
   Menge/Einheit werden abgetrennt, Felder danach leer, Fokus zurück),
   „Erledigte entfernen".
6b. **Täglicher Smoothie:** Im Wochenplan „＋ Smoothie planen" → „＋ Neues
   Smoothie-Rezept" (Kategorie ist auf „Smoothie" vorbelegt) mit Zutaten für
   **einen** Smoothie anlegen → das Rezept steht danach im Smoothie-Slot aller
   sieben Tage, die Karte meldet „An 7 von 7 Tagen". In der Einkaufsliste
   erscheint jede Smoothie-Zutat mit der 7-fachen Menge (z. B. `1 Stk Banane`
   → `7 Stk`) plus Hinweiszeile; Löffelmengen (`2 EL Haferflocken` → `14 EL`)
   bleiben erhalten, Gewürze wie Zimt nicht. Über „✎ Anpassen" Tage abwählen →
   die Mengen sinken entsprechend; „Entfernen" leert alle sieben Slots.
7. **Gewohnheiten:** In „Gewohnheiten" erscheinen die Standard-Gewohnheiten als
   Matrix über die Woche (inkl. **Morgenessen** 🥣). Zellen abhaken (Schreiben
   nach `habits/<datum>/…`, Serie `🔥 N` aktualisiert sich), „＋ Gewohnheit"
   anlegen (Name + Symbol), Namen anklicken zum Bearbeiten/Löschen.
   Wochennavigation (‹ ›) blättert die Matrix durch die Wochen.
8. **Integration in Quantus** (Quantus-Session parallel geöffnet): Nach dem
   Planen einer Woche und Abhaken von Habits im Weekly Planner erscheinen in
   Quantus:
   - **Daily Planner** (App „Daily Briefing") in der „Tagesplanung"-Timeline die
     Smoothie/Mittag-/Abendessen des jeweiligen Tages (07:30 / 12:00 / 18:30,
     mit Rezeptname).
   - **Habits-App / Daily Planner**: „Morgenessen" und die weiteren Weekly-
     Planner-Gewohnheiten als Routinen; in Quantus abgehakt → im Weekly Planner
     abgehakt und umgekehrt (`/nobraine/habits` ist die gemeinsame Wahrheit).
   Verifikation im RTDB: `dailyBriefing.routines[]` enthält Einträge mit
   `nbHabitId`, `dailyBriefing.timeBlocks[<datum>]` Blöcke mit `nbMealKey`.
