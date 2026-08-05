# Quantus Career Model

Career Model ist die berufliche Weiterbildungs-App von Quantus. Sie übernimmt vollständig vorbereitete Fachmodule als versionierte JSON-Datei, teilt während der Nutzung nichts mehr mit KI auf und synchronisiert Inhalte, Fortschritt und Reflecta-Einträge in Echtzeit zwischen allen angemeldeten Geräten.

## Ablauf

1. In `Career Model → Import` werden Karrierebereich, Modultitel, Niveau und die gewünschte Tagesdauer erfasst.
2. Quantus erzeugt daraus einen kopierfertigen Claude-Prompt mit dem exakten Datenvertrag.
3. Der Nutzer lädt bei Claude zusätzlich alle relevanten Dokumente hoch und lässt eine reine JSON-Datei erzeugen.
4. Quantus validiert die Datei vollständig im Browser. Erst nach erfolgreicher Prüfung kann sie importiert werden.
5. Das Modul erscheint als Abfolge von Lerntagen. Jeder Tag enthält Lernziele, vollständige Inhalte, Quellenreferenzen, Praxisaufgabe mit Musterlösung, Kontrollfragen und Merksätze.
6. Fortschritt und Abschlussnotiz werden unter `careerModel/users/<uid>` gespeichert und live auf Tablet und Laptop aktualisiert.

## Datenpfad

```text
careerModel/users/<firebase-uid>/
  areas/<areaId>
  modules/<moduleId>
  progress/<moduleId>
  reflections/<YYYY-MM-DD>
  settings
  meta
```

Neue Regeln in `firebase/database.rules.json` begrenzen Lesen und Schreiben auf die jeweils angemeldete Firebase-UID. Die bestehende offene Fallback-Regel schliesst `careerModel` und `quantusRealtime` ausdrücklich aus, damit sie die UID-Regeln nicht überstimmt.

## Importvertrag

- Schema: `quantus-career-model/v1`
- Version: `1`
- JSON Schema: `/career-model.schema.json`
- Beispieldatei: `/career-model-sample.json`
- Maximale Dateigrösse: 5 MB
- Tagesdauer: technisch 15–60 Minuten; 25–35 Minuten werden für das 30-Minuten-Ziel empfohlen
- Tagesnummern beginnen bei 1 und sind lückenlos
- IDs enthalten nur Kleinbuchstaben, Zahlen, Bindestrich und Unterstrich
- Inhalt ist reiner Text; Script-, iframe- und Event-Handler-Markup wird abgelehnt
- Mindestens zwei Kontrollfragen und eine Praxisaufgabe mit Musterlösung pro Tag

Ein Reimport mit derselben `module.id` aktualisiert die Lerninhalte. Abschlüsse bleiben erhalten, sofern die jeweilige `day.id` weiterhin existiert. Dadurch kann Claude ein Modul später verbessern, ohne den Lernstand zu löschen.

## Reflecta

Reflecta ist in Career Model eingebaut und speichert pro Arbeitstag:

- Was gut gemacht wurde
- Was falsch lief oder schwierig war
- Was effizienter möglich gewesen wäre
- Wichtigste Erkenntnis
- Konkreter nächster Schritt
- Fokus und Energie von 1 bis 10

Die Einträge werden nicht automatisch bewertet oder an eine KI gesendet.

## Dateien

- `public/career-model.html` – App-Einstieg
- `public/career-model.css` – responsive Oberfläche
- `public/career-model.js` – Firebase-Sync, Lernen, Import und Reflecta
- `public/career-model-core.js` – DOM-freie Validierungs-, Merge- und Promptlogik
- `public/career-model.schema.json` – maschinenlesbarer Importvertrag
- `public/career-model-sample.json` – validierte Beispieldatei
- `tests/career-model-core.test.mjs` – Validierung, Reimport und Fortschritt
