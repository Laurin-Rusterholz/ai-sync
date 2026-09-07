# ChatGPT-Modul — Notes, Leads, ChatGPT-Aufgaben

Route `#/chatgptnotes` (Reiter Notes), `#/chatgptnotes/leads`, `#/chatgptnotes/tasks`,
`#/chatgptnotes/<leadId>` (Lead-Detail). Alles in `public/index.html`, Block 1
(Ansichten, Regeln, Handler) — kein Sonderweg, keine eigene Firebase-Struktur.

Das Modul ist die Arbeitsoberflaeche des ChatGPT-Assistenten in Quantus. Drei
Datentypen, drei **getrennte** Zaehler in der Seitenleiste (nie summiert):

| Reiter | Sammlung | Zaehler (Farbe) |
|---|---|---|
| Notes | `entities.chatgptNotes` + `chatgptNotesMeta.lastSessionReadAt` | neu seit letzter Sitzung (Petrol) |
| Leads | `entities.chatgptLeads` | ungelesen, `readAt == null` (Koralle) |
| ChatGPT-Aufgaben | `entities.chatgptTasks` | offen, `state == "offen"` (Sand) |

## Teil A — Notes (Gedaechtnis des Assistenten)

* Eintrag: `category` (auftrag/feedback/konvention/entscheid), `instruction`
  (Wortlaut), `derived` (Ableitung), `instructionDate`, `promptSection`, `tags`,
  `state` (aktiv/ueberholt), `supersedes`/`supersededBy`, Verknuepfungen,
  `externalLinks`, `files`, `comments`.
* **Nie inhaltlich editieren.** „Abloesen" legt einen neuen Eintrag an, der alte
  wird `ueberholt` und verweist auf den neuen. „Korrigieren" nur fuer Tippfehler.
* Standardfilter beim Oeffnen: `createdAt > lastSessionReadAt`. „Als gelesen
  markieren" setzt den Marker; er wird beim Merge als neuerer Zeitstempel
  uebernommen (eigener Zweig in `mergeData`).
* Musteranalyse: drei oder mehr `feedback`-Eintraege mit demselben Tag oder
  derselben `promptSection` → Hinweis „Kandidat fuer den Prompt".
* Volltext: `buildSearchIndex()` fuehrt Notes und Leads; die universelle Suche
  und Polaris finden sie darueber.

## Teil B — Leads (Auftragseingang mit erzwungener Denkstruktur)

Laurin legt einen Lead mit **Titel + Wortlaut** an (Enter im Titel springt ins
Textfeld, Strg/⌘+Enter legt an). Nur der Assistent bearbeitet ihn.

Schritte in fester Reihenfolge (Detailansicht untereinander):

1. Interpretation *(Pflicht)*
2. Offene Fragen
3. Recherche *(Pflicht)*
4. Plan *(Pflicht)*
5. **Bewertung & Zuweisung** *(Pflicht)* — sechs Kriterien (`assessment.menge`,
   `werkzeug`, `kontext`, `quantusNaehe`, `recherche`, `zuschnitt`, je `chatgpt`
   oder `cowork`), Ergebnis „2 : 4 → Cowork", `assignee` (`chatgpt`|`cowork`)
   und `assignmentReason` (ein Satz). **Auch bei Eigenbearbeitung Pflicht.**
   Bei `cowork`: `handoverPacket` (Wortlaut, aufklappbar, vollstaendig lesbar),
   `grantedPermissions` (`websuche`, `dateienErstellen{erlaubt,formate[]}`,
   `externeTools[]`, `verboten[]` — Standard ueberall „nicht erteilt", keine
   „alles erlauben"-Abkuerzung), `handoverAt`, `returnedAt`.
   Cowork hat keinen Zugriff auf Quantus: was nicht im Paket steht, existiert
   fuer Cowork nicht — deshalb liegt das Paket am Lead.
6. Ausfuehrung *(Pflicht)*
7. Ergebnis *(Pflicht, mit Ort in Quantus)*
8. Workflow-Notiz
9. Verknuepfungen *(mindestens eine)*

**Abschluss:** `chatgptLeadMissing(lead)` ist die eine Quelle. Leere Liste →
„Lead abschliessen" aktiv; sonst gesperrt, mit „Fehlt noch: …" (Tooltip, Zeile
unter dem Knopf, Toast beim Klickversuch). Kein Statuswechsel auf
`abgeschlossen` ueber das Select, keine Massenaktion. Einzige Ausnahme:
„Lead ist hinfaellig (nur Laurin)" — Grund + Bestaetigung, am Lead vermerkt
als `closedBy:"laurin"`, `obsoleteReason`.

`readAt` setzt der Assistent mit „📖 Gelesen" oder automatisch, sobald er einen
Schritt ausfuellt. `wartet` verlangt `blockedReason`.

**Persistenz der Freitextfelder:** jede Eingabe (`input`) landet sofort im
Lead (`chatgptLeadApplyField`), gespeichert wird gebuendelt ueber
`scheduleSaveDebounced("cgl-field:<id>", 500)` — `flushPendingSaves` holt das
bei `pagehide`/`beforeunload`/`visibilitychange` nach. `change` bleibt der
finale Commit (trimmt, speichert sofort). Vor jedem `renderMain()` und beim
Verlassen werden alle Felder aus dem DOM uebernommen (`chatgptLeadCommitDom`),
damit weder ein Hintergrund-Render (`syncFreshness`) noch ein programm-
gesteuertes `.value =` etwas verliert; der Fokus kehrt danach ins Feld zurueck.
Fortschritt und Abschluss rechnen ausschliesslich aus dem Lead-Objekt.

Raster, Zuweisung und Berechtigungen stehen **ohne Klick** auf der Lead-Karte
im Eingang und im Detail (`chatgptLeadAssessmentSummary`).

## Teil C — ChatGPT-Aufgaben (Sorgfaltsauftraege am Element)

* `text`, `state` (offen/erledigt/wartet), `anchorKind`, `anchorId`,
  `anchorLabel`, `createdBy` (laurin/assistant), `resolvedAt`, `blockedReason`.
* **Ohne Anker nicht anlegbar:** `createChatgptTask()` prueft, dass der Anker
  aufloesbar ist (Entity aus der Registry oder virtueller Typ wie
  `gmailMessage`), sonst `null`.
* Abschnitt „🤖 ChatGPT" am Element: kleiner Sand-Marker mit Anzahl, zugeklappt;
  bei offenen Aufgaben ein deutlicher Hinweis fuer den Assistenten. Einzeiliges
  Feld, Enter legt an. Erledigte bleiben ausgegraut sichtbar — nie loeschen.
* Der Abschnitt wird **generisch** in jede Detailansicht eingeblendet, die
  ueber `renderMain` laeuft (`quantusInjectChatgptSections`, Route → Typ via
  `kindForRoute`). Overlays rufen ihn selbst auf: NoteFlow (`note`), Gmail Hub
  (`gmailMessage`, virtueller Anker mit `gmailOpenFromExternal`), Mail Hub
  (`email`).
* Sammelansicht im Modul: offene und wartende Aufgaben nach Elementtyp
  gruppiert, Sprung zum Element (`chatgptAnchorOpen`).
* **Nicht** in `getTaskStats`, `getOverdueTasks`, `getUpcomingTasks` oder
  irgendeiner Aufgabenliste — eigene Sammlung, eigener Zaehler.

## Entity-Kind-Registry (Grundlage fuer Verknuepfen und Anker)

`QUANTUS_ENTITY_KINDS` in Block 1: `kind`, `store`, `label`, `plural`, `icon`,
`nameField`, `route`, optional `linkable:false`. `entityKindRegistry()` ergaenzt
automatisch jede Sammlung unter `entities`, die dort nicht steht (Typname =
Sammlung ohne Plural-s; ausgenommen `passwords`, Strukturtabellen, Puffer).
Ein spaeter dazukommender Typ ist damit ohne Aenderung verknuepfbar und
ankerfaehig — fuer Beschriftung, Symbol und Sprungziel traegt man ihn trotzdem
ein.

Darauf laufen: `getEntityMap`, `getEntityDisplayName`/`entityDisplayLabel`,
`kindIcon`, `routeForKind`, `cleanupLinks`, `renderLinkedEntitiesSection`,
`openLinkModal`, `ATTACHMENT_KIND_STORES` (chatgptNote, chatgptLead) und der
v5-Override `linkFieldForKind` (Whitelist mit Rueckfall auf `linked<Typ>s`).

Virtuelle Anker ohne Sammlung: `QUANTUS_VIRTUAL_KINDS` (`gmailMessage`).

## Tests

`tests/sync-chatgptnotes-merge.test.mjs` (Teil A) und
`tests/sync-chatgpt-leads-tasks.test.mjs` (Teil B/C, Registry): echte
`mergeData()` gegen zwei Geraete, echte `chatgptLeadMissing()`,
`createChatgptTask()` ohne Anker, Aufgabenzahlen lesen nur `entities.tasks`,
Registry nimmt neue Sammlungen automatisch auf, `linkFieldForKind`-Rueckfall.
Beide laufen in `npm run test:persistence`.

## Portierung

* **quantus-tablet-version:** Notes lesen (Seit-letzter-Sitzung-Filter), Leads
  lesen, ChatGPT-Aufgaben: Marker am Element + Anlegen, keine Sammelansicht.
* **mobile-management:** Notes: Schnellerfassung + Liste; Leads: anlegen
  (Titel + Text); ChatGPT-Aufgaben: anlegen am Element.
