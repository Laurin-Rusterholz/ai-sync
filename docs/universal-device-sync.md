# Quantus Universal Device Sync

Die bestehende Quantus-Hauptdatenbank bleibt die Quelle für Aufgaben, Projekte, Notizen, Pinnboards und alle anderen Kernobjekte. Die neue universelle Geräteebene ergänzt drei Dinge:

1. **Präsenz:** Tablet, Laptop und Handy melden, dass Quantus geöffnet ist und welche Ansicht aktuell aktiv ist.
2. **Sichere Übergabe:** Eine Ansicht oder ein konkretes Objekt kann an ein anderes aktives Gerät gesendet werden.
3. **Direktes Öffnen:** Das Zielgerät empfängt den Befehl live und öffnet den geprüften Quantus-Deep-Link.

## Datenpfad

```text
quantusRealtime/workspaces/<firebase-uid>/
  devices/<deviceId>
  commands/<targetDeviceId>/<commandId>
```

Die Firebase-Regeln erlauben den Zugriff nur, wenn `auth.uid` dem Workspace entspricht. Befehle laufen nach fünf Minuten ab, werden nach Empfang markiert und anschliessend entfernt. URLs werden vor Versand und Empfang auf Quantus-, lokale Entwicklungs- oder passende Netlify-Origins begrenzt.

## Universelle Einbindung

`netlify/edge-functions/quantus-universal-bootstrap.js` ergänzt jede von Netlify ausgelieferte HTML-Seite um:

- `/quantus-universal.css`
- `/quantus-device-sync.js`
- `/quantus-universal-ui.js`

Die Transformation ist idempotent und lässt Nicht-HTML-Antworten unverändert. Damit erhalten auch eigenständige Seiten wie `bm.html`, DocStudio oder No-Braine dieselbe Geräteebene, ohne die sehr grosse Hauptdatei anzupassen.

## Live-Adapter

- Die Hauptanwendung hört zusätzlich push-basiert auf `appStore/app-data_json` und startet bei einer Fremdänderung sofort den bestehenden Pull-before-push-Merge.
- Die BM-App hört auf `bmpruefung` und rendert Änderungen anderer Geräte neu.
- Smarter und Leseplan hören auf ihre eigenen RTDB-Pfade; eine gerade geöffnete Ansicht wird nach einer Änderung neu aufgebaut.
- Career Model verwendet für Inhalte, Fortschritt und Reflecta einen eigenen kontinuierlichen Value-Listener.

Während ein Eingabefeld aktiv ist, werden Aktualisierungen bis zum Verlassen des Feldes zurückgestellt, damit kein gerade geschriebener Text überschrieben wird.

## Tablet

Die Tablet-Erweiterung zeigt auf Home live:

- BM-Tageslektion und fällige Wiederholungen
- Neuestes Smarter-Dokument
- Nächste Leseplan-Einheit
- Nächsten Career-Model-Lerntag
- Pinnboard-Status
- Anzahl weiterer aktiver Geräte

Projekt- und andere Entitätskarten erhalten eine Übergabe-Schaltfläche. Der Kontext enthält Sammlung und Objekt-ID. Bei Empfang öffnet das Tablet zuerst die richtige Route und anschliessend automatisch den konkreten Eintrag.


## Konto und Datenschutz

Gerätepräsenz und Übergaben werden nur für nicht-anonyme Firebase-Konten aktiviert. Tablet und Laptop müssen mit demselben Google-Konto angemeldet sein. Die bestehende offene Root-Fallback-Regel nimmt `careerModel` und `quantusRealtime` explizit aus; beide Pfade sind damit auf die jeweilige UID begrenzt.
