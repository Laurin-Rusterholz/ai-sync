# E-Mail-Auswertung fuers Tagesbriefing — Aktivierung (auf Abruf, kein Zeitplan)

Betrifft: `netlify/lib/quantus-v3-daily-briefing.mjs` +
`netlify/functions/quantus-v3-daily-briefing-run.mjs`.

**Architektur, verbindlich:** die taegliche Orchestrierung (Aufgaben, Notes,
Briefing) macht der Nutzer selbst ueber einen lokal geplanten ChatGPT-Lauf
auf seinem eigenen Rechner. Diese Funktion ist **kein** zweiter, autonomer
Scheduler — sie hat bewusst **keinen** Netlify-Zeitplan (`config.schedule`)
und tut **nichts von selbst**. Sie wartet auf einen authentifizierten Aufruf
von aussen und wertet dann genau einmal die neuen Gmail-Nachrichten aus.

## 1. Environment-Variablen (Netlify → Site settings → Environment variables)

Bereits vorhanden, kein neuer Wert noetig:
- `FIREBASE_SERVICE_ACCOUNT_JSON` — liest/schreibt den Datenstand.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — Gmail-OAuth (server-seitig,
  wie bei `gmail-api.mjs`).
- `SYNC_AUTH_TOKEN` — Zugangsschluessel dieses Endpunkts (derselbe wie fuer
  die uebrigen bestehenden Sync-Endpunkte).

Neu zu setzen (Namen, keine Geheimnisse):
```
QUANTUS_V3_ANTHROPIC_MODEL=claude-sonnet-5
QUANTUS_V3_ANTHROPIC_INPUT_MICROS_PER_MTOK=2000000
QUANTUS_V3_ANTHROPIC_OUTPUT_MICROS_PER_MTOK=10000000
QUANTUS_V3_TENANT=quantus
QUANTUS_V3_TAGESBRIEFING_POLICY_JSON=<siehe 2.>
QUANTUS_V3_COST_POLICY_JSON=<siehe 3.>
```
Die Preise ($2/$10 pro Million Token) entsprechen dem offiziell aktuellen
Sonnet-5-Standardpreis (verifiziert gegen
`https://platform.claude.com/docs/en/about-claude/pricing`, Stand
20.09.2026) — nicht raten, bei einer Preisaenderung dort neu nachsehen und
beide Werte zusammen aendern.

Der Anthropic-Schluessel selbst braucht **keine eigene Variable**: er wird
aus den bereits in Quantus hinterlegten Einstellungen gelesen
(`APP.state.settings.anthropicApiKey`, ueber Firebase gespiegelt) — einmal
in der App unter Einstellungen eintragen, fertig.

## 2. `QUANTUS_V3_TAGESBRIEFING_POLICY_JSON` (Schema `tagesbriefing-policy/3`)

```json
{
  "schema": "tagesbriefing-policy/3",
  "version": "1",
  "tenant": "quantus",
  "timezone": "Europe/Zurich",
  "sourceMaxAgeMinutes": 15,
  "evaluationTtlMinutes": 15,
  "deferralLimit": 3,
  "maxWaitDays": 30,
  "requiredSources": [
    { "id": "quantus-core", "kind": "quantus-core" },
    { "id": "gmail", "kind": "mail" }
  ],
  "noExternalSources": false,
  "closure": { "earliestLocalTime": "23:00", "requiredReceipts": ["process09", "close23"] },
  "featureFlags": { "writes": "live", "runner": "live", "providers": "live" }
}
```
`tenant` muss exakt `QUANTUS_V3_TENANT` entsprechen. Die `id: "gmail"` ist
verbindlich (`SOURCE_ID` im Code) — ein anderer Name wuerde den
Quellen-Cursor nicht wiederfinden.

## 3. `QUANTUS_V3_COST_POLICY_JSON` (Schema `quantus-v3-cost-policy/1`, GETRENNT von 2.)

```json
{
  "schema": "quantus-v3-cost-policy/1",
  "version": "1",
  "currency": "USD",
  "approval": { "approvedBy": "<Name/Kuerzel>", "approvalRef": "<Referenz>", "approvedAtMs": 1758000000000 },
  "effectiveFromMs": 1758000000000,
  "effectiveUntilMs": 4102444800000,
  "dayLimitMicros": 10000000,
  "runLimitMicros": 5000000,
  "callLimitMicros": 1000000,
  "unresolvedBlockMicros": 5000000,
  "featureFlags": { "providers": "live" },
  "models": {
    "anthropic:claude-sonnet-5": {
      "inputMicrosPerMillionTokens": 2000000,
      "outputMicrosPerMillionTokens": 10000000,
      "maxCallMicros": 1000000
    }
  }
}
```
`approvedAtMs`/`effectiveFromMs` als reale Unix-Millisekunden setzen (nicht
in der Zukunft). Diese Policy plus der globale, hart codierte
$50/Monat-Deckel (`MONTHLY_CAP_MICROS`, `runtime/quantus-v3/src/
monthly-cost-cap.mjs`, $30-Warnung in der UI) gelten **ausschliesslich fuer
diesen E-Mail-Auswertungsaufruf** — keine andere Automatisierung ruft
`anthropic.dispatch` ueber diesen Pfad auf.

## 4. Aufruf durch den lokalen Agenten

```
POST https://<site>.netlify.app/.netlify/functions/quantus-v3-daily-briefing-run
Authorization: Bearer <SYNC_AUTH_TOKEN>
```
Kein Body noetig. Antwort (Beispiele):
- `{"ok":true,"drafted":true,"sourceOutcome":"ok", ...}` — Entwurf steht als
  Notiz in DailyBriefing (`v3-draft:quantus:<Datum>:briefing04:<policyVersion>`).
- `{"ok":true,"sourceOutcome":"ok","drafted":false}` — Posteingang leer,
  nichts zu verarbeiten, ehrlich vermerkt.
- `{"ok":true,"skipped":"duplicate_delivery"}` — lief gerade schon (Pacht
  aktiv), kein zweiter Aufruf noetig.
- `{"ok":false,"blocked":"missing_configuration","missing":[...]}` — siehe
  Abschnitt 1, nur Namen, nie Werte.
- `{"ok":false,"blocked":"anthropic_key_not_configured", "sourceOutcome":"ok"}`
  — Gmail wurde trotzdem ehrlich gescannt/vermerkt, nur der Entwurf fehlt.
- HTTP 401 `{"ok":false,"error":"KEIN_ZUGANG"}` — falscher/fehlender Token.

Ein einzelner `curl`-Test ohne echten Versand:
```
curl -s -X POST -H "Authorization: Bearer $SYNC_AUTH_TOKEN" \
  https://<site>.netlify.app/.netlify/functions/quantus-v3-daily-briefing-run
```

## 5. Verbleibende Blocker vor dem ersten echten Lauf

1. Alle sieben Variablen aus Abschnitt 1 muessen in Netlify gesetzt sein
   (Name pruefbar per Preflight-Antwort oben, ohne Netz).
2. Der Anthropic-Schluessel muss in Quantus unter Einstellungen eingetragen
   und mindestens einmal synchronisiert (Firebase) sein.
3. Der lokale ChatGPT-Lauf muss den obigen Aufruf tatsaechlich ausfuehren
   (Konfiguration liegt beim Nutzer, ausserhalb dieses Repos).
4. Bis zur ersten Konfiguration bleibt jede Antwort ehrlich `503
   missing_configuration` — es wird nichts vorgetaeuscht.

Nichts hiervon ist bereits live geschaltet oder auf Netlify konfiguriert;
das bleibt Sache des Nutzers.
