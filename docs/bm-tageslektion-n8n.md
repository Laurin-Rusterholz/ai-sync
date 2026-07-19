# BM Tageslektion — n8n-Workflow (Firebase → Quantus BM-Prüfung)

Der Workflow spielt **täglich** den „Lehrer": er liest den Lernfortschritt aus
Firebase, bestimmt die heute fälligen Themen, lässt Claude eine kurze Lektion +
prüfungsnahe Fragen schreiben und legt das Ergebnis in Firebase ab. Die App
`bm.html` liest es unter `bmpruefung/lessons/<datum>` und zeigt es in
**Tageslektion** an.

> **Alles über Firebase, keine Netlify-Blobs.** Lesen/Schreiben via RTDB-REST
> (offene Rules unter `$andere`, kein Login).

---

## Endpunkte & Schemas (Fakten für den Workflow)

**Firebase RTDB-Basis:**
```
https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app
```

| Zweck | Methode | Pfad |
|---|---|---|
| Prüfungsdatum/Plan lesen | GET | `/bmpruefung/config.json` → `{ examDate, planStart, streak, ... }` |
| Fortschritt lesen | GET | `/bmpruefung/aufg.json` → Map `{ "<fach>_<themaId>_<aufgabeId>": {box,due,c,w}, ... }` |
| Lektion schreiben | PUT | `/bmpruefung/lessons/<YYYY-MM-DD>.json` (Body = Lektions-JSON, siehe unten) |

**Curriculum (Themen + Aufgaben), statisch:**
```
https://management-xo2-pro.netlify.app/theorie/kompendium.json
```
Struktur: `{ faecher:[ { key, fach, themen:[ { id, kapitel, titel, lernziele[], theorie, merksaetze[], beispiele[], aufgaben:[ {id,typ,frage,optionen?,loesung,erklaerung,schwierigkeit} ] } ] } ] }`

**Fortschritts-/Schlüssel-Logik (identisch zur App):**
- Aufgaben-Key in `bmpruefung/aufg` = `` `${fachKey}_${themaId}_${aufgabeId}` `` (die App ersetzt `/ . # $ [ ]` durch `_`).
- **Box** eines Aufgabe-Eintrags ist 0–5 (Leitner). Ohne Eintrag = Box 0.
- **Thema-Beherrschung** = Mittelwert über die Aufgaben des Themas von `min(box,5)/5`.
- **„Gemeistert"** = Beherrschung ≥ **0.6**.
- **Pacing:** `daysLeft = examDate − heute`; `remaining = #Themen mit Beherrschung < 0.6`; `perDay = ceil(remaining / max(daysLeft,1))`. Heutige Themen = die **ersten `perDay` noch nicht gemeisterten** Themen in Curriculum-Reihenfolge (Fächer in Reihenfolge der `faecher`, Themen in Array-Reihenfolge).

**Lektions-JSON, das die App erwartet** (nach `/bmpruefung/lessons/<YYYY-MM-DD>`):
```json
{
  "datum": "2026-07-19",
  "titel": "Tageslektion: Kontenrahmen & Buchungssatz",
  "text": "Kurzer Lehrer-Text (Markdown erlaubt: ## Überschrift, **fett**, - Liste).",
  "fragen": [
    {
      "id": "tl-2026-07-19-1",
      "fach": "frw",                 // fachKey aus kompendium (optional, aber empfohlen)
      "themaId": "das-konto",        // themaId aus kompendium (optional)
      "typ": "mc",                   // "mc" | "offen" | "anwenden" | "rechnen"
      "frage": "…",
      "optionen": ["…","…","…","…"], // nur bei typ=mc
      "loesung": "…",                // bei mc: exakt gleich wie eine Option
      "erklaerung": "…",
      "schwierigkeit": "mittel"      // leicht | mittel | schwer
    }
  ]
}
```
Falsch beantwortete Lektionsfragen wandern in der App automatisch in die
Spaced-Repetition-Queue (bei gesetztem `fach`+`themaId` ins jeweilige Thema,
sonst als eigenständiger Snapshot).

**Anthropic (Messages API), wie im bestehenden Modell-Workflow:**
`POST https://api.anthropic.com/v1/messages`, Header `x-api-key` (aus n8n-Credential, **nicht** hardcoden), `anthropic-version: 2023-06-01`, `content-type: application/json`. Modell: `claude-opus-4-8`.

---

## Prompt für „Claude for Chrome" (zum Bauen des Workflows in n8n)

> Kopiere den Block unten und gib ihn Claude für Chrome, während deine n8n-Instanz offen ist.

```
Baue mir in n8n einen neuen Workflow mit dem Namen „BM Tageslektion". Er soll täglich laufen und für meine Lern-App „Quantus · BM-Prüfung" eine Tageslektion erzeugen und in Firebase schreiben. Halte dich exakt an die folgenden Vorgaben.

TRIGGER
- Schedule Trigger, täglich um 06:00 Uhr (Europe/Zurich).

SCHRITT 1 — Fortschritt & Plan lesen (HTTP Request Nodes, Methode GET):
- A: https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app/bmpruefung/config.json  → liefert { examDate, planStart } (examDate ist das Prüfungsdatum als "YYYY-MM-DD"; kann null sein).
- B: https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app/bmpruefung/aufg.json     → Map von Aufgaben-Status: Key = "<fachKey>_<themaId>_<aufgabeId>", Wert = { box (0..5), due, c, w }. Kann null sein.
- C: https://management-xo2-pro.netlify.app/theorie/kompendium.json                                → das Curriculum mit faecher[].themen[].aufgaben[].

SCHRITT 2 — Heutige Themen bestimmen (Code Node, JavaScript):
- Datum heute = YYYY-MM-DD (Zeitzone Europe/Zurich).
- Falls examDate gesetzt: daysLeft = max(1, Tage zwischen heute und examDate).
- Für jedes Thema in Curriculum-Reihenfolge (faecher in Array-Reihenfolge, darin themen in Array-Reihenfolge): berechne Beherrschung = Mittelwert über seine aufgaben von min(box,5)/5, wobei box aus aufg["<fachKey>_<themaId>_<aufgabeId>"].box kommt (fehlt der Eintrag → box 0). Ein Thema gilt als „gemeistert", wenn Beherrschung ≥ 0.6.
- remaining = Anzahl nicht gemeisterter Themen. perDay = ceil(remaining / daysLeft) (mindestens 1; falls examDate null: perDay = 3).
- todayTopics = die ersten perDay NICHT gemeisterten Themen in dieser Reihenfolge. Gib pro Thema mit: fachKey, fach, themaId, titel, kapitel, theorie, merksaetze, lernziele und die Liste seiner aufgaben.

SCHRITT 3 — Lektion generieren (HTTP Request an Anthropic):
- POST https://api.anthropic.com/v1/messages
- Header: x-api-key = mein Anthropic-API-Key aus einem n8n-Credential (NICHT im Klartext hardcoden), anthropic-version: 2023-06-01, content-type: application/json.
- Body (JSON):
  {
    "model": "claude-opus-4-8",
    "max_tokens": 2000,
    "system": "Du bist ein Lehrer für die Schweizer Berufsmaturitätsprüfung (Wirtschaft & Dienstleistungen). Schreibe auf Deutsch in Schweizer Rechtschreibung (kein ß, nutze ss). Antworte NUR mit gültigem JSON, ohne Markdown-Codeblock, ohne Text davor oder danach.",
    "messages": [{ "role": "user", "content": "<siehe unten>" }]
  }
- Der user-content soll die todayTopics (Titel + Kurz-Theorie + ein paar bestehende Aufgaben als Stil-Vorlage) enthalten und Folgendes verlangen:
  „Erstelle eine motivierende, kurze Tageslektion zu diesen Themen und 6 prüfungsnahe Fragen. Gib GENAU dieses JSON zurück:
  { \"titel\": \"…\", \"text\": \"2-4 Absätze Lehrer-Erklärung, Markdown erlaubt\", \"fragen\": [ { \"id\":\"tl-<datum>-<n>\", \"fach\":\"<fachKey>\", \"themaId\":\"<themaId>\", \"typ\":\"mc|offen|anwenden|rechnen\", \"frage\":\"…\", \"optionen\":[\"…\"] (nur bei mc), \"loesung\":\"… (bei mc exakt eine der Optionen)\", \"erklaerung\":\"…\", \"schwierigkeit\":\"leicht|mittel|schwer\" } ] }.
  Nutze fach und themaId aus den vorgegebenen Themen. Mische MC und offene Fragen.\"

SCHRITT 4 — Zusammenbauen (Code Node):
- Parse die Anthropic-Antwort (Feld content[0].text) als JSON. Falls das Parsen fehlschlägt, entferne evtl. umschließende ```json ... ``` und parse erneut.
- Setze datum = heutiges Datum. Ergänze/überschreibe jede Frage-id mit "tl-<datum>-<index>" falls leer.
- Ergebnis-Objekt: { datum, titel, text, fragen }.

SCHRITT 5 — In Firebase schreiben (HTTP Request, Methode PUT):
- URL: https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app/bmpruefung/lessons/<heutiges-Datum>.json   (das Datum als Pfadsegment, z. B. …/lessons/2026-07-19.json)
- Body: das Ergebnis-Objekt aus Schritt 4 (Content-Type application/json).

FEHLERBEHANDLUNG
- Wenn config/aufg null sind (neue Nutzung), nutze perDay = 3 und die ersten 3 Themen des Curriculums.
- Der Workflow soll idempotent sein: erneutes Laufen am selben Tag überschreibt die Lektion dieses Tages.

Zeig mir am Ende die fertige Workflow-Struktur und teste einen manuellen Lauf.
```

---

## Manuell testen (ohne n8n)

Eine Beispiel-Lektion sofort setzen (dann in der App unter „Tageslektion" sichtbar):
```bash
curl -X PUT \
  "https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app/bmpruefung/lessons/$(date +%F).json" \
  -H "Content-Type: application/json" \
  -d '{"datum":"'"$(date +%F)"'","titel":"Test-Lektion","text":"## Willkommen\nHeute üben wir **Buchungssätze**.","fragen":[{"id":"t1","fach":"frw","themaId":"das-konto","typ":"mc","frage":"Soll steht …","optionen":["links","rechts"],"loesung":"links","erklaerung":"Aktivkonten: Zunahme im Soll.","schwierigkeit":"leicht"}]}'
```
