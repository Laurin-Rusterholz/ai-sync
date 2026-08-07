# FlowerTech — Kundenworkflow, Kundenlinks und n8n

Der FlowerTech-Kundenprozess läuft vollständig in Quantus, auf der ganz normalen
Projektseite (`#/projects/<id>`). Es gibt keine zweite App und kein zweites
Datenmodell: Aufgaben sind Quantus-Aufgaben, Mails laufen über die bestehende
Gmail-Anbindung, Offerten und Rechnungen bleiben die vorhandenen FlowerTech-Dokumente.

## 1. Der Prozess

```
Lead → Bestandesaufnahme → Angebot / Vertrag → Umsetzung → Änderungsrunde → Freigabe / Abschluss
```

Die Phasen liegen in `public/flowertech-workflow-core.js` (`WORKFLOW_STAGES`) und
werden an allen Stellen gleich benannt: Projektseite, Pipeline und Kundenansicht.
Alte Phasenschlüssel (`discovery`, `won`, `lost`) bleiben lesbar.

**Interesse erfassen:** FlowerTech → Reiter *Projekte* → *Interesse erfassen*.
Dort werden Projektname, Typ (Website oder Programm), Kundendaten,
Budget/Preisvorstellung und der bisherige Anbieterpreis erfasst. Beim Anlegen
entstehen automatisch die beiden Freigabe-Links (Bedarfsformular, Kundenansicht).

## 2. Bedarfsformular

Ein Feldset, drei Verwendungen — definiert in `BRIEFING_FIELDS`:

| Ort | Beschreibung |
| --- | --- |
| Projektseite → Reiter *Bedarf* | intern ausfüllen |
| `flowertech-formular.html?t=<token>` | teilbarer Link für die Kundschaft |
| n8n | maschineller Eingang mit denselben Feldern |

Aus einer Antwort entstehen:

* strukturierte Projektfelder (Typ, Budget, bisheriger Preis, Termin, Kundendaten),
* **normale Quantus-Aufgaben** (`sourceBriefingKey` verhindert Duplikate),
* eine erste Leistungsbeschreibung aus den Vorlagen.

## 3. Änderungswünsche

Jeder Änderungswunsch — intern erfasst oder vom Kunden über die Kundenansicht —
wird zu einer echten Quantus-Aufgabe (`source: "flowertech-change"`,
`sourceChangeRequestId`). Damit erscheint er automatisch in der zentralen
Aufgaben-App. Der Status des Wunsches folgt der Aufgabe: Aufgabe erledigt →
Wunsch erledigt. Die Aufgabe bleibt führend.

## 4. Angebot, Vertrag, AGB, Datenschutz

Vier Editoren mit demselben Aufbau: jeder Abschnitt ist ein eigener Block mit
Titel, Text, Variablen, Reihenfolge und An/Aus. Die Startvorlagen sind
vorformulierte deutschsprachige FlowerTech-Texte.

* **Angebot / Leistungsbeschreibung** — je nach Typ Website oder Programm.
* **Projektauftrag** — 11 Klauseln plus Signaturzeile: Parteien, Leistung/Abgrenzung,
  Mitwirkung, Termine, Vergütung (inkl. fairer Konkurrenzpreis-Formulierung *nur bei
  vergleichbarem Umfang*), Änderungswünsche, Abnahme, Rechte/Drittanbieter,
  Vertraulichkeit/Datenschutz, Haftung, Schlussbestimmungen mit Schweizer Recht
  und Gerichtsstand.
* **AGB** und **Datenschutz** — Kurzfassungen als bearbeitbare Blöcke.

Variablen werden zur Laufzeit ersetzt (`{{kundin_name}}`, `{{projektname}}`,
`{{preis_chf}}`, `{{gerichtsstand}}` …). Unbekannte Variablen bleiben sichtbar
stehen, damit keine Lücke übersehen wird.

> **Rechtstexte sind Entwürfe.** Jede Vorlage trägt den Hinweis
> „Vor Verwendung rechtlich prüfen". Sie sind keine Rechtsberatung und keine
> Zusicherung rechtlicher Verbindlichkeit.

## 5. Kundenansicht

`flowertech-kunde.html?t=<token>` zeigt der Kundschaft: Typ, Phase,
Kostenübersicht, Leistungsbeschreibung, Termine, Änderungswünsche mit Status,
Versionen/Freigabe, Kontakt sowie — falls hinterlegt — Links zu Vorschau und
Verwaltung/Admin.

Die Seite liest einen **datensparsamen Snapshot** aus
`flowertech/clientPortals/<token>`. Der Snapshot entsteht erst, wenn im Projekt
*Kundenansicht veröffentlichen* gedrückt wird. Vorher zeigt die Seite einen
freundlichen Leerzustand. Interne Notizen, Rechnungsdetails und der Kontaktverlauf
sind nicht enthalten (Nachrichten nur, wenn ausdrücklich `shared`).

Links lassen sich jederzeit erneuern (*Neu*) — der alte Link funktioniert danach
nicht mehr.

## 6. Mails

Zuordnung ausschliesslich über den **ausdrücklichen Projektkontext**:

* Mails, die aus dem Projekt gesendet wurden (samt Antworten, `mailThreadIds`),
* manuell verknüpfte Mails,
* die im Projekt hinterlegten Kontaktadressen.

Es findet keine allgemeine Postfachüberwachung statt. Alle Mails bleiben
zusätzlich normal im Posteingang; die Projektseite verlinkt sie nur.

## 7. Claude-Code-Prompt

Reiter *Claude-Prompt* erzeugt aus Briefing und offenen Änderungswünschen einen
fertigen Prompt mit Kopierfunktion. Was übertragen wird, ist auswählbar —
**Kundendaten, Preise und interne Notizen sind standardmässig ausgeschaltet.**

## 8. n8n: „FlowerTech: Lead → Projekt & Aufgaben"

Import: `n8n/flowertech-lead-to-project.workflow.json` (Workflow → Import from File).

### Ablauf

```
Webhook /flowertech-lead  (Header Auth durch n8n)
        └→ Normalisieren & zuordnen → Zuordnung gültig?
Mail-Eingang (optional, aus) ┘            ├ ja  → Quantus-API → Ergebnis → Antwort 202
                                          └ nein→ Antwort 400 (kein Raten)
```

n8n prüft den Header **am Webhook, bevor der Workflow läuft**. Ein Aufruf ohne
gültige Signatur erreicht die Normalisierung gar nicht. Der IMAP-Eingang ist ein
interner, standardmässig deaktivierter Zweig und braucht keine Signatur.

### Zwei manuelle Schritte nach dem Import

Die Instanz braucht **keine n8n-Variables-Lizenz**. Das Geheimnis liegt in einem
Credential, die öffentliche Quantus-Basis steht fest im HTTP-Node.

**1. Credential anlegen** — n8n → *Credentials* → *New* → **Header Auth**:

| Feld | Wert |
| --- | --- |
| Name | `FlowerTech Shared Signature` |
| Header Name | `X-FlowerTech-Signature` |
| Header Value | das gemeinsame Geheimnis, z. B. aus `openssl rand -base64 48` |

**2. Credential in beiden Nodes wählen:**

- `Webhook: flowertech-lead` → *Authentication: Header Auth* → Credential wählen
- `Quantus-API: Eingang buchen` → Credential wählen

Ohne diesen Schritt zeigen beide Nodes eine Credential-Warnung und der Workflow
läuft nicht. Das ist beabsichtigt: Der importierte Workflow trägt bewusst nur
den Namen des Credentials, nie dessen Wert.

### Einzutragende Variablen

Nur noch auf der Netlify-Seite — in n8n übernimmt das Credential.

| Ort | Variable | Bedeutung |
| --- | --- | --- |
| Netlify (Site settings → Environment) | `FLOWERTECH_WEBHOOK_SECRET` | **identisch** zum Header Value des n8n-Credentials |
| Netlify | `FLOWERTECH_ALLOWED_ORIGINS` | zusätzliche erlaubte Herkünfte, kommagetrennt |
| Netlify | `FLOWERTECH_RATE_SALT` | Salt für das IP-Ratenlimit |
| Netlify | `FIREBASE_SERVICE_ACCOUNT_JSON` | bereits vorhanden (Firebase-Admin) |

Die Basis-URL `https://management-xo2-pro.netlify.app` steht fest im HTTP-Node
und ist keine Variable.

### Sicherheit und Wiederholbarkeit

* **Zugang zur Funktion:** Ein Aufruf ist auf genau zwei Wegen zulässig —
  Browser-Aufruf mit einer **erlaubten Herkunft** (`Origin`-Header) *oder*
  Server-zu-Server mit **gültiger Signatur** (`X-FlowerTech-Signature`).
  Ein fehlender `Origin`-Header ist ausdrücklich **kein** Freibrief: `curl` und
  beliebige Skripte ohne Signatur erhalten **401**, bevor irgendetwas gespeichert
  wird. Ohne gesetztes `FLOWERTECH_WEBHOOK_SECRET` sind ausschliesslich
  Browser-Aufrufe von erlaubten Herkünften möglich. Der Signaturvergleich läuft
  in konstanter Zeit über die volle Länge.
* **Idempotenz:** `idempotencyKey` aus Token, Art, E-Mail und Zieltext. Der
  Server merkt sich verarbeitete Schlüssel unter `flowertech/submissionKeys/` und
  antwortet bei Wiederholung mit `{ ok: true, duplicate: true }`. Retries sind
  gefahrlos; der HTTP-Node wiederholt bis zu dreimal.
* **Fehlerpfad:** Ohne gültigen Token oder ohne Pflichtangaben wird **nichts**
  angelegt — der Lauf antwortet mit 400 und einer Begründung. Es wird nicht geraten,
  zu welchem Projekt ein Lead gehören könnte.
* **Ratenlimit:** 12 Eingänge pro Stunde und IP für Browser-Aufrufe.
* **Datensparsamkeit:** Der Code-Node überträgt nur die Felder des
  Bedarfsformulars. Rohe Fremddaten werden verworfen.

### Testablauf

1. In Quantus ein FlowerTech-Testprojekt anlegen und im Reiter *Kundenansicht*
   den **Formular-Token** aus dem Link kopieren (der Teil nach `?t=`).
2. `FLOWERTECH_WEBHOOK_SECRET` in Netlify setzen und neu deployen.
3. In n8n den Workflow importieren, das Credential anlegen, in beiden Nodes
   wählen und den Workflow aktivieren.
4. Testaufruf:

   ```bash
   curl -sS -X POST "$N8N_BASE/webhook/flowertech-lead" \
     -H 'Content-Type: application/json' \
     -H "X-FlowerTech-Signature: $FLOWERTECH_WEBHOOK_SECRET" \
     -d '{"token":"<FORMULAR_TOKEN>","name":"Testkundin","email":"test@example.ch",
          "message":"Wir brauchen eine neue Website mit Kontaktformular und Terminbuchung."}'
   ```

   Erwartet: `{"ok":true,"submissionId":"sub_…"}` mit HTTP 202.
5. Denselben Aufruf **noch einmal** absetzen. Erwartet: `"duplicate":true` —
   es entsteht kein zweites Projekt und keine doppelte Aufgabe.
6. Aufruf ohne Token: erwartet HTTP 400 mit Begründung, kein Eintrag.
   Aufruf am n8n-Webhook **ohne** `X-FlowerTech-Signature`: n8n antwortet mit
   403, bevor der Workflow startet — der Lead wird nicht einmal normalisiert.

   ```bash
   # muss 401 liefern — weder Herkunft noch Signatur
   curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
     "https://management-xo2-pro.netlify.app/.netlify/functions/flowertech-portal" \
     -H 'Content-Type: application/json' -d '{"token":"<TOKEN>","kind":"change","payload":{"title":"x"}}'
   ```
7. In Quantus die Projektseite öffnen: Bedarf ist gefüllt, die Aufgaben stehen
   in der zentralen Aufgaben-App, die Phase ist auf *Bestandesaufnahme*.

Die Funktion lässt sich auch direkt testen (ohne n8n):

```bash
curl -sS -X POST "https://management-xo2-pro.netlify.app/.netlify/functions/flowertech-portal" \
  -H 'Content-Type: application/json' \
  -H "X-FlowerTech-Signature: $FLOWERTECH_WEBHOOK_SECRET" \
  -d '{"token":"<TOKEN>","kind":"change","payload":{"title":"Logo tauschen"}}'
```

## 9. Datenablage

| Pfad | Inhalt |
| --- | --- |
| `flowertech/submissions/<id>` | Roheingänge aus Formular, Kundenansicht und n8n |
| `flowertech/submissionKeys/<key>` | verarbeitete Idempotenz-Schlüssel |
| `flowertech/clientPortals/<token>` | veröffentlichter Kunden-Snapshot |
| `flowertech/rateLimits/<hash>/<stunde>` | IP-Ratenlimit (gehasht, kein Klartext) |

In der App (`APP.state.data.flowertech`): `briefings`, `changeRequests`,
`contentDocs`, `contracts`, `legalDocs`, `shares`, `promptPrefs`,
`processedSubmissions`.
