# Firebase-RTDB-Speicherung (Auto-Sync-Primär)

Speichert den **kompletten App-Datensatz** in der Firebase **Realtime Database** (RTDB)
statt nur in localStorage/Netlify. RTDB ist der **primäre** Auto-Sync-Provider;
Netlify bleibt als automatischer Fallback und Shadow warm.

**Warum RTDB?**
- **Kein ~5-MB-localStorage-Limit** (RTDB erlaubt bis 16 MB pro Schreibvorgang) — löst
  das Ueberlaufproblem (verlorene Daten/API-Keys auf neuen Geraeten) an der Wurzel.
- **Kein CORS-Problem** wie bei Firebase Storage — RTDB nutzt einen anderen Endpoint,
  der vom Browser nicht blockiert wird.

Ablage-Knoten: `appStore/<blobKey>` (z. B. `appStore/app-data_json`), Format
`{ data: <JSON-String des Datensatzes>, updatedAt, savedAt, savedBy }`.

## Wie der Auto-Sync funktioniert
- **Push:** Bei jedem Speichern wird der Datensatz zuerst nach RTDB geschrieben.
  Danach wird er gedrosselt (~alle 45 s, fire-and-forget) als *Shadow* auch nach
  Netlify (und Firebase Storage, falls verfuegbar) geschrieben, damit ein
  Rueckschalten verlustfrei bleibt.
- **Pull:** Beim Laden/Abgleich wird RTDB bevorzugt gelesen; schlaegt es fehl,
  greift automatisch Netlify/Firebase. Beim manuellen Transfer werden alle Provider
  gelesen und der **neueste** Stand (per Zeitstempel) gewaehlt.
- **Merge:** Entitaeten werden verlustfrei vereint (`mergeData`); Einstellungen werden
  uebernommen, aber **nicht-leere lokale API-Keys werden nie von leeren Remote-Werten
  ueberschrieben** (Wurzelfix fuer „API-Keys verschwinden"). Die lokale Storage-Config
  bleibt immer erhalten.

## Umschalten / Rollback (Einstellungen → Sync)
- Checkbox **„RTDB als primären Auto-Sync verwenden"** (Default: an).
  Aus → Netlify wird wieder primär (RTDB bleibt Fallback/Shadow).
  Intern: `settings.storage.primaryProvider = "rtdb" | "netlify"`.
- Ganz abschalten (RTDB gar nicht nutzen): `settings.storage.rtdbSync = false`.
- Zusaetzliche manuelle Buttons: **Jetzt sichern / Jetzt laden / Status**.

## WICHTIG: Sicherheit (RTDB-Regeln)
Der Datensatz enthaelt **Einstellungen inkl. API-Keys** und wird jetzt **laufend
automatisch** geschrieben. Die RTDB-Regeln MUESSEN den Zugriff einschraenken.
Beispiel (nur authentifizierte Nutzer):

```json
{
  "rules": {
    "appStore": {
      ".read": "auth != null",
      ".write": "auth != null"
    }
  }
}
```

**Nicht** mit offenen Regeln (`".read": true, ".write": true`) fuer echte Daten nutzen —
sonst waeren die laufend geschriebenen API-Keys oeffentlich lesbar. Wer die Regeln
(noch) nicht gesichert hat, kann RTDB per `storage.rtdbSync = false` deaktivieren,
bis die Regeln stehen.
