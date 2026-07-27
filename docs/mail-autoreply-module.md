# Automatische Mail-Antworten — Text-Autoresponder + KI-Antwort

Konfigurationsbereich im Gmail-Modul: **Gmail → Assistent → 🤖 Auto-Antwort**.

Quantus **sendet hier selbst nichts**. Die Ansicht pflegt ausschliesslich eine
Konfiguration; das Beantworten übernimmt ein n8n-Workflow, der diese
Konfiguration aus der Firebase RTDB liest (Stub:
[`n8n/mail-autoreply.workflow.json`](../n8n/mail-autoreply.workflow.json)).

## Zwei unabhängige Modi

| Modus | Schalter | Verhalten |
| --- | --- | --- |
| **A — Fester Text** | `textEnabled` | Antwortet mit dem hinterlegten Text (`textBody`), ohne KI. Klassische Abwesenheitsnotiz. |
| **B — KI-Antwort** | `aiEnabled` | Eine KI formuliert die Antwort. **Standard ist der Entwurfsmodus.** |
| ↳ Auto-Senden | `aiAutoSend` | Nur wenn dieser Unterschalter bewusst aktiviert wird, geht die KI-Antwort wirklich raus. Standard: **AUS**. |

Beide Modi sind unabhängig schaltbar. Ist **B aktiv, hat B Vorrang vor A** — die
Modusbestimmung im Workflow prüft `aiEnabled` zuerst.

### Entwurfsmodus (Standard des KI-Modus)

Ohne `aiAutoSend` schreibt der Workflow den Antwortentwurf nach `/gmailDrafts`
(`status: "pending"`, `source: "n8n-ai"`). Dort liest ihn die bereits
bestehende Ansicht **🤖 KI-Entwürfe** (`loadDrafts` / `renderDraftsPane`) und
zeigt ihn zur Prüfung — gesendet wird erst nach „✏️ Prüfen & senden". Der
Entwurfspfad ist damit derselbe, den der Workflow *GmailQuantusAIDraft* schon
heute nutzt; es entsteht kein zweiter Entwurfs-Mechanismus.

Sicherheitsnetze in der UI:

- `aiAutoSend` ist **nicht schaltbar**, solange `aiEnabled` aus ist (Schalter
  `disabled`).
- Wird `aiEnabled` ausgeschaltet, fällt `aiAutoSend` automatisch auf `false`
  zurück — Auto-Senden kann nicht „vergessen aktiviert" liegen bleiben.
- Das Einschalten von `aiAutoSend` verlangt eine explizite Bestätigung
  (`confirm`), danach zeigt die Karte einen dauerhaften Warnhinweis.

## Datenstruktur

`APP.state.data.mailAutoReply`:

```js
{
  textEnabled:    false,   // Modus A an/aus
  textBody:       "…",     // Antworttext (max. 8000 Zeichen, vorbelegt)
  aiEnabled:      false,   // Modus B an/aus
  aiAutoSend:     false,   // echtes Senden statt Entwurf (Opt-in)
  aiInstructions: "",      // Ton/Anweisung für die KI (max. 4000 Zeichen)
  updatedAt:      0        // ms-Timestamp der letzten Änderung
}
```

`normalizeMailAutoReply(raw)` (bei `normalizeData`, `public/index.html`) baut das
Objekt defensiv auf: fehlt das Feld (Legacy-Stände) oder enthält es Unsinn,
entstehen gültige Defaults statt einer Exception. Die Booleans werden strikt auf
`=== true` geprüft — ein `"ja"` oder `1` aus einem fremden Datenstand aktiviert
**nichts**, insbesondere nicht das Auto-Senden.

## Persistenz & Sync

Zwei Wege, bewusst getrennt:

1. **App-Sync (Quantus-Blob).** `scheduleSave()` nach jeder Änderung;
   `buildLocalAppSnapshot()` übernimmt das Feld über den Spread von
   `APP.state.data`, und `buildRemoteAppPayload()` normalisiert es zusätzlich
   explizit — so enthält der Payload das Feld auch bei Altbeständen, die es noch
   nie hatten. Damit ist die Konfiguration auf allen Geräten identisch.
2. **RTDB-Spiegel für n8n.** `publishMailAutoReply()` schreibt dieselben Felder
   per `rtdbPatch("mailAutoReply", …)` nach
   `https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app/mailAutoReply`.
   Gleiches Muster wie `publishOrgMail()` / `/orgMailInstructions`; abgedeckt von
   der offenen `$andere`-Regel in `firebase/database.rules.json`. Der Aufruf ist
   „best effort" — schlägt er fehl, ist die Konfiguration lokal trotzdem
   gespeichert und die UI blockiert nicht.

Textfelder speichern per `onchange` (also beim Verlassen des Feldes), damit der
entprellte `render()`-Zyklus den Cursor nicht aus der Textarea wirft. Schalter
speichern sofort und rendern neu.

## Code-Orte (`public/index.html`)

| Bereich | Was |
| --- | --- |
| `MAIL_AUTOREPLY_DEFAULT_TEXT`, `normalizeMailAutoReply()` | Defaults + defensive Normalisierung, direkt vor `normalizeData()` |
| `normalizeData()` | `d.mailAutoReply = normalizeMailAutoReply(d.mailAutoReply)` |
| `buildRemoteAppPayload()` | normalisiert `payload.mailAutoReply` vor dem Upload |
| CSS `.gml-ar…` | Karten, Schalter (`role="switch"`), Warnhinweis; mobile Regeln in `@media (max-width:820px)` |
| `renderNav()` | Navigationseintrag „🤖 Auto-Antwort" unter *Assistent*, Badge `AN` bei aktiver Automatik |
| `renderMainPane()` | `GM.smart === "autoreply"` → `renderAutoReplyPane()` |
| `arCfg()`, `arSave()`, `publishMailAutoReply()`, `gmailArToggle()`, `gmailArText()`, `gmailArResetText()` | Zustand, Speichern, Bedienung |

## n8n-Anbindung

Der Stub `n8n/mail-autoreply.workflow.json` enthält nur Struktur und
Platzhalter (`ERSETZEN-NACH-IMPORT`), **keine Credentials**:

```
Gmail Trigger → RTDB /mailAutoReply lesen → Modus bestimmen → aktiv?
  ├─ KI-Modus  → Prompt bauen → Anthropic → Antwort auslesen → Auto-Senden?
  │                                            ├─ ja   → Gmail: senden
  │                                            └─ nein → RTDB /gmailDrafts (pending)
  └─ Textmodus → Gmail: Text-Antwort senden
```

Vor dem Aktivieren zu ersetzen: Gmail-OAuth2-Credential (Trigger + beide
Sende-Nodes) und das Header-Auth-Credential „Anthropic API-Key (Header
x-api-key)". Der Workflow ist `active: false` ausgeliefert.

Offene Punkte für den produktiven Betrieb (bewusst nicht im Stub):

- **Schleifenschutz** — bereits beantwortete Threads markieren (z. B. Label
  `Quantus/Auto-beantwortet`), damit auf eine Antwort nicht erneut geantwortet
  wird. Der Trigger filtert bisher nur `-from:me`.
- **Wen beantworten?** — aktuell alle Posteingangs-Mails. Sinnvolle Eingrenzung:
  nur bekannte Personen (wie der `fromPerson`-Filter der App) oder nur
  bestimmte Labels.
- **Org-Anweisungen** — `/orgMailInstructions` liesse sich im Node
  „KI-Prompt bauen" einlesen und dem System-Prompt anhängen (gleiches Muster wie
  in `GmailQuantusAIDraft`).
