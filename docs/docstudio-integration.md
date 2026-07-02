# DocStudio — Integration & Datenmodell

DocStudio (`public/docstudio.html`) ist ein eigenstaendiges Quantus-Single-File-Modul zum
Generieren, Bearbeiten und Exportieren fertig gestalteter Dokumente (Rechnung, Einladung,
Factsheet, Brief, Bericht, Protokoll, frei) fuer mehrere Organisationen.
Generierung laeuft ueber n8n → Claude API; das Ergebnis ist immer ein vollstaendiges
standalone HTML-Dokument (A4, `@page`, print-Media-Queries, alle Styles im `<style>`-Block,
Logo als Base64-`<img>`, Farben/Schriften als `:root`-CSS-Variablen).

## Aufrufweg aus anderen Quantus-Modulen

DocStudio laesst sich mit vorbefuelltem Kontext oeffnen:

```
docstudio.html?context=<entityId>&type=<collection>
```

- `context` — die Entity-ID aus den Quantus-Daten (`entities.<collection>.<id>`)
- `type` — eine der Collections `projects`, `tasks`, `notes`, `persons`
  (Singularformen `project`, `task`, `note`, `person`/`contact` werden ebenfalls akzeptiert)

Beim Laden holt DocStudio den Quantus-App-Blob aus der RTDB
(`appStore/app-data_json` → `wrap.data` → `entities.…`), sucht die Entity, uebernimmt
Titel + Inhalt als editierbaren Kontext in den Generierungsdialog und springt zur
Ansicht «Erstellen». Der URL-Parameter wird danach per `history.replaceState` entfernt,
damit ein Reload den Kontext nicht doppelt anlegt.

### Fertiger Button-Snippet (Projekt-/Aufgaben-Detailansicht in index.html)

```html
<!-- item = das gerade angezeigte Projekt; fuer Aufgaben type=tasks verwenden -->
<button class="btn sm" title="Dokument aus diesem Kontext erstellen"
  onclick="window.open('docstudio.html?context=' + encodeURIComponent(item.id) + '&type=projects', '_blank')">
  📄 Dokument erstellen
</button>
```

Fuer Notizen `&type=notes`, fuer Kontakte `&type=persons`.

## Datenmodell (Firebase Realtime Database, REST `.json`-Endpunkte)

Gleiche RTDB-Instanz wie die Hauptapp
(`https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app`):

| Pfad | Inhalt |
|---|---|
| `docOrgs/<id>` | Organisationsprofil: Name, Kurzname, Logo (Storage-URL + Base64), Farben (primaer/sekundaer/akzent/text), Schriften (head/body), Absenderdaten, Fusszeile, Bank (IBAN/QR-IBAN/Bank/MWST-Nr), Tonalitaet, Standard-Stilpreset |
| `docExamples/<id>` | Beispieldokument: orgId, fileName, fileUrl (Storage), mimeType, extrahierter Text, Stilanalyse, Status (`pending`/`ok`/`error`) |
| `docDocuments/<id>` | Generiertes Dokument: orgId, docType, Titel, Status (`entwurf`/`final`), verknuepfter Kontext, Generator-Snapshot (`gen`, fuer «Als Vorlage duplizieren» und Rechnungsnummern-Zaehler) und `versions[]` (`{ts, note, html}`) fuer Rollback |

Logos und Original-Beispieldateien liegen in Firebase Storage unter
`docstudio/logos/…` bzw. `docstudio/examples/<orgId>/…`.

## n8n-Webhooks (Header `x-quantus-key`)

Basis-URL und Key stehen im `CONFIG`-Objekt am Anfang des Scripts in `docstudio.html`
(alle anzupassenden Stellen sind mit `// TODO(Laurin):` markiert).

| Webhook | Payload | Antwort |
|---|---|---|
| `POST …/quantus-doc-generate` | `{org, docType, fields, style:{preset, sliders, freitext}, context:[{source,title,content}], examples:[{styleAnalysis,excerpt}], wishes, contract}` | vollstaendiges HTML (roh oder als JSON `{html}`) |
| `POST …/quantus-doc-revise` | `{html, instruction, org}` | vollstaendiges HTML |
| `POST …/quantus-doc-example` | `{org, fileUrl, fileName, mimeType}` | JSON `{text, styleAnalysis}` |

`contract.cssVars` benennt die `:root`-Variablen, die das generierte Dokument fuer
Farben/Schriften nutzen muss (`--doc-primary`, `--doc-secondary`, `--doc-accent`,
`--doc-text`, `--doc-font-head`, `--doc-font-body`) — die Schnellregler im Editor
(Primaerfarbe/Schrift nachtraeglich aendern) setzen genau diese Variablen. Der
n8n-Prompt muss Claude entsprechend anweisen. Bei Rechnungen mit hinterlegter
QR-IBAN (`fields.qrRechnung === true`) soll das Dokument die Schweizer QR-Rechnung
ueber eine im Dokument eingebettete JS-Library erzeugen, damit es standalone und
editierbar bleibt.
