# Firebase-RTDB-Speicherung (opt-in)

Speichert den **kompletten App-Datensatz** in der Firebase **Realtime Database** (RTDB)
statt nur in localStorage/Netlify.

**Warum RTDB?**
- **Kein ~5-MB-localStorage-Limit** (RTDB erlaubt bis 16 MB pro Schreibvorgang) — löst
  das Ueberlaufproblem (verlorene Daten/API-Keys auf neuen Geraeten) an der Wurzel.
- **Kein CORS-Problem** wie bei Firebase Storage — RTDB nutzt einen anderen Endpoint,
  der vom Browser nicht blockiert wird.

Ablage-Knoten: `appStore/<blobKey>` (z. B. `appStore/app-data_json`).

## Nutzung (Einstellungen -> Sync)
- **In Firebase sichern** — schreibt den kompletten Datensatz nach RTDB.
- **Aus Firebase laden** — laedt ihn und fuehrt ihn mit dem lokalen Stand zusammen
  (mergeData; Einstellungen/API-Keys werden uebernommen, lokale Storage-Config bleibt).
- **Status** — prueft, ob ein Datensatz vorhanden ist.

Alles **manuell/opt-in** — der bestehende Auto-Sync (Netlify) bleibt unveraendert.

## WICHTIG: Sicherheit (RTDB-Regeln)
Der Datensatz enthaelt **Einstellungen inkl. API-Keys**. Die RTDB-Regeln MUESSEN den
Zugriff einschraenken. Beispiel (nur authentifizierte Nutzer):

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
sonst waeren API-Keys oeffentlich lesbar.

## Naechster Schritt (optional)
Wenn erprobt, kann die RTDB-Speicherung zum **Auto-Sync-Primaer** gemacht werden
(statt/zusaetzlich zu Netlify). Dann entfaellt das localStorage-Limit dauerhaft.
Aktuell bewusst als opt-in vorbereitet (kein Auto-Write -> kein Datenverlust-Risiko
waehrend der Erprobung).
