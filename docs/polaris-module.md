# Polaris — Sprachsteuerungs-Modul mit Gedächtnis & Charakter

Modul in **`public/index.html`** (Route `#/polaris`, alles inline — IIFE,
`data-action`-Delegation, `toast()`, `scheduleSave()`, Schiefer-Tokens) plus
n8n-Workflow **`n8n/polaris-webhooks.json`**. Polaris ist ein
ElevenLabs-Conversational-AI-Agent mit Langzeitgedächtnis, sich entwickelndem
Charakter, Web-Recherche und proaktivem Gesprächsverhalten.

- Firebase-Projekt: `jupidu-36804` · RTDB: `https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app`
- ElevenLabs Web-SDK: `@elevenlabs/client@1.14.1` via CDN — **`dist/lib.iife.js`**
  (einen `lib.umd.js`-Build gibt es ab v1.x nicht mehr), Global `window.ElevenLabsClient`
- Agent-ID: Konstante `POLARIS_AGENT_ID` im Modul (Marker `>>> HIER AGENT-ID EINTRAGEN <<<`)
- **Keine Secrets im Frontend**: Session-Zugang via Signed-URL vom n8n-Endpoint
  `GET /webhook/polaris/session-url`; `x-polaris-secret` existiert nur serverseitig

## Frontend-Verhalten

| Element | Verhalten |
|---|---|
| Toggle „Polaris aktiv" | An = Session starten (nach Mikrofon-Permission-Check), Aus = `endSession()`. Persistiert unter `data.settings.polaris.enabled` via `scheduleSave()`. `onDisconnect` (auch agentenseitiges `end_call`) setzt konsistent auf „Aus". |
| Launch-Button | Session-Start + `sendUserMessage("LAUNCH")` + Boot-Overlay (audio-reaktiver Orb). Overlay verschwindet beim ersten `speaking → listening`-Wechsel (SDK-Statuscallback, kein Transkript-Parsing), Sicherheitsventil 45 s, Tap-to-dismiss. |
| Status-Orb | idle / listening / thinking (abgeleitet: User-Transkript eingetroffen) / speaking; Glow/Scale via `getOutputVolume()`-rAF-Loop. |
| Sprachbefehle | „merk dir …" / „notier(e) …" / „schreib auf …" → `note-save`. „recherchiere …" / „such im Netz nach …" → `research`, Ergebnis geht als Kontext-Update zurück an den Agenten. „schreib eine Mail (an name@adresse) (Betreff: …) …" → `compose-mail` (legt **nur einen Gmail-Entwurf** an, sendet nie). „leg ein Projekt an …" / „neues Projekt …" → `create-project`. Dazu zwei Schnellaktions-Buttons im Polaris-View (`data-action="polaris-create-project"` / `"polaris-compose-mail"`, Touch-Targets ≥44px). |
| Nach Session-Ende | Transcript-Zusammenfassung → `memory-save` (type `conversation`), Beziehungs-Update (Stimmung, lastTopics, Open Loops, Streak), Charakter-Evolution (Trait-Drift hart ±0.05, `evolutionLog`). |
| Beim Session-Start | `memory-recall` + `proactive` + Charakter-Lesen parallel zum Auth-Fetch → dynamische Variablen (siehe unten). |
| Proaktivität | Auto-Start beim App-Öffnen (nur wenn Toggle zuletzt an, Proaktivität an **und** Mikrofon-Permission bereits erteilt) und Inaktivitäts-Nudge (4 min Stille, 15 min Cooldown). Abschaltbar über den Schalter im Panel; Setting liegt lokal + gespiegelt unter `polaris/settings/proactiveEnabled` (RTDB-Wert gewinnt beim Panel-Refresh). |
| Charakter-Panel | Read-only: Trait-Balken, Stimmung + Streak, letzte 5 Erinnerungen. Cache in `data.settings.polaris.cache` (`scheduleSave()`), Quelle ist die RTDB. |

Fehlerbilder zeigen deutsche `toast()`-Meldungen und stellen immer einen
konsistenten Zustand her (kein „Toggle an ohne Session"); nicht erreichbare
Endpunkte fallen auf direkte RTDB-Zugriffe bzw. lokal gebaute Ersatzwerte
zurück (einmalige Warnung pro Endpoint und Seitenaufruf).

## Datenmodell (RTDB, unter `polaris/`)

| Pfad | Inhalt |
|---|---|
| `polaris/memory/{pushId}` | `{ ts, type: 'conversation'\|'note'\|'fact'\|'preference', text, summary, tags[], importance 1–5, source: 'voice'\|'system' }` |
| `polaris/notes/{pushId}` | `{ ts, text, tags[], done: false }` |
| `polaris/character` | `{ traits: { humor, warmth, directness, curiosity, formality } je 0–1, backstory, catchphrases[], evolutionLog: [{ ts, change, reason }] }` — wird beim ersten Zugriff mit Defaults initialisiert |
| `polaris/relationship` | `{ ts, mood, lastTopics[], openLoops[], streak }` |
| `polaris/projects/{pushId}` | `{ ts, title, description, tags[], status: 'open'\|'done', source: 'voice'\|'system' }` |
| `polaris/conversations/{conversationId}` | `{ id, startedAt, durationSecs, turnCount, summary, transcript, createdAt, ts }` — schreibt der n8n-Post-Call-Webhook (`/conversation-log`) nach jedem Gespräch. Beim Session-Start liest das Frontend die **15 neuesten** Einträge (client-seitig nach `ts` absteigend sortiert — die Keys sind ElevenLabs-IDs, nicht chronologisch) und hängt sie als Block `Frühere Gespräche:` mit Zeilen `Früheres Gespräch vom TT.MM.JJJJ: {summary}` an `{{polaris_memory}}` an (neueste 5 Summaries max. 240 Zeichen, ältere 120, Block ≤1600, Variable gesamt ≤3000 Zeichen; Inhalte defensiv bereinigt). Leerer/nicht erreichbarer Knoten → Kontext wie bisher ohne Historie. |
| `polaris/display` | `{ title, content, type, ts, updatedAt }` — die aktuelle Bildschirm-Anzeige (n8n schreibt/überschreibt). Das Frontend hört live darauf (`on('value')`, REST-Poll-Fallback) und zeigt eine Karte unten rechts, auch über dem Ruhemodus: `type='list'` → zeilenweise Liste, `type='code'` → `<pre>`/monospace, sonst Text; leerer Knoten → Karte blendet sanft aus; Inhalte werden immer escaped gerendert (kein Roh-HTML). Schliessen via `data-action="polaris-display-close"` oder Escape (bis neuer Inhalt kommt). |
| `polaris/settings/proactiveEnabled` | Spiegel des Frontend-Schalters (auch von n8n/Agent lesbar) |

Die RTDB-Regeln decken `polaris/*` über den offenen `$andere`-Zweig ab.
Primärer Schreibweg sind die n8n-Webhooks; Direktzugriffe sind Lese- und
Fallback-Pfad des Frontends.

## n8n-Endpunkte (`n8n/polaris-webhooks.json`)

Basis: `https://n8n.srv1757990.hstgr.cloud/webhook/polaris`

| Endpoint | Request | Response | Umsetzung |
|---|---|---|---|
| `GET /session-url` (+ optional `?agent_id=…`) | – | `{signedUrl}` oder `{conversationToken}` | **bestehender** Workflow, nicht Teil der Import-Datei |
| `POST /memory-save` | `{type, text, summary?, tags?, importance?, source?}` | `{ok, id}` | normalisieren → bei `conversation` LLM-Zusammenfassung (Claude, Fallback: Client-Heuristik) → Push nach `polaris/memory` |
| `POST /memory-recall` | `{query, limit?}` | `{items:[…]}` | Volltext-/Tag-Suche über `memory` + `notes` mit Rezenz-/Wichtigkeits-Bonus |
| `POST /note-save` | `{text, tags?}` | `{ok, id}` | Push nach `polaris/notes` (`done:false`) |
| `POST /research` | `{query}` | `{query, summary, sources:[{title,url}]}` | dedizierte HTTP-Request-Nodes: Wikipedia-Suche (de→en) + REST-Summary des besten Treffers (timeout 6000, continueOnFail); Code-Node verarbeitet nur — kein Credential, kein `this.helpers.httpRequest` (hängt in der Task-Runner-Sandbox) |
| `POST /character-update` | `{traitDeltas, reason}` | `{ok, character}` | Deltas hart ±0.05 klemmen, Traits 0–1, `evolutionLog`-Eintrag (max. 20) |
| `POST /proactive` | `{}` | `{opener}` | Gruss nach Tageszeit (Europe/Zurich) + ältester Open Loop bzw. offene Notizen bzw. Streak |
| `POST /create-project` | `{title, description?, tags?}` | `{ok, id, title}` | Brain-Workflow, credential-frei: HTTP-Node POST auf `polaris/projects.json`; ohne Titel `{ok:false, error:'kein Titel'}` |
| `POST /read-mail` | `{id}` | `{ok, id, from, to, subject, date, text}` | On-Demand-Workflow, Gmail-Node `message/get` (gmailOAuth2). Reine Input-Validierung — **kein** Secret-/`$env`-Check (Env-Zugriff ist in der Instanz gesperrt); ohne id `{ok:false, error:'no id'}` |
| `POST /compose-mail` | `{to?, subject?, body}` | `{ok, draftId, to, subject, note}` | On-Demand-Workflow, Gmail-Node **`draft/create`** — legt ausschliesslich einen **Entwurf** an, sendet **niemals**; ohne body `{ok:false, error:'kein Text'}` |

**Import:** Datei in n8n importieren → den beiden Claude-Nodes das
Anthropic-Credential (Header `x-api-key`) zuweisen → Workflow aktivieren.
Die RTDB-Nodes brauchen keine Credentials (offene Regeln); CORS ist auf allen
Webhooks aktiv (`allowedOrigins: *`), damit das Frontend direkt posten darf.

**Sicherheit/Härtung:** Browser-Aufrufe kommen ohne `x-polaris-secret` an —
deshalb prüfen die Webhooks das Secret aktuell nicht (eine „nur wenn Header
vorhanden"-Prüfung wäre Scheinsicherheit). Härtungspfad: Browser-Aufrufe über
eine Netlify-Function proxen, die das Secret serverseitig injiziert, dann die
Prüfung in n8n aktivieren. Der ElevenLabs-Agent kann die Webhooks unabhängig
davon als Server-Tools **mit** Secret-Header aufrufen.

## ElevenLabs-Agent einrichten

Agent-ID: `agent_5101kx5v9rw7fx78kx919m332kkh` (bereits im Frontend eingetragen).

**Dynamische Variablen** (kommen bei jedem Session-Start vom Frontend):

| Variable | Inhalt |
|---|---|
| `{{user_name}}` | „Laurin" |
| `{{current_date}}` / `{{current_weekday}}` / `{{current_time}}` / `{{timezone}}` | via `Intl`, Europe/Zurich (TT.MM.JJJJ, deutscher Wochentag, HH:MM) |
| `{{polaris_memory}}` | die 5 relevantesten Erinnerungen (memory-recall), eine pro Zeile — plus Block „Frühere Gespräche:" mit den 15 neuesten Summaries aus `polaris/conversations` (gesamt max. 3000 Zeichen) |
| `{{polaris_opener}}` | proaktiver Gesprächseinstieg |
| `{{polaris_character}}` | Trait-Brief (Prozente), Backstory, typische Sprüche, letzte Stimmung + Streak — **so erreicht die Charakter-Evolution die Stimme** |

**First Message** (Vorschlag): leer lassen und `LAUNCH`/Systemhinweise das
Gespräch eröffnen lassen — oder schlicht `{{polaris_opener}}`.

**System-Prompt-Vorlage** (kürzen/anpassen nach Geschmack):

```
Du bist Polaris, der persönliche Sprach-Begleiter von {{user_name}} in seiner
Quantus-App. Heute ist {{current_weekday}}, der {{current_date}}, es ist
{{current_time}} ({{timezone}}).

DEIN CHARAKTER (entwickelt sich über die Zeit, halte dich an diese Werte):
{{polaris_character}}
Hohe Werte lebst du hörbar aus (mehr Humor = trockene Sprüche, hohe Direktheit
= keine Floskeln, tiefe Förmlichkeit = Du-Form, locker). Sprich natürlich,
kurz und gesprächig — du wirst gehört, nicht gelesen.

DEIN GEDÄCHTNIS (relevante Erinnerungen aus früheren Gesprächen):
{{polaris_memory}}
Beziehe dich beiläufig darauf, wenn es passt („Du wolltest ja noch …").
Erfinde keine Erinnerungen.

KOMMANDOS:
- Nachricht „LAUNCH": Starte das Morgen-Briefing — begrüsse Laurin, fasse die
  wichtigsten offenen Themen zusammen und schliesse mit einer Frage.
- Nachrichten in der Form „(Systemhinweis: …)": Das sind Regieanweisungen der
  App, keine Aussagen von Laurin. Setze sie dezent um und erwähne sie nie.
  Beispiel: die App schlägt dir mit „{{polaris_opener}}" einen Einstieg vor.
- Sagt Laurin „merk dir …" oder „recherchiere …", bestätigt die App das per
  Systeminfo-Kontext — quittiere kurz („Notiert.") statt es zu wiederholen.

VERHALTEN:
- Stelle Rückfragen, denk mit, schlage nächste Schritte vor — du bist ein
  Begleiter, kein Frage-Antwort-Bot.
- Wenn nichts mehr ansteht oder Laurin sich verabschiedet, beende das Gespräch
  über das System-Tool end_call.
```

**Tools/Einstellungen im Agenten:**
- System-Tool **`end_call`** aktivieren (das Frontend behandelt den Disconnect
  und setzt den Toggle zurück).
- Optional die n8n-Webhooks als **Server-Tools** anbinden (memory-save,
  memory-recall, note-save, research) — dort den Header `x-polaris-secret`
  hinterlegen. Damit kann der Agent selbst speichern/suchen, unabhängig von
  den Client-Sprachbefehlen.
- Sicherheit → dynamische Variablen/Overrides zulassen, damit
  `dynamicVariables` vom SDK akzeptiert werden.

## Manuelle Schritte (Checkliste)

1. ~~`POLARIS_AGENT_ID` eintragen~~ ✅
2. `n8n/polaris-webhooks.json` importieren, Anthropic-Credential zuweisen,
   aktivieren (der bestehende `session-url`-Workflow bleibt unberührt)
3. ElevenLabs-Agent konfigurieren (Prompt-Vorlage oben, `end_call`, optional
   Server-Tools mit `x-polaris-secret`)
4. PR mergen, Netlify deployt `public/` automatisch
5. Erstes Gespräch führen und prüfen: `polaris/memory` bekommt einen Eintrag,
   `polaris/character.evolutionLog` wächst, Panel zeigt Stimmung/Streak
