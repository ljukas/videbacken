# ADR 0026 — Integration Credential Store

- **Status**: Accepted
- **Date**: 2026-10-05
- **Deciders**: Lukas
- **Decision in one line**: Admins set the pulled integrations' credentials from the GUI. They are stored
  AES-256-GCM-encrypted in our own Postgres under a dedicated `CREDENTIALS_ENCRYPTION_KEY`, override the env vars
  field by field, and take effect on the next call without a redeploy.

**Spec**: [charging settings design](../superpowers/specs/2026-10-05-charging-settings-design.md).
**Roadmap**: [charging settings roadmap](../superpowers/roadmaps/2026-10-05-charging-settings.md).
**Builds on**: [ADR-0019](./0019-external-data-integrations.md) (fail closed, health tracking),
[ADR-0022](./0022-live-vehicle-state-attribution.md) (Škoda key, geofence),
[ADR-0023](./0023-solar-aware-charging-cost.md) (Emaldo credentials).

---

## Context

Every pulled integration reads its credentials from env vars:
- Zaptec: `ZAPTEC_USERNAME`, `ZAPTEC_PASSWORD`.
- Škoda: `SKODA_API_KEY`, `SKODA_VIN`, `SKODA_HOME_COORDINATES`.
- Emaldo: `EMALDO_USER`, `EMALDO_PASSWORD`, `EMALDO_APP_ID`, `EMALDO_APP_SECRET`.
- The grid tariff watcher: `GRID_FACILITY_ID`.

Each adapter selects its client once per process (`lazy()`). An env var only changes with a new deployment.

Some of these credentials expire or rotate:
- The Škoda key lasts about six months.
- The Emaldo app id and secret come from the Emaldo Android app and can change.

Renewing one today means: create the key, open Vercel, edit a Production env var, redeploy, wait, then sync. The
owner wants to paste the new key into the app and be done.

## Decision

1. **One encrypted row per credential owner** in a new `integration_credential` table, keyed by `source`
   (`zaptec`, `skoda`, `emaldo`, `gridTariff`).
   - The source's fields are one JSON object, encrypted with AES-256-GCM (`node:crypto`).
   - A fresh 12-byte IV is used for every write, and the source name is the additional authenticated data (AAD).
   - Stored as the envelope `v1.<iv>.<tag>.<ciphertext>` (base64url parts), so a later key rotation can add `v2`
     without a schema change.
   - Plaintext metadata: the *names* of the fields set, `updated_at`, and `updated_by`. Values never.
2. **A dedicated key**, `CREDENTIALS_ENCRYPTION_KEY`: 32 random bytes, base64, set once per Vercel environment.
   It is deliberately not derived from `BETTER_AUTH_SECRET`, so rotating the auth secret can't make every stored
   credential unreadable.
3. **Per-field precedence: stored value, then env var, then missing.**
   - Pasting only a new Škoda key keeps the VIN from env.
   - Env-only setups keep working unchanged, and env stays the documented fallback.
4. **Fail closed** (ADR-0019).
   - If a stored row exists but can't be decrypted (key missing, wrong key, tampering), that source fails with a new
     health code, `credentials_unreadable`. It never falls back to a possibly stale env value.
   - With no stored row, a missing key changes nothing.
   - Saving without a key is refused (`ENCRYPTION_KEY_MISSING`).
5. **Resolved per call, rebuilt only on change.**
   - `resolveCredentials(source)` merges stored values over env and returns the values plus a fingerprint, a hash of
     the values.
   - The adapter facades replace `lazy()` with a cache keyed on that fingerprint. Unchanged credentials reuse the
     same client, which keeps the Zaptec and Emaldo token caches, so Emaldo doesn't re-login and end its other
     sessions on every call.
   - The stored read is cached in memory for 60 s (env is merged on every call; see the amendment). A save
     invalidates it on the saving instance, so the post-save sync uses the new value at once; other warm instances
     follow within 60 s.
6. **Admin-only, write-only.**
   - Procedures return each field's *origin* (`stored` / `env` / `missing`) and when it was stored. They never
     return a value, not even masked.
   - …and whether its env var is set (`envSet`, a boolean, so the remove confirm can say what happens next). Never
     a value. Env var *names* live in the client-safe `CREDENTIAL_ENV_VARS`.
   - Logs carry the source and field names only.
7. **Encryption is not an effect.** It is a pure in-process transform, so it lives in a server-only
   `src/lib/credentials/` module. Only `services/integrationCredential/` touches the table (ADR-0002).

## Alternatives considered

- **Supabase Vault (`pgsodium`).** Supabase would hold the key, but local and CI run plain `postgres:17-alpine`
  without the extension. That means either a different local image or a second code path, which breaks the
  local/prod parity the tests rely on. Rejected.
- **Write the env var through the Vercel API, then redeploy.** It still redeploys (about 2 minutes), which is the
  pain being removed. It also needs a Vercel token with project-write scope stored inside the app, a far larger
  blast radius than one integration key. Rejected.
- **Plaintext in the database, relying on RLS and DB access control.** A database dump, a backup or a read-only
  `SELECT` (which the owner allows on prod for verification) would expose live credentials. Rejected.
- **Whole-source precedence** (a stored row replaces all of that source's env vars). It's simpler, but renewing only
  the Škoda key would then drop the VIN and home point unless they were re-entered. Rejected in favour of per field.
- **Test the credentials before saving.** It needs a separate probe path per client, and an Emaldo login ends the
  running sync's session anyway. Instead, saving runs that source's sync once and its health shows the result
  within seconds. Rejected for now.

## Consequences

- Renewing the Škoda key is: phone → copy → paste → save. No deploy.
- **One more env var per environment.** Without it, the GUI can't store credentials, but nothing else changes.
- Losing `CREDENTIALS_ENCRYPTION_KEY` makes stored credentials unreadable. The sources fail closed with
  `credentials_unreadable`, and the fix is to re-enter them (or restore the key).
- Each Vercel environment has its own database, so credentials stored in Preview never reach Production. The
  "Škoda and Emaldo in Production only" rule (shared VIN quota, Emaldo session kicking) now also means: don't store
  them in Preview.
- `integration_sync`'s error-code CHECK gains `credentials_unreadable`. That is a migration, so it gets the schema
  review.
- Removing or renaming a field in `CREDENTIAL_FIELDS` makes every stored row that holds it unreadable (fail closed).
  Such a change needs re-entry or a data migration.
- Rollback: once the new code has recorded `credentials_unreadable`, an instant rollback to older code shows that
  row's code without copy. It is display-only.

## Amendment (2026-10-05): as built in step 2

The build refined the decision in these places. The [spec](../superpowers/specs/2026-10-05-charging-settings-design.md)
has the same corrections inline.

**Schema** (`drizzle/0018_integration_credential.sql`):
- `updated_by` is `uuid`, because `user.id` is a uuid. Its FK is `on delete set null`. It has no index: the table
  holds at most 4 rows.
- The ciphertext CHECK is version-agnostic: `^v[1-9][0-9]*[.]` followed by three base64url parts, plus
  `char_length(ciphertext) <= 16384`. A `v2` envelope needs no schema change.
- `fields_set` is display-only metadata. The service validates it; there is no per-element CHECK. Resolution never
  trusts it, only the decrypted object.
- RLS is on with no policies; the app connects as the table owner. Revoking the `anon` and `authenticated` grants
  was considered and skipped, since the values are encrypted anyway.

**Saving** (`services/integrationCredential`):
- `set` serializes per source. Its transaction (default READ COMMITTED) first runs
  `pg_advisory_xact_lock(hashtext('videbacken.integration_credential:' || source))`, then `SELECT … FOR UPDATE`.
- The lock is needed because `FOR UPDATE` can't lock a row that doesn't exist yet. Without it, two concurrent first
  saves for one source would each merge over nothing, and the later upsert would drop the earlier fields.
- `set` and `clear` invalidate the cache in a `finally`. A COMMIT that succeeded on the server but errored on the
  client must still drop the cached read.
- Validation also rejects ASCII control characters. An unknown field name is echoed in `INVALID_FIELD` only if it
  matches `/^[A-Za-z]{1,32}$/`; otherwise the error names it `unknown`.

**Resolving** (`src/lib/credentials/`):
- Only the stored read is cached (60 s). A rejected read is not cached. Env is merged on every call: it is free, and
  it keeps test env stubs live.
- The fingerprint is an unsalted hash of low-entropy values. It is an in-memory cache key only, never logged or
  returned.

**Adapters** (`src/lib/effects/keyedAdapter.ts`):
- `keyedAdapter` replaces `lazy()` for Zaptec, Škoda and Emaldo.
- Its cache holds one entry. A resolve still in flight from before a save can finish last. That one call then uses
  the just-superseded credentials: one more vendor call with a revoked secret (for Emaldo, a refused login that
  sets the stale client's `loginBlock`). Its client also overwrites the newer entry, costing one extra rebuild
  (for Emaldo, one extra login). The next call resolves the new values and settles it. Accepted.
- Under VITEST it returns not-configured before it imports the resolver. The import is dynamic, which keeps `db` out
  of the facades' module graph.
- Decrypting fails with a plain `CredentialsUnreadableError` (crypto layer). `keyedAdapter` maps it to the source's
  own `IntegrationError` with `credentials_unreadable`, so `runPulledSync` records it instead of `internal_error`.
- Effects reach the credential service only through the resolver, and only to read (an ADR-0001 note).

**Home point and facility ID:**
- The Škoda home point is resolved inside the run (`execute`, before the client call), not before `runPulledSync`.
  One run is one log line: the cron handler doesn't log, so a resolve error outside the run (DB down) would be a
  500 with no line, outside the lease and deadline. Inside, it is recorded as `internal_error`.
- `init` sets `geofence` from an injected home point only; `execute` sets it from the resolved one.
- An unreadable Škoda row makes the home point `null` (geofence off), while the client call fails the run as
  `credentials_unreadable`.
- The grid watcher reads `facilityId` through the resolver. An unreadable row is `failed` / `credentials_unreadable`,
  nothing is fetched, and the run line logs at error.

## Amendment (2026-10-05): step 3 brainstorm

The [spec](../superpowers/specs/2026-10-05-charging-settings-design.md) has the detail ("Credentials per source",
"Step 3a", "Step 3b").

- **Per source, all fields together.** A save over an unreadable row must fill every field of that source
  (`REENTER_ALL_FIELDS`); otherwise the unsent fields would silently fall back to env. Over a readable row, a blank
  field keeps its stored value, as before.
- **Name the wrong field.** `INVALID_FIELD` lists every invalid field at once. A failed sync stores the credential
  field names the vendor's answer points at (`suspect_fields text[]` on `integration_sync` and
  `integration_sync_run`, names only). Each client sets them from its own status handling. Storing the HTTP status
  and mapping it in the UI was rejected: it spreads vendor rules into the client.
- **`suspect_fields` has no tie to `error_code`.** Older code (a Vercel instant rollback) clears the code on success
  and leaves the column, so such a CHECK would make its outcome write fail. The CHECKs only require non-empty names
  from `CREDENTIAL_FIELD_NAMES` (plus `outcome <> 'ok'` on the append-only run table); the read model shows the field
  only while `error_code` is set.
- **A refused Emaldo login flags `user` + `password`**, even though a rotated app secret (which encrypts the login
  body) can cause it too. The run message names both causes.
- **Step 3 ships as two PRs:** 3a (server) and 3b (UI).

## Amendment (2026-10-06): the home position is shown to admins

The owner asked for a map picker for the Škoda home position (spec "Step 3c"). A picker that can't show the saved pin
is a guess every time. So decision 6 ("write-only") gets **one exception**: `credentials.homePosition` returns the
resolved home point (stored, else env) to admins.
- **Every other field stays write-only**, including the facility ID and every secret.
- **An unreadable Škoda row returns `UNREADABLE`**, never the env value (decision 4).
- **The value never reaches the server-rendered HTML**, because the client fetches it only when the Škoda dialog
  opens, never in a loader. (Step 3c-2 narrowed this to when the picker opens: see the as-built amendment below.) Separately, `gcTime: 0` limits how long it stays in the client cache. It is never logged.
- **Why this one:** it is the household's own address, shown only to its admins, who already know it. A key, a
  password or the facility ID gives access to something. A pin on a map gives nothing beyond what the admin already
  knows.
- **Alternatives rejected:**
  - Keep it write-only, so the map always opens on a default view.
  - Return a rounded area (about 1 km), which leaves a rule to explain for little gain.
- **Cost, accepted:** a stolen admin session or an XSS can now read the household's position; write-only prevented
  that.
- **Address search** goes to Nominatim (OpenStreetMap), proxied by our server (see the 3c-2 amendment below).
  The address text itself reaches OpenStreetMap's servers; the admin's IP and browser do not. There is no reverse
  geocoding of the chosen point.

## Amendment (2026-10-06): as built in step 3c-2

**Home position read:**
- `credentials.homePosition` returns `{ latitude, longitude } | null`, the shape the geofence uses.
- The service reads the stored row, else `SKODA_HOME_COORDINATES`. It does not use the resolver's 60 s cache.
- An unreadable row is the domain code `UNREADABLE` (409), never the env value.
- The client fetches it only while the picker is open and enabled, not when the Škoda dialog opens. It uses
  `gcTime: 0`, no retry and no refocus refetch. The timing line carries only `homePositionMs`.

**Seeding:**
- The picker seeds the form value with the saved pin, rounded to 5 decimals, unless the admin already picked.
- So "Spara" with the picker open re-saves that point. For an env pin, that moves it into the app.
- Accepted: the hint "Ett värde som sparas här går före miljövariabeln" says so.

**Address search** (`credentials.searchAddress` → `effects/geocoder`, Nominatim):
- The query is trimmed, 2–200 characters. The result is up to 5 `{ label, latitude, longitude }`.
- It sends `countrycodes=se`, `accept-language=sv`, `limit=5` and a distinctive `User-Agent`.
- It is throttled to 1 request/s per instance. A search that would wait more than 3 s for its slot fails fast as
  `rate_limited`. An aborted search releases its slot.
- **No retries.** A retry inside `fetchWithRetry` would bypass the 1 req/s slot. The admin's next "Sök" is the retry.
- Results are cached in memory for 10 min, at most 100 queries. A cache hit takes no slot. Failures are not cached.
- Any failure is `GEOCODER_UNAVAILABLE` (503).
- The handler logs an outage once, at warn, with only the geocoder code. Success logs at debug with the hit count
  and the cached flag. The query and the results are never logged.
- **`logRpcError` grading changed.** A *defined* `ORPCError` (declared in `.errors()`, thrown via `errors.X()`) is
  an expected outcome (info `rpc rejected`) whatever its status. Undefined 5xx errors and unknown throws stay at
  error. `GEOCODER_UNAVAILABLE` is the first declared 5xx, so a future declared 5xx must log its own warn.

**Browser permissions:**
- `Permissions-Policy` is now `camera=(), microphone=(), geolocation=(self)`, for "Använd min position".

**The map:**
- It is `maplibre-gl` 6 with `@vis.gl/react-maplibre` and OpenFreeMap `liberty`, in one lazy chunk (about 288 KB gz).
  Only modules that show a map load it.
- Without WebGL2, or if the chunk fails to load, a note replaces the map. Search and the coordinates input remain.

**Missing position:**
- Owner, 2026-10-06: a missing home position starts closed, with the badge "Inte angiven", the line "Används för
  att se om bilen står hemma." and a "Välj på kartan" button.
- Admin reads of the position are still covered by the pre-existing #101: a demoted admin keeps admin rights for
  about 300 s through the Better Auth cookie cache.
