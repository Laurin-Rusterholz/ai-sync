# Polaris — Budget-/Finanzdaten lesen (für einen n8n-Endpunkt `/polaris/budget`)

Recherche-Ergebnis: **Wo liegen die Budgetdaten und in welchem Format?**
Diese Datei dokumentiert nur den Lesezugriff — die Budget-Logik selbst bleibt
unangetastet.

## Kurzfassung

- **Speicher:** Firebase **Realtime Database** (RTDB), Projekt `jupidu-36804`,
  Region `europe-west1`.
- **Basis-URL:** `https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app`
- **Es gibt KEINEN eigenen `budget`-Knoten.** Die Finanzdaten sind Teil des
  einen grossen App-Daten-Blobs, den `public/index.html` als Ganzes
  synchronisiert (dasselbe Muster wie alle Quantus-Module: Tasks, Notizen,
  Projekte … liegen alle in diesem Blob).
- **Exakter RTDB-Pfad:** `appStore/app-data_json`
  → REST: `…firebasedatabase.app/appStore/app-data_json.json`
- Der Knoten enthält **nicht direkt** die Daten, sondern einen Wrapper:
  ```json
  { "data": "<JSON-STRING des gesamten App-Payloads>",
    "updatedAt": "...", "savedAt": 1234567890, "savedBy": "device-id" }
  ```
  Das Feld **`data` ist ein JSON-String** und muss zuerst geparst werden.
  (Grund: RTDB-Schlüssel dürfen kein `.` enthalten — `app-data.json` wird beim
  Schreiben zu `app-data_json` umgeschrieben; siehe `rtdbNodeKey()` in
  `public/index.html`.)

## Wo im geparsten Payload stehen die Finanzdaten

Nach `JSON.parse(wrapper.data)` liegen die relevanten Sammlungen unter
`entities` (jeweils eine Map `{ id → objekt }`):

| Pfad im geparsten Payload | Inhalt |
|---|---|
| `entities.transactions` | **Alle Buchungen** (Einnahmen/Ausgaben) — das Kern-Budget |
| `entities.accounts` | Konten inkl. `balance` (aktueller Saldo) |
| `entities.creditCards` | Kreditkarten inkl. `usedBalance`, `limit`, `linkedAccountId` |
| `entities.subscriptions` | Abos/wiederkehrende Zahlungen |
| `entities.financialGoals` | Sparziele |
| `entities.purchaseProposals` | Kaufvorschläge/-anträge |

### Feldformat `transactions[<id>]`

```json
{
  "id": "…",
  "amount": 42.5,                      // Zahl, immer positiv
  "type": "expense" | "income",        // Richtung
  "category": "Lebensmittel",          // frei
  "description": "…",
  "date": "2026-07-13",                // YYYY-MM-DD
  "accountId": "…",                    // → entities.accounts
  "creditCardId": "…" | null,
  "isFuture": false,                   // geplante/zukünftige Buchung
  "isSettlement": false,               // Kreditkarten-Abrechnung
  "createdAt": "ISO", "updatedAt": "ISO"
}
```
`accounts[<id>]` enthält u.a. `name`, `balance`, `currency` (Default `CHF`).

## Beispiel: Saldo/Ausgaben in einem n8n-Code-Node berechnen

Muster wie bei den anderen Polaris-Endpunkten (dedizierter **HTTP-Request-Node**
holt den Knoten, ein **Code-Node** verarbeitet — kein `this.helpers.httpRequest`
im Code, kein Credential nötig, RTDB-Regeln decken den Lesezugriff ab):

1. **HTTP-Request-Node** (typeVersion 4.2, `timeout 6000`, `continueOnFail`):
   `GET https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app/appStore/app-data_json.json`
2. **Code-Node** (nur Verarbeitung):
   ```js
   // $json ist der Wrapper { data: "<json-string>", ... }
   let payload = {};
   try { payload = JSON.parse(($json.data) || '{}'); } catch (e) {}
   const ent = payload.entities || {};
   const tx = Object.values(ent.transactions || {});
   const accounts = Object.values(ent.accounts || {});

   const now = new Date();
   const ym = now.toISOString().slice(0, 7);                // "2026-07"
   const real = tx.filter(t => t && !t.isFuture);
   const income  = real.filter(t => t.type === 'income').reduce((s, t) => s + (Number(t.amount) || 0), 0);
   const expense = real.filter(t => t.type === 'expense').reduce((s, t) => s + (Number(t.amount) || 0), 0);
   const monthExpense = real.filter(t => t.type === 'expense' && String(t.date || '').startsWith(ym))
                            .reduce((s, t) => s + (Number(t.amount) || 0), 0);
   const totalBalance = accounts.reduce((s, a) => s + (Number(a.balance) || 0), 0);

   return [{ json: {
     ok: true,
     currency: (accounts[0] && accounts[0].currency) || 'CHF',
     totalBalance,
     income, expense, net: income - expense,
     monthExpense, month: ym,
     accounts: accounts.map(a => ({ name: a.name, balance: a.balance || 0 })),
     txCount: real.length
   } }];
   ```
3. **Respond-Node** (JSON, `Access-Control-Allow-Origin: *`, wie die übrigen
   Polaris-Webhooks).

## Wichtige Hinweise

- **Grösse:** `app-data_json` ist der komplette App-Blob (viele MB möglich).
  Für `/polaris/budget` reicht das trotzdem — es ist ein einzelner GET; nur
  im Code-Node gezielt `entities.transactions/accounts` herausgreifen und den
  Rest verwerfen, damit die Antwort klein bleibt.
- **Kein separater Budget-Schreibpfad:** Wer Budget **schreiben** wollte,
  müsste den ganzen Blob mergen — das ist ausdrücklich **nicht** Teil dieser
  Aufgabe und sollte dem Frontend überlassen bleiben (Single-Writer-Prinzip,
  siehe Kommentar bei `appStore` in `public/index.html`). `/polaris/budget`
  ist ein **reiner Lese-Endpunkt**.
- **Alternative (nicht umgesetzt):** Wenn du später einen schlanken,
  dedizierten `polaris/budget`-Spiegel möchtest, könnte das Frontend bei jedem
  `scheduleSave()` eine kompakte Zusammenfassung zusätzlich nach
  `polaris/budget` schreiben. Das wäre eine **Frontend-Änderung** und wurde
  hier bewusst unterlassen (Aufgabe: Budget-Logik nicht anfassen, nur
  dokumentieren).

## Getroffene Annahme

Da es keinen dedizierten Budget-RTDB-Knoten gibt, ist der oben beschriebene
Weg über `appStore/app-data_json` → `entities.transactions/accounts/…` der
korrekte und einzige Lesepfad. Verifiziert im Code von `public/index.html`
(`viewBudget()` liest exakt diese `entities.*`-Sammlungen; die RTDB-Ablage
erfolgt über `rtdbJsonPut`/`rtdbNodeKey` unter `appStore/<sanitizedKey>`).
