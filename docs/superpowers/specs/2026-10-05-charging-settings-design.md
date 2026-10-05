# Charging settings — sources, tariffs and credentials — design

Status: agreed 2026-10-05. Decision record: [ADR-0026](../../adr/0026-integration-credential-store.md).
Roadmap: [charging settings](../roadmaps/2026-10-05-charging-settings.md). Builds on:
- [ADR-0019](../../adr/0019-external-data-integrations.md): pulled sync, fail closed, health.
- [ADR-0013](../../adr/0013-form-presentation-and-dialog-architecture.md): URL dialog state.
- The Datakällor panel (#71, #76, #83).

## Intent

The bottom of `/charging` (the overview) carries two admin blocks that aren't about charging:
- the tariff card, "Påslag, elnät och skatt";
- the **Datakällor** panel.

They belong on a settings page for the charging part of the app. That page should also let an admin **set or
replace each source's credentials in the GUI**. Today an expired Škoda key means editing a Vercel env var and
redeploying, which is too much.

The page is a pure *settings and status* page for the connected sources and their setup.

**Success**
- The overview shows charging only.
- `/charging/settings` (admin-only) holds the sources, their sync and history, the tariffs, and every source's
  credentials.
- An expired Škoda key is fixed from a phone in under a minute: copy the new key in MyŠkoda, paste it into the app,
  and the Škoda tile turns "Fungerar" with no deploy.

## Agreed decisions (brainstorm 2026-10-05)

| Question | Decision |
|---|---|
| Who sees the page | **Admins only.** The tariff table moves there too. Members still see the resulting costs. |
| Where GUI-set credentials live | **Encrypted rows in our Postgres** (AES-256-GCM, dedicated `CREDENTIALS_ENCRYPTION_KEY`). Stored values win over env, field by field; env stays the fallback. See ADR-0026. |
| What saving does | **Save, then run that source's sync once.** The tile's health shows the result. No separate "test" path. |
| Removing | **"Ta bort sparade uppgifter"** clears the stored row: env applies again (or `not_configured`), then a sync runs. |
| Slicing | Three steps, one PR each: **move → store → UI** (see the roadmap). |

## Scope

**In**
- The new admin route.
- Moving the tariff card and the whole Datakällor panel, including the Škoda tile's car data and log import.
- Links from the overview's alerts to the settings page.
- An encrypted credential store, with a per-field resolver for Zaptec, Škoda (key, VIN, home coordinates), Emaldo
  (four fields) and the grid tariff watcher (facility ID).
- A credentials dialog per source, plus a grid card for the facility ID.
- Copy, email, runbook, ADR and `.env.example` updates.

**Out**
- **Testing credentials before saving** (ADR-0026 alternatives).
- **Key rotation tooling.** The envelope is versioned (`v1.`) so it can be added later.
- **Other settings:** non-credential settings (cadences, zone, tariff defaults) and settings for other app areas
  (sensors).
- **An Emaldo alert on the overview.** Emaldo's health stays on the settings page and in the alert email, as today.

## Step 1 — the settings page (move only)

### Route
- File `src/routes/_authenticated/charging/settings.tsx`, a sibling of `charging/index.tsx`, so no layout change is
  needed.
- `beforeLoad`: a non-admin is redirected to `/charging`. This mirrors `admin.tsx`, which redirects to `/`; the
  overview is the friendlier target here.
- Search schema: `dialog` (`tariffNew | tariffEdit | tariffDelete | vehicleImport | syncRuns`), `tariffId` and
  `source`. They move from the overview's schema unchanged, together with:
  - the `useUrlDialog` wiring;
  - the "clear a dialog that can't show" effect.
- The loader uses `loadRouteData` ([ADR-0025](../../adr/0025-deferred-route-loading.md), merged in #89 while this
  step was being built):
  - **critical** (awaited on the server, so SSR and deep links render complete): `tariff.list` and all four
    `syncStatus` queries;
  - **deferred** (started on the client after hydration): all four `recentRuns` queries, `vehicleRecordCoverage`
    and `vehicleStateLatest`.

  Every read is a plain `useQuery`. The Datakällor panel and the tariff card sit in the same `SectionSkeleton`s
  they had on the overview (`charging-sources`, `charging-tariffs`), captured from this page.
- Page:
  - A `PageContainer` with the heading "Laddningsinställningar" and a short lead.
  - The admin "Synka nu" (sync all) action, as in `ChargingHeading`. The live-status line stays on the overview.
  - Then **Datakällor** (`SyncSourcesPanel`, entries exactly as today), then the **tariff card**, then the three
    dialogs (`TariffDialog`, `DeleteTariffDialog`, `VehicleImportDialog`).
  - The panel's "Bara admins ser den här delen" sentence is dropped: the whole page is admin-only.

### Overview (`charging/index.tsx`) after the move
- **Removed:**
  - the panel and the tariff card with their dialogs;
  - the `dialog` / `tariffId` / `source` params;
  - the runs, coverage, latest-state and Emaldo health queries.
- **Kept:**
  - `tariff.list`, because `showCost` and `costNotice` depend on it;
  - the Zaptec, elpris and Škoda health queries and their polling, which feed the alerts;
  - `useSyncNow`.
- `SyncHealthAlert` and `CredentialExpiryAlert` gain an admin-only "Gå till inställningar" link to
  `/charging/settings`. The Zaptec alert's member copy is unchanged, and members get no link.
- `CostNotice`'s `onAddTariff` becomes a link to `/charging/settings?dialog=tariffNew`, rendered for admins only.
- An old `/charging?dialog=…` URL loses the param silently. Nothing in the app links there (verified 2026-10-05).

### Navigation
- **Sidebar.** `chargingSubItems` gains `{ to: '/charging/settings', label: m.nav_charging_settings_short,
  adminOnly: true }`.
  - `AppSidebar` filters sub-items by the user's role. It takes `role` as a prop, the same way `CommandPalette`
    does.
  - The settings link must not carry the overview's `year` / `vehicle` search.
- **Command palette.** A `/charging/settings` entry with `adminOnly: true` and its own keywords.

### Emails
- These link to `/charging/settings` instead of `/charging`:
  - `IntegrationSyncAlertEmail` (health is fixed there);
  - `CredentialExpiryEmail`;
  - `GridTariffAvailableEmail` (tariffs live there).
- Copy is unchanged in step 1.

### Tests
- The overview's route tests (`-vehicleScopePages.browser.test.tsx`) for the car log, import, panel, history deep
  links and bad-link cleanup move to a new `-settings.browser.test.tsx`. Add:
  - the admin gate (a member is redirected);
  - the tariff card renders on the settings page.
- The overview's order test drops its tariff assertion.
- `CostNotice` and `AppSidebar` tests follow their changes.
- The email tests assert the new link.

## Step 2 — credential store and resolver (server only)

### Client-safe vocabulary — `src/lib/integrationCredentials.ts`
Dependency-free, in the same pattern as `integrationHealth.ts`:
```ts
export const CREDENTIAL_SOURCES = ['zaptec', 'skoda', 'emaldo', 'gridTariff'] as const
export const CREDENTIAL_FIELDS = {
  zaptec: ['username', 'password'],
  skoda: ['apiKey', 'vin', 'homeCoordinates'],
  emaldo: ['user', 'password', 'appId', 'appSecret'],
  gridTariff: ['facilityId'],
} as const
// secret → password input; text → plain input (still never pre-filled). Only the VIN is text.
export const credentialFieldKind = (source: CredentialSource, field: string): 'secret' | 'text' =>
  source === 'skoda' && field === 'vin' ? 'text' : 'secret'
export type CredentialOrigin = 'stored' | 'env' | 'missing'
```
`vin` is `text`; every other field is `secret`, including `homeCoordinates` and `facilityId`, which must never be
shown.

The field-to-env-var map is server-only, in `src/lib/credentials/env.ts`:
- `zaptec.username` → `ZAPTEC_USERNAME`, `zaptec.password` → `ZAPTEC_PASSWORD`.
- `skoda.apiKey` → `SKODA_API_KEY`, `skoda.vin` → `SKODA_VIN`, `skoda.homeCoordinates` → `SKODA_HOME_COORDINATES`.
- `emaldo.user` → `EMALDO_USER`, `emaldo.password` → `EMALDO_PASSWORD`, `emaldo.appId` → `EMALDO_APP_ID`,
  `emaldo.appSecret` → `EMALDO_APP_SECRET`.
- `gridTariff.facilityId` → `GRID_FACILITY_ID`.

### Schema — `src/lib/db/schema/integrationCredential.ts`
| Column | Type | Notes |
|---|---|---|
| `source` | `text` PK | CHECK `IN (CREDENTIAL_SOURCES)` |
| `ciphertext` | `text not null` | `v1.<iv>.<tag>.<ct>`, base64url parts; CHECK `^v[1-9][0-9]*[.]` + three base64url parts, and `char_length <= 16384` |
| `fields_set` | `text[] not null` | names only; CHECK non-empty |
| `updated_at` | `timestamptz not null default now()` | `$onUpdate` |
| `updated_by` | `uuid` FK → `user.id` `on delete set null` | no index (at most 4 rows) |

- `updated_by` is `uuid`, because `user.id` is a uuid.
- The ciphertext CHECK is version-agnostic, so a `v2` envelope needs no schema change.
- `fields_set` is display-only metadata. The service validates it (no per-element CHECK), and resolution never
  trusts it.
- The table ends with `.enableRLS()`, with no policies; the app connects as the owner. Revoking the `anon` and
  `authenticated` grants was considered and skipped, since the values are encrypted anyway.
- `integration_sync` and `integration_sync_run` gain `credentials_unreadable` in their error-code CHECKs, by adding
  it to `INTEGRATION_ERROR_CODES`. Both are migrations, and both get `migration-guard` plus the schema-design
  review.
- **Alerting.** `credentials_unreadable` is alertable like `auth_failed`. Only `not_configured` stays non-alertable.

### Crypto — `src/lib/credentials/crypto.ts` (server-only)
- `encrypt(source, plaintextJson)` and `decrypt(source, envelope)`: AES-256-GCM, a random 12-byte IV, a 16-byte tag,
  and `AAD = source`.
- The key comes from `CREDENTIALS_ENCRYPTION_KEY`, which must decode from base64 to exactly 32 bytes; anything else
  counts as missing.
- `decrypt` throws a typed `CredentialsUnreadableError` on any failure. It never returns partial data.

### Service — `src/lib/services/integrationCredential/`
- `status()`: per source, per field `{ origin }`, plus the row's `updatedAt` and `unreadable: boolean`.
  `encryptionKeyConfigured: boolean` is also returned. The `env` origin is computed from `process.env` presence.
  Values are never returned.
- `set(source, fields, userId)`, in one transaction (default READ COMMITTED):
  1. Validate every non-blank field (see below) and reject unknown fields.
  2. Take `pg_advisory_xact_lock(hashtext('videbacken.integration_credential:' || source))` as the first statement,
     then read the row with `SELECT … FOR UPDATE`. `FOR UPDATE` alone can't lock a row that doesn't exist yet, so
     two concurrent first saves would each merge over nothing and the later upsert would drop the earlier fields.
  3. Decrypt the existing row, if any.
  4. Merge the new fields over it, then encrypt and upsert.

  The cache invalidation runs in a `finally`, so a COMMIT that errored on the client still drops the cached read.

  If the existing row is unreadable, the new fields **replace** it; the old values are lost anyway. Blank or omitted
  fields are unchanged.
- `clear(source)` deletes the row. It is idempotent.
- `readStored(source)`, for the resolver: the decrypted values, or `null` when there is no row. It throws
  `CredentialsUnreadableError`.
- **Validation** (trimmed; at most 512 characters each; ASCII control characters are rejected):
  - `vin`: `^[A-HJ-NPR-Z0-9]{17}$`, after upper-casing.
  - `homeCoordinates`: must parse with `parseHomePoint`.
  - `facilityId`: must parse with `parseFacilityId`.
  - Every other field: non-empty.
- **Domain errors** (`IntegrationCredentialDomainError`):
  - `INVALID_FIELD`: carries the field name. The message never contains the value. An unknown field name is echoed
    only if it matches `/^[A-Za-z]{1,32}$/`; otherwise it is `unknown`.
  - `NOTHING_TO_SAVE`.
  - `ENCRYPTION_KEY_MISSING`.

### Resolver — `src/lib/credentials/resolve.ts` (server-only)
- `resolveCredentials(source)` returns `{ values: Partial<Record<field, string>>, fingerprint }`:
  - each field's value is the stored value, else `process.env[ENV]`;
  - `fingerprint` is the SHA-256 of the canonical JSON of the values.
  The fingerprint is an unsalted hash: an in-memory cache key only, never logged or returned.
- A missing key with no stored row resolves from env, with no error. A stored row that can't be decrypted throws
  `CredentialsUnreadableError`.
- Only the **stored read** is cached in memory, for 60 s per source; a rejected read is not cached. Env is merged on
  every call, which is free and keeps test env stubs live. `invalidateCredentials(source)` drops the entry; the
  service's `set` and `clear` call it in a `finally`. `setupDatabase()` clears the cache before each test, because
  each test gets a fresh schema.
- Removing or renaming a field in `CREDENTIAL_FIELDS` makes existing rows with it unreadable (fail closed). It needs
  re-entry or a data migration.

### Adapter wiring
- **Facades.** `zaptec.ts`, `skoda.ts` and `emaldo.ts` replace `lazy()` with `keyedAdapter` (in
  `src/lib/effects/keyedAdapter.ts`). On each call it runs the following, in order:
  1. Under VITEST, return `notConfigured` **before importing the resolver**. The import is dynamic, which keeps `db`
     out of the facades' module graph.
  2. Resolve the credentials.
  3. If the fingerprint is unchanged, reuse the cached client. This keeps the Zaptec and Emaldo token caches.
  4. Otherwise build a new client through the existing `select*Adapter`. The selector now takes the resolved values
     instead of `process.env`; Zaptec's `ZAPTEC_ADAPTER=fake` and the production guard still read env.

  The cache holds one entry. A resolve still in flight from before a save can finish last and overwrite the newer
  entry, costing one extra client rebuild (for Emaldo, one extra login) at a credential change; the next call
  settles it. Accepted.
- **`CredentialsUnreadableError`** is a plain error from the crypto layer. `keyedAdapter` maps it to the source's
  own `IntegrationError` subclass with code `credentials_unreadable`; otherwise `runPulledSync` would record
  `internal_error` and rethrow. The run fails closed and is health-tracked.
- Effects reach the credential service only through the resolver (an ADR-0001 note).
- **Home point.** `vehicleState/sync.ts` resolves `homeCoordinates` through `resolveCredentials('skoda')` inside the
  run (`execute`, before the client call); the injected `deps.homePoint` still wins. One run is one log line: the
  cron handler doesn't log, so a resolve error before the run (DB down) would be a 500 with no line. Inside, it is
  recorded as `internal_error`. An unreadable Škoda row makes the home point `null` (geofence off), while the client
  call fails the run as `credentials_unreadable`.
- **Grid.** `gridTariff/catalogueCheck.ts` replaces its `env` injection with a `facilityId` resolver injection that
  defaults to `resolveCredentials('gridTariff')`. An unreadable row logs an error and returns outcome
  `failed` / `credentials_unreadable`. The watcher isn't health-tracked, so nothing else changes.
- `notConfigured` messages name both places: "set it under Inställningar or as `SKODA_API_KEY`".

### Tests (node, `setupDatabase()`)
- **Crypto:**
  - round-trip;
  - a wrong key, a wrong AAD (a row swapped between sources) and a flipped tag byte all throw;
  - two encryptions of the same input differ (fresh IV).
- **Service:**
  - per-field merge;
  - a blank field keeps the stored value;
  - an unreadable row is replaced;
  - each domain-error code;
  - the stored `ciphertext` contains no plaintext value;
  - `status` never returns values.
- **Resolver:**
  - precedence: stored, then env, then missing;
  - the 60 s cache and `invalidate`;
  - the fingerprint is stable for the same values.
- **Facades:**
  - same fingerprint → same client instance; a changed value → a new client;
  - `credentials_unreadable` surfaces as the source's error code.

### Scope additions (as built)
- `.env.example` and the CLAUDE.md code map and env list were updated in step 2, not step 3.
- Rollback: after the new code has recorded `credentials_unreadable`, an instant rollback to older code shows that
  row's code without copy (display-only).

## Step 3 — credentials UI

### Procedures — `src/lib/orpc/procedures/credentials.ts` (registered as `credentials`)
- `status`: `adminProcedure` (a read, but admin-only). Returns the service's `status()`.
- `set({ source, fields })`: `adminProcedure`, `.errors(credentialErrors)`.
  - Zod restricts `fields` to that source's field names.
  - It logs `admin set integration credentials` with `{ source, fields: [names] }`.
- `clear({ source })`: `adminProcedure`. It logs the source only.

### Settings page additions
- **Each credential source's tile** (Zaptec, Škoda, Emaldo; elpris has none) gets an **"Inloggning"** button in the
  footer's actions slot.
  - When the source is `not_configured`, the button reads **"Konfigurera"**. Sync is already hidden in that state.
  - When the source is `auth_failed` or `credentials_unreadable`, the tile's health message adds an "Uppdatera
    inloggning" link that opens the same dialog.
- A new **"Elnätsavtal"** card holds the facility ID.
  - Status: "Anläggnings-ID sparat i appen" / "från miljövariabel" / "saknas – månadskollen hoppas över".
  - Next to the status: "Kontrolleras den 1:a varje månad".
  - An "Ändra" button opens the same dialog with `source=gridTariff`.
- **URL state** (ADR-0013): `?dialog=credentials&source=<credential source>`. The settings route's `source` param
  widens to `INTEGRATION_SOURCES ∪ CREDENTIAL_SOURCES`. A `syncRuns` link with `gridTariff` is cleaned like any
  other bad link.

### Credentials dialog (`CredentialsDialog.tsx`)
- A `ResponsiveDialog` with `useAppForm` and a Zod schema built per render for locale messages, shaped like
  `TariffDialog`.
- **Each field shows:**
  - its label;
  - its status line: "Sparad i appen · 5 okt" / "Från miljövariabel" / "Saknas";
  - an input that is never pre-filled. `secret` fields use `type="password"`; all inputs use `autoComplete="off"`.
- **Description text:**
  - "Lämna ett fält tomt för att behålla det som är sparat."
  - For Škoda: a link to `https://go.skoda.eu/api-keys` and the line "Skapa nyckeln i MyŠkoda-appen och klistra in
    den här."
- **When the encryption key is missing** (`encryptionKeyConfigured: false`), the inputs are disabled and the dialog
  shows an alert: "Appen saknar CREDENTIALS_ENCRYPTION_KEY – uppgifter kan inte sparas."
- **When the stored row is unreadable**, an alert says: "De sparade uppgifterna går inte att läsa. Fyll i alla
  fält igen."
- **"Spara":**
  1. Call `credentials.set`.
  2. On success, show the toast "Sparat", close the dialog, invalidate `credentials` and `evCharging`, and run
     `useSyncNow().syncSource(source)` for health-tracked sources.
  3. For `gridTariff`, nothing runs.

  `INVALID_FIELD` shows on that field; other errors show as a toast and keep the dialog open.
- **"Ta bort sparade uppgifter"** is shown only when something is stored. It opens a confirm (`AlertDialog`), then
  calls `credentials.clear` and runs the same sync.

### Overview links
`SyncHealthAlert` for `auth_failed` / `credentials_unreadable` and `CredentialExpiryAlert` link straight to
`/charging/settings?dialog=credentials&source=<source>`. In step 1 they link to the page.

### Copy and docs
- **Key-expiry email and warning.** `email_credential_expiry_body`, `charging_skoda_key_expiring_body*` and the
  matching en keys say "klistra in den nya nyckeln under Laddning → Inställningar" instead of "byt SKODA_API_KEY i
  Vercel och gör en ny deploy". The email test's `SKODA_API_KEY` assertion changes with them.
- **Runbook** `docs/runbooks/skoda-api-key.md`: the GUI is the primary path, and env is the fallback.
- **Config docs** landed in step 2 (`.env.example` with `CREDENTIALS_ENCRYPTION_KEY` and the GUI override, the
  CLAUDE.md env list and code map, the ADR-0019 pointer to ADR-0026). Step 3 updates them only for what its UI adds.

### Tests
- **Browser, `CredentialsDialog`:**
  - statuses render;
  - inputs are empty;
  - a blank submit is refused;
  - save then sync is called;
  - `INVALID_FIELD` lands on its field;
  - the missing-key and unreadable states;
  - remove asks for confirmation.
- **Browser, settings route:** the tile buttons, the `not_configured` "Konfigurera" label, the grid card, and the
  `dialog=credentials` deep link and its cleanup.
- **Procedure:** a member gets `FORBIDDEN` on all three procedures; `set` never echoes values.
- **Live** (Phase 6), at desktop, tablet and mobile widths.

## Error handling summary

| Situation | Behaviour |
|---|---|
| Key unset, no stored rows | Everything runs from env, as today. The dialog says saving is unavailable. |
| Key unset or wrong, a row stored | That source fails closed with `credentials_unreadable`, is alerted, and its tile links to the dialog. |
| Saved a bad key | The post-save sync fails with `auth_failed`, the tile shows it, and the admin pastes again. |
| Sync already running at save | The run is `skipped` by the lease. The next cron run (or "Synka nu") uses the new value. |
| Another warm instance | Picks up the new value within 60 s (resolver TTL). |
