# Quantus — wie dieses Programm gebaut ist

Diese Datei beschreibt das Gesamtkonzept: was die App ist, wie ihre Teile
zusammenhaengen, wo die Daten leben — und welche Fallstricke aus der Bauweise
folgen. Sie ist fuer jemanden geschrieben, der die Datei zum ersten Mal
aufmacht und trotzdem sicher etwas aendern soll.

## Was es ist

Ein persoenliches Management-System („Quantus") fuer eine Person: Aufgaben,
Projekte, Notizen, Ziele, Kalender, Budget, Lernkarten, Lesen, Schreiben,
Mail, KI-Assistenz. Kein Framework, kein Build-Schritt. Der Kern ist **eine
einzige HTML-Datei** (`public/index.html`, ~117'000 Zeilen), die Netlify
unveraendert ausliefert. Serverseitig gibt es nur schmale Funktionen fuer das,
was ein Browser nicht darf.

Daraus folgt fast alles Weitere: keine Imports, keine Bundler-Aufloesung, keine
Typpruefung. Was zusammenarbeiten soll, muss sich ueber `window` finden.

## Die Teile

```
public/index.html            die App: 49 Inline-Script-Bloecke
  └─ Block 1 (~69'000 Zeilen)  Kern: Zustand, Datenmodell, Speichern,
                               Abgleich, Routing, Rendern, alle Hauptansichten
  └─ Bloecke 2–49              angebaute Module, je in eigener Huelle:
                               Journal Booklet, NoteFlow, Recall Lab,
                               ReadingHub, Newsroom, Gmail Hub, Polaris (KI),
                               Quantus Browser, Sticky Board, PDF-Editor,
                               Smarter, Leseplan, FlowerTech, Tabs, Themes …

public/*.html                eigenstaendige Satelliten-Apps mit eigenem Zustand
                             (career-model, english-c1, nobraine, drive,
                             docstudio, ruhestand, bm, flowertech-*)
public/theorie/*.html        Lernstoff-Seiten
netlify/functions/*.mjs      15 Funktionen: blob-get/put (Datenstand),
                             briefing-*, gcal-*, gmail-api, flowertech-*,
                             download-proxy, date-invite
netlify/edge-functions/      schreiben index.html BEIM AUSLIEFERN um
                             (App-Registry + Router-Eintraege der Satelliten)
netlify/lib/firebase-admin   Dienstkonto-Zugang zu Firebase RTDB/Storage
tests/*.test.mjs             40 Testdateien, reines Node, ohne Abhaengigkeiten
```

Dazu ein zweites Repository: **journal-mobile** (PWA fuers Handy). Es liest
`https://management-xo2-pro.netlify.app/.netlify/functions/blob-get?key=app-data.json`
und zeigt daraus `mobilePushes` — die aus dem Journal Booklet verschickten
Eintraege.

## Der Zustand

Alles haengt an einem Objekt:

```
APP.state = {
  data:     der Datenbestand (wird synchronisiert)
  settings: Einstellungen (Speicher, KI-Schluessel, Kuerzel, Erscheinungsbild)
  ui:       Ansichtszustand (Filter, Flags) — teils mitgesichert
  storage:  Zustand des Abgleichs (status, etag, _saving …)
}
```

`APP.state.data` hat zwei Ebenen:

* **`entities`** — die Sammlungen: `tasks`, `projects`, `notes`, `notebooks`,
  `goals`, `organizations`, `timeEntries`, `strategies`, `programs`,
  `accounts`, `transactions`, `scheduledMessages`, … Jede ist eine Karte
  `id → Objekt` mit `createdAt`/`updatedAt`.
* **~30 weitere Bereiche** direkt daneben: `journal`, `dailyBriefing`,
  `weekPlan`, `aiChats`, `timers`, `customPages`, `readingList`,
  `mailTemplates`, `handbook`, `mobilePushes`, `reflections`, `rules` …

Diese zweite Ebene ist die historisch gewachsene: jedes neue Modul haengte
seinen Bereich dazu. **Das ist die wichtigste Fehlerquelle im Abgleich** (siehe
unten).

## Wie gespeichert wird

Drei Ringe, von innen nach aussen:

1. **Lokal, sofort.** `scheduleSave()` markiert den Stand als schmutzig und
   stoesst `scheduleLocalSave()` an: gebuendelt (400 ms, beim Schreiben im
   Journal 5 s) ein `JSON.stringify` des gesamten Bestandes nach
   `localStorage`. Bei Ueberlauf weicht es nach IndexedDB aus.
   `flushLocalSave()` holt das bei `pagehide`/`visibilitychange` sofort nach.
2. **Wolke, gebuendelt.** `doSave()` macht Pull-Merge-Push: erst den
   Serverstand holen, mit `mergeData()` zusammenfuehren, dann hochladen.
   `remotePutByKey()` geht dabei der Reihe nach durch die Anbieter und nimmt
   den ersten, der antwortet; der Rest bekommt einen gedrosselten
   Schattenschreibvorgang. **Die Reihe ist rtdb → firebase** —
   `getCloudProviderOrder()` fuehrt `netlify` gar nicht, der entsprechende
   Zweig in `remotePutByKey`/`remoteGetByKey` ist also toter Code.
3. **Frischeprüfung.** `syncFreshness()` laeuft beim Sichtbarwerden des Tabs,
   beim Fokus und alle 30 s: ist der Server neuer, wird gemergt, gerendert und
   zurueckgeschrieben. Waehrend im Journal geschrieben wird, haelt sich alles
   zurueck (`remoteSaveOnHold()` → `jbIsTyping()`).

Dazu: `BroadcastChannel('app_sync')` fuer den zweiten Tab, ein `storage`-
Ereignis als Rueckfall, `_deleteLog` (Grabsteine) damit Loeschungen nicht von
einem anderen Geraet wiederauferstehen, und ETags gegen das Ueberschreiben
fremder Aenderungen (412 → einmal ohne `If-Match` erneut).

**Wichtig zum Verstaendnis:** `blob-get`/`blob-put` sind kein eigener
Speicher, sondern eine REST-Fassade vor **demselben** Firebase-Knoten
(`appStore/app-data_json`), den auch der Browser direkt beschreibt — Client und
Funktion benutzen dieselbe Schluesselbereinigung. Die Fassade existiert fuer
Clients ohne Firebase-Zugangsdaten, also fuer die Handy-App.

Daraus folgt: Die Handy-App haengt **nur** an dieser Fassade. Faellt sie aus
(abgelaufenes Dienstkonto → 500), merkt der Rechner davon nichts — er
synchronisiert direkt ueber Firebase weiter, waehrend das Handy stillsteht.

## Wie gerendert wird

Ein Router auf `location.hash`, eine grosse `render()`-Funktion, die je nach
Route HTML als Zeichenkette baut und in `#main` setzt. Ereignisse laufen fast
alle ueber **Delegation**: `data-action="…"` am Element, ein zentraler
Klick-Handler entscheidet. Die grossen Module (Journal, NoteFlow, ReadingHub,
Newsroom, PDF-Editor …) sind dagegen **Overlays**: eigene `<div>`-Container mit
`position:fixed`, die per Klasse `active` ueber die App gelegt werden, mit
eigenem Zustand und eigenen Ereignissen.

## Fallstricke, die aus der Bauweise folgen

Diese vier haben in der Vergangenheit jeweils echte Fehler verursacht. Wer hier
etwas aendert, sollte sie kennen.

### 1. Modulgrenzen sind echt — `window` ist der einzige Draht

Jeder `<script>`-Block ist in eine sofort ausgefuehrte Funktion gehuellt. Eine
Funktion aus Block 1 ist in Block 12 **nicht** sichtbar, es sei denn, sie haengt
an `window` (Abschnitt „GLOBAL EXPORTS"). Das Tueckische: Aufrufer sichern sich
gern mit `if (typeof fremdeFunktion === "function")` ab — und dann passiert
still gar nichts. So blieben 16 Aufrufe wirkungslos, darunter die Notbremse des
Journals und ein „Zusammenfuehren", das in Wahrheit ersetzte.

**Regel:** Wer aus einem Modul heraus etwas aus einem anderen ruft, prueft im
Browser `typeof window.name` — nicht im Kopf.

### 2. `mergeData()` vergisst, was es nicht kennt

Das Ergebnis ist eine **Kopie des lokalen Standes**, ergaenzt um die Bereiche,
fuer die es einen Zweig gibt. Ein Bereich ohne Zweig behaelt stumm den lokalen
Wert — und weil direkt danach gepusht wird, loescht der Rechner den Stand des
anderen Geraets auch auf dem Server. Genau so verschwanden Journal-Eintraege
vom Handy.

Seit dem Auffangzweig am Ende von `mergeData()` gilt: lokal Unbekanntes wird
uebernommen, Listen und Karten **mit Id** werden vereinigt (bei Kollision der
neuere Zeitstempel), Reihenfolgen und Schalter bleiben lokal. Wer einen neuen
Bereich mit eigener Struktur anlegt, prueft trotzdem, ob er einen eigenen Zweig
braucht — und schreibt einen Test in `tests/sync-merge.test.mjs`.

### 3. Tastatur-Handler am Dokument treffen auch Schreibfelder

Ein gutes Dutzend Module haengt `keydown` an `document`. Wer nur auf
`INPUT`/`TEXTAREA` prueft, uebersieht `contenteditable` — das ist ein `DIV`. So
verschluckte das Recall Lab jedes Enter und jede Leertaste im Journal, und der
App-weite Rueckgaengig-Schritt machte Strg+Z im Editor unbrauchbar.

**Regel:** Jeder globale Tastatur-Handler prueft `activeElement.isContentEditable`
mit. Der Journal-Editor haelt zusaetzlich einen eigenen Schirm
(`jbKeyShield`), der Tasten aus dem Schreibbereich gar nicht erst zum Dokument
durchlaesst.

### 4. Zustandsreste ueberleben den Ansichtswechsel

Modul-lokale Variablen wie `currentRLRoute` werden beim Betreten gesetzt, aber
beim Verlassen nicht zurueckgesetzt; Handler wie der Escape-Fang des
Thesis-Fokusmodus melden sich nur auf einem von zwei Wegen wieder ab. Beides
wirkt dann in ganz anderen Ansichten weiter.

**Regel:** Was beim Betreten registriert wird, muss beim Verlassen abgemeldet
werden — und ein Handler prueft zusaetzlich selbst, ob sein Modul ueberhaupt
noch sichtbar ist.

## Testen

`npm test` laeuft ohne Netz und ohne Abhaengigkeiten. Die Tests schneiden
**echte Funktionen** aus `index.html` heraus und fuehren sie gegen ein
Stub-DOM aus (`new Function(...)`), der Rest sind gezielte Quelltextpruefungen
an den Stellen, an denen einmal ein Fehler sass. Jede Testdatei beginnt mit
einem Kommentar, der den Produktionsbefund beschreibt — das ist Absicht: der
Test erklaert, warum es ihn gibt.

Fuer Verhalten, das nur der echte Browser zeigt (Cursor, Umbruch, Scrollen,
Vollbild), gibt es kein Test-Framework im Repo; solche Aenderungen werden mit
Chromium/Playwright nachgemessen — vorher/nachher, mit Zahlen.

## Ausliefern

Netlify, kein Build. `index.html` wird mit `no-store` ausgeliefert (die Edge
Function entfernt den ETag, eine zwischengespeicherte Fassung liesse sich sonst
nicht mehr revalidieren). Welcher Stand live ist, verraet:

```
curl -sSI https://management-xo2-pro.netlify.app/ | grep -i x-quantus-build
```

Der Wert kommt aus `<meta name="quantus-build">` — **bei jeder Aenderung an
index.html mitziehen.**

Serverseitig braucht Firebase ein Dienstkonto (`FIREBASE_SERVICE_ACCOUNT_JSON`).
Der Refresh-Token-Weg funktioniert auch, laeuft aber ab: Google verlangt dann
eine erneute Anmeldung (`invalid_rapt`), und ab da antworten **alle**
Netlify-Funktionen mit 500 — der Rechner merkt es nicht, die Handy-App steht
still.
