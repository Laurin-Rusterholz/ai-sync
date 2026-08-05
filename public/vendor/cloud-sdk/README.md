# Vendored Firebase SDK (compat, v10.8.0)

Diese vier Dateien sind die unveraenderten UMD-Browser-Bundles aus dem npm-Paket
`firebase@10.8.0` — dieselben Builds, die auch unter
`https://www.gstatic.com/firebasejs/10.8.0/` ausgeliefert werden. Nur die
`sourceMappingURL`-Kommentare am Dateiende wurden entfernt, damit die Browser-
Konsole keine 404 fuer die nicht mitgelieferten `.map`-Dateien meldet.

| Datei        | Quelle im npm-Paket             |
| ------------ | ------------------------------- |
| `app.js`     | `firebase/firebase-app-compat.js`      |
| `auth.js`    | `firebase/firebase-auth-compat.js`     |
| `storage.js` | `firebase/firebase-storage-compat.js`  |
| `db.js`      | `firebase/firebase-database-compat.js` |

## Warum vendored?

Das SDK direkt von `gstatic.com` zu laden ist die haeufigste Ursache fuer
"Firebase nicht geladen": Adblocker, Privacy-Filter, Firmen-Proxys und DNS-
Blocklisten kennen `gstatic.com/firebasejs/` als Tracker-Pfad und blockieren
ihn. Faellt das SDK aus, kann die App ihren Datensatz weder aus der Firebase
RTDB laden noch dorthin speichern (siehe `primaryCloudProvider()` in
`index.html`) — Boards, Anhaenge und Sync sind dann tot.

Aus dem eigenen Origin ausgeliefert kann kein Filter dazwischenfunken. Die
Dateinamen sind bewusst neutral (`app.js` statt `firebase-app-compat.js`),
damit auch pfadbasierte Filterregeln nicht greifen.

`gstatic.com` bleibt als Fallback bestehen, falls ein Deploy die vendorten
Dateien einmal nicht ausliefert.

## Update

```sh
npm pack firebase@<version>          # oder: npm i firebase@<version>
cp node_modules/firebase/firebase-app-compat.js      public/vendor/cloud-sdk/app.js
cp node_modules/firebase/firebase-auth-compat.js     public/vendor/cloud-sdk/auth.js
cp node_modules/firebase/firebase-storage-compat.js  public/vendor/cloud-sdk/storage.js
cp node_modules/firebase/firebase-database-compat.js public/vendor/cloud-sdk/db.js
# sourceMappingURL-Kommentar am Dateiende entfernen
```

Danach `node tests/firebase-sdk-loading.test.mjs` laufen lassen.
