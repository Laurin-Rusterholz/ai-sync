# Sticky Board — Post-its / Whiteboard-Modul

Ein wiederverwendbares, Miro-artiges Post-it-/Whiteboard-Element. Verfügbar als
Block in den Detailansichten von **Aufgaben, Projekten, Strategien und
Konzepten**.

## Aufbau

Ein einzelnes, self-contained `<script>`-Modul am Ende von `public/index.html`
(IIFE, alle CSS-Klassen `sb-`-präfixiert, keine externen Abhängigkeiten). Es
folgt dem Muster der bestehenden geteilten Blöcke `renderMeasuresBlock` /
`renderFileAttachments`:

- **`window.renderStickyBoardBlock(kind, id)`** — rendert eine kompakte Vorschau
  (Mini-Board mit Bounding-Box-Skalierung + Zähler) in die Detailansicht. Wird
  neben `renderMeasuresBlock(...)` in allen vier Views aufgerufen (guarded:
  `${window.renderStickyBoardBlock ? … : ''}`).
- **`window.openStickyBoard(kind, id)`** — öffnet den Editor als Overlay am
  `document.body`. Bewusst **ausserhalb** des `render()`-Zyklus, damit
  Drag/Pan/Zoom nicht durch App-Re-Renders unterbrochen werden. Beim Schliessen
  wird `render()` einmal aufgerufen, um die Vorschau zu aktualisieren.
  - **Split-Screen (Desktop, Standard ab Fensterbreite ≥ 1100px)**: öffnet als
    rechtes Seitenpanel (halb/halb, per Divider resizable), startet unter der
    38px-Tableiste (`#browserTabBar`, z-index 2147483600) und reflowt die App
    via `body.sb-docked` auf die linke Hälfte → die Quantus-Tableiste und
    Tab-Wechsel bleiben erreichbar. z-index im Split unter der Tableiste (1000).
  - **Vollbild**: per Toolbar-Toggle (⇥/⛶) umschaltbar; deckt alles ab
    (z-index 2147483646). Auf schmalen Screens immer Vollbild.
  - Präferenz (`sbViewMode`) und Split-Breite (`sbSplitPx`) in localStorage.

`kind` ∈ `{ task, project, strategy, concept }` → Collection über die interne
`KIND_MAP` (identisch zu `MEASURE_ENTITY_MAP`).

## Datenmodell

Direkt am Entity gespeichert (keine neue Collection, keine Schemaänderung):

```js
entity.stickyBoard = {
  notes: [{
    id, x, y, w, h, text, color, textColor, shape,          // 'square'|'rect'|'torn'
    fontSize, align, valign, bold, italic, underline, strike,
    z, tags:[], votes, locked, groupId, author, createdAt, updatedAt
  }],
  connections: [{ id, from, to, style, color, width, arrow, label }],
  view: { x, y, zoom },   // zuletzt genutzte Kameraposition
  bulkMode: false
}
```

Persistenz läuft komplett über `scheduleSave()` (localStorage + RTDB-Blob unter
`appStore/app-data.json`) — es sind keine RTDB-Rules- oder Storage-Änderungen
nötig, da alles im bestehenden Daten-Blob mitreist.

## Funktionsumfang

- **Erstellen**: Toolbar `＋ Post-it`, Doppelklick auf die Fläche, Taste `N`,
  Duplizieren (`Ctrl/Cmd+D`), Einfügen (`Ctrl/Cmd+V`), Multiline-Paste →
  ein Post-it pro Zeile, **Bulk-Modus** (Enter erzeugt das nächste Post-it).
- **Text**: Inline-Bearbeitung (contenteditable) mit Auto-Fit-Schriftgrösse,
  manuelle Schriftgrösse (`A−`/`A＋`/Auto), Ausrichtung, Fett/Kursiv/
  Unterstrichen/Durchgestrichen, Aufzählung.
- **Aussehen**: 10 Post-it-Farben (Hintergrund + kontrastierende Textfarbe),
  Formen (Quadrat, Rechteck, „abgerissen").
- **Verschieben**: Drag & Drop mit **Smart-Guides** — beim Ziehen erscheinen
  Ausrichtungslinien und die Notiz rastet an Kanten/Mitte anderer Post-its ein
  (Alt gedrückt halten deaktiviert das Einrasten); „Lift"-Effekt beim Ziehen.
- **Beschriften**: Doppelklick, **einfacher Klick auf eine bereits gewählte
  Notiz**, oder eine gewählte Notiz einfach **lostippen** (Tippen-zum-Bearbeiten).
- **Verbinden**: an den Rand-Ankerpunkten ziehen; Ziehen auf ein anderes
  Post-it verbindet, Ziehen auf **leere Fläche erzeugt ein neues, direkt
  verbundenes Post-it** (öffnet gleich den Texteditor).
- **Anordnen**: Resize, Z-Order vor/zurück,
  Ausrichten & Verteilen (6 + 2 Modi), „In Raster anordnen", Clustern nach
  Farbe/Tag, Gruppieren/Gruppierung lösen.
- **Verbinden**: Anchor-Punkte beim Hover oder Verbinden-Modus; Linien folgen
  beim Verschieben; Stil (gebogen/gerade/rechtwinklig), Farbe, Dicke, Pfeil,
  Label — editierbar per Klick auf die Linie.
- **Tags & Filter**: Tags pro Post-it, Filterleiste mit Suche + Farb-/Tag-Filter.
- **Interaktion**: Votes (👍), Autoren-Anzeige, Sperren (Lock), „Als Notiz
  kopieren" (→ Notes-Collection).
- **Canvas**: Pan (Leertaste/Mittelklick/Pan auf leerer Fläche), Zoom (Mausrad
  zum Cursor, `+`/`−`/`100%`), „Alles einpassen".
- **Zeichnen (Tablet/Stift)**: Freihand-Zeichenmodus (`✏️ Zeichnen`) mit
  Stiftfarbe und -dicke, Radierer (Striche antippen/überfahren), „Leeren".
  Strokes liegen in `board.drawings` und sind Teil von Undo/Redo.
- **Touch/Tablet-Gesten**: Ein Finger auf leerer Fläche verschiebt, zwei Finger
  = gleichzeitig Verschieben & Zoom (Pinch). Stift/Finger malen im
  Zeichenmodus.
- **Aktionen**: Kopieren/Ausschneiden/Einfügen/Löschen, Undo/Redo (Snapshot),
  Marquee- und Shift-Mehrfachauswahl, Kontextmenü (Rechtsklick).
- **Import/Export**: CSV-Export; Import aus Zeilen/CSV.

## Tastenkürzel

`N` neu · `Enter` bearbeiten · `Entf`/`Backspace` löschen ·
`Ctrl/Cmd+D` duplizieren · `Ctrl/Cmd+Z` / `+Shift` undo/redo ·
`Ctrl/Cmd+A` alles auswählen · `Ctrl/Cmd+C/X/V` kopieren/ausschneiden/einfügen ·
Pfeiltasten nudge (`+Shift` = Grid-Schritt) · `Esc` Bearbeiten/Auswahl beenden
bzw. Board schliessen.
