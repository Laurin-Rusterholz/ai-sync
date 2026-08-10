# FlowerTech — Kundenablauf: zwei Links, zwei Phasen

Der FlowerTech-Kundenprozess läuft vollständig in Quantus, auf der ganz normalen
Projektseite (`#/projects/<id>`). Es gibt keine zweite App und kein zweites
Datenmodell: Aufgaben sind Quantus-Aufgaben, Mails laufen über die bestehende
Gmail-Anbindung, Offerten und Rechnungen bleiben die vorhandenen FlowerTech-Dokumente.

## 0. Die zwei Links — die wichtigste Regel

Es gibt **genau zwei** öffentliche Links, und sie werden nie verwechselt:

| | Phase 1 | Phase 2 |
| --- | --- | --- |
| **Name** | **Fragebogen-Link** (auch: Briefing-Link) | **Kundenportal-Link** |
| **Adresse** | `flowertech.ch/fragebogen.html?e=<Einladungstoken>` | `flowertech.ch/kunde.html?t=<Portaltoken>` |
| **Inhalt** | Kundendaten, Bedarf, Vision Room | Vorschau, Verwaltung, Änderungswünsche, Rückfragen, Versionen/Freigabe, Angebot, Vertrag, AGB |
| **Zeigt Vorschau?** | **nie** | ja |
| **Existiert ab** | dem Anlegen des Fragebogens | der ausdrücklichen Veröffentlichung |
| **Erzeugt** | beim Absenden: **1 Projekt + 1 Aufgabe** | nichts — er zeigt nur |

Der Begriff **„Kundenlink" gibt es nicht mehr.** Er war die Ursache der
Vermischung: Ein Link, der einmal Fragebogen und einmal Vorschau meinte, führt
zwangsläufig dazu, dass eine leere Kundenseite als Fragebogen verschickt wird.
Die Beschriftungen stehen als Daten in `LINK_LABELS` (`flowertech-workflow-core.js`)
und werden von Oberfläche, Dokumentation und Tests gemeinsam benutzt.

## 1. Der Ablauf als Grafik

```
╔══════════════════ PHASE 1 · KUNDEN-BRIEFING (vor dem Projekt) ══════════════════╗
║                                                                                 ║
║  flowertech.ch (öffentlich)              Quantus                                ║
║  ──────────────────────────              ───────                                ║
║  Vision Room  ─── kind:"inquiry" ──▶  ANFRAGE                                   ║
║  (ohne Einladung)                     · kein Projekt                            ║
║  Kontaktformular ─────────────────▶   · kein Vorgang, keine Nummer              ║
║                                            │                                    ║
║                                            │  „Fragebogen-Link kopieren"        ║
║                                            │  Kundendaten & Vision Room –       ║
║                                            ▼  noch keine Vorschau               ║
║  Offerte OHNE Projekt ──────────────▶ FRAGEBOGEN  (flowertech/intakeForms/<e>)  ║
║  (versendbar, ohne Projektzwang)      · hängt via intake.offerId an der Offerte ║
║                                            │                                    ║
║   fragebogen.html?e=<Token>  ◀─────────────┘                                    ║
║   ┌───────────────────────────────────────────────────────┐                     ║
║   │ Projekt-/Firmenname · Kontaktperson · E-Mail          │                     ║
║   │ Telefon · Adresse                                     │                     ║
║   │ Bisherige Website/URL · Iststand · Anbieter · Preis   │                     ║
║   │ Ziel · Seiten/Inhalte · Funktionen · Stil/Referenzen  │                     ║
║   │ Budget · Termin · eigene Fragen                       │                     ║
║   │ ┌───────────────────────────────────────────────────┐ │                     ║
║   │ │ VISION ROOM — Teil DESSELBEN Fragebogens:         │ │                     ║
║   │ │ Idee + Funktionen als zwei Antworten              │ │                     ║
║   │ └───────────────────────────────────────────────────┘ │                     ║
║   └───────────────────────────┬───────────────────────────┘                     ║
║                               │  EIN Absenden (kind:"intake")                   ║
║                               ▼                                                 ║
║                    ┌──────────────────────────┐                                 ║
║                    │ genau 1 PROJEKT          │  idempotent: der Schlüssel      ║
║                    │ genau 1 AUFGABE          │  hängt am Einladungstoken,      ║
║                    │  „Offertenanfrage …"     │  Reload/Doppelklick wirken      ║
║                    │ + Anfrage-Dokument       │  genau einmal                   ║
║                    │ + HTML-Vorlage           │                                 ║
║                    │ + Claude-Code-Prompt     │                                 ║
║                    │ + dieselbe Offerte       │  zugeordnet, nicht kopiert      ║
║                    └──────────────────────────┘                                 ║
║                    KEIN Kundenportal. Phase 1 endet hier.                       ║
╚═════════════════════════════════════════════════════════════════════════════════╝
                                     │
                                     ▼
╔═════════ PHASE 2 · INTERNE ERSTELLUNG UND KUNDENPORTAL (nach dem Briefing) ═════╗
║                                                                                 ║
║   Prompt kopieren ──▶ Claude Code ──▶ HTML hochladen (Vorschau)                 ║
║        ▲                                    │                                   ║
║        └──── Vorlage/Prompt herunter- und wieder hochladbar                     ║
║                                             ▼                                   ║
║   Leistungsbeschreibung · Offerte mit Kosten · Vertrag · AGB                    ║
║                                             │                                   ║
║                    ┌────────────────────────┴────────────────────────┐          ║
║                    │  Checkliste vollständig?                        │          ║
║                    │  Vorschau ✓ Leistung ✓ Offerte ✓ Vertrag ✓ AGB ✓│          ║
║                    └────────────────────────┬────────────────────────┘          ║
║                     nein │                  │ ja                                ║
║                          ▼                  ▼                                   ║
║       „Kundenportal – noch    [ Kundenportal veröffentlichen ]  ← Entscheidung  ║
║        nicht veröffentlicht"                │                                   ║
║        (intern sichtbar,                    ▼                                   ║
║         KEIN kopierbarer Link)   flowertech/clientPortals/<t>                   ║
║                                             │                                   ║
║                                             ▼                                   ║
║                              kunde.html?t=<Portaltoken>                         ║
║   ┌─────────────────────────────────────────────────────────────────┐           ║
║   │ Website-Vorschau (sandboxed) · Verwaltung/Admin-Link             │           ║
║   │ Änderungswünsche mit Status · zusätzliche Rückfragen             │           ║
║   │ Versionen/Freigabe · Angebot mit Kosten · Vertrag · AGB          │           ║
║   └─────────────────────────────────────────────────────────────────┘           ║
║                                   │                                             ║
║          Änderungswunsch / Antwort / AGB-Zustimmung ──▶ zurück nach Quantus     ║
╚═════════════════════════════════════════════════════════════════════════════════╝
```

Die Phasen des Vorgangs selbst (`WORKFLOW_STAGES`) bleiben unverändert:

```
Lead → Bestandesaufnahme → Angebot / Vertrag → Umsetzung → Änderungsrunde → Freigabe / Abschluss
```

Sie werden an allen Stellen gleich benannt: Projektseite, Pipeline und
Kundenportal. Alte Phasenschlüssel (`discovery`, `won`, `lost`) bleiben lesbar.

## 2. Phase 1 im Einzelnen

### 2a. Die Anfrage erzeugt kein Projekt

Was über den öffentlichen Vision Room oder das Kontaktformular hereinkommt, ist
eine **Anfrage** — kein Projekt, kein Direktauftrag, keine Offerte und keine
Nummer. Ein Projekt vor der Antwort der Kundschaft wäre eine Behauptung: Es
stünde leer in der Liste und müsste von Hand aufgeräumt werden, wenn nie jemand
antwortet.

An jeder Anfrage steht deshalb genau ein nächster Schritt: **Fragebogen-Link
kopieren**. Beschriftung und Hilfetext sagen unmissverständlich, was der Link
zeigt — *„Kundendaten & Vision Room – noch keine Vorschau"*. Ein zweiter Klick
erzeugt keinen zweiten Fragebogen, sondern liefert denselben Link.

### 2b. Der Fragebogen fragt, was gebraucht wird

`DEFAULT_INTAKE_QUESTIONS` deckt die Pflichtthemen ab; `INTAKE_REQUIRED_TOPICS`
und `intakeCoverage()` prüfen das als Daten, damit die Oberfläche warnt und der
Test es beweist:

| Thema | Rolle bzw. Frage |
| --- | --- |
| Projekt-/Firmenname | `projectTitle`, `company` |
| Kontaktperson, E-Mail, Telefon, Adresse | `contactName`, `contactEmail`, `contactPhone`, `address` |
| Bisherige Website / URL | `currentUrl` |
| Technischer/inhaltlicher Iststand | Frage `iststand` |
| Bisheriger Anbieter | `currentProvider` |
| Bisher bezahlter Preis (optional) | `currentPrice` |
| Ziel | `need` |
| Seiten / Inhalte | Fragen `pages`, `content` |
| Funktionen | Frage `features` + Vision Room |
| Stil / Referenzen | Frage `design` |
| Budget, Zeitrahmen | `budget`, `deadline` |
| Eigene Fragen der Kundschaft | Frage `fragen` |
| Vision Room | Fragen mit `vision: "idea"` / `"features"` |

Der Fragebogen bleibt frei bearbeitbar — Fragen lassen sich ergänzen, umsortieren
und entfernen. Fällt er unter die Pflichtthemen, sagt die Oberfläche das, statt
es stillschweigend hinzunehmen.

### 2c. Der Vision Room gehört zum Fragebogen

Der Vision Room ist **kein zweiter Kanal**, sondern zwei Fragen desselben
Fragebogens: die Idee und die gewünschten Funktionen. Die Seite stellt sie als
Mindmap mit anklickbaren Vorschlägen dar; die Werte landen in denselben Feldern
wie jede andere Antwort und gehen mit **einem** Absenden hinaus.

Damit ist ausgeschlossen, was vorher passierte: dass ein Vision-Room-Beitrag
einen eigenen Direktauftrag oder ein zweites Projekt erzeugt.

| Aufruf | Wirkung |
| --- | --- |
| `fragebogen.html?e=<Token>` | Vision Room ist Teil des Fragebogens, ein Absenden |
| `flowertech.ch/#vision` ohne Einladung | wird zur **Anfrage** (`kind:"inquiry"`) |
| `flowertech.ch/?e=<Token>#vision` | verweist auf `fragebogen.html?e=…`, kein zweiter Eingang |
| `kind:"vision"` am Einladungstoken | wird als Antwort in denselben Fragebogen übernommen |
| `kind:"vision"` am Offerten-Token (`?v=`) | ergänzt den Bedarf des bestehenden Vorgangs |

### 2d. Das Absenden: genau ein Projekt, genau eine Aufgabe

Erst ein **gültiges** Absenden erzeugt einen Vorgang. Es entstehen in einem Zug:

* **genau ein** FlowerTech-Projekt mit Kundendaten, Iststand, Budget und Termin,
* **genau eine** Aufgabe *„Offertenanfrage bearbeiten: …"* — eine ganz normale
  Quantus-Aufgabe, damit sie in der zentralen Aufgaben-App erscheint,
* das **Anfrage-Dokument** mit allen Antworten, unverändert und intern,
* eine **HTML-Vorlage** aus den Antworten,
* der **Claude-Code-Prompt**.

Idempotent auf drei Ebenen: Der Idempotenz-Schlüssel hängt serverseitig am
Einladungstoken (`ft_intake_<token>`), der Fragebogen kennt sein Projekt, und die
Einreichungs-ID steht am Fragebogen. Reload und Doppelklick wirken genau einmal.

**Ein Kundenportal entsteht hier ausdrücklich nicht.**

## 3. Phase 2 im Einzelnen

### 3a. Der Claude-Code-Prompt

Das Projekt besitzt sofort einen individuellen Prompt (`buildProjectPrompt()`).
Er enthält **alle website-relevanten** Wünsche aus Standard- und Freifragen sowie
dem Vision Room:

* Projektkontext (Art, Phase, **Budgetrahmen**, **Wunschtermin**),
* **Bisherige Lösung**: Ist-Website/URL, bisheriger Anbieter, bisher bezahlter Preis,
* alle Antworten des Fragebogens, jede unter ihrer eigenen Überschrift,
* **Vision Room** als eigener Abschnitt (Idee und Funktionen),
* Änderungswünsche und beantwortete Rückfragen,
* Vorgaben zu Technik, Zugänglichkeit und Sprache.

**Kontakt- und Adressdaten bleiben intern.** Sie gehen nur mit, wenn ich das am
Projekt ausdrücklich wähle (`includeContact`); ohne Wahl steht dort
*„(intern hinterlegt)"*. In einen öffentlichen Snapshot gelangen sie nie.

### 3b. Vorschau, Vorlage und Verwaltung

Aus Claude Code kommt das fertige HTML zurück. Im Projekt (Reiter *Vorschau &
Prompt*) lassen sich **Vorlage und Prompt herunterladen, ändern und wieder
hochladen**. Hochgeladenes HTML wird entschärft (`sanitizeTemplateHtml`) und im
Kundenportal zusätzlich in einem `sandbox`-iframe gezeigt — zwei Schichten.

Optional werden **Vorschau-Link** und **Verwaltung/Admin-Link** hinterlegt; nur
vollständige HTTPS-Adressen erscheinen beim Kunden.

### 3c. Die Freigabe des Kundenportals

Der zweite Link entsteht erst, wenn es etwas zu zeigen gibt **und** ich ihn
bewusst veröffentliche. Die Bedingung liegt in `portalReleaseState()` — also im
Kern, nicht in der Anzeige. Eine Prüfung, die nur angezeigt wird, ist mit einem
Klick umgangen.

| Voraussetzung | erfüllt, wenn |
| --- | --- |
| Website-Vorschau | eine HTML-Vorlage oder eine HTTPS-Vorschau-URL da ist |
| Leistungsbeschreibung | mindestens ein aktiver Block Text trägt |
| Offerte mit Kosten | eine Offerte Kunde, Leistung und Preis > 0 hat |
| Vertrag | mindestens eine Klausel Text trägt |
| AGB | ein AGB-Entwurf Text trägt |

Vorher gibt es **keinen kopierbaren Link** — weder am Projekt, noch in der
Offerte, noch in der Projektliste. Sichtbar ist ausschliesslich der interne
Zustand **„Kundenportal – noch nicht veröffentlicht"** samt Liste des Fehlenden.
Ein Token darf vorbereitet sein; ein öffentlich lesbarer Snapshot entsteht nicht.

*Zurückziehen* löscht den Snapshot und setzt den Zustand zurück. *Neu* erneuert
den Token und widerruft den alten Link samt Inhalt.

### 3d. Was das veröffentlichte Kundenportal zeigt

Das Portal entspricht dem Beispiel „Sämi":

* sichtbare **Website-Vorschau** (Frontend) und **Verwaltung/Admin-Link**, falls hinterlegt,
* **strukturierte Änderungswünsche mit Status**,
* **zusätzliche Rückfragen** mit Antwortmöglichkeit,
* **Versionen und Freigabe**,
* **Angebot mit Kosten** (Summen, keine Rechnungsdetails),
* **Vertrag** und **AGB**.

### 3e. AGB-Zustimmung ist versioniert

Die Zustimmung ist ein Ereignis mit **Fassung und Zeitpunkt**, kein Häkchen.
`termsState()` vergleicht die zugestimmte Fassung mit der aktuellen:

| Zustand | Portal zeigt |
| --- | --- |
| keine Zustimmung | Text und Zustimmungsformular |
| Zustimmung zur aktuellen Fassung | „Zugestimmt am … (Fassung n)" |
| Zustimmung zu einer **älteren** Fassung | Hinweis auf die Änderung, Formular **erneut** |

Eine geänderte Fassung macht damit zwingend eine neue Zustimmung nötig; die alte
gilt sichtbar als veraltet statt stillschweigend weiter.

## 4. Eine Offerte ohne Projekt ist ein vollwertiger Startpunkt

Eine Offerte **ohne Projekt** ist der häufige Normalfall, kein Sonderfall und
kein Fehler. Sie lässt sich anlegen, pflegen, drucken und **versenden**, ohne
dass vorher ein Projekt angelegt oder — schlimmer — ein fremdes Projekt (etwa
„Projekt Sämi") ausgewählt werden muss. Ob sie versandfertig ist, entscheidet
allein `offerSendableState()`: Kunde, mindestens eine Leistung, ein Preis > 0.
Ein Projekt steht in dieser Prüfung **nicht**.

### 4a. Der optionale Fragebogen-Link an der Offerte

Fehlen Kundendaten, gibt es dafür an genau dieser Offerte einen klaren
**optionalen** Knopf:

| Zustand | Knopf | Hilfetext |
| --- | --- | --- |
| noch kein Link | **Fragebogen-Link erstellen** | *Kundendaten & Vision Room – noch keine Vorschau* |
| Link vorhanden | **Fragebogen-Link kopieren** | dieselbe Zeile, dazu *Öffnen* |

Der Zustand kommt aus `offerBriefingLinkState()` im Kern — Oberfläche, Tests und
Dokumentation lesen dieselbe Wahrheit.

* Der Link gehört zu **genau dieser Offerte** (`intake.offerId`). Ein zweiter
  Klick erzeugt keinen zweiten Fragebogen, sondern liefert denselben Link.
* Er öffnet **nur** `fragebogen.html?e=<Einladungstoken>` — Kundendaten und
  Vision Room. **Nie** das Kundenportal, nie eine Vorschau.
* Er darf ausdrücklich für eine **noch unfertige** Offerte verschickt werden;
  genau dafür ist er da.
* Er **sperrt nichts**: Speichern und Versenden der Offerte laufen unabhängig
  vom Fragebogen weiter. Die Offerte bleibt eine Offerte.

### 4b. Was die Antwort der Kundschaft auslöst

Sendet die Kundschaft den Fragebogen ab, entsteht **genau einmal**:

| | wird erzeugt | Idempotenz |
| --- | --- | --- |
| Projekt | genau **1** | `intake.projectId` gesetzt → zweiter Durchlauf tut nichts |
| Aufgabe „Offertenanfrage …" | genau **1** | `sourceIntakeKey = <projektId>:intake` |
| Offertenzuordnung | genau **1** | `offerProjectLinkPlan()`: `new` / `already` / `foreign` |
| Anfrage-Dokument, Vorlage, Prompt | je 1 | am Projekt |

Die Offerte wird dem neuen Projekt **zugeordnet, nicht kopiert**: gesetzt wird
ausschliesslich `offer.projectId`, dazu ein Eintrag im Dokumentverlauf. Inhalt,
Positionen, Preise und Nummer bleiben unverändert. Eine Offerte, die bereits zu
einem anderen Vorgang gehört, wird **nicht umgehängt** (`state: "foreign"`).

Reload, Doppelklick und ein wiederholter Eingang wirken damit auf drei Ebenen
genau einmal: Serverschlüssel `ft_intake_<token>`, `processedSubmissions` in der
App und die drei Prüfungen oben.

### 4c. Nach der Antwort

Die strukturierten Angaben stehen danach **an der verknüpften Offerte** und im
Projekt. In der Offerte lassen sie sich auf Klick übernehmen — und zwar nur in
**leere** Felder; Bestehendes wird nie überschrieben. Der Projekt-Prompt enthält
alle website-relevanten Antworten samt Vision Room (`buildProjectPrompt`), danach
entsteht die Vorschau und erst zuletzt, bewusst getrennt, der Kundenportal-Link
der Phase 2.

### 4d. Der Hinweis an einer unvollständigen Offerte

Eine unvollständige Offerte bleibt eine **Offertenanfrage**: kein Versand, keine
Offertennummer. Der Hinweis benennt, was fehlt, und zeigt den Weg, der die Lücke
wirklich schliesst:

* **ohne Projekt** → der Fragebogen-Link dieser Offerte (freiwillig, sperrt nichts),
* **mit Projekt** → der Fragebogen-Link der Phase 1 am Vorgang.

In beiden Fällen gilt: Das Kundenportal gibt es an dieser Stelle noch gar nicht.

## 4e. Der Fragebogen-Link eines BESTEHENDEN Projekts

Ein Projekt muss nicht aus einem Fragebogen entstanden sein. „Lehner" etwa wurde
von Hand angelegt — und hatte damit gar keinen Fragebogen-Link. In der
FlowerTech-Karte der Projektseite stand allein der Kundenportal-Link. Genau daraus
entstand die Verwechslung: Wer Kundendaten einholen wollte, griff zum einzigen
sichtbaren Link, dem der Phase 2.

Deshalb trägt **jedes** FlowerTech-Projekt seinen eigenen Fragebogen-Link, direkt
unter dem Kopf der FlowerTech-Karte und auf jedem Reiter:

```
Phase 1 · Fragebogen
  Fragebogen-Link – Kundendaten & Vision Room, keine Vorschau
  [ https://flowertech.ch/fragebogen.html?e=… ]  [Fragebogen-Link kopieren] [Fragebogen öffnen]

Phase 2 · Kundenportal
  Kundenportal – noch nicht veröffentlicht   (bzw. der Link nach der Freigabe)
```

* **Noch kein Link** → Knopf **„Fragebogen-Link erstellen"**. Er legt genau einen
  Fragebogen an, gebunden an dieses Projekt, und veröffentlicht ihn. Danach stehen
  Kopieren und Öffnen sofort bereit.
* **Reload und Doppelklick** treffen denselben Fragebogen und denselben Token —
  ein bereits verschickter Link bleibt gültig.
* Das Kopieren meldet ausdrücklich, **welcher** Link kopiert wurde:
  *„Fragebogen-Link kopiert – Kundendaten & Vision Room, keine Vorschau"*.
* Der Kundenportal-Link erscheint unverändert **erst nach der ausdrücklichen
  Veröffentlichung** (Abschnitt 3c). Die Zweiphasen-Sicherheit bleibt unberührt.

### Die Bindung: `boundProjectId` ≠ `projectId`

| Feld am Fragebogen | Bedeutung |
| --- | --- |
| `boundProjectId` | Der Fragebogen **gehört zu** diesem bestehenden Projekt. |
| `projectId` | Aus diesem Fragebogen **ist** ein Projekt entstanden (Erstweg). |

Beides im selben Feld zu führen wäre genau die Vermischung, die hier aufgeräumt
wird: `projectId` schliesst den öffentlichen Fragebogen sofort als „beantwortet".
`intakeBinding()` liest die Bindung; ein Projekt, das aus einem Fragebogen
entstanden ist, zeigt weiterhin genau diesen einen Fragebogen — nie einen zweiten.

### Was die Antwort auslöst

| Fragebogen | Antwort erzeugt |
| --- | --- |
| ohne Bindung (Anfrage / Offerte ohne Projekt) | **1 Projekt + 1 Aufgabe „Offertenanfrage"** — unverändert |
| **gebunden** an ein bestehendes Projekt | **kein zweites Projekt.** Das Projekt wird aktualisiert; höchstens **eine** Aufgabe „Offertenanfrage" |

Die Aufgabe hängt bei beiden Wegen am selben Schlüssel (`<projektId>:intake`) —
ein zweiter Eingang, ein Reload oder ein Doppelaufruf legt nichts nach.

`intakeUpdateForProject()` entscheidet, was übernommen wird: **ergänzen, nicht
überschreiben.** Gepflegte Angaben (Firma, Budget, Termin) bleiben stehen, leere
werden gefüllt. Zwei Ausnahmen mit Absicht:

* Der **Vision Room** wird nachgeführt — er ist die jüngste Aussage der Kundschaft.
* Die Phase springt von `lead` auf `intake`; weiter fortgeschrittene Phasen werden
  **nicht** zurückgedreht.

Ein Kundenportal entsteht dabei ausdrücklich nicht. Der veröffentlichte Fragebogen
trägt weiterhin nur Titel, Einleitung, Fragen, Status und Firmenname — nie
Vorschau, Vertrag, AGB, Kosten oder Kundenportal (Positivliste in
`publishIntakeForm()`).

Belegt in `tests/flowertech-projekt-fragebogen.test.mjs`.

### Fragebogen zurücksetzen — der Rückweg nach einer Fehleingabe

Eine Testeingabe oder ein Fehlversuch der Kundschaft schliesst den Fragebogen:
Der öffentliche Link gilt als beantwortet, die Kundschaft kommt nicht mehr
hinein. **„Neu"** hilft dort nicht — es tauscht den Token und macht genau den
Link ungültig, der bereits verschickt wurde.

Deshalb trägt die FlowerTech-Karte am **beantworteten** Fragebogen einen
zweiten, ausdrücklich administrativen Knopf:

```
✓ Fragebogen beantwortet · Stand 08.08.2026 11:00
[↺ Fragebogen zurücksetzen]   Setzt ausschliesslich Antwortstatus,
                              Antwortzeitpunkt und Fragebogen-Payload zurück.
```

* **Nur sichtbar, wenn beantwortet.** Vorher steht der Knopf nicht da, nach dem
  Zurücksetzen wieder nicht (`projectIntakeLinkState().canReset`).
* **Nur in der App.** Die Kundenseite (`flowertech-kunde.html`) und der
  öffentliche Eingang kennen kein Zurücksetzen — es ist keine Kundeneingabe.
* **Nie ohne Bestätigung.** Der Text nennt beide Seiten:

| Zurückgesetzt wird | Erhalten bleibt |
| --- | --- |
| Antwortstatus (gilt wieder als unbeantwortet) | Fragebogen-Link **samt Token** — derselbe Link bleibt gültig |
| Antwortzeitpunkt | Projekt mit Titel, Phase, Notizen und Verlauf |
| Fragebogen-Payload am Projekt (`ftIntakeDocument`) | Kundendaten, Budget und Preise |
| | Offerten, Verträge, AGB und Kundenportal |
| | **Alle Aufgaben, auch die bestehende „Offertenanfrage"** |

Aus dem Fragebogen ergänzte Kundendaten bleiben ausdrücklich stehen — sie sind
Projektdaten, kein Fragebogen-Zustand.

**Danach:** Die Karte zeigt wieder *„Fragebogen-Link – Kundendaten & Vision
Room, keine Vorschau"* ohne Beantwortet-Vermerk, und derselbe Link zeigt wieder
eine leere Form (der veröffentlichte Fragebogen steht sofort wieder auf `open`).

**Die erneute Einreichung** findet robust dasselbe Projekt: Das Zurücksetzen
setzt `boundProjectId` ausdrücklich auf dieses Projekt — auch bei einem
Fragebogen, aus dem das Projekt einst entstanden ist. Sie aktualisiert damit
diesen einen Vorgang und legt wegen des unveränderten Aufgabenschlüssels
(`<projektId>:intake`) **keine zweite Aufgabe** an.

**Die Fassung (`generation`).** Der Eingang macht den Fragebogen pro Einladung
idempotent (`ft_intake_<token>`). Ohne Gegenmassnahme wäre die erste Antwort
nach dem Zurücksetzen eine „Wiederholung" und würde stillschweigend verworfen —
der Link zeigte eine leere Form, das Absenden liefe ins Leere. Deshalb zählt das
Zurücksetzen `formGeneration` hoch, `publishIntakeForm()` veröffentlicht die
Zahl, und der Eingang hängt sie an den Schlüssel (`ft_intake_<token>_g2`).
Fassung 1 behält bewusst den alten Schlüssel: bereits verschickte Fragebögen
bleiben genau so idempotent wie bisher.

Belegt in `tests/flowertech-fragebogen-reset.test.mjs`.

## 4g. Der Kundenbereich: EIN Link, der mitwächst

Die Kundschaft lernt genau **eine** Adresse — den projektgebundenen
Fragebogen-Link. Er wird nie ersetzt und nie erneuert; er wächst in Stufen.

| Stufe | Sichtbar ab | Zeigt | Zeigt nie |
| --- | --- | --- | --- |
| **1 · Fragebogen** | immer, sobald der Link existiert | Kundendaten, Bestandesaufnahme, Vision Room | Offerte, Vorschau, Verwaltung, Vertrag, AGB |
| **2 · Offerte** | eine Offerte ist **wirklich versendet** (`status` ∈ sent/accepted/declined/expired **und** `sentAt` gesetzt) | Dokument, Betrag (inkl. MWST), Gültigkeit, Status | jeden Entwurf |
| **3 · Vorschau** | HTTPS-`previewUrl` **+** erzeugter Prompt **+** ausdrückliche Freigabe | die Vorschau-Adresse und den Weg für Änderungswünsche | alles ohne Freigabe |
| **3 · Verwaltung** | HTTPS-`adminUrl` **+** eigene Freigabe **+** sichtbare Vorschau | die Verwaltungs-Adresse | die Verwaltung vor der Vorschau |

Der Kern rechnet das in `customerAreaState()`; veröffentlicht wird
`customerAreaSnapshot()` — dieselbe **Positivliste** wie bisher, ergänzt um
`stage` und `tiles`:

```json
{
  "schema": 1, "title": "…", "intro": "…", "questions": [ … ],
  "status": "open", "company": {"name": "FlowerTech"}, "generation": 1,
  "stage": "intake | offer | preview",
  "tiles": {
    "offer":   {"label":"Offerte","number":"OF-2026-001","amount":4864.5,"currency":"CHF",
                "validUntil":"2026-09-30","expired":false,"status":"sent","statusLabel":"Versendet",
                "sentAt":"…","document":{"html":"…","url":""}},
    "preview": {"label":"Website-Vorschau & Änderungswünsche","url":"https://…","feedback":true},
    "admin":   {"label":"Verwaltung","url":"https://…"}
  },
  "updatedAt": "…"
}
```

`null` bei einer Kachel heisst ausdrücklich **noch nicht** — die Seite zeigt
dann gar nichts, statt etwas Halbes. Weiterhin gilt: keine Projekt-ID, keine
Kontaktdaten, keine internen Notizen, kein Vertrag, keine AGB, kein
Kundenportal. Das Offertendokument geht durch `sanitizeTemplateHtml()` — kein
Skript, keine eingebettete Seite, kein Ereignis-Attribut.

**Ausgelöst wird die Veröffentlichung** von genau drei Entscheidungen: eine
Offerte auf „Versendet" setzen, die Vorschau freigeben, die Verwaltung
freigeben. Jede davon ist widerrufbar; der Widerruf entfernt die Kachel mit der
nächsten Veröffentlichung — der **Link bleibt gültig**.

**In der Mail** steht dieselbe Adresse: `{{kundenbereichLink}}` ist in der
Offertenvorlage verdrahtet und kommt aus `shareLinks().customer`.

**Änderungswünsche** kommen über denselben Link (`kind: "change"` mit dem
Einladungstoken). Sie werden nur angenommen, solange die Vorschau-Kachel
wirklich freigegeben ist — vorher gibt es nichts zu kommentieren.

**Das Kundenportal (`kunde.html`) bleibt unberührt**: eigener Token, eigene
Freigabe, eigener Snapshot. Bereits verschickte Portal-Links funktionieren
unverändert weiter.

> Gerendert wird der Kundenbereich von `flowertech.ch/fragebogen.html`. Diese
> Seite liegt ausserhalb dieses Repos; hier stehen Datenvertrag, Freigaben und
> Veröffentlichung.

### 4g-1. Freigegeben ist nicht sichtbar

Eine Freigabe in Quantus ist eine **Absicht**. Sichtbar wird sie erst, wenn der
Datensatz unter `flowertech/intakeForms/<token>` wirklich neu geschrieben ist.
Diese zwei Dinge wurden verwechselt — mit dem Ergebnis, dass Quantus am Projekt
Lehner „sichtbar" meldete, während auf `flowertech.ch/fragebogen.html?e=<token>`
keine Vorschau stand:

* `publishIntakeForm()` schrieb asynchron und meldete nichts zurück; ohne
  Firebase-Zugang setzte es still einen Vermerk und lief weiter.
* `refreshCustomerArea()` gab in jedem Fall „true" zurück.
* `setCustomerRelease()` las diesen Rückgabewert gar nicht erst und meldete
  ausnahmslos „ist jetzt im Kundenbereich sichtbar".
* `contractHtml`/`contractTitle` wurden dem Kern nie übergeben — die
  Vertragskachel konnte auf dem Kundenlink gar nicht erscheinen.

Seither gilt:

| Grösse | Bedeutung |
| --- | --- |
| `preview.visible` / `stage.visible` | freigegeben — die Absicht steht |
| `publication.ok` | der Kundenlink wurde **bestätigt neu geschrieben** |
| `stage.live`, `liveLabels` | beides zusammen — nur das darf „sichtbar" heissen |

`publishIntakeForm()` liefert `{ ok, pending, token, error, done }`;
`refreshCustomerArea()` reicht das durch; `setCustomerRelease()` meldet erst
nach dem bestätigten Schreiben Erfolg und sonst den Fehlschlag im Klartext.
`intakePublication()` rechnet den Nachweis aus `publishedAt`,
`publishRequestedAt`, `publishPending` und `publishError`.

### 4g-2. Der Schritt „Claude-Code-Rückgabe"

Der verbindliche Weg zu einer Projekt-Website — und die Stelle, an der die
Vorschau ihre Herkunft bekommt:

```text
Quantus erzeugt den projektspezifischen Prompt
  → Codex übergibt alle HTML-, Datei- und Deploy-Aufgaben an Claude Code
  → Claude Code erstellt, veröffentlicht und liefert EINE HTTPS-Rückgabe-URL
  → Codex trägt genau diese URL in Quantus ein und bestätigt sie
  → erst dann ist die reguläre Freigabe eine erledigte Claude-Vorschau
```

Vier Stationen (`CLAUDE_HANDOFF_STEPS`, gerechnet in `claudeHandoffState()`):

| Status | Beschriftung | Bedeutung |
| --- | --- | --- |
| `open` | Noch nicht übergeben | Es wartet kein Auftrag bei Claude Code |
| `waiting` | **Warte auf Claude Code** | Übergeben, noch keine Rückgabe |
| `review` | **Rückgabe-Link prüfen** | HTTPS-Adresse eingetragen, nicht bestätigt |
| `confirmed` | **freigegeben** | Bestätigt — reguläre Freigabe möglich |

Am Projekt steht das in `ftClaudeHandoff` (`requestedAt`, `returnedUrl`,
`returnedAt`, `confirmedAt`). Bedient wird es mit `_ftClaudeHandoffRequest`,
`_ftClaudeHandoffReturn`, `_ftClaudeHandoffConfirm`, `_ftClaudeHandoffReset`.

Die Regeln, die das Ganze überhaupt erst verbindlich machen:

* Als Rückgabe zählt **ausschliesslich eine vollständige HTTPS-Adresse**.
* Eintragen ist nicht bestätigen. Erst die Bestätigung übernimmt die Adresse
  als `previewUrl` — sie wird nie abgetippt.
* Die Vorschau gilt nur dann als Claude-Ergebnis, wenn `previewUrl` **Zeichen
  für Zeichen** die bestätigte Rückgabe ist. Wird sie danach von Hand
  ausgetauscht, ist sie sofort wieder manuell.
* Eine manuelle Adresse **verschwindet nicht** — sie erscheint vollständig,
  wird aber als `source: "manuell"`, `provisional: true` veröffentlicht und auf
  der Kundenseite als **Testvorschau · Zwischenstand** benannt. Sie wird nie als
  erledigte Claude-Vorschau ausgegeben; die Freigabe vermerkt das im
  Kontaktverlauf und in `ftCustomerPreview.mode`.
* Ein neuer Auftrag an Claude Code hebt eine frühere Bestätigung auf.

> Der heutige Lehner-Link (`https://beispiel-lehner.netlify.app/`) ist genau
> das: eine **manuelle Testvorschau**, kein Claude-Code-Ergebnis.

Der Kundenlink bleibt dabei, was er ist: **eine** Adresse, die mit den Freigaben
wächst. Belegt in `tests/flowertech-claude-rueckgabe.test.mjs`.

## 4h. Der Reiter „Claude-Prompt"

Der Reiter zeigt den **vollständigen, automatisch erzeugten Prompt dieses
Projekts** — nicht mehr nur das interne Bedarfsformular. Er entsteht aus allem,
was da ist: Fragebogen, Vision Room, Kundendaten, Budget und Frist,
Leistungsbeschreibung, versendete Offerte und Änderungswünsche.

Gliederung (`buildProjectPrompt()`): Projektkontext · Ziel und Zielgruppe ·
Bestehende Seite (Iststand) · Antworten aus dem Fragebogen · Vision Room ·
Inhalte · Funktionen · Design · Daten, SEO und Barrierefreiheit · Budget und
Termin · Lieferumfang · Änderungswünsche · Rückfragen · Vorgaben ·
**Nicht erfinden** · **Konkrete nächste Schritte**.

Dazu im Reiter: **Quellen und Stand** (`projectPromptSources()`) und die
**fehlenden Angaben** (`projectPromptMissing()`) — dieselbe Liste steht im
Prompt unter „Offen und deshalb nicht zu erfinden", damit die Lücke benannt und
nicht gefüllt wird.

Knöpfe: *Prompt kopieren* · *.md herunterladen* · *HTML-Vorlage herunterladen* ·
*HTML-Vorlage hochladen* · *Prompt für Claude Code kopieren*. Der Upload legt
die Vorlage **nur am Projekt** ab — er veröffentlicht nichts. Sichtbar wird eine
Vorschau ausschliesslich über die Freigabe aus Abschnitt 4g.

Belegt in `tests/flowertech-kundenbereich-prompt.test.mjs`.

## 5. Migration und Abwärtskompatibilität

**Es werden keine Daten angefasst.** Bestehende Projekte und Angebote bleiben
unverändert; alles wird beim *Lesen* abgeleitet:

| Fall | Verhalten |
| --- | --- |
| Projekt ohne `ftRoute` | Weg wird gelesen (Offerte vorhanden → *Offerte zuerst*, sonst *Direktprojekt*) |
| Projekt mit `portalToken` **und** `publishedAt` (Altbestand) | zählt als **erteilte Freigabe** — der bereits verschickte Link funktioniert weiter und wird weiter nachgezogen, sofern der Vorgang vollständig ist. Rein lesend abgeleitet, es wird nichts geschrieben. |
| Altbestand, aber **unvollständig** | bleibt draussen: kein Link, keine Aktualisierung. Der alte Snapshot bleibt lesbar, wird aber nicht mehr überschrieben — genau das halb leere Portal, das diese Trennung abschafft. |
| Projekt mit `portalReleased: false` | ausdrücklich zurückgezogen; ein vorhandenes `publishedAt` hebt das **nicht** auf |
| Neues Projekt ohne `publishedAt` | gilt als **nicht veröffentlicht**; der Token darf vorbereitet sein, der Snapshot entsteht erst mit der Freigabe |
| Bereits veröffentlichter Snapshot | bleibt lesbar; `published` fehlt dort und wird von der Kundenseite als „veröffentlicht" gelesen |
| Antworten als Liste **oder** als Zuordnung | beide Formen laufen über `intakeAnswerMap()` zusammen |

> **Behobener Fehler:** Der Fragebogen sendet seine Antworten als Liste
> (`{answers:[{key,answer}]}`), die Funktion normalisierte aber gegen eine
> Zuordnung (`{key: wert}`). Jede korrekt ausgefüllte Einreichung kam deshalb als
> „unvollständig" mit HTTP 400 zurück — es entstand **nie** ein Projekt.
> `intakeAnswerMap()` führt beide Formen zusammen.

## 6. Die Weggabelung: Offerte zuerst oder Direktprojekt

Jeder neue Vorgang startet auf **genau einem** von zwei Wegen. Es gibt keine
dritte, unklare Route.

| Weg | Ablauf | Angebotsschritt |
| --- | --- | --- |
| **Offerte zuerst** | Bedarf → Offerte erstellen → senden → Entscheidung → Umsetzung | ja |
| **Direktprojekt** | Bedarf → Leistung & Vertrag → Umsetzung → Änderungen → Freigabe | bewusst übersprungen, sichtbar markiert |

Die Wahl steht zuoberst auf `#/flowertech` unter **Neue Zusammenarbeit starten**.
Sie betrifft nur die *interne* Führung eines Vorgangs, nicht die zwei Links: Ein
Projekt entsteht in beiden Wegen ausschliesslich aus einem abgesendeten
Fragebogen (Phase 1), und ein Kundenportal entsteht in beiden Wegen erst mit der
ausdrücklichen Veröffentlichung (Phase 2).

**Kein paralleles Datenmodell.** Ein Angebotsvorgang *ist* ein
FlowerTech-Projekt. Wird die Offerte angenommen, wird dasselbe Projekt zum
Umsetzungsprojekt (`pipelineStage: "build"`); wird sie abgelehnt, endet derselbe
Vorgang (`ftOutcome: "lost"`, archiviert). Es entsteht in **keinem** Fall ein
zweites Projekt.

### Beilage zur Offerte

Vor dem Senden wird verbindlich gewählt, was mitgeht:

| Beilage | Was passiert |
| --- | --- |
| **Vision Room** | Ein persönlicher Link `https://flowertech.ch/?v=<token>#vision`. Die Ausarbeitung der Kundschaft hängt an genau dieser Offerte und ergänzt deren Bedarf — ohne Doppelanlage. |
| **Website-Beispiel** | Eine echte, selbst gepflegte Vorschau-URL. **Es wird kein Link erfunden.** Fehlt sie, sagt die UI genau das und bietet den Vision Room an. |

### Vision Room → Direktprojekt

Der Vision Room auf flowertech.ch erfasst Art, Idee, Funktionen und E-Mail. Beim
Absenden entsteht **ohne manuelle Nacharbeit** ein FlowerTech-Direktprojekt:
Titel aus der Idee, Typ aus der Art, Funktionen als Bedarf und als normale
Quantus-Aufgaben, Route `direct`, Phase *Bestandesaufnahme*.

## 7. Datenverträge

**`POST /.netlify/functions/flowertech-portal`**

```json
{
  "kind": "intake",
  "token": "<Einladungstoken: 24–64 Zeichen [A-Za-z0-9_-]>",
  "payload": { "answers": [ { "key": "need", "answer": "…" } ] },
  "idempotencyKey": "ft_…",
  "website": ""
}
```

Die Antworten dürfen als **Liste** (`{answers:[{key,answer}]}`, so sendet der
Fragebogen) oder als **Zuordnung** (`{key: wert}`, so sendet n8n) kommen;
`intakeAnswerMap()` führt beide zusammen. Was nicht gefragt wurde, kommt nicht
durch — der veröffentlichte Fragebogen ist die serverseitige Grenze.

Antworten: `201 {ok, submissionId}` · `200 {ok, duplicate:true}` ·
`400` (unbrauchbar/ungültiger Token) · `401` (keine Herkunft, keine Signatur) ·
`403` (fremde Herkunft) · `429` (Ratenlimit) · `202` (Honeypot, still verworfen).

**Zuordnung:**

| Art | Token | Wirkung |
| --- | --- | --- |
| `inquiry` / `quote` / `vision` | keiner | **Anfrage** in Quantus. Kein Projekt, kein Direktauftrag. Nur aus dem Browser und nur von erlaubter Herkunft. |
| `intake` | `intakes[id].inviteToken` | Fragebogen beantwortet → **genau ein** Projekt + **genau eine** Aufgabe |
| `vision` / `quote` | `intakes[id].inviteToken` | Vision-Beitrag zu **demselben** Fragebogen — kein zweiter Vorgang |
| `change` | `intakes[id].inviteToken` | Änderungswunsch aus dem Kundenbereich — **nur** solange die Vorschau-Kachel freigegeben ist (Abschnitt 4g) |
| `vision` | `shares[projectId].visionToken` | Ausarbeitung zur Offerte dieses Vorgangs |
| `briefing` | `shares[projectId].formToken` | Bedarfsformular |
| `change` / `quote` / `terms` / `answer` | `shares[projectId].portalToken` | Kundenportal (nur nach Freigabe versendet) |

Jeder Token öffnet genau die Wege, für die er ausgegeben wurde. Ein
Einladungstoken kann keinen Änderungswunsch einschleusen und ein Portaltoken
keinen Fragebogen beantworten.

**Persistierte Felder** am Projekt: `ftCurrentUrl`, `ftCurrentProvider`,
`currentProviderPrice`, `ftIntakeDocument`, `ftTemplate`, `ftPrompt`, `ftVision`,
`ftTermsConsent`, `ftPortalQuestions`, `ftRoute`, `ftRouteDecidedAt`,
`ftRouteSource`, `ftOfferAttachment {kind, visionToken, exampleUrl}`,
`ftOutcome`, `sourceIntakeId`, `previewUrl`, `adminUrl`,
`ftCustomerPreview {released, releasedAt}`, `ftCustomerAdmin {released, releasedAt}`.
Am Freigabe-Eintrag (`shares[projectId]`): `portalToken`, `portalReleased`,
`portalReleasedAt`, `publishedAt`, `publishError`.
Am Fragebogen (`intakes[id]`): `inviteToken`, `status`, `projectId`,
`submissionId`, `answeredAt`, `formGeneration`, `resetAt`, `resetCount`
und die Herkunft — `inquiryId` (aus einer Anfrage)
**oder** `offerId` (aus einer Offerte ohne Projekt, siehe Abschnitt 4).
Am Offertendokument: `projectId` — bei der Zuordnung aus dem Fragebogen das
**einzige** geänderte Feld neben `updatedAt` und dem Verlaufseintrag.

**Sicherheit:** Der Token steht im öffentlichen Link, enthält aber keine
Projekt-ID und keinen Zugang zu Quantus. Herkunftsprüfung, Honeypot, Grössen-
und Ratenlimit gelten unverändert; der Idempotenz-Schlüssel verhindert
Doppelanlagen bei Doppelklick und Wiederholung.

### Abwärtskompatibilität

Siehe Abschnitt 5. Kurz: Bestehende Projekte tragen kein `ftRoute`; ihr Weg wird
beim *Lesen* abgeleitet. Es wird kein einziges Datum angefasst.

## 8. Bedarfsformular (intern und n8n)

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

## 9. Änderungswünsche

Jeder Änderungswunsch — intern erfasst oder von der Kundschaft über das Kundenportal —
wird zu einer echten Quantus-Aufgabe (`source: "flowertech-change"`,
`sourceChangeRequestId`). Damit erscheint er automatisch in der zentralen
Aufgaben-App. Der Status des Wunsches folgt der Aufgabe: Aufgabe erledigt →
Wunsch erledigt. Die Aufgabe bleibt führend.

## 10. Angebot, Vertrag, AGB, Datenschutz

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

## 11. Das Kundenportal (Phase 2)

`kunde.html?t=<Portaltoken>` zeigt der Kundschaft: Website-Vorschau, Verwaltung/
Admin-Link, Typ, Phase, Kostenübersicht, Leistungsbeschreibung, Termine,
Änderungswünsche mit Status, Rückfragen, Versionen/Freigabe, Vertrag und AGB.

Die Seite liest einen **datensparsamen Snapshot** aus
`flowertech/clientPortals/<token>` — eine Positivliste im Kern
(`buildClientSnapshot`). Der Snapshot entsteht **erst mit der ausdrücklichen
Veröffentlichung** (Abschnitt 3c) und trägt `published: true`. Interne Notizen,
Rechnungsdetails, Kontaktdaten und der Kontaktverlauf sind nicht enthalten;
`CLIENT_SNAPSHOT_FORBIDDEN_KEYS` wird im Test gegen echte Projektdaten geprüft.

Käme je ein Snapshot ohne Freigabe dort an, zeigt die Kundenseite ihn **nicht**,
sondern sagt, dass der Bereich noch nicht freigegeben ist — zwei Schichten statt
einer.

Links lassen sich jederzeit erneuern (*Neu*) — der alte Link funktioniert danach
nicht mehr. *Zurückziehen* löscht den Snapshot und setzt den Zustand auf
„noch nicht veröffentlicht".

## 12. Mails

Zuordnung ausschliesslich über den **ausdrücklichen Projektkontext**:

* Mails, die aus dem Projekt gesendet wurden (samt Antworten, `mailThreadIds`),
* manuell verknüpfte Mails,
* die im Projekt hinterlegten Kontaktadressen.

Es findet keine allgemeine Postfachüberwachung statt. Alle Mails bleiben
zusätzlich normal im Posteingang; die Projektseite verlinkt sie nur.

## 13. Claude-Code-Prompt (Reiter im Projekt)

Reiter *Claude-Prompt* erzeugt aus Briefing und offenen Änderungswünschen einen
fertigen Prompt mit Kopierfunktion. Zwei Dinge sind wählbar:

**Wofür der Prompt ist** (`PROMPT_MODES`):

| Modus | Auftrag an Claude Code |
| --- | --- |
| **Beispiel bauen** | Aus dem Bedarf einen vollständigen, lauffähigen Entwurf bauen, den man der Kundschaft zeigen kann — Platzhalter-Inhalte sichtbar als Beispiel markiert, keine echten Kundendaten, Preise oder erfundenen Referenzen, läuft ohne Konten und Schlüssel, auf allen Geräten. |
| Umsetzen | Die offenen Punkte im bestehenden Projekt umsetzen. |
| Nur Änderungswünsche | Ausschliesslich die offenen Wünsche, nichts darüber hinaus. |
| Prüfen | Den Stand gegen den Bedarf prüfen, ohne etwas zu ändern. |

Ohne eigene Wahl schlägt das Projekt den passenden Modus vor: **Beispiel bauen**,
solange keine offenen Änderungswünsche existieren, sonst **Umsetzen**. Im
Beispielmodus bleiben Änderungswünsche bewusst draussen — der Bedarf ist dort
der ganze Auftrag.

**Welche Daten mitgehen** — **Kundendaten, Preise und interne Notizen sind
standardmässig ausgeschaltet**, in jedem Modus. Dieselbe Wahl steuert den
Projekt-Prompt aus Abschnitt 3a: Ist *Kundendaten* eingeschaltet, wandern
Kontakt- und Adressdaten in den Code-Prompt — ausdrücklich als intern
gekennzeichnet und nie in einen öffentlichen Snapshot.

## 14. n8n: „FlowerTech: Lead → Projekt & Aufgaben"

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

1. In Quantus ein FlowerTech-Testprojekt anlegen und im Reiter *Kundenportal*
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

## 15. Datenablage

| Pfad | Inhalt |
| --- | --- |
| `flowertech/submissions/<id>` | Roheingänge aus Fragebogen, Vision Room, Kundenportal und n8n |
| `flowertech/submissionKeys/<key>` | verarbeitete Idempotenz-Schlüssel |
| `flowertech/intakeForms/<einladungstoken>` | veröffentlichter Fragebogen (Phase 1) |
| `flowertech/clientPortals/<portaltoken>` | freigegebener Kundenportal-Snapshot (Phase 2) |
| `flowertech/rateLimits/<hash>/<stunde>` | IP-Ratenlimit (gehasht, kein Klartext) |

In der App (`APP.state.data.flowertech`): `intakes`, `inquiries`, `briefings`,
`changeRequests`, `contentDocs`, `contracts`, `legalDocs`, `shares`,
`promptPrefs`, `promptModes`, `processedSubmissions`.
