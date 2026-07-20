# BM-Lernprogramm — n8n-Architektur (Firebase ⇄ Quantus BM-Prüfung)

Das Programm folgt dem Sticky-Board-Konzept: **Tageslektionen** (Fokus) mit
Grafiken + Übungsfragen + Repetitionsfragen, **wöchentlicher Übungstest**
(Wochenthemen + frühere Themen; Fehler → zurück in die Repetition), **statische
Theoriebücher** + KI-Chat, und **Fortschritt** über alle Themen. Der **Pace**
(Themen/Woche) wird berechnet, nicht geraten.

**Prinzip: n8n ist das Gehirn, die App (`bm.html`) ist der Client.**
Die App erfasst Antworten und rendert; n8n rechnet Pace, generiert Lektionen und
Tests und schedulet die Repetition. Alles über **Firebase RTDB** (offene
`$andere`-Rules, kein Login), **keine Netlify-Blobs**.

```
App (Antworten) ──▶ Firebase aufg/…  ──▶ n8n (rechnen+generieren) ──▶ Firebase plan/lessons/tests ──▶ App rendert
```

---

## Firebase-Contract (`bmpruefung/`)

Basis: `https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app` — Pfade unter `/bmpruefung/`.

| Pfad | Wer schreibt | Inhalt |
|---|---|---|
| `config` | App | `{ examDate, planStart }` (Prüfungsdatum) |
| `aufg/<fachKey>_<themaId>_<aufgabeId>` | App | `{ box(0–5), due, c, w }` — Leitner-Status je Aufgabe |
| `plan` | **n8n** (wöchentlich) | `{ generatedAt, weeksLeft, topicsPerWeek, weekTopics:["fachKey/themaId",…], weekOf }` |
| `lessons/<YYYY-MM-DD>` | **n8n** (täglich) | siehe Lektions-Schema |
| `tests/<YYYY-Www>` | **n8n** (wöchentlich) | siehe Test-Schema; App schreibt `…/result` |

**Curriculum (statisch):** `https://management-xo2-pro.netlify.app/theorie/kompendium.json`
(6 Fächer, 158 Themen, 1046 Aufgaben; `faecher[].themen[].aufgaben[]`).
Fallback: `https://raw.githubusercontent.com/Laurin-Rusterholz/ai-sync/main/public/theorie/kompendium.json`.

**Frage-Objekt** (überall gleich): `{ id, fach, themaId, typ(mc|offen|anwenden|rechnen), frage, optionen?, loesung, erklaerung, schwierigkeit }`. Bei `mc`: `loesung` exakt = eine der `optionen`.

**Lektions-Schema** (`lessons/<datum>`):
```json
{
  "datum": "2026-07-19",
  "titel": "Tageslektion: …",
  "text": "KURZES Coach-Briefing (Markdown ok: ## …, **fett**, - Liste, | Tabellen |). KEIN Theorie-Nachdruck.",
  "themen": ["fachKey/themaId", "…"],
  "uebungsfragen": [ Frage-Objekt, … ],
  "repetitionsfragen": [ Frage-Objekt, … ]
}
```
Die App zeigt zu `themen[]` automatisch die **Grafiken** des jeweiligen Themas (Beherrschungs-Ring, Schwierigkeitsverteilung) und verlinkt Theorie/Lehrbuch — der Lektions-`text` bleibt bewusst kurz.

**Test-Schema** (`tests/<YYYY-Www>`, ISO-Woche z.B. `2026-W30`):
```json
{ "woche": "2026-W30", "erstelltAm": "2026-07-25", "themenDieseWoche": ["fachKey/themaId", …], "fragen": [ Frage-Objekt, … ] }
```
Die App schreibt nach dem Test `tests/<woche>/result = { abgegebenAm, richtig, falsch, score }` und benotet jede Frage in `aufg` (falsch → `box 0`, `due = morgen`). **Dadurch schliesst sich die Schleife automatisch:** falsche Testfragen sind am nächsten Tag fällig und erscheinen als **Repetitionsfragen** in der Tageslektion.

**Gemeinsame Rechenregeln (in n8n-Code-Nodes):**
- Aufgaben-Key = `` `${fachKey}_${themaId}_${aufgabeId}` `` (Zeichen `/ . # $ [ ]` → `_`).
- Thema-Beherrschung = Mittel über seine `aufgaben` von `min(box,5)/5` (fehlt → box 0). **Gemeistert = ≥ 0.6.**
- `config`/`aufg` dürfen `null` sein (Neu-Start) → alles box 0.

---

## Prompt für „Claude for Chrome" (drei Workflows bauen)

> Kopiere alles unten. Basis-Fakten (Firebase-URL, kompendium, Key-Format) stehen oben in diesem Dokument.

```
Baue in n8n drei Workflows für meine BM-Lern-App. Alle lesen/schreiben Firebase RTDB
(Basis https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app, Pfade unter /bmpruefung/…).
Curriculum: https://management-xo2-pro.netlify.app/theorie/kompendium.json (faecher[].themen[].aufgaben[]).
Anthropic wie im bestehenden „Claude"-Node (Credential „Header Auth account" unverändert, model claude-opus-4-8,
anthropic-version 2023-06-01). Pacing/Auswahl deterministisch in Code-Nodes (via this.helpers.httpRequest,
json:true, try/catch pro Quelle). KI nur für Textinhalte. Alle Daten in Zeitzone Europe/Zurich.
Bei Fehlern kontrolliert abbrechen (nie leere/kaputte Datei schreiben). Schedules NICHT aktivieren,
erst manuellen Testlauf zeigen.

GEMEINSAME LOGIK (Code):
- aufg-Key = `${fachKey}_${themaId}_${aufgabeId}` (Zeichen / . # $ [ ] → _).
- Thema-Beherrschung = Mittel über seine aufgaben von min(box,5)/5 (fehlt → box 0); gemeistert = ≥ 0.6.
- config/aufg dürfen null sein → alles box 0.
- Frage-Objekt immer { id, fach, themaId, typ, frage, optionen?, loesung, erklaerung, schwierigkeit }.

WORKFLOW 1 — „BM Pace" (Schedule Montag 05:00):
- Lies config (examDate) + aufg + kompendium.
- weeksLeft = max(1, ceil(Tage bis examDate / 7)); remaining = #Themen mit Beherrschung < 0.6;
  topicsPerWeek = max(1, ceil(remaining / weeksLeft)).
- weekTopics = erste topicsPerWeek NICHT gemeisterte Themen in Curriculum-Reihenfolge, je "fachKey/themaId".
- PUT /bmpruefung/plan.json = { generatedAt, weeksLeft, topicsPerWeek, weekTopics, weekOf: <Montag dieser Woche> }.

WORKFLOW 2 — „BM Tageslektion" (Schedule täglich 06:00):
- Lies plan + aufg + kompendium (fehlt plan: Logik von WF1 inline).
- todayTopics = nächste 1–2 Themen aus plan.weekTopics, die noch NICHT gemeistert sind.
- uebungsfragen = 4–6 Fragen aus den aufgaben von todayTopics (Mix mc/offen), Frage-Objekte aus kompendium.
- repetitionsfragen = alle aufg mit due ≤ heute, Frage-Objekte per Key aus kompendium rekonstruiert, max 6.
- Anthropic: NUR ein KURZES Coach-Briefing (2–3 Sätze pro Thema: warum heute wichtig + Kernidee/Stolperfalle),
  KEIN Theorie-Nachdruck, KEINE Code-Blöcke (Markdown-Tabellen | … | sind aber erlaubt und werden gerendert), am Ende ein Lerntipp. Schweizer Rechtschreibung: Umlaute ä/ö/ü
  ganz normal verwenden, aber KEIN scharfes ß (stattdessen ss). Reines JSON { titel, text } (UTF-8) zurück.
- PUT /bmpruefung/lessons/<YYYY-MM-DD>.json =
  { datum, titel, text, themen: <todayTopics als "fachKey/themaId">, uebungsfragen, repetitionsfragen }.
- Idempotent (überschreibt denselben Tag).

WORKFLOW 3 — „BM Wochentest" (Schedule Samstag 08:00):
- Lies plan + aufg + kompendium.
- fragenWoche = aus den aufgaben der plan.weekTopics je 2 Fragen.
- fragenAlt = 8 zufällige Fragen aus Themen, die schon bearbeitet wurden (mind. eine aufgabe mit box>0)
  und NICHT in weekTopics sind.
- PUT /bmpruefung/tests/<YYYY-Www>.json (ISO-Woche, z.B. 2026-W30) =
  { woche, erstelltAm, themenDieseWoche: plan.weekTopics, fragen: [ …fragenWoche, …fragenAlt ] }.

Zeig mir je einen manuellen Testlauf (das geschriebene JSON).
```

---

## KI-Funktionen der App (Chat „Polaris", Erklären, Aufgaben, Antwort-Bewertung)

Laufen **nicht** über Netlify. Reihenfolge:
1. **In Quantus hinterlegter Anthropic-Key** — same-origin aus `localStorage["mgmt-v4-settings"].anthropicApiKey`, direkter Anthropic-Call (`anthropic-dangerous-direct-browser-access: true`). Kein Setup nötig, sobald der Key in Quantus steht.
2. **Fallback: n8n-Webhook** `POST <BASE>/quantus-bm-chat` (Header `x-quantus-key`).

**Optionalen Chat-Webhook** (nur falls Weg 2 gewünscht): Webhook-Node (POST `quantus-bm-chat`, prüft `x-quantus-key`, Body `{system, messages, max_tokens}`) → HTTP an Anthropic (Key aus n8n-Credential) → `Respond to Webhook` mit `{ "text": <content[0].text> }`, CORS `Access-Control-Allow-Origin: *`.

---

## Manuell testen (ohne n8n)

Beispiel-Lektion sofort setzen (erscheint dann in der App unter „Tageslektion"):
```bash
curl -X PUT \
  "https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app/bmpruefung/lessons/$(date +%F).json" \
  -H "Content-Type: application/json" \
  -d '{"datum":"'"$(date +%F)"'","titel":"Test-Lektion","text":"## Guten Morgen\nHeute: **Buchungssätze**.","themen":["frw/das-konto"],"uebungsfragen":[{"id":"u1","fach":"frw","themaId":"das-konto","typ":"mc","frage":"Soll steht …","optionen":["links","rechts"],"loesung":"links","erklaerung":"Aktivkonten: Zunahme im Soll.","schwierigkeit":"leicht"}],"repetitionsfragen":[]}'
```
(Die genauen `themaId`-Werte je Fach stehen in der `kompendium.json` bzw. sind über die App-Themenliste ersichtlich.)
