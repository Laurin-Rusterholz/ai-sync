# Leseplan — Modul-Dokumentation

**Leseplan** kombiniert Smarter (dokumentbasierte Aufnahme + Aufteilung, KI-Aufbereitung)
mit der BM-Pace-Logik (Zieldatum → Tempo): HTML-Dokumente werden hochgeladen,
automatisch in Lerneinheiten geschnitten und **gleichmässig bis zu einem Zieldatum
verteilt**. Mehrere Dokumente laufen **parallel** (je eigenes Zieldatum, eigener
Fortschritt, eigene Aufteilung). Pro Dokument entsteht je Slot eine Leseeinheit; ist
die reine Tagesportion unter ~10 Minuten geschätzter Lesezeit, wird auf einen
**2-Tages-Rhythmus** umgestellt (grössere Einheiten, seltener).

Datenquelle ist wie bei Smarter die **Firebase RTDB** (`jupidu-36804`,
`europe-west1`), unter dem eigenen, offenen Top-Level-Pfad `leseplan/`
(fällt unter die Wildcard-Regel `$andere` in `firebase/database.rules.json`
→ App und n8n schreiben ohne Credential per plain HTTP/SDK).

Bausteine:
- **ai-synch-Kern:** Modul `Leseplan` in `public/index.html` (Route `#/leseplan`).
- **mobile-management:** View `js/views/leseplan.js` (Tablet-Zweispaltenansicht).
- **n8n:** `n8n/leseplan.workflow.json` (Ingest + Zieldatum-Tempo + tägliche KI-Aufbereitung).

Die Aufteilungs-/Tempo-Logik ist **DOM-frei** und in allen drei Bausteinen identisch
(gleiche Funktionen `lpSplit` / `lpBuildPlan` / `lpBuildDoc`), damit App, Mobile-App
und n8n exakt dieselben Pläne erzeugen.

---

## 1 · RTDB-Datenvertrag (`leseplan/`)

Basis: `https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app`

| Pfad | Wer schreibt | Inhalt |
|---|---|---|
| `leseplan/config` | App (idempotent geseedet) | `{ wordsPerMinute:200, minMinutesPerUnit:10, timezone:"Europe/Zurich", aufbereitenWebhookUrl:"" }` |
| `leseplan/docs/<docId>` | App **oder** n8n-Ingest | Dokument inkl. Aufteilung + Plan (siehe unten) |
| `leseplan/aufbereitung/<docId>/<index>` | **n8n** (Daily) | `{ zusammenfassung, kernpunkte:[…], generatedAt, generatedBy }` |

**Dokument** (`leseplan/docs/<docId>`):
```json
{
  "id": "doc_xxx",
  "title": "…",
  "createdAt": "<iso>", "updatedAt": "<iso>",
  "startDatum": "YYYY-MM-DD",       // Anlagetag (in config.timezone)
  "zieldatum":  "YYYY-MM-DD",
  "rhythmus": "taeglich" | "zweitaeglich",
  "status": "aktiv" | "fertig",
  "totalWords": <int>,
  "geschaetzteLesezeit": <int>,      // Minuten gesamt (Woerter / wordsPerMinute)
  "einheitenGesamt": <int>,
  "einheitenErledigt": <int>,
  "sektionen": {                     // die verlustfreie Aufteilung (atomare Bausteine)
    "s0": { "order":0, "title":"…", "html":"<h2>…</h2><p>…</p>", "wordCount":<int>, "estMinutes":<int> },
    "s1": { … }
  },
  "plan": [                          // die zeitverteilten Leseeinheiten
    { "index":0, "datum":"YYYY-MM-DD", "sektionIds":["s0","s1"], "words":<int>, "estMinutes":<int>, "done":false, "doneAt":null },
    …
  ]
}
```

- Der **Fortschritt** (`plan[i].done`, `einheitenErledigt`, `status`) wird von der
  App/Nutzer gesetzt (PATCH auf `docs/<docId>`), **nie** vom Daily-Workflow → kein Datenverlust.
- Die **KI-Aufbereitung** liegt getrennt unter `aufbereitung/<docId>/<index>`, damit der
  Daily-Workflow schreiben kann, ohne den Fortschritt zu berühren. Die App zeigt sie über
  der jeweiligen Leseeinheit an. **Die App funktioniert auch ganz ohne diesen Workflow.**

Bestehende Quantus-Daten bleiben unangetastet: `leseplan/` ist ein neuer, eigener
Top-Level-Key; `smarter/`, `bmpruefung/`, `cloud-sync/` etc. werden nicht berührt.

---

## 2 · Aufteilungs- & Tempo-Logik

**Aufteilung (`lpSplit`, verlustfrei, DOM-frei):** `<head>/<title>/<script>/<style>`
werden entfernt, dann definieren **Überschriften `h1`–`h3`** die Abschnittsgrenzen.
Sehr grosse Abschnitte werden zusätzlich an Block-Schluss-Tags (`</p>`, `</li>`,
`</tr>`, …) über Zeichen-Offsets weiter geschnitten (Richtwert `maxChunkWords ≈ 600`).
Jeder Abschnitt ist eine exakte Teil-HTML-Zeichenkette → Aneinanderreihung ergibt den
bereinigten Body zurück (nur script/style entfernt).

**Lesezeit-Schätzung:** Wortanzahl des gestrippten Textes / `wordsPerMinute` (Default 200).

**Tempo (`lpBuildPlan`):**
1. `daysAvailable` = Tage von `startDatum` bis `zieldatum` (inklusive). `zieldatum` in der
   Vergangenheit → Fehler `past`.
2. Reine Tagesportion `totalMinutes / daysAvailable`. Ist sie `< minMinutesPerUnit`
   (Default 10) **und** stehen mehr als 1 Tag zur Verfügung → **`rhythmus = "zweitaeglich"`**.
3. Anzahl Einheiten `maxSlots` = `daysAvailable` (täglich) bzw. `ceil(daysAvailable/2)`
   (2-tägig), **gedeckelt auf die Zahl der Abschnitte** (Abschnitte sind atomar).
4. Termine werden **gleichmässig über `[start, ziel]`** verteilt: `off_i = round(i·span/(n−1))`.
   → Ein **ferneres Zieldatum ergibt weitere Abstände**, ein näheres dichtere; zwei
   Dokumente mit unterschiedlichem Zieldatum erhalten dadurch echte, unabhängige Pläne.
5. Die Abschnitte werden **gleichmässig** in die Slots gepackt (jeder Slot ≥ 1 Abschnitt;
   weitere nur solange der kumulierte Fortschritt unter der linearen Ziel-Grenze bleibt und
   für jeden Rest-Slot noch ein Abschnitt übrig bleibt; der letzte Slot nimmt den Rest).
   → **kein Abschnitt geht verloren** (Summe der zugewiesenen Abschnitte = alle Abschnitte).

**Fehlerzustände (App):** kein/leeres HTML → „Kein lesbarer Text“; > 2 MB → „Dokument zu
gross“; Zieldatum leer → Hinweis; Zieldatum in der Vergangenheit/zu knapp → verständliche
Meldung. Lade-/Leer-/Offline-Zustände sind abgedeckt (Skeleton, Leer-Notice, Offline-Banner
bzw. „Cloud nicht erreichbar“ mit Retry).

---

## 3 · App (ai-synch-Kern, `public/index.html`)

Route `#/leseplan` (Nav-Eintrag `📖`, auch in der Apps-Kachelübersicht). Vier Tabs:
- **Dokumente:** Zweispaltig — links die Dokumentliste (Titel, Rhythmus-Tag, Zieldatum,
  Fortschrittsbalken, Einheiten), rechts das gewählte Dokument mit **aktueller Leseeinheit**
  (self-contained HTML in isoliertem iframe, Scripts entfernt), optionaler KI-Aufbereitung,
  „✓ Als gelesen markieren“ und Plan-Übersicht.
- **Neues Dokument:** Titel (optional), Zieldatum, HTML-Inhalt (einfügen oder `.html`-Datei
  wählen) → Aufteilung + Plan client-seitig, Speicherung nach `leseplan/docs/<docId>`.
- **Aufbereitungs-Prompt:** der sichtbare, **kopierbare** Prompt (Wortlaut siehe §6).
- **Einstellungen:** `wordsPerMinute`, `minMinutesPerUnit`, Zeitzone; Anzeige der
  `aufbereitenWebhookUrl`.

Single-File/IIFE, `data-action`-Delegation (`leseplan-…` → `leseplanHandleAction`),
Design-System „Schiefer/Leinen“ mit eigenem Modul-Akzent (Blau `#4C7DB8`, Petrol/​Amber).
Post-render-Hook `window.__leseplanPostRender` mountet das Leseeinheit-iframe.

---

## 4 · Mobile-App (mobile-management, `js/views/leseplan.js`)

Neues View-Modul, additiv registriert (`js/main.js`, `js/config.js` `MORE_MODULES` →
erscheint unter „Mehr“ und in der Tablet-Seitenleiste). **Beruehrt `store.js` und den
bestehenden app-data-Blob-Sync NICHT** (eine evtl. parallele Firebase-Datenpfad-Umstellung
bleibt unberührt) — der Zugriff läuft direkt per RTDB-REST auf den offenen `leseplan/`-Pfad.

- **Tablet (≥ 820 px):** Zweispaltenansicht `.split` — links Dokumentliste mit
  Fortschritt/Zieldatum, rechts aktuelle Leseeinheit (themed, sanitisiert) + „Als gelesen
  markieren“ + Plan.
- **Smartphone:** Liste; Tippen öffnet ein Vollbild-Sheet mit der Leseeinheit.
- Grosse Touch-Flächen, Light/Dark über die vorhandenen Tokens.
- „＋ Neu“ (Sheet: Titel/Zieldatum/HTML) und „📋 Prompt“ (Sheet mit kopierbarem Prompt).

---

## 5 · n8n-Workflow (`n8n/leseplan.workflow.json`)

Ein Workflow, **zwei Abläufe** (offener `leseplan/`-Pfad → RTDB-Nodes ohne Credential;
nur der Anthropic-Node nutzt das bestehende Header-Auth-Credential
**„Anthropic API-Key (Header x-api-key)“**). Modell `claude-sonnet-5`.

1. **Ingest** — Webhook `POST /webhook/leseplan-ingest`, Body
   `{ title?, zieldatum, html, docId? }`. Node „Aufteilen + Tempo planen“ nutzt exakt die
   DOM-freie Kern-Logik (verlustfreie Aufteilung + Zieldatum-Tempo inkl. 10-Min/2-Tage-Regel),
   schreibt `leseplan/docs/<docId>` (PUT) und antwortet `{ ok, docId, einheiten, rhythmus }`
   bzw. bei Problemen `{ ok:false, error }` (HTTP 400). Gleicher Datenvertrag wie die App —
   der Webhook ist die **serverseitige Alternative** zur client-seitigen Aufteilung.
2. **Daily** — Schedule `0 4:30` (Cron `30 4 * * *`, Zeitzone `Europe/Zurich`). Liest
   `config` + `docs` + `aufbereitung`, wählt je aktivem Dokument die aktuell **fällige**
   (`datum ≤ heute`), noch nicht erledigte und noch nicht aufbereitete Einheit → Anthropic
   erzeugt kurze `zusammenfassung` + `kernpunkte` → PATCH
   `leseplan/aufbereitung/<docId>/<index>`. Der Fortschritt (`done`) wird **nicht** verändert.

### Import-/Konfig-Anleitung
1. n8n → **Workflows → Import from File** → `n8n/leseplan.workflow.json`.
2. Node **„Anthropic: Aufbereitung“** → Credential **„Anthropic API-Key (Header x-api-key)“**
   zuweisen (Header-Auth, wiederverwenden; die interne Credential-ID steht bewusst nicht im
   Repo, im Export als `ERSETZEN-NACH-IMPORT`). Die RTDB-Nodes brauchen **kein** Credential.
3. Workflow **aktivieren**. Nächste Schedule-Laufzeit prüfen (04:30 `Europe/Zurich`).
4. Optional: Production-URL `…/webhook/leseplan-ingest` als
   `leseplan/config/aufbereitenWebhookUrl` hinterlegen, falls serverseitiger Ingest genutzt
   werden soll (die App legt Dokumente auch ohne diesen Webhook an).
5. Es werden **keine Secret-Werte** im Repo abgelegt — nur Namen/Platzhalter.

---

## 6 · Sichtbarer, kopierbarer Aufbereitungs-Prompt (exakter Wortlaut)

```
Bereite den folgenden Text als HTML-Lerndokument fuer die App „Leseplan“ auf.

FORMATREGELN (exakt einhalten):
1. Gib NUR reines HTML aus — kein Markdown, keine Code-Fences (```), kein <html>/<head>/<body>.
2. Beginne mit genau EINER Hauptueberschrift <h1>Titel des Dokuments</h1>. Dieser Titel wird als Dokumenttitel uebernommen.
3. Gliedere den Inhalt in inhaltlich sinnvolle Abschnitte. Jeder Abschnitt beginnt mit <h2>Abschnittstitel</h2> (Unter-Abschnitte mit <h3>). Diese Ueberschriften sind die Abschnittsgrenzen, an denen die App den Stoff in Lerneinheiten schneidet — setze also etwa alle 300–800 Woerter eine <h2>- oder <h3>-Ueberschrift.
4. Fliesstext in <p>…</p>. Erlaubte Tags: h1, h2, h3, p, ul, ol, li, strong, em, blockquote, table, thead, tbody, tr, th, td, code. KEINE <img>, <script>, <style>, <iframe> und KEINE inline style-Attribute.
5. Aendere den Inhalt nicht: nichts kuerzen, nichts hinzuerfinden, nichts zusammenfassen — den vorhandenen Text nur sauber in die obige HTML-Struktur bringen.
6. Schweizer Rechtschreibung: echte Umlaute (ä, ö, ü, Ä, Ö, Ü), statt ß immer ss. Keine ASCII-Umschreibungen wie ae/oe/ue.

Hier ist der Text:
[HIER DEINEN TEXT EINFUEGEN]
```

---

## 7 · Testfälle (verifiziert)

Automatisiert (Node + headless Chromium):
- **Kern-Logik** `scripts/leseplan-core.test.mjs`: 17/17 (Aufteilung nach Überschriften,
  grosse Abschnitte weiter geschnitten, verlustfrei, 10-Min → 2-Tage, parallele Pläne je
  Zieldatum, alle Abschnitte verteilt, Vergangenheit/leer → Fehler, End-to-End-Dokument).
- **n8n-Code-Nodes** `scripts/leseplan-workflow.test.mjs`: 12/12 (Ingest ok/Fehler,
  Daily-Auswahl inkl. „bereits aufbereitet überspringen“, Anthropic-Antwort inkl.
  thinking-Block geparst).
- **ai-synch-Kern** (headless): Modul rendert, Tabs schalten, Prompt sichtbar, 0 uncaught JS-Errors.
- **Mobile** (headless, Tablet): Anlegen → RTDB, Aufteilung/Plan, Detailspalte zeigt
  Leseeinheit, zwei parallele Dokumente mit unabhängigen Terminen, „als gelesen“ persistiert,
  Prompt korrekt. 10/10, 0 uncaught JS-Errors.
- **n8n-Validator** `scripts/validate-n8n-workflow.js n8n/leseplan.workflow.json`: 0 Fehler.

Abgedeckte fachliche Fälle: HTML-Upload wird aufgeteilt · zwei Dokumente parallel mit
unterschiedlichen Zieldaten → unabhängige Pläne · Tagesportion < 10 Min → 2-Tages-Rhythmus ·
generierte Einheit lesbar + als erledigt markierbar · kopierbarer Aufbereitungs-Prompt
sichtbar & korrekt · Daten landen in der RTDB und überleben den Reload.
