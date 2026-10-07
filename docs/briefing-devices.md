# Tagesbriefing on phones and tablets

`public/quantus-briefing-device.js`, its CSS and controller are the shared native presentation. The desktop dashboard remains in `public/index.html`. All three consume the same Quantus entities, assistant run receipts and source checks. The shared renderer never writes to the snapshot.

Distribute the six assets (including the durable command, answer and capture clients) with:

```sh
node scripts/sync-briefing-devices.mjs --mobile ../mobile-management --tablet ../quantus-tablet-version
```

Commit all affected repositories and bump each native service-worker cache. Native adapters retain the apps' existing original-entry navigation, task actions and authenticated attachment pipeline. Existing personal planning remains accessible below the new dashboard.

Answers and captures use account-scoped IndexedDB, Firebase identity and the ai-sync command endpoint. Captures wait for an active daily run; ambiguous transport never becomes a success. Configure each deployed HTTPS device origin in `QUANTUS_V3_ALLOWED_ORIGINS` and Firebase authorized domains. No wildcard or bypass is introduced. Pending inputs remain on their originating device until confirmed; a failed request does not imply server persistence. Drafts survive in-app rendering, queued submissions survive reloads. Routine, finance and calendar completion are never inferred from dashboard display.

Validation: `node --test tests/quantus-v4-device-briefing.test.mjs`, each native repository's `npm test`, and native browser checks at 390, 768 and 1024 pixels, including original-entry navigation, durable offline submissions, reload and account isolation.
