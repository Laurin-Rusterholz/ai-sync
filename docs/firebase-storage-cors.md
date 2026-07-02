# Firebase Storage CORS einrichten

Der Browser blockiert Firebase Storage (Origin `https://management-xo2-pro.netlify.app`)
mit einem **CORS-Fehler**. Firebase wird in dieser App nur als **Backup-/Schatten-Sync**
genutzt — die App synchronisiert derweil unverändert über **Netlify** weiter. Um die
Firebase-Redundanz zu reaktivieren, muss am **Bucket** einmalig CORS gesetzt werden.
Das ist eine **Google-Cloud-Einstellung, nicht im App-Code** (kann daher nicht aus der
App/dem CI heraus gesetzt werden).

## Voraussetzung
- Google Cloud SDK (`gsutil`): <https://cloud.google.com/sdk/docs/install>
- Zugriff auf das Firebase-Projekt `jupidu-36804`:
  ```bash
  gcloud auth login
  ```

## Fix (ein Befehl)
```bash
bash scripts/set-firebase-cors.sh
```
… oder direkt:
```bash
gsutil cors set firebase/cors.json gs://jupidu-36804.firebasestorage.app
```

## Prüfen
```bash
gsutil cors get gs://jupidu-36804.firebasestorage.app
```
Danach in der App im Firebase-CORS-Hinweis auf **„🔄 Erneut versuchen"** klicken.

## Hinweis
Die `origin`-Liste in `firebase/cors.json` muss alle Domains enthalten, unter denen die
App läuft (z. B. weitere Netlify-Preview-URLs). Bei Bedarf dort ergänzen und den Befehl
erneut ausführen.
