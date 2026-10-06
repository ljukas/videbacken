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
| Slicing | One PR per step: **move → store → credentials server (3a) → credentials UI (3b)** (see the roadmap; the owner split step 3 on 2026-10-05). |
| One source or all | **Per source** (owner, 2026-10-05, after checkpoint 2). A source's fields are set together (all the Škoda fields in one save), and each source is independent of the others (Škoda never with Emaldo). See [Credentials per source](#credentials-per-source-owner-decision-after-checkpoint-2). |
| When one fails | **Only that source fails** (owner, same day). A rejected save, a refused key or an unreadable row affects that source only. |

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
  - `INVALID_FIELD`: carries the field names (a list; see Step 3a). The message never contains the value. An unknown field name is echoed
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

  The cache holds one entry. A resolve still in flight from before a save can finish last. That one call then uses
  the just-superseded credentials: one more vendor call with a revoked secret (for Emaldo, a refused login that
  sets the stale client's `loginBlock`). Its client also overwrites the newer entry, costing one extra rebuild
  (for Emaldo, one extra login). The next call resolves the new values and settles it. Accepted.
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

## Credentials per source (owner decision after checkpoint 2)

The owner reviewed the design from the UI's side after checkpoint 2 (2026-10-05). A source's fields are set
together, sources are set independently, and if one source fails, the others must not.

- **Step 2's storage already fits.** There is one encrypted row per source, so an unreadable or refused source never
  affects another. Each source has its own dialog, save and sync.
- **A save over an unreadable row needs every field of the source.**
  - Today, `set` replaces an unreadable row with only the fields sent, so the unsent ones would silently fall back
    to env.
  - Step 3a makes `set` refuse that with a new domain code, `REENTER_ALL_FIELDS`.
  - The dialog's "Fyll i alla fält igen" alert then matches the rule.
  - Over a readable row, a blank field still keeps its stored value.
- **A missing or rotated `CREDENTIALS_ENCRYPTION_KEY` makes every stored source unreadable at once.** They share one
  key, so this is a key event, not one source failing. The fix is to restore the key or re-enter the sources.
- **Name the wrong field when we can tell** (owner, same day). For example "the VIN is invalid", while the other
  fields show as fine.
  - **At save:** validation reports every invalid field at once, not just the first. `INVALID_FIELD` carries a
    list of field names. Each name shows on its own input.
  - **At sync:** the run maps a vendor's answer to the field it points at, where the answer allows it. The dialog
    and tile flag that field.

    | Source | Answer | Code | Flags |
    |---|---|---|---|
    | Škoda | 401 | `auth_failed` | `apiKey` (expired or wrong) |
    | Škoda | 404 | `forbidden` | `vin` (no car for that VIN) |
    | Škoda | 403 | `forbidden` | `apiKey` + `vin` together (the key isn't authorized for that car); can't tell which |
    | Zaptec | 400/401 at login, credentials rejected | `auth_failed` | `username` + `password` together (Zaptec doesn't say which) |
    | Zaptec | 400/401 at login, `unsupported_grant_type` (grant retired) | `auth_failed` | none: no field is wrong |
    | Emaldo | refused login | `auth_failed` | `user` + `password` |
    | Emaldo | answer we can't decode (often a rotated app key) | `unexpected_response` | `appId` + `appSecret` |

    Checked against the client code in the step 3 brainstorm (2026-10-05):
    - Škoda's 403 and 404 both map to `forbidden` (`skoda/client.ts`). Only the stored fields tell them apart.
    - An Emaldo login body is encrypted with the app secret, so a refused login can also mean a rotated app
      id/secret. The owner chose to flag `user` + `password` (the common cause). The run message still names the app
      id/secret. Flagging all four was rejected: it tells the admin nothing.

    Step 3a stores the suspect fields with the run, by name only, never a value (see below).

## Step 3 — credentials (two PRs, owner 2026-10-05)

Step 3 ships as **3a (server, no UI)** then **3b (UI)**. Each is reviewable in one sitting, and 3a's migration gets
its own schema review. The checkpoint runs after 3b.

## Step 3a — save rules, suspect fields, procedures (server only)

### Save rules (`services/integrationCredential`)
- **`INVALID_FIELD` lists every invalid field.** Validation checks every input before it throws; the error carries
  `fields: string[]` (names only, never values; an unknown name is still echoed only if it matches
  `/^[A-Za-z]{1,32}$/`, else `unknown`). The message lists the names.
- **New code `REENTER_ALL_FIELDS`.** Over an unreadable row, `set` requires every field of the source (non-blank).
  Otherwise the unsent fields would silently fall back to env. Over a readable row, a blank field still keeps its
  stored value. Checked inside the lock, after the row is read. Like `INVALID_FIELD`, it carries `data: { fields }`
  (the blank ones).
- **Check order:** unknown or invalid fields → `NOTHING_TO_SAVE` → `ENCRYPTION_KEY_MISSING` → (in the transaction)
  `REENTER_ALL_FIELDS`.

### Suspect fields (the run names the wrong field)
- `IntegrationError` gains an optional `suspectFields: readonly CredentialFieldName[]`: the credential field names
  the vendor's answer points at. `CredentialFieldName` is the union of every credential field name, so a typo fails
  to compile; the sync outcome and the read model use it too. Each client sets it per the [mapping table](#credentials-per-source-owner-decision-after-checkpoint-2),
  next to its existing status handling (the vendor knowledge stays in the client).
- `runPulledSync` records them in a new **`suspect_fields text[]`** column on both tables:
  - `integration_sync` (current health, read by the tile and dialog). It is written with every outcome and cleared
    on success, together with `error_code`. `nextRow` dedupes the list and turns an empty one into NULL.
  - `integration_sync_run` (history, so the history overlay can show it).
- CHECKs, on both tables: non-empty when set, and every name drawn from `CREDENTIAL_FIELD_NAMES`.
  - **No tie to `error_code` on `integration_sync`.** Older code (a Vercel instant rollback) clears the code on
    success and leaves this column, so such a CHECK would make its outcome write fail. The read model (`toHealth`)
    shows the field only while `error_code` is set.
  - `integration_sync_run` adds `suspect_fields IS NULL OR outcome <> 'ok'`. It is append-only, and older code
    inserts NULL.
  - Renaming or removing a field name needs an `array_replace` / `array_remove` data fix in the migration (see the
    comment in `src/lib/integrationCredentials.ts`).
- A run with no field to blame writes `NULL`, never `'{}'`.
- **Alternatives considered:** storing the HTTP status and mapping it in the UI (spreads vendor rules into the
  client); storing on `integration_sync` only (loses the history). Rejected.
- `suspectFields: CredentialFieldName[] | null` is in `adminDetail` (admins only), not top-level health.
  `RunRow.suspectFields` carries it per run (`recentRuns` is admin-only).

### Procedures — `src/lib/orpc/procedures/credentials.ts` (registered as `credentials`)
- `status`: `adminProcedure` (a read, but admin-only). Returns the service's `status()`.
- `set({ source, fields })`: `adminProcedure`, `.errors(credentialErrors)`.
  - Zod restricts `fields` to that source's field names: a discriminated union on `source`.
  - `INVALID_FIELD` and `REENTER_ALL_FIELDS` map with `data: { fields }`; `NOTHING_TO_SAVE` and
    `ENCRYPTION_KEY_MISSING` map without data.
  - HTTP status: `ENCRYPTION_KEY_MISSING` is 409, the other three are 422.
  - It logs `admin set integration credentials` with `{ source, fields: [names] }` and records the
    `credentialsSetMs` timing.
- `clear({ source })`: `adminProcedure`. It returns `{ cleared }` and logs the source only.
- An unexpected error is logged through `serializeError` (a `DrizzleQueryError` message carries the ciphertext
  parameter). `readStored` / `resolveCredentials` stay out of procedures and routes.

### Tests
- **Service:** `INVALID_FIELD` lists two bad fields at once; `REENTER_ALL_FIELDS` over an unreadable row with a field
  missing, and success with all of them; a blank field over a readable row still keeps its value.
- **Clients:** each mapping row sets its `fields` (and the Zaptec grant-retired case sets none).
- **Sync lifecycle:** suspect fields are written on failure, cleared on success, and recorded on the run.
- **Procedure:** a member gets `FORBIDDEN` on all three procedures; `set` never echoes values; Zod rejects a field of
  another source.

## Step 3b — credentials UI

### Settings page additions
- **A key icon button in the top-right corner** of each credential source's tile (Zaptec, Škoda, Emaldo; elpris has
  none). Owner, 2026-10-05: instead of a footer button.
  - A ghost icon button (`KeyRoundIcon`). Its accessible name and tooltip are "Inloggning för <source>". It is 44 px
    tall on coarse pointers, like the tile's other buttons.
  - The header reserves room on the right, so a long name never runs under it, in both the stacked (narrow) and the
    row (wide) header.
  - The footer keeps only sync and history.
- **Inline links in the tile's health message** open the same dialog:
  - `not_configured`: "Konfigurera" (sync is already hidden in that state);
  - `auth_failed`, `credentials_unreadable`, Škoda's `forbidden`, and any failure with stored suspect fields:
    "Uppdatera inloggning".
  - The suspect line ("<fields> fungerade inte vid senaste synken.") shows only alongside "Uppdatera inloggning".
  - Each link's accessible name names the source ("Uppdatera inloggning, Škoda").
- A new **"Elnätsavtal"** card holds the facility ID.
  - Status: "Anläggnings-ID sparat i appen" / "från miljövariabel" / "saknas – månadskollen hoppas över".
  - Next to the status: "Kontrolleras den 1:a varje månad".
  - The same key icon button in its top-right corner opens the dialog with `source=gridTariff`.
- **URL state** (ADR-0013): `?dialog=credentials&source=<credential source>`. The settings route's `source` param
  widens to `INTEGRATION_SOURCES ∪ CREDENTIAL_SOURCES`. A `syncRuns` link with `gridTariff` is cleaned like any
  other bad link.

### Credentials dialog (`CredentialsDialog.tsx`)
- A `ResponsiveDialog` with `useAppForm`, shaped like `TariffDialog`. No client-side Zod schema (as built): the
  server's `INVALID_FIELD` is the one source of format rules, and each listed field shows its own message.
- **Each field shows:**
  - its label;
  - its status line: "Sparad i appen · 5 okt" / "Från miljövariabel" / "Saknas" (superseded by Step 3c-1);
  - a red line "Fungerade inte vid senaste synken" when it is in the source's current `suspectFields`;
  - an input that is never pre-filled, with a namespaced id `credential-<source>-<field>`. `secret` fields use
    `type="password"` + `autoComplete="new-password"` (browsers ignore "off" there) and the password-manager
    opt-outs `data-1p-ignore`, `data-lpignore`, `data-bwignore`, `data-form-type="other"`; text inputs use
    `autoComplete="off"`.
- **Description text:**
  - "Lämna ett fält tomt för att behålla det som är sparat." (superseded by Step 3c-1)
  - For Škoda: a link to `https://go.skoda.eu/api-keys` and the line "Skapa nyckeln i MyŠkoda-appen och klistra in
    den här."
- **When the encryption key is missing** (`encryptionKeyConfigured: false`), the inputs are disabled and the dialog
  shows an alert: "Appen saknar CREDENTIALS_ENCRYPTION_KEY – uppgifter kan inte sparas."
- **When the stored row is unreadable**, an alert says: "De sparade uppgifterna går inte att läsa. Fyll i alla
  fält igen, eller ta bort dem." `REENTER_ALL_FIELDS` puts an error on each empty field.
- **"Spara":**
  1. Call `credentials.set`.
  2. On success, show the toast "Sparat", close the dialog, invalidate `credentials` and `evCharging`, and run
     `useSyncNow().syncSource(source)` for health-tracked sources.
  3. For `gridTariff`, nothing runs.

  `INVALID_FIELD` puts an error on each listed field; other errors show as a toast and keep the dialog open.
- **"Ta bort sparade uppgifter"** is shown only when something is stored. It opens a confirm (`AlertDialog`), then
  calls `credentials.clear` and runs the same sync.

### As built (decided in the build)
- **Grid card:** a fourth status, "Det sparade anläggnings-ID:t går inte att läsa"; its key button is named "Ändra
  anläggnings-ID".
- **Loading:** `credentials.status` is a critical read; the grid card sits in `SectionSkeleton name="charging-grid"`
  (ADR-0025). The dialog opens once the status has loaded or failed, never on a guess.
- **After "Ta bort sparade uppgifter"** the dialog closes. The page runs the sync (not the dialog), so the tile's
  "Synkar…" follows it.
- **Focus:** closing returns focus to the key button `#credentials-<source>`. The dialog can't be dismissed while a
  save or remove is in flight. With the key missing, focus starts on the footer's cancel ("Stäng" when every field is
  closed, "Avbryt" otherwise).
- **The stored date shows the year:** "Sparad i appen · 5 okt. 2026" (superseded by Step 3c-1).
- **Stale suspect fields are hidden:** they count (tile line, dialog field line) only while the health's
  `lastAttemptAt` is not older than the source's `credentials.status` `updatedAt` (no stored row or status unknown →
  they count). After a save the red lines disappear until the next sync outcome is recorded, so a blame from before
  the save never shows while no newer outcome exists (the post-save sync never fired, or its lease holder died).
  `lastAttemptAt` is when the outcome was recorded, not when the run started: a run that read the old values (one
  already holding the lease, or a warm instance's 60 s cached row) and records after the save can still flag fields
  for one cycle. The row has one `updatedAt` for all fields, so a partial save (e.g. only the API key) also hides a
  blamed field it didn't touch, until the next outcome. The "Uppdatera inloggning" link is unchanged
  (`currentSuspectFields` in `credentialLink.ts`).

### Overview links
`SyncHealthAlert` for `auth_failed` / `credentials_unreadable` / Škoda `forbidden`, and `CredentialExpiryAlert`,
link straight to `/charging/settings?dialog=credentials&source=<source>`; `CredentialExpiryAlert`'s link reads
"Byt nyckel". In step 1 they link to the page.

### Copy and docs
- **Key-expiry email and warning.** `email_credential_expiry_body`, `charging_skoda_key_expiring_body*` and the
  matching en keys say "klistra in den nya nyckeln under Laddning → Inställningar" instead of "byt SKODA_API_KEY i
  Vercel och gör en ny deploy". The email test's `SKODA_API_KEY` assertion changes with them.
- **Runbook** `docs/runbooks/skoda-api-key.md`: the GUI is the primary path, and env is the fallback.
- **Config docs** landed in step 2 (`.env.example` with `CREDENTIALS_ENCRYPTION_KEY` and the GUI override, the
  CLAUDE.md env list and code map, the ADR-0019 pointer to ADR-0026). Step 3 updates them only for what it adds.

### Tests
- **Browser, `CredentialsDialog`:**
  - statuses render, and a suspect field shows its red line;
  - inputs are empty;
  - a blank submit is refused;
  - save then sync is called;
  - `INVALID_FIELD` lands on each listed field; `REENTER_ALL_FIELDS` on the empty ones;
  - the missing-key and unreadable states;
  - remove asks for confirmation.
- **Browser, settings route:** the key buttons (names, none on elpris), the `not_configured` "Konfigurera" link, the
  grid card, and the `dialog=credentials` deep link and its cleanup.
- **Live** (Phase 6), at desktop, tablet and mobile widths.

## Step 3c — credentials UX (two PRs, owner 2026-10-06)

The owner reviewed the 3b dialog after it merged (#102):
- The grey status line under an empty input ("Från miljövariabel") reads like an error.
- Typing "lat,lon" by hand is the wrong input for a position.
- The VIN is easier to find in the MyŠkoda app than in the registration certificate.

Research behind this section (2026-10-06):
- Write-only values in admin UIs: Grafana's `SecretInput` ("configured" + Reset), GitHub Actions secrets, Stripe
  keys, Vercel sensitive env vars. Field anatomy follows GOV.UK, Carbon and Atlassian: hint above the input, the space
  below the input is for errors, no state in placeholders.
- Map libraries, tile hosts and geocoders: the alternatives are listed under "Alternatives considered" in "3c-2" below.

Owner decisions (2026-10-06 brainstorm):

| Question | Decision |
|---|---|
| How a field shows its origin | **Badge + Byt.** A set field shows no input until "Byt" / "Ange i appen" reveals it. "Ta bort sparade uppgifter" stays per source; no per-field remove. |
| Map stack | **MapLibre GL v6 + OpenFreeMap tiles**, with address search through **Nominatim, proxied by our server**. |
| Show the saved pin | **Yes, to admins.** The home position is the one credential value the server returns (ADR-0026 amendment, 2026-10-06). |
| "Använd min position" | **Yes.** `Permissions-Policy` changes from `geolocation=()` to `geolocation=(self)`. |
| Slicing | **3c-1** field states and copy (UI only), then **3c-2** the map picker (dependencies, server reads, ADR amendment). |

### 3c-1 — field states and copy (UI only)

On phones the dialog keeps ADR-0013's bottom sheet. Whether keyboard-heavy forms like this one (and the 3c-2 map)
should go full-screen is [issue #107](https://github.com/ljukas/videbacken/issues/107), kept out of step 3c.

Each field row is its label with a neutral badge, then a body that depends on the field's origin. The badge is real
text, so the state never relies on colour alone.

| Origin | Badge (sv / en) | Body |
|---|---|---|
| `stored` | "Sparad" / "Saved" | "Sparad i appen {date}" / "Saved in the app {date}" and a **Byt** / **Replace** button |
| `env` | "Miljövariabel" / "Environment variable" | "Används från `{ENV_VAR}`" / "Using `{ENV_VAR}`" and an **Ange i appen** / **Set in the app** button |
| `missing` | "Inte angiven" / "Not set" | the input, shown directly |
| source unreadable | "Går inte att läsa" / "Can't be read" (amber, with an icon) | the input, shown directly |

- **Every `env` field names its variable**, for every source: Zaptec (`ZAPTEC_USERNAME`, `ZAPTEC_PASSWORD`), Škoda,
  Emaldo (the four `EMALDO_*`) and the grid card's facility ID (`GRID_FACILITY_ID`) (owner, 2026-10-06).
- **The home position's button speaks of the map** (owner, 2026-10-06): "Välj på kartan" / "Choose on the map" for
  `env` and `missing`, and "Ändra på kartan" / "Change on the map" for `stored`. In 3c-1, before the picker exists,
  the button opens the "lat,lon" input and keeps the same label. In 3c-2 it opens the picker. A *missing* home
  position shows the input directly in 3c-1; 3c-2 decides how a missing position reaches the picker (likely the same
  "Välj på kartan" button).
- **Footer** (from the mockup): with no field open, the footer shows "Stäng" and a disabled "Spara"; once a field is
  open, it shows "Avbryt" and an enabled "Spara".
- **The remove confirm names the stored fields** ("De sparade uppgifterna för Škoda (API-nyckel och VIN) tas
  bort."); an unreadable source is named without fields.
- **The env var name** comes from one client-safe map, `CREDENTIAL_ENV_VARS` in `integrationCredentials.ts`
  (vocabulary only: names, never values). The server-only `src/lib/credentials/env.ts` reads `process.env` through it.
- **"Byt" / "Ange i appen"** reveals the input and focuses it, with an "Avbryt" / "Cancel" link that hides it again
  and clears what was typed.
  - The hint sits between the label and the input: "Det nuvarande värdet används tills du sparar." / "The current
    value stays in use until you save."
  - For an `env` field, add: "Ett värde som sparas här går före miljövariabeln." / "A value saved here overrides the
    environment variable."
  - A field's format hint (VIN, coordinates, facility ID) also moves above the input.
  - Each button has its own accessible name, "{action}, {field}": "Byt, VIN" / "Replace, VIN".
- **Only open inputs are submitted.** A hidden field keeps its value, so the dialog-level "Lämna ett fält tomt för
  att behålla det som är sparat" line goes away. "Spara" with nothing open, or only empty open inputs, is refused as
  today ("Fyll i minst ett fält").
- **An unreadable source** shows every input open. The existing alert stays above the fields.
- **Server field errors** (`INVALID_FIELD`, `REENTER_ALL_FIELDS`) open the named field if it is closed, then show the
  error below its input. Red text and borders stay reserved for errors.
- **The suspect line** ("Fungerade inte vid senaste synken") stays under the badge row, in red text, as today.
- **"Ta bort sparade uppgifter"** stays per source. Its confirm adds what happens next, judged over the required
  fields (all but Škoda's optional home position):
  - every required field has an env value (`envSet`): "Appen använder miljövariablerna igen." / "The app falls back to
    the environment variables." (grid: "…miljövariabeln igen.");
  - some do: "Miljövariablerna räcker inte, så källan slutar synka." / "The environment variables are not enough, so
    the source stops syncing.";
  - none: "Källan slutar synka." / "This source stops syncing." (grid: "Månadskollen hoppas över.");
  - an unreadable source gets the source-only sentence, plus the consequence line.
- **VIN hint:** "17 tecken (inte I, O eller Q). Finns i MyŠkoda-appen under Inspect → Car details." /
  "17 characters (no I, O or Q). In the MyŠkoda app under Inspect → Car details." (owner, 2026-10-06; the app's
  own English menu names, kept verbatim in both languages).
- **Tests (browser, `CredentialsDialog`):**
  - each origin renders its badge and body;
  - "Byt" reveals and focuses the input, and "Avbryt" hides it and clears it;
  - only open inputs are sent;
  - a server field error opens a closed field;
  - an unreadable source opens every field;
  - the remove confirm's three outcomes, and the unreadable sentence;
  - the env var name shown for an `env` field.
- **Live check:** at desktop, tablet and mobile widths.

**As built (3c-1):**

- Action buttons are named "{action}, {field}" (WCAG 2.5.3, label in name).
- `status` returns `envSet`; the client reads env var names from `CREDENTIAL_ENV_VARS`.
- The remove confirm's consequence covers the required fields (all but Škoda's optional home position) with three
  outcomes: falls back to the environment variables; "Miljövariablerna räcker inte, så källan slutar synka."; stops
  syncing. An unreadable source gets a source-only sentence. The consequence is part of the dialog's accessible
  description.
- The unreadable badge reads "Går inte att läsa" / "Can't be read".
- The open input's description starts with its state badge. Only open inputs are sent. With every field closed,
  focus starts on the first reveal button.
- `TextField` gained optional `labelledBy` and `descriptionPlacement` props; other forms are unchanged.
- The grid card's `env` status names `GRID_FACILITY_ID` in a `code` element.
- The dialog has a per-source description (`charging_credentials_dialog_description` / `_grid`: "Uppgifterna som
  Videbacken använder för att hämta data från {source}."), which replaced "Lämna ett fält tomt…".
- A field without a value (missing, unreadable) joins the open set and stays open until "Avbryt", so a status
  refetch that gives it a value never hides its typing. A reveal ("Byt" / "Ange i appen") always starts empty.

### 3c-2 — the home-position map picker

The Škoda "Laddboxens position" field's "Byt" opens a picker instead of a text input.

- **Saved pin.** `credentials.homePosition` (`adminProcedure`) returns `{ lat, lon }` or `null`.
  - The value is the stored one, else the env one, parsed with `parseHomePoint`. The service owns the read (ADR-0002);
    the procedure stays thin.
  - An unreadable Škoda row returns a typed `UNREADABLE` error and the picker opens on the default view.
  - The client fetches it only when the Škoda dialog opens, so it never lands in the server-rendered HTML or the
    dehydrated cache. It uses `gcTime: 0`.
  - It is never logged, and the timing line carries no value.
- **Address search.** `credentials.searchAddress({ query })` (`adminProcedure`) returns up to 5
  `{ label, lat, lon }`.
  - It goes through a new keyless effect, `src/lib/effects/geocoder/`, with a Nominatim adapter shaped like
    `effects/eltariff`. It uses `effects/http.ts` (timeout and retries) and fails closed with `GEOCODER_UNAVAILABLE`.
  - Request parameters: `countrycodes=se`, `accept-language=sv`, `limit=5`, a distinctive `User-Agent`.
  - It is throttled to 1 request/s per instance and keeps a small in-memory cache (10 min) of results.
  - The query and the results are never logged; log lines carry only the outcome and the timing.
  - The search runs on submit ("Sök"), never as the admin types: Nominatim's policy forbids autocomplete.
- **Picker component** (`HomePositionPicker`). The form value stays the same `"lat,lon"` string, so the server's
  validation is unchanged.
  - A search box with "Sök", and a list of up to 5 hits; picking one moves the pin.
  - A map about 260 px tall: `maplibre-gl` v6 through `@vis.gl/react-maplibre`.
    - It is lazy-loaded and wrapped in TanStack Router's `<ClientOnly>`, so nothing loads until the picker opens.
    - It uses OpenFreeMap's `liberty` style.
    - On touch pointers it uses `cooperativeGestures`, so one finger still scrolls the bottom sheet.
    - The OpenFreeMap / OpenStreetMap attribution stays visible, in compact form.
  - A draggable pin that the keyboard can also move. Clicking the map moves the pin there.
  - "Använd min position" / "Use my location" (`navigator.geolocation`): it centres the map and moves the pin there.
  - A "lat, lon" text input synced both ways with the pin, as the keyboard and screen-reader alternative.
  - The chosen point is announced in a polite live region. Coordinates are rounded to 5 decimals (about 1 m).
  - It opens on the saved pin; with none, on Sweden at country zoom.
- **Config.**
  - Vite: `optimizeDeps.exclude: ['maplibre-gl']` and the worker URL (`setWorkerUrl`), checked in both
    `vite dev` and `vite build`.
  - `Permissions-Policy: geolocation=(self)`.
- **Failure behaviour:**

  | Situation | Behaviour |
  |---|---|
  | Geocoder down or rate-limited | An inline "Adressökningen fungerar inte just nu"; the map and the text input still work. |
  | No WebGL2 | The map is replaced by a note, and the text input remains. |
  | Location denied or unavailable | An inline message; nothing else changes. |
  | Tiles fail to load | The map shows the pin on a blank background; the text input remains. |

- **Tests:**
  - unit tests for parsing and rounding;
  - service and procedure tests for `homePosition`: a member gets `FORBIDDEN`, an unreadable row gives `UNREADABLE`,
    and a log spy proves the value is never logged;
  - geocoder adapter tests with `effects/testing/fakeFetch`: the parameters, the `User-Agent`, the throttle, the
    cache, and failing closed;
  - `searchAddress` procedure tests;
  - browser tests with the map module mocked: search → pick, the text input ↔ pin sync, the geolocation button, and
    the fallbacks;
  - the real map checked live at three widths, including a phone-sized bottom sheet.
- **Privacy notes:**
  - Proxying the search hides the admin's IP and browser from the geocoder, but the address text still reaches
    OpenStreetMap's servers.
  - The tile host sees roughly which area is viewed, and the admin's IP.
  - There is no reverse geocoding of the chosen point.
- **Alternatives considered** (research, 2026-10-06):
  - map: Leaflet with OSM raster tiles, pigeon-maps;
  - geocoder: Photon, Lantmäteriet, keyed free tiers;
  - tiles: keyed tiers.

## Error handling summary

| Situation | Behaviour |
|---|---|
| Key unset, no stored rows | Everything runs from env, as today. The dialog says saving is unavailable. |
| Key unset or wrong, a row stored | That source fails closed with `credentials_unreadable`, is alerted, and its tile links to the dialog. |
| Saved a bad key | The post-save sync fails with `auth_failed`, the tile shows it, and the admin pastes again. |
| Sync already running at save | The run is `skipped` by the lease. The next cron run (or "Synka nu") uses the new value. |
| Another warm instance | Picks up the new value within 60 s (resolver TTL). |
