# EV charging — live attribution from the Škoda API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Poll the official MyŠkoda Public API every 15 min, store each poll, attribute sessions after the exported
log as ours/guest by the majority of known time, and remind admins before the API key expires.

**Architecture:** A new pulled source `skoda` on the shared `runPulledSync` lifecycle (ADR-0019) writes one
`vehicle_state_snapshot` row per poll; `reattributeSessions` gains a second branch (after the export's coverage)
that reads those rows through an index-bounded `LATERAL` per session window; `integration_sync` gains generic
credential-expiry columns that drive an admin warning and 30/7-day reminder emails. Three stacked PRs:
collect → attribute → remind.

**Tech Stack:** TanStack Start, oRPC, Drizzle 0.45 (pg), zod 4, ky (`effects/http.ts`), React Email, date-fns 4 +
`@date-fns/tz`, Paraglide, Vitest (node + browser).

**Spec:** `docs/superpowers/specs/2026-10-02-ev-charging-live-attribution-design.md` · **ADR:** `docs/adr/0022-live-vehicle-state-attribution.md`

**Revision:** v2 after six adversarial plan reviews (database, rule/services, integration backend, frontend,
email/queue, security). Owner rulings 2026-10-02: sessions under 40 min stay undecided; keep every poll and set
retention in Phase 6 (privacy section in ADR-0022); Škoda failures email after 3 in a row.

## Global Constraints

- All DB access through `src/lib/services/<entity>/` (ADR-0002); every `pgTable(...)` ends with `.enableRLS()`.
- Every timestamp column `timestamp(..., { withTimezone: true })`.
- Never `console.*`; log via `~/lib/logger` (server: `logger` / injected `log`).
- **Never store, log, return to the client, or commit**: GPS coordinates, address, licence plate, the API key, the
  VIN, `SKODA_HOME_COORDINATES`. **Never log presence**: no `plugState`, `atHome`, `parkingState` in any log line.
  Error messages never echo payload values (field paths only); API-supplied strings are logged only if they match
  `/^[A-Z_]{1,64}$/`.
- Client code imports only **types** from services, and preferably uses `RouterOutputs[...]` types.
- Pulled sources have **no devLog/fake adapter**; unset `SKODA_API_KEY` or `SKODA_VIN` → `not_configured`.
- Rule constants: `HOME_RADIUS_M = 150`; window margin **10 min** each end; decide only sessions **≥ 40 min**
  (window ≥ 20 min); a poll's state holds until the next poll, **≤ 20 min**; decide when known time ≥ **½** the
  window; tie → ours; skip sessions with `reliable_clock = false`; decided rows get `vehicle_source = 'skoda_live'`.
- Precedence: admin > exported log (inside its coverage) > live snapshots > default.
- Cron **`7,22,37,52 * * * *`** at `/api/cron/skoda-sync` (offset from Zaptec's `0 * * * *` so the two re-matches don't
  collide), `CRON_SECRET`-gated via `handleCronRun`.
- `STALE_AFTER_MS.skoda = 1 h`; `ALERT_AFTER_FAILURES.skoda = 3` (zaptec/elpris 1). Reminder thresholds **30** and
  **7** days; admin warning from **30** days while the source is healthy.
- Škoda HTTP: retry only 502/503/504/network/timeouts, **at most 1 retry** (quota is 20/h per VIN, errors count).
- User-facing strings in `messages/sv.json` (source of truth) **and** `messages/en.json` (key-complete).
- **Migrations are frozen once pushed.** Get migration-guard + schema-design approval before the first push of a PR
  that adds one; a later fix is a new migration, never an edited/regenerated one (Preview's DB applies by journal
  timestamp).
- Env vars `SKODA_*` go in Vercel **Production only**: Preview has its own database, but would share the VIN's
  20 req/h quota. Local live testing also uses that quota.
- Conventional Commits, ≤ 72 chars, one hat per commit; end every commit message with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Tests need the local DB: `bun run db:up && bun run db:migrate`.

## Review Focus

1. **Stale `CONNECTED` after an unplug** (≈27 min observed) at the start of a long guest session must still come out
   guest — Task 9 ("stale CONNECTED at the start of a long guest session").
2. **A polling outage mid-session** must leave the session unchanged, never guest — Task 9 ("a long gap between polls
   is not bridged", "an unknown poll ends the previous poll's interval", "known time under half").
3. **API drift in one part** (a malformed `parkingPosition`, a fractional SoC, a null leaf) must not fail the poll —
   Task 2 ("a malformed part is dropped, the rest kept") + Task 6.
4. **The rule must stay fast as polls accumulate** (≈35k/yr) — Task 9's `LATERAL` bound + "polls far outside the
   window do not change the result".
5. **A renewed key** resets the reminders and clears the warning; **a reminder that couldn't be sent is retried**; a
   duplicate run never claims twice — Tasks 12 and 14.

---

# PR 1 — `feat(charging): poll the Škoda API for the car's state`

Branch `feat/skoda-state-poll` (this worktree; spec, ADR and this plan already committed).

### Task 1: `vehicle_state_snapshot` schema + migration

**Reviewers:** `migration-guard` + schema-design reviewer (`general-purpose`, loads `supabase-postgres-best-practices`,
judges against Task 9's per-window `LATERAL` range scan on `polled_at`, Task 4's insert and latest-by-`polled_at`).

**Files:**
- Create: `src/lib/db/schema/vehicleState.ts`
- Modify: `src/lib/db/schema/index.ts`
- Create (generated): `drizzle/0009_vehicle_state_snapshot.sql`, `drizzle/meta/*`

**Interfaces:**
- Produces: `vehicleStateSnapshot` table; `VEHICLE_STATE_TEXT_MAX = 64`.

- [ ] **Step 1: Write the schema**

```ts
// src/lib/db/schema/vehicleState.ts
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

/** Raw API strings are capped so API drift can't write megabytes. */
export const VEHICLE_STATE_TEXT_MAX = 64
const textMax = sql.raw(String(VEHICLE_STATE_TEXT_MAX))

// One row per poll of the MyŠkoda Public API (ADR-0022): what the car's latest
// reports said when we asked. Append-only (no updated_at, like
// integration_sync_run). A household presence history: never GPS, address or
// plate — `at_home` is the only trace of the position — and never exposed raw
// beyond the admin "latest" read (ADR-0022, Privacy).
export const vehicleStateSnapshot = pgTable(
  'vehicle_state_snapshot',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    polledAt: timestamp('polled_at', { withTimezone: true }).notNull(),
    /** charging.carCapturedTimestamp; null when the charging part was missing. */
    capturedAt: timestamp('captured_at', { withTimezone: true }),
    chargingState: text('charging_state'),
    chargeType: text('charge_type'),
    plugState: text('plug_state'),
    chargePowerKw: doublePrecision('charge_power_kw'),
    parkingState: text('parking_state'),
    /** Parked inside the geofence → true; parked outside or moving → false; unknown → null. */
    atHome: boolean('at_home'),
    socPercent: smallint('soc_percent'),
    odometerKm: integer('odometer_km'),
    odometerCapturedAt: timestamp('odometer_captured_at', { withTimezone: true }),
  },
  (table) => [
    index('vehicle_state_snapshot_polled_at_idx').on(table.polledAt),
    check(
      'vehicle_state_snapshot_charging_state_length_check',
      sql`${table.chargingState} IS NULL OR char_length(${table.chargingState}) <= ${textMax}`,
    ),
    check(
      'vehicle_state_snapshot_charge_type_length_check',
      sql`${table.chargeType} IS NULL OR char_length(${table.chargeType}) <= ${textMax}`,
    ),
    check(
      'vehicle_state_snapshot_plug_state_length_check',
      sql`${table.plugState} IS NULL OR char_length(${table.plugState}) <= ${textMax}`,
    ),
    check(
      'vehicle_state_snapshot_parking_state_length_check',
      sql`${table.parkingState} IS NULL OR char_length(${table.parkingState}) <= ${textMax}`,
    ),
    check(
      'vehicle_state_snapshot_charge_power_nonneg_check',
      sql`${table.chargePowerKw} IS NULL OR ${table.chargePowerKw} >= 0`,
    ),
    check(
      'vehicle_state_snapshot_soc_percent_check',
      sql`${table.socPercent} IS NULL OR ${table.socPercent} BETWEEN 0 AND 100`,
    ),
    check(
      'vehicle_state_snapshot_odometer_nonneg_check',
      sql`${table.odometerKm} IS NULL OR ${table.odometerKm} >= 0`,
    ),
  ],
).enableRLS()
```

Add `export * from './vehicleState'` to `src/lib/db/schema/index.ts` (after `vehicleCharge`). The index is
deliberately non-unique: polls are millisecond timestamps and the lease serialises runs.

- [ ] **Step 2: Generate and apply**

Run: `bun run db:generate --name=vehicle_state_snapshot && bun run db:migrate`
Expected: `drizzle/0009_vehicle_state_snapshot.sql` — `CREATE TABLE`, the index, seven CHECKs (`<= 64` rendered
literally), `ENABLE ROW LEVEL SECURITY`; nothing touches other tables.

- [ ] **Step 3:** `bunx vitest run test/rls.test.ts` → PASS.
- [ ] **Step 4: Commit** `feat(charging): add the vehicle state snapshot table`

---

### Task 2: Škoda effect client (+ a retry limit in the shared HTTP policy)

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:**
- Modify: `src/lib/effects/http.ts` (optional `retryLimit`)
- Create: `src/lib/effects/skoda/{skoda,client,errors,parse,fixtures,index}.ts`, `adapters/notConfigured.ts`
- Modify: `src/lib/effects/index.ts` (`export { skoda } from './skoda'`)
- Test: `src/lib/effects/skoda/skoda.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type LatLon = { latitude: number; longitude: number }
  export type SkodaPart = 'charging' | 'odometer' | 'parkingPosition'
  export type SkodaVehicleState = {
    chargingCapturedAt: Date | null; chargingState: string | null; chargeType: string | null
    plugState: string | null; chargePowerKw: number | null; socPercent: number | null
    odometerKm: number | null; odometerCapturedAt: Date | null
    parking: { state: string | null; position: LatLon | null } | null
    /** errors[].type the API reported, filtered to /^[A-Z_]{1,64}$/. */
    missingParts: string[]
    /** Parts present but not matching our schema (dropped, rest kept). */
    invalidParts: SkodaPart[]
  }
  export type SkodaReading = { state: SkodaVehicleState; keyExpiresAt: Date | null }
  export interface SkodaCallStats { fetchMs: number; requests: number; retries: number }
  export function newCallStats(): SkodaCallStats
  export interface CallOpts { signal?: AbortSignal; stats?: SkodaCallStats }
  export interface SkodaClient { vehicleState(o?: CallOpts): Promise<SkodaReading> }
  export function selectSkodaAdapter(env: Record<string, string | undefined>): 'notConfigured' | 'http'
  export function createSkodaClient(deps: { fetch: typeof fetch; apiKey: string; vin: string }): SkodaClient
  export class SkodaError extends IntegrationError { readonly code; readonly op: 'vehicle'; readonly status?: number }
  export const skoda: SkodaClient
  // http.ts: RequestPolicy gains `retryLimit?: number` (default 2)
  ```

- [ ] **Step 1: `http.ts` retry limit**

In `RequestPolicy` add
```ts
  /** Max retries (default 2); 0 when `retryStatuses` is empty. */
  retryLimit?: number
```
and in `fetchWithRetry` change `limit: p.retryStatuses.size > 0 ? 2 : 0` to
`limit: p.retryStatuses.size > 0 ? (p.retryLimit ?? 2) : 0`. Zaptec and elpris are unaffected (default). Run
`bunx vitest run src/lib/effects` → PASS.

- [ ] **Step 2: Fixtures (synthetic: Škoda docs' sample VIN, central-Stockholm coordinates, invented values)**

```ts
// src/lib/effects/skoda/fixtures.ts
// Shapes seen live on the owner's car (2026-10-02), with every value made up:
// the VIN is the Škoda docs' sample, coordinates are central Stockholm.
export const TEST_VIN = 'TMBJB9NY5RF999999'
export const TEST_KEY = 'test-key'
export const EXPIRES_AT = '2027-01-15T12:00:00.5Z'

export const chargingAtHome = {
  vehicle: {
    vin: TEST_VIN,
    charging: {
      isVehicleInSavedLocation: true,
      carCapturedTimestamp: '2026-05-04T08:57:51Z',
      status: {
        battery: { remainingCruisingRangeInMeters: 300000, stateOfChargeInPercent: 55 },
        chargePowerInKw: 3.5,
        chargeType: 'AC',
        plugConnectionState: 'CONNECTED',
        plugLockState: 'LOCKED',
        state: 'CHARGING',
      },
    },
    odometer: { mileageInKm: 12345, carCapturedTimestamp: '2026-05-04T08:55:01.847Z' },
    parkingPosition: {
      state: 'PARKED',
      formattedAddress: 'redacted',
      gpsCoordinates: { latitude: 59.3293, longitude: 18.0686 },
    },
  },
  errors: [],
}

// Unplugged: `chargeType` is omitted entirely; the car is moving (no position).
export const unplugged = {
  vehicle: {
    vin: TEST_VIN,
    charging: {
      carCapturedTimestamp: '2026-05-04T08:40:10Z',
      status: {
        battery: { stateOfChargeInPercent: 55 },
        chargePowerInKw: 0,
        plugConnectionState: 'DISCONNECTED',
        plugLockState: 'UNLOCKED',
        state: 'CONNECT_CABLE',
      },
    },
    odometer: { mileageInKm: 12345, carCapturedTimestamp: '2026-05-04T08:41:24.258Z' },
    parkingPosition: { state: 'IN_MOTION' },
  },
}

// A partial 200: the charging part could not be retrieved.
export const chargingUnavailable = {
  vehicle: { vin: TEST_VIN, odometer: { mileageInKm: 12349 } },
  errors: [{ type: 'CHARGING_UNAVAILABLE', description: 'not available' }],
}
```

- [ ] **Step 3: Failing tests**

```ts
// src/lib/effects/skoda/skoda.test.ts
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { type FakeRoute, fakeFetch, jsonResponse } from '../testing/fakeFetch'
import { createSkodaClient, newCallStats, SkodaError, selectSkodaAdapter } from '.'
import { chargingAtHome, chargingUnavailable, EXPIRES_AT, TEST_KEY, TEST_VIN, unplugged } from './fixtures'

// ky waits on real timers: fake them, jumping straight to the next one (as zaptec.test.ts).
beforeEach(() => {
  vi.useFakeTimers()
  vi.setTimerTickMode('nextTimerAsync')
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const ROUTE = `GET /api/v1/vehicles/${TEST_VIN}`
const client = (route: FakeRoute) => {
  const f = fakeFetch({ [ROUTE]: route })
  return { f, skoda: createSkodaClient({ fetch: f.fetch, apiKey: TEST_KEY, vin: TEST_VIN }) }
}
const ok = (body: unknown) => () => jsonResponse(body, { headers: { 'X-API-Key-Expires-At': EXPIRES_AT } })
const noVin = (err: SkodaError) => {
  expect(err.message).not.toContain(TEST_VIN)
  expect(JSON.stringify(err.cause ?? null)).not.toContain(TEST_VIN)
}

test('selects http only with both key and VIN, never under VITEST', () => {
  expect(selectSkodaAdapter({ SKODA_API_KEY: 'k', SKODA_VIN: 'v' })).toBe('http')
  expect(selectSkodaAdapter({ SKODA_API_KEY: 'k' })).toBe('notConfigured')
  expect(selectSkodaAdapter({ SKODA_VIN: 'v' })).toBe('notConfigured')
  expect(selectSkodaAdapter({ VITEST: 'true', SKODA_API_KEY: 'k', SKODA_VIN: 'v' })).toBe('notConfigured')
})

test('sends the key header and asks for charging, odometer and parking position', async () => {
  const { f, skoda } = client(ok(chargingAtHome))
  await skoda.vehicleState()
  const [req] = f.calls
  expect(req.headers.get('x-api-key')).toBe(TEST_KEY)
  expect(new URL(req.url).searchParams.get('include')).toBe('charging,odometer,parkingPosition')
})

test('parses a charging-at-home reading and the key expiry', async () => {
  const { skoda } = client(ok(chargingAtHome))
  const stats = newCallStats()
  expect(await skoda.vehicleState({ stats })).toEqual({
    keyExpiresAt: new Date(EXPIRES_AT),
    state: {
      chargingCapturedAt: new Date('2026-05-04T08:57:51Z'),
      chargingState: 'CHARGING',
      chargeType: 'AC',
      plugState: 'CONNECTED',
      chargePowerKw: 3.5,
      socPercent: 55,
      odometerKm: 12345,
      odometerCapturedAt: new Date('2026-05-04T08:55:01.847Z'),
      parking: { state: 'PARKED', position: { latitude: 59.3293, longitude: 18.0686 } },
      missingParts: [],
      invalidParts: [],
    },
  })
  expect(stats).toMatchObject({ requests: 1, retries: 0 })
})

test('an unplugged response omits chargeType; a moving car has no position', async () => {
  const { skoda } = client(ok(unplugged))
  expect((await skoda.vehicleState()).state).toMatchObject({
    chargeType: null,
    plugState: 'DISCONNECTED',
    parking: { state: 'IN_MOTION', position: null },
  })
})

test('a partial 200 without the charging part is a reading with nulls and the missing part', async () => {
  const { skoda } = client(ok(chargingUnavailable))
  expect((await skoda.vehicleState()).state).toMatchObject({
    chargingCapturedAt: null,
    plugState: null,
    odometerKm: 12349,
    parking: null,
    missingParts: ['CHARGING_UNAVAILABLE'],
    invalidParts: [],
  })
})

test('a malformed part is dropped, the rest kept; null leaves and fractions are tolerated', async () => {
  const body = structuredClone(chargingAtHome) as Record<string, any>
  body.vehicle.parkingPosition.gpsCoordinates = { latitude: 'north' }
  body.vehicle.charging.status.battery.stateOfChargeInPercent = 55.6
  body.vehicle.charging.status.chargeType = null
  const { skoda } = client(ok(body))
  const { state } = await skoda.vehicleState()
  expect(state).toMatchObject({
    plugState: 'CONNECTED',
    chargeType: null,
    socPercent: 56,
    parking: null,
    invalidParts: ['parkingPosition'],
  })
})

test('unknown enum values pass through; odd error types are not echoed', async () => {
  const body = structuredClone(chargingAtHome) as Record<string, any>
  body.vehicle.charging.status.state = 'SOMETHING_NEW'
  body.errors = [{ type: 'ODOMETER_DISABLED' }, { type: 'weird <b>type</b> with VIN TMBJB9NY5RF999999' }]
  const { skoda } = client(ok(body))
  const { state } = await skoda.vehicleState()
  expect(state.chargingState).toBe('SOMETHING_NEW')
  expect(state.missingParts).toEqual(['ODOMETER_DISABLED'])
})

test('a missing or unparseable expiry header is null, not a failure', async () => {
  const { skoda } = client(() => jsonResponse(chargingAtHome))
  expect((await skoda.vehicleState()).keyExpiresAt).toBeNull()
  const { skoda: bad } = client(() => jsonResponse(chargingAtHome, { headers: { 'X-API-Key-Expires-At': 'soon' } }))
  expect((await bad.vehicleState()).keyExpiresAt).toBeNull()
})

test.each([
  [401, 'auth_failed'],
  [403, 'forbidden'],
  [404, 'forbidden'],
  [429, 'rate_limited'],
  [500, 'unreachable'],
  [400, 'unexpected_response'],
] as const)('HTTP %i → %s', async (status, code) => {
  const { skoda } = client(() => jsonResponse({ type: 'x', status }, { status }))
  await expect(skoda.vehicleState()).rejects.toMatchObject({ name: 'SkodaError', code, status })
})

test('a 403 problem body naming the VIN never reaches the error', async () => {
  const { skoda } = client(() =>
    jsonResponse(
      {
        type: 'https://public.api.connect.skoda-auto.cz/problems/api-key-not-authorized',
        status: 403,
        detail: `The API key is not authorized to access vehicle ${TEST_VIN}.`,
      },
      { status: 403 },
    ),
  )
  noVin(await skoda.vehicleState().catch((e: unknown) => e as SkodaError))
})

test('429 is not retried; 503 is retried once, then fails as unreachable', async () => {
  const limited = client(() => jsonResponse({}, { status: 429 }))
  await expect(limited.skoda.vehicleState()).rejects.toBeInstanceOf(SkodaError)
  expect(limited.f.calls).toHaveLength(1)

  const flaky = client((_req, call) => (call === 0 ? jsonResponse({}, { status: 503 }) : ok(chargingAtHome)()))
  const stats = newCallStats()
  await expect(flaky.skoda.vehicleState({ stats })).resolves.toBeDefined()
  expect(stats).toMatchObject({ requests: 2, retries: 1 })

  const down = client(() => jsonResponse({}, { status: 503, headers: { 'Retry-After': '1' } }))
  const err = await down.skoda.vehicleState().catch((e: unknown) => e as SkodaError)
  expect(err).toMatchObject({ code: 'unreachable', status: 503 })
  expect(down.f.calls).toHaveLength(2)
})

test('a body that is not JSON, or has the wrong top-level shape, is unexpected_response', async () => {
  const notJson = client(() => new Response('<html>', { status: 200 }))
  await expect(notJson.skoda.vehicleState()).rejects.toMatchObject({ code: 'unexpected_response' })
  const wrong = client(ok({ vehicles: [] }))
  const err = await wrong.skoda.vehicleState().catch((e: unknown) => e as SkodaError)
  expect(err).toMatchObject({ code: 'unexpected_response' })
  expect(err.message).toContain('vehicle')
})

test('network failures and timeouts are unreachable and never echo the VIN', async () => {
  const net = client(() => {
    throw Object.assign(new TypeError(`fetch failed for ${TEST_VIN}`), { code: 'ECONNRESET' })
  })
  const netErr = await net.skoda.vehicleState().catch((e: unknown) => e as SkodaError)
  expect(netErr).toMatchObject({ code: 'unreachable' })
  noVin(netErr)

  const hang = client(
    (req) =>
      new Promise<Response>((_res, rej) => req.signal.addEventListener('abort', () => rej(req.signal.reason))),
  )
  const hangErr = await hang.skoda.vehicleState().catch((e: unknown) => e as SkodaError)
  expect(hangErr).toMatchObject({ code: 'unreachable' })
  noVin(hangErr)
})
```

- [ ] **Step 4:** `bunx vitest run src/lib/effects/skoda/skoda.test.ts` → FAIL (no module).

- [ ] **Step 5: `errors.ts`, `skoda.ts`, `adapters/notConfigured.ts`, `index.ts`**

```ts
// src/lib/effects/skoda/errors.ts
import type { IntegrationErrorCode } from '~/lib/integrationHealth'
import { IntegrationError } from '../integrationError'

export type SkodaOp = 'vehicle'

/**
 * The one error the Škoda client throws. Messages are written for an admin and
 * never carry the API key, the VIN, a position or any payload value (the
 * request URL contains the VIN, so network errors keep only `networkCause`).
 */
export class SkodaError extends IntegrationError {
  override readonly name = 'SkodaError'

  constructor(
    readonly code: IntegrationErrorCode,
    readonly op: SkodaOp,
    readonly status?: number,
    options?: { cause?: unknown; message?: string },
  ) {
    super(
      options?.message ?? `Škoda ${op} failed: ${code}${status === undefined ? '' : ` (HTTP ${status})`}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    )
  }
}
```

```ts
// src/lib/effects/skoda/skoda.ts
import { lazy } from '../lazy'

/**
 * The car's current state from the official MyŠkoda Public API (ADR-0022),
 * backed by one of two adapters:
 *   - `http` — the real client (`createSkodaClient`), when `SKODA_API_KEY` and
 *     `SKODA_VIN` are both set.
 *   - `notConfigured` — throws `SkodaError('not_configured')`. Selected when
 *     either is unset, and always under VITEST. Deliberately **no devLog or
 *     fake adapter** (ADR-0019): a silent no-op would read as a healthy sync.
 *
 * The client never logs; callers pass a `stats` sink. The parked position is
 * returned only so the caller can run the geofence — never store or log it.
 */
export type LatLon = { latitude: number; longitude: number }
export type SkodaPart = 'charging' | 'odometer' | 'parkingPosition'

export type SkodaVehicleState = {
  chargingCapturedAt: Date | null
  chargingState: string | null
  chargeType: string | null
  plugState: string | null
  chargePowerKw: number | null
  socPercent: number | null
  odometerKm: number | null
  odometerCapturedAt: Date | null
  parking: { state: string | null; position: LatLon | null } | null
  /** errors[].type the API reported, filtered to /^[A-Z_]{1,64}$/. */
  missingParts: string[]
  /** Parts present but not matching our schema (dropped, the rest kept). */
  invalidParts: SkodaPart[]
}

export type SkodaReading = { state: SkodaVehicleState; keyExpiresAt: Date | null }

export interface SkodaCallStats {
  fetchMs: number
  requests: number
  retries: number
}

export function newCallStats(): SkodaCallStats {
  return { fetchMs: 0, requests: 0, retries: 0 }
}

export interface CallOpts {
  signal?: AbortSignal
  stats?: SkodaCallStats
}

export interface SkodaClient {
  vehicleState(o?: CallOpts): Promise<SkodaReading>
}

type Env = Record<string, string | undefined>

export function selectSkodaAdapter(env: Env): 'notConfigured' | 'http' {
  if (env.VITEST === 'true') return 'notConfigured'
  return env.SKODA_API_KEY && env.SKODA_VIN ? 'http' : 'notConfigured'
}

const getAdapter = lazy(async (): Promise<SkodaClient> => {
  const apiKey = process.env.SKODA_API_KEY
  const vin = process.env.SKODA_VIN
  if (selectSkodaAdapter(process.env) === 'http' && apiKey && vin) {
    const { createSkodaClient } = await import('./client')
    return createSkodaClient({ fetch: globalThis.fetch, apiKey, vin })
  }
  return (await import('./adapters/notConfigured')).notConfigured
})

export const skoda: SkodaClient = {
  async vehicleState(o) {
    return (await getAdapter()).vehicleState(o)
  },
}
```

```ts
// src/lib/effects/skoda/adapters/notConfigured.ts
import { SkodaError } from '../errors'
import type { SkodaClient } from '../skoda'

// Selected when SKODA_API_KEY or SKODA_VIN is unset (and under VITEST): fails
// closed so health shows "not configured", never a fake healthy sync.
export const notConfigured: SkodaClient = {
  async vehicleState() {
    throw new SkodaError('not_configured', 'vehicle', undefined, {
      message: 'Škoda client is not configured (SKODA_API_KEY / SKODA_VIN unset)',
    })
  },
}
```

```ts
// src/lib/effects/skoda/index.ts
export { createSkodaClient } from './client'
export { SkodaError, type SkodaOp } from './errors'
export {
  type CallOpts,
  type LatLon,
  newCallStats,
  type SkodaCallStats,
  type SkodaClient,
  type SkodaPart,
  type SkodaReading,
  type SkodaVehicleState,
  selectSkodaAdapter,
  skoda,
} from './skoda'
```

Register in `src/lib/effects/index.ts`: `export { skoda } from './skoda'` (alphabetical, before `storage`).

- [ ] **Step 6: `parse.ts` — strict envelope, tolerant parts**

```ts
// src/lib/effects/skoda/parse.ts
import { z } from 'zod'
import { issuePath, summarizeIssuePaths } from '~/lib/issuePaths'
import { SkodaError } from './errors'
import type { SkodaPart, SkodaVehicleState } from './skoda'

const instant = z.iso.datetime({ offset: true }).transform((s) => new Date(s))
// Enums are plain strings: the API says new values may appear at any time.
const label = z.string().max(64)
const SAFE_TYPE = /^[A-Z_]{1,64}$/

// The envelope must match; each part is parsed on its own so drift in one part
// (a new shape, a null) drops that part — the poll still counts (ADR-0022).
const envelopeSchema = z.object({
  vehicle: z.object({
    charging: z.unknown().optional(),
    odometer: z.unknown().optional(),
    parkingPosition: z.unknown().optional(),
  }),
  errors: z.array(z.looseObject({ type: z.string() })).nullish(),
})

const chargingSchema = z.object({
  carCapturedTimestamp: instant.nullish(),
  status: z
    .object({
      state: label.nullish(),
      chargeType: label.nullish(),
      chargePowerInKw: z.number().min(0).nullish(),
      plugConnectionState: label.nullish(),
      battery: z.object({ stateOfChargeInPercent: z.number().min(0).max(100).nullish() }).nullish(),
    })
    .nullish(),
})
const odometerSchema = z.object({
  mileageInKm: z.number().min(0).nullish(),
  carCapturedTimestamp: instant.nullish(),
})
const parkingSchema = z.object({
  state: label.nullish(),
  gpsCoordinates: z
    .object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })
    .nullish(),
})

export function parseVehicleState(body: unknown): SkodaVehicleState {
  const envelope = envelopeSchema.safeParse(body)
  if (!envelope.success) {
    const at = summarizeIssuePaths(envelope.error.issues.map((i) => issuePath(i.path)))
    throw new SkodaError('unexpected_response', 'vehicle', undefined, {
      message: `Škoda vehicle response has an unexpected shape at: ${at}`,
    })
  }
  const invalidParts: SkodaPart[] = []
  function part<T>(name: SkodaPart, schema: z.ZodType<T>, value: unknown): T | null {
    if (value === undefined || value === null) return null
    const parsed = schema.safeParse(value)
    if (parsed.success) return parsed.data
    invalidParts.push(name)
    return null
  }
  const { vehicle, errors } = envelope.data
  const charging = part('charging', chargingSchema, vehicle.charging)
  const odometer = part('odometer', odometerSchema, vehicle.odometer)
  const parking = part('parkingPosition', parkingSchema, vehicle.parkingPosition)
  const status = charging?.status
  const soc = status?.battery?.stateOfChargeInPercent
  const km = odometer?.mileageInKm
  return {
    chargingCapturedAt: charging?.carCapturedTimestamp ?? null,
    chargingState: status?.state ?? null,
    chargeType: status?.chargeType ?? null,
    plugState: status?.plugConnectionState ?? null,
    chargePowerKw: status?.chargePowerInKw ?? null,
    socPercent: soc == null ? null : Math.round(soc),
    odometerKm: km == null ? null : Math.round(km),
    odometerCapturedAt: odometer?.carCapturedTimestamp ?? null,
    parking: parking ? { state: parking.state ?? null, position: parking.gpsCoordinates ?? null } : null,
    missingParts: (errors ?? []).map((e) => e.type).filter((t) => SAFE_TYPE.test(t)),
    invalidParts,
  }
}

/** `X-API-Key-Expires-At` (RFC 3339) → a date; absent or unparseable → null. */
export function parseKeyExpiry(header: string | null): Date | null {
  if (header === null) return null
  const parsed = z.iso.datetime({ offset: true }).safeParse(header)
  return parsed.success ? new Date(parsed.data) : null
}
```

(If the installed zod 4 lacks `z.looseObject`, use `z.object({ type: z.string() }).passthrough()`.)

- [ ] **Step 7: `client.ts`**

```ts
// src/lib/effects/skoda/client.ts
import { discard, fetchWithRetry, networkCause } from '../http'
import { SkodaError } from './errors'
import { parseKeyExpiry, parseVehicleState } from './parse'
import { type CallOpts, newCallStats, type SkodaCallStats, type SkodaClient, type SkodaReading } from './skoda'

const BASE_URL = 'https://public.api.connect.skoda-auto.cz/api/v1'
const INCLUDE = 'charging,odometer,parkingPosition'
const TIMEOUT_MS = 10_000
// Errors count against the 20 requests/h per VIN (5xx and timeouts included):
// 429 is never retried, gateway errors once → worst case 4 polls × 2 = 8/h.
const RETRY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504])
const RETRY_LIMIT = 1

/** Real MyŠkoda Public API client. Never logs; never reads an error body (it can name the VIN). */
export function createSkodaClient(deps: { fetch: typeof fetch; apiKey: string; vin: string }): SkodaClient {
  const url = `${BASE_URL}/vehicles/${encodeURIComponent(deps.vin)}?include=${INCLUDE}`

  async function send(signal: AbortSignal | undefined, stats: SkodaCallStats) {
    try {
      return await fetchWithRetry(
        url,
        { headers: { 'X-API-Key': deps.apiKey, Accept: 'application/json' } },
        {
          fetch: deps.fetch,
          timeoutMs: TIMEOUT_MS,
          retryStatuses: RETRY_STATUSES,
          retryLimit: RETRY_LIMIT,
          signal,
          stats,
          onTiming: (ms) => {
            stats.fetchMs += ms
          },
        },
      )
    } catch (err) {
      // ky's errors can carry the URL (with the VIN): keep only name + code.
      throw new SkodaError('unreachable', 'vehicle', undefined, {
        cause: networkCause(err),
        message: 'Škoda vehicle request failed or was cut off',
      })
    }
  }

  return {
    async vehicleState(o: CallOpts = {}): Promise<SkodaReading> {
      const stats = o.stats ?? newCallStats()
      const res = await send(o.signal, stats)
      if (!res.ok) {
        await discard(res)
        throw statusError(res.status)
      }
      let body: unknown
      try {
        body = JSON.parse(await res.text())
      } catch {
        throw new SkodaError('unexpected_response', 'vehicle', res.status, {
          message: `Škoda vehicle response is not valid JSON (HTTP ${res.status})`,
        })
      }
      return {
        state: parseVehicleState(body),
        keyExpiresAt: parseKeyExpiry(res.headers.get('X-API-Key-Expires-At')),
      }
    },
  }
}

function statusError(status: number): SkodaError {
  if (status === 401) return new SkodaError('auth_failed', 'vehicle', status) // api-key-expired
  // 403 api-key-not-authorized (key not for this car); 404 = no vehicle for the VIN.
  if (status === 403 || status === 404) return new SkodaError('forbidden', 'vehicle', status)
  if (status === 429) return new SkodaError('rate_limited', 'vehicle', status)
  if (status >= 500) return new SkodaError('unreachable', 'vehicle', status)
  return new SkodaError('unexpected_response', 'vehicle', status)
}
```

- [ ] **Step 8:** `bunx vitest run src/lib/effects` → PASS (Zaptec/elpris unchanged, Škoda green).
- [ ] **Step 9: Commit** `feat(charging): add a MyŠkoda Public API client`

---

### Task 3: geofence (pure)

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:** Create `src/lib/vehicleState/geofence.ts`, test `src/lib/vehicleState/geofence.test.ts`.

**Interfaces:**
- Consumes: `type LatLon` from `~/lib/effects/skoda` (Task 2), type-only.
- Produces: `HOME_RADIUS_M = 150`; `parseHomePoint(raw: string | undefined): LatLon | null`;
  `distanceMeters(a: LatLon, b: LatLon): number`;
  `atHome(parking: { state: string | null; position: LatLon | null } | null, home: LatLon | null): boolean | null`.

- [ ] **Step 1: Failing tests**

```ts
// src/lib/vehicleState/geofence.test.ts
import { expect, test } from 'vitest'
import { atHome, distanceMeters, HOME_RADIUS_M, parseHomePoint } from './geofence'

const HOME = { latitude: 59.3293, longitude: 18.0686 } // central Stockholm, not a real home

test('parseHomePoint reads "lat,lon" with optional spaces', () => {
  expect(parseHomePoint('59.3293,18.0686')).toEqual(HOME)
  expect(parseHomePoint(' 59.3293 , 18.0686 ')).toEqual(HOME)
})

test('parseHomePoint rejects blank, malformed and out-of-range values', () => {
  for (const raw of [undefined, '', 'abc', '59.3', '59.3,18.0,1', '91,18', '59,181', 'NaN,18', ',18']) {
    expect(parseHomePoint(raw)).toBeNull()
  }
})

test('distanceMeters is ~111 km per degree of latitude and 0 for the same point', () => {
  expect(distanceMeters(HOME, HOME)).toBe(0)
  const north = { latitude: HOME.latitude + 1, longitude: HOME.longitude }
  expect(distanceMeters(HOME, north)).toBeGreaterThan(110_000)
  expect(distanceMeters(HOME, north)).toBeLessThan(112_000)
})

test('parked inside the radius is home; outside is not', () => {
  const near = { latitude: HOME.latitude + 0.001, longitude: HOME.longitude } // ≈ 111 m
  const far = { latitude: HOME.latitude + 0.002, longitude: HOME.longitude } // ≈ 222 m
  expect(distanceMeters(HOME, near)).toBeLessThan(HOME_RADIUS_M)
  expect(atHome({ state: 'PARKED', position: near }, HOME)).toBe(true)
  expect(atHome({ state: 'PARKED', position: far }, HOME)).toBe(false)
})

test('moving is never home, wherever it is', () => {
  expect(atHome({ state: 'IN_MOTION', position: null }, HOME)).toBe(false)
  expect(atHome({ state: 'IN_MOTION', position: HOME }, HOME)).toBe(false)
})

test('unknown when there is no position, no home point, or an unknown parking state', () => {
  expect(atHome(null, HOME)).toBeNull()
  expect(atHome({ state: 'PARKED', position: null }, HOME)).toBeNull()
  expect(atHome({ state: 'PARKED', position: HOME }, null)).toBeNull()
  expect(atHome({ state: 'SOMETHING_NEW', position: HOME }, HOME)).toBeNull()
})
```

- [ ] **Step 2:** `bunx vitest run src/lib/vehicleState/geofence.test.ts` → FAIL (no module).
- [ ] **Step 3: Implement**

```ts
// src/lib/vehicleState/geofence.ts
import type { LatLon } from '~/lib/effects/skoda'

// Home geofence for live attribution (ADR-0022). The car's parked position is
// compared here, in memory, and only the boolean leaves this module — never the
// coordinates. Haversine is hand-rolled: a few lines, no geo library installed.

/** Generous for GPS while parked; the probe saw the car 5 m from the home point. */
export const HOME_RADIUS_M = 150
const EARTH_RADIUS_M = 6_371_000

/** `SKODA_HOME_COORDINATES` ("lat,lon", decimal degrees) → a point, or null when unset/invalid. */
export function parseHomePoint(raw: string | undefined): LatLon | null {
  const parts = raw?.split(',').map((p) => p.trim())
  if (parts?.length !== 2 || parts.some((p) => p === '')) return null
  const [latitude, longitude] = parts.map(Number)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
  return { latitude, longitude }
}

export function distanceMeters(a: LatLon, b: LatLon): number {
  const rad = (deg: number) => (deg * Math.PI) / 180
  const h =
    Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h))
}

/**
 * Parked inside the radius → true; parked outside, or moving → false (a moving
 * car is not at our charger); no position, no home point or an unknown parking
 * state → null (the rule then falls back to plug state alone).
 */
export function atHome(
  parking: { state: string | null; position: LatLon | null } | null,
  home: LatLon | null,
): boolean | null {
  if (parking?.state === 'IN_MOTION') return false
  if (parking?.state !== 'PARKED' || !parking.position || !home) return null
  return distanceMeters(parking.position, home) <= HOME_RADIUS_M
}
```

- [ ] **Step 4:** run → PASS (6 tests).
- [ ] **Step 5: Commit** `feat(charging): add the home geofence for the car's position`

---

### Task 4: `vehicleState` service

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:** Create `src/lib/services/vehicleState/{vehicleState,index}.ts`, test `vehicleState.test.ts`; modify
`test/fixtures/evCharging.ts`.

**Interfaces:**
- Produces:
  ```ts
  export type SnapshotInput = {
    polledAt: Date; capturedAt: Date | null; chargingState: string | null; chargeType: string | null
    plugState: string | null; chargePowerKw: number | null; parkingState: string | null
    atHome: boolean | null; socPercent: number | null; odometerKm: number | null; odometerCapturedAt: Date | null
  }
  export async function recordSnapshot(input: SnapshotInput): Promise<void>
  export type LatestSnapshot = { polledAt: Date; capturedAt: Date | null }
  export async function latestSnapshot(): Promise<LatestSnapshot | null>
  // test/fixtures/evCharging.ts
  export async function insertSnapshot(overrides?: Partial<typeof vehicleStateSnapshot.$inferInsert>): Promise<void>
  ```

- [ ] **Step 1: Fixture** — append to `test/fixtures/evCharging.ts` (add `vehicleStateSnapshot` to its import):

```ts
export async function insertSnapshot(
  overrides: Partial<typeof vehicleStateSnapshot.$inferInsert> = {},
): Promise<void> {
  await db.insert(vehicleStateSnapshot).values({
    polledAt: new Date('2026-10-02T10:00:00Z'),
    plugState: 'CONNECTED',
    atHome: true,
    ...overrides,
  })
}
```

- [ ] **Step 2: Failing tests**

```ts
// src/lib/services/vehicleState/vehicleState.test.ts
import { asc } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { vehicleStateSnapshot } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'
import { latestSnapshot, recordSnapshot, type SnapshotInput } from './vehicleState'

setupDatabase()

const input = (overrides: Partial<SnapshotInput> = {}): SnapshotInput => ({
  polledAt: new Date('2026-05-04T08:58:24Z'),
  capturedAt: new Date('2026-05-04T08:57:51Z'),
  chargingState: 'CHARGING',
  chargeType: 'AC',
  plugState: 'CONNECTED',
  chargePowerKw: 3.5,
  parkingState: 'PARKED',
  atHome: true,
  socPercent: 55,
  odometerKm: 12345,
  odometerCapturedAt: new Date('2026-05-04T08:55:01Z'),
  ...overrides,
})
const rows = () => db.select().from(vehicleStateSnapshot).orderBy(asc(vehicleStateSnapshot.polledAt))

test('stores every poll as its own row, even with the same capture time', async () => {
  await recordSnapshot(input())
  await recordSnapshot(input({ polledAt: new Date('2026-05-04T09:13:24Z') }))
  const stored = await rows()
  expect(stored).toHaveLength(2)
  expect(stored[0]).toMatchObject({ plugState: 'CONNECTED', atHome: true, socPercent: 55, odometerKm: 12345 })
})

test('stores a poll with no charging part as unknown', async () => {
  await recordSnapshot(
    input({ capturedAt: null, chargingState: null, chargeType: null, plugState: null, chargePowerKw: null }),
  )
  expect((await rows())[0]).toMatchObject({ capturedAt: null, plugState: null })
})

test('latestSnapshot is the newest poll (times only), or null before any', async () => {
  expect(await latestSnapshot()).toBeNull()
  await recordSnapshot(input({ polledAt: new Date('2026-05-04T12:18:11Z'), plugState: 'DISCONNECTED' }))
  await recordSnapshot(input({ polledAt: new Date('2026-05-04T09:00:00Z') }))
  expect(await latestSnapshot()).toEqual({
    polledAt: new Date('2026-05-04T12:18:11Z'),
    capturedAt: new Date('2026-05-04T08:57:51Z'),
  })
})
```

- [ ] **Step 3:** run → FAIL.
- [ ] **Step 4: Implement**

```ts
// src/lib/services/vehicleState/vehicleState.ts
import { desc } from 'drizzle-orm'
import { db } from '~/lib/db'
import { vehicleStateSnapshot } from '~/lib/db/schema'

/** One poll of the car's state, already reduced (the position is only `atHome`). */
export type SnapshotInput = {
  polledAt: Date
  capturedAt: Date | null
  chargingState: string | null
  chargeType: string | null
  plugState: string | null
  chargePowerKw: number | null
  parkingState: string | null
  atHome: boolean | null
  socPercent: number | null
  odometerKm: number | null
  odometerCapturedAt: Date | null
}

/** Appends one poll (ADR-0022): the live rule needs every poll, not only state changes. */
export async function recordSnapshot(input: SnapshotInput): Promise<void> {
  await db.insert(vehicleStateSnapshot).values(input)
}

/** Times only — the card needs no presence data (ADR-0022, Privacy). */
export type LatestSnapshot = { polledAt: Date; capturedAt: Date | null }

/** The newest poll, for the admin card's "last contact with the car". */
export async function latestSnapshot(): Promise<LatestSnapshot | null> {
  const [row] = await db
    .select({ polledAt: vehicleStateSnapshot.polledAt, capturedAt: vehicleStateSnapshot.capturedAt })
    .from(vehicleStateSnapshot)
    .orderBy(desc(vehicleStateSnapshot.polledAt))
    .limit(1)
  return row ?? null
}
```

`index.ts`: `export * from './vehicleState'`.

- [ ] **Step 5:** run → PASS. **Step 6: Commit** `feat(charging): add a service for the car's state snapshots`

---

### Task 5: per-source alert threshold (+ Škoda staleness)

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:** `src/lib/services/integrationSync/{policy,transition,integrationSync}.ts`, test `transition.test.ts`.

**Interfaces:**
- Produces: `ALERT_AFTER_FAILURES: Record<IntegrationSource, number>` = `{ zaptec: 1, elpris: 1, skoda: 3 }`;
  `nextRow(prev, outcome, now, startedAt, alertAfterFailures = 1)`; `STALE_AFTER_MS.skoda = 1 h`.

- [ ] **Step 1: Failing tests** (append to `transition.test.ts`, reusing its `healthy`, `fail`, `ok`, `NOW`, `STARTED`)

```ts
test('with a threshold of 3, the alert opens on the third alertable failure in a row', () => {
  const first = nextRow(healthy, fail('unreachable'), NOW, STARTED, 3)
  expect(first.transition).toBe('none')
  expect(first.row.alertedAt).toBeNull()
  const second = nextRow(first.row, fail('rate_limited'), NOW, STARTED, 3)
  expect(second.transition).toBe('none')
  const third = nextRow(second.row, fail('unreachable'), NOW, STARTED, 3)
  expect(third.transition).toBe('started_failing')
  expect(third.row.alertedAt).toEqual(NOW)
})

test('a streak shorter than the threshold recovers silently', () => {
  const failed = nextRow(healthy, fail('unreachable'), NOW, STARTED, 3).row
  expect(nextRow(failed, ok, NOW, STARTED, 3).transition).toBe('none')
})

test('not_configured never alerts, whatever the threshold', () => {
  let row = healthy
  for (let i = 0; i < 5; i++) {
    const next = nextRow(row, fail('not_configured'), NOW, STARTED, 3)
    expect(next.transition).toBe('none')
    row = next.row
  }
})
```

(Also add, in `policy` tests or `integrationSync.test.ts`, `expect(deriveState('skoda', <row ok 61 min ago>, now)).toBe('stale')`
using that file's existing helpers.)

- [ ] **Step 2:** run → FAIL (the extra arg is ignored → the first failure alerts).
- [ ] **Step 3: Implement** — `policy.ts`:

```ts
// How many consecutive alertable failures open an alert email. Hourly/daily
// sources alert at once; Škoda polls every 15 min, where a single 503 or 429
// would otherwise email every admin and then "recovered" 15 min later.
export const ALERT_AFTER_FAILURES: Record<IntegrationSource, number> = {
  zaptec: 1,
  elpris: 1,
  skoda: 3,
}
```

and replace the skoda `STALE_AFTER_MS` placeholder with `skoda: millisecondsInHour` and the comment line
`// skoda polls every 15 min, so 1 h = three missed polls.`

`transition.ts` `nextRow` gains a 5th parameter `alertAfterFailures = 1` and
`const opensAlert = !alertOpen && outcome.code !== 'not_configured' && prev.consecutiveFailures + 1 >= alertAfterFailures`;
update its header comment ("an alert opens on the `alertAfterFailures`-th consecutive failure of a streak…"). In
`integrationSync.ts:148` pass `ALERT_AFTER_FAILURES[source]` (import from `./policy`).

- [ ] **Step 4:** `bunx vitest run src/lib/services/integrationSync src/lib/integrations` → PASS (existing callers
  default to 1).
- [ ] **Step 5: Commit** `feat(charging): let a source wait for a failure streak to alert`

---

### Task 6: `runSkodaSync` + cron + docs

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:**
- Create: `src/lib/vehicleState/{sync,skodaSyncCron}.ts` (+ tests), `src/routes/api/cron/skoda-sync.ts`
- Modify: `vite.config.ts` (cron), `CLAUDE.md`, regenerated `src/routeTree.gen.ts`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  ```ts
  export type SkodaSyncRun = RunBase & {
    source: 'skoda'; fetchMs: number; snapshotMs: number; requests: number; retries: number
    stored: boolean; geofence: 'on' | 'off'; missingParts: number; invalidParts: number
    reattributeMs: number; reattributeChanged: number
  }
  export async function runSkodaSync(opts: {
    trigger: SyncTrigger; now?: () => Date; deadlineMs?: number
    deps?: { skoda?: SkodaClient; log?: Logger; homePoint?: LatLon | null }
  }): Promise<SkodaSyncRun>
  export function handleSkodaSyncCron(request: Request): Promise<Response>
  ```

- [ ] **Step 1: Failing sync tests**

```ts
// src/lib/vehicleState/sync.test.ts
import { asc } from 'drizzle-orm'
import { afterEach, beforeEach, expect, type MockInstance, test, vi } from 'vitest'
import { db } from '~/lib/db'
import { user, vehicleStateSnapshot } from '~/lib/db/schema'
import { queue } from '~/lib/effects'
import { type SkodaClient, SkodaError, type SkodaReading } from '~/lib/effects/skoda'
import { createServerLogger } from '~/lib/logger/server'
import { getHealth } from '~/lib/services/integrationSync'
import { setupDatabase } from '~test/setup'
import { runSkodaSync } from './sync'

setupDatabase()

const NOW = new Date('2026-05-04T09:07:00Z')
const HOME = { latitude: 59.3293, longitude: 18.0686 }

const reading = (
  overrides: Partial<SkodaReading['state']> = {},
  keyExpiresAt: Date | null = new Date('2027-01-15T12:00:00Z'),
): SkodaReading => ({
  keyExpiresAt,
  state: {
    chargingCapturedAt: new Date('2026-05-04T08:57:51Z'),
    chargingState: 'CHARGING',
    chargeType: 'AC',
    plugState: 'CONNECTED',
    chargePowerKw: 3.5,
    socPercent: 55,
    odometerKm: 12345,
    odometerCapturedAt: new Date('2026-05-04T08:55:01Z'),
    parking: { state: 'PARKED', position: HOME },
    missingParts: [],
    invalidParts: [],
    ...overrides,
  },
})
const fakeSkoda = (impl: () => Promise<SkodaReading>): SkodaClient => ({
  vehicleState: async (o) => {
    if (o?.stats) o.stats.requests++
    return impl()
  },
})

function capturingLogger() {
  const lines: string[] = []
  const log = createServerLogger({
    write(chunk: string) {
      lines.push(chunk)
      return true
    },
  })
  const entries = () =>
    lines
      .join('')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown> & { msg: string })
  return { log, entries, raw: () => lines.join('') }
}

type RunOpts = { homePoint?: typeof HOME | null; log?: ReturnType<typeof capturingLogger>['log']; now?: Date }
const run = (client: SkodaClient, opts: RunOpts = {}) =>
  runSkodaSync({
    trigger: 'cron',
    now: () => opts.now ?? NOW,
    deps: {
      skoda: client,
      homePoint: 'homePoint' in opts ? (opts.homePoint ?? null) : HOME,
      log: opts.log ?? capturingLogger().log,
    },
  })
// Alerts and reminders go to active admins (same seeding as runPulledSync.test.ts).
const seedAdmin = () => db.insert(user).values({ name: 'A', email: 'a@example.com', role: 'admin' })
const snapshots = () => db.select().from(vehicleStateSnapshot).orderBy(asc(vehicleStateSnapshot.polledAt))

let publish: MockInstance<typeof queue.publish>
beforeEach(() => {
  publish = vi.spyOn(queue, 'publish').mockResolvedValue(undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
})

test('stores the poll with the geofence result and no coordinates', async () => {
  const result = await run(fakeSkoda(async () => reading()))
  expect(result).toMatchObject({ source: 'skoda', outcome: 'ok', stored: true, geofence: 'on' })
  const [row] = await snapshots()
  expect(row).toMatchObject({
    polledAt: NOW,
    capturedAt: new Date('2026-05-04T08:57:51Z'),
    plugState: 'CONNECTED',
    parkingState: 'PARKED',
    atHome: true,
    socPercent: 55,
    odometerKm: 12345,
  })
  expect(JSON.stringify(row)).not.toContain('59.3293')
  expect((await getHealth('skoda', { now: NOW, includeAdminDetail: false })).state).toBe('ok')
})

test('parked away is at_home false; no home point is null, geofence off, warned at most once', async () => {
  const away = { latitude: HOME.latitude + 0.05, longitude: HOME.longitude }
  await run(fakeSkoda(async () => reading({ parking: { state: 'PARKED', position: away } })))
  const { log, entries } = capturingLogger()
  const off1 = await run(fakeSkoda(async () => reading()), { homePoint: null, log, now: new Date(NOW.getTime() + 1000) })
  const off2 = await run(fakeSkoda(async () => reading()), { homePoint: null, log, now: new Date(NOW.getTime() + 2000) })
  expect(off1.geofence).toBe('off')
  expect(off2.geofence).toBe('off')
  expect((await snapshots()).map((r) => r.atHome)).toEqual([false, null, null])
  expect(
    entries().filter((e) => e.msg === 'skoda sync: home point unset or invalid, geofence off').length,
  ).toBeLessThanOrEqual(1)
})

test('missing and invalid parts are an ok run that stores an unknown-plug row and warns', async () => {
  const { log, entries } = capturingLogger()
  const result = await run(
    fakeSkoda(async () =>
      reading({
        chargingCapturedAt: null,
        chargingState: null,
        chargeType: null,
        plugState: null,
        chargePowerKw: null,
        parking: null,
        missingParts: ['CHARGING_UNAVAILABLE'],
        invalidParts: ['parkingPosition'],
      }),
    ),
    { log },
  )
  expect(result).toMatchObject({ outcome: 'ok', stored: true, missingParts: 1, invalidParts: 1 })
  expect((await snapshots())[0]?.plugState).toBeNull()
  expect(entries().find((e) => e.msg === 'skoda sync: parts missing or invalid')).toMatchObject({
    missingParts: ['CHARGING_UNAVAILABLE'],
    invalidParts: ['parkingPosition'],
  })
})

test('an expired key fails the run as auth_failed, stores nothing, and alerts on the third poll in a row', async () => {
  await seedAdmin()
  const expired = fakeSkoda(async () => {
    throw new SkodaError('auth_failed', 'vehicle', 401)
  })
  for (let i = 0; i < 2; i++) {
    expect(await run(expired, { now: new Date(NOW.getTime() + i * 900_000) })).toMatchObject({
      outcome: 'failed',
      code: 'auth_failed',
      stored: false,
    })
  }
  expect(publish).not.toHaveBeenCalled()
  await run(expired, { now: new Date(NOW.getTime() + 2 * 900_000) })
  expect(publish).toHaveBeenCalledTimes(1)
  expect(publish).toHaveBeenCalledWith(
    'email_integration_sync_alert',
    expect.objectContaining({ source: 'skoda', transition: 'started_failing', code: 'auth_failed' }),
  )
  expect(await snapshots()).toHaveLength(0)
})

test('not configured fails closed without alerting', async () => {
  await seedAdmin()
  for (let i = 0; i < 3; i++) {
    const result = await runSkodaSync({
      trigger: 'cron',
      now: () => new Date(NOW.getTime() + i * 900_000),
      deps: { homePoint: HOME },
    })
    expect(result).toMatchObject({ outcome: 'failed', code: 'not_configured' })
  }
  expect(publish).not.toHaveBeenCalled()
})

test('the run line carries counters but never the position or presence', async () => {
  const { log, entries, raw } = capturingLogger()
  await run(fakeSkoda(async () => reading()), { log })
  const line = entries().find((e) => e.msg === 'integration sync run')
  expect(line).toMatchObject({ source: 'skoda', outcome: 'ok', stored: true, geofence: 'on' })
  expect(typeof line?.fetchMs).toBe('number')
  for (const leak of ['59.3293', 'atHome', 'plugState', 'CONNECTED', 'PARKED']) expect(raw()).not.toContain(leak)
})
```

- [ ] **Step 2:** run → FAIL.

- [ ] **Step 3: Implement `sync.ts`**

```ts
// src/lib/vehicleState/sync.ts
import { type LatLon, newCallStats, type SkodaClient, SkodaError, skoda } from '~/lib/effects/skoda'
import type { SyncTrigger } from '~/lib/integrationHealth'
import { type RunBase, runPulledSync, withDeadline } from '~/lib/integrations/runPulledSync'
import type { Logger } from '~/lib/logger'
import { logger } from '~/lib/logger/server'
import * as vehicleStateService from '~/lib/services/vehicleState'
import { atHome, parseHomePoint } from './geofence'

/**
 * One poll of the MyŠkoda Public API (ADR-0022), inside the shared
 * pulled-integration lifecycle (lease, health, alert email, one run line).
 * Called by the 15-min cron and the admin `syncNow`. The parked position is
 * reduced to `atHome` here and dropped; no presence (plug, position, at home)
 * is ever logged. A stateless source: `since`/`syncedUntil` stay null (the
 * health watermark then defaults to `startedAt`, which nothing reads for Škoda).
 */
export type SkodaSyncRun = RunBase & {
  source: 'skoda'
  fetchMs: number
  snapshotMs: number
  requests: number
  retries: number
  /** The poll was written to vehicle_state_snapshot. */
  stored: boolean
  /** Whether a valid home point was configured for this run. */
  geofence: 'on' | 'off'
  missingParts: number
  invalidParts: number
  reattributeMs: number
  reattributeChanged: number
}

const SOURCE = 'skoda'
/**
 * Budget for the one GET (10 s per attempt, ≤ 1 retry + ≤ 10 s Retry-After ≈
 * 30 s) plus the insert and re-match. Well under Vercel's 300 s maxDuration,
 * which is under the 5-min lease (ADR-0019), so a slow run still records.
 */
const RUN_DEADLINE_MS = 60_000

// Warn once per instance, not every 15 min; the run line carries `geofence`.
let warnedNoHomePoint = false

export async function runSkodaSync(opts: {
  trigger: SyncTrigger
  now?: () => Date
  deadlineMs?: number
  deps?: { skoda?: SkodaClient; log?: Logger; homePoint?: LatLon | null }
}): Promise<SkodaSyncRun> {
  const client = opts.deps?.skoda ?? skoda
  const stats = newCallStats()
  const homePoint =
    opts.deps && 'homePoint' in opts.deps
      ? (opts.deps.homePoint ?? null)
      : parseHomePoint(process.env.SKODA_HOME_COORDINATES)
  return runPulledSync<SkodaSyncRun>({
    source: SOURCE,
    trigger: opts.trigger,
    now: opts.now ?? (() => new Date()),
    deadlineMs: opts.deadlineMs ?? RUN_DEADLINE_MS,
    log: opts.deps?.log ?? logger,
    init: (base) => ({
      ...base,
      source: SOURCE,
      fetchMs: 0,
      snapshotMs: 0,
      requests: 0,
      retries: 0,
      stored: false,
      geofence: homePoint ? 'on' : 'off',
      missingParts: 0,
      invalidParts: 0,
      reattributeMs: 0,
      reattributeChanged: 0,
    }),
    execute: async ({ run, signal, now, log }) => {
      const { state } = await withDeadline(
        client.vehicleState({ signal, stats }),
        signal,
        () =>
          new SkodaError('unreachable', 'vehicle', undefined, {
            cause: { name: 'TimeoutError' },
            message: 'Škoda vehicle did not answer within the sync deadline',
          }),
      )
      run.missingParts = state.missingParts.length
      run.invalidParts = state.invalidParts.length
      if (run.missingParts + run.invalidParts > 0) {
        // Only allow-listed type codes and our own part names — no API text.
        log.warn('skoda sync: parts missing or invalid', {
          missingParts: state.missingParts,
          invalidParts: state.invalidParts,
        })
      }
      if (!homePoint && !warnedNoHomePoint) {
        warnedNoHomePoint = true
        log.warn('skoda sync: home point unset or invalid, geofence off')
      }
      const started = performance.now()
      await vehicleStateService.recordSnapshot({
        polledAt: now(),
        capturedAt: state.chargingCapturedAt,
        chargingState: state.chargingState,
        chargeType: state.chargeType,
        plugState: state.plugState,
        chargePowerKw: state.chargePowerKw,
        parkingState: state.parking?.state ?? null,
        atHome: atHome(state.parking, homePoint),
        socPercent: state.socPercent,
        odometerKm: state.odometerKm,
        odometerCapturedAt: state.odometerCapturedAt,
      })
      run.snapshotMs = Math.round(performance.now() - started)
      run.stored = true
    },
    // Run-history columns are session-named: for Škoda, sessionsSeen/upserted
    // = 1 when a poll was read/stored (documented in ADR-0022).
    toRunStats: (run) => ({
      since: null,
      pages: 0,
      sessionsSeen: run.stored ? 1 : 0,
      upserted: run.stored ? 1 : 0,
      voided: 0,
      timings: {
        fetchMs: Math.round(stats.fetchMs),
        snapshotMs: run.snapshotMs,
        reattributeMs: run.reattributeMs,
        requests: stats.requests,
        retries: stats.retries,
      },
    }),
    finalize: (run) => {
      run.fetchMs = Math.round(stats.fetchMs)
      run.requests = stats.requests
      run.retries = stats.retries
    },
    logFields: (run) => ({
      fetchMs: run.fetchMs,
      snapshotMs: run.snapshotMs,
      requests: run.requests,
      retries: run.retries,
      stored: run.stored,
      geofence: run.geofence,
      missingParts: run.missingParts,
      invalidParts: run.invalidParts,
      reattributeMs: run.reattributeMs,
      reattributeChanged: run.reattributeChanged,
    }),
  })
}
```

- [ ] **Step 4:** run sync tests → PASS.

- [ ] **Step 5: Cron handler, route, test**

```ts
// src/lib/vehicleState/skodaSyncCron.ts
import { handleCronRun } from '~/lib/integrations/cron'
import { runSkodaSync } from './sync'

// The 15-min Škoda cron entrypoint. Kept out of the route file so the flow is
// unit-testable; the secret gate and status mapping are shared (`handleCronRun`).
export function handleSkodaSyncCron(request: Request): Promise<Response> {
  return handleCronRun(
    request,
    (log) => runSkodaSync({ trigger: 'cron', deps: { log } }),
    (run) => ({ stored: run.stored }),
  )
}
```

```ts
// src/routes/api/cron/skoda-sync.ts
import { createFileRoute } from '@tanstack/react-router'
import { handleSkodaSyncCron } from '~/lib/vehicleState/skodaSyncCron'

// 15-min Vercel Cron target (vite.config.ts `vercel.config.crons`). Auth is
// `Authorization: Bearer $CRON_SECRET`, checked by the handler. Outside the
// `_authenticated` guard, like api/cron/zaptec-sync.ts.
export const Route = createFileRoute('/api/cron/skoda-sync')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => handleSkodaSyncCron(request),
    },
  },
})
```

```ts
// src/lib/vehicleState/skodaSyncCron.test.ts
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { setupDatabase } from '~test/setup'

const control = vi.hoisted(() => ({ throwFromSync: false }))
vi.mock('./sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sync')>()
  return {
    ...actual,
    runSkodaSync: (opts: Parameters<typeof actual.runSkodaSync>[0]) =>
      control.throwFromSync ? Promise.reject(new Error('sync exploded')) : actual.runSkodaSync(opts),
  }
})

import { handleSkodaSyncCron } from './skodaSyncCron'

setupDatabase()

const SECRET = 'test-cron-secret'
const request = (auth?: string) =>
  new Request('http://localhost/api/cron/skoda-sync', { headers: auth ? { authorization: auth } : {} })

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET)
  control.throwFromSync = false
})
afterEach(() => {
  vi.unstubAllEnvs()
})

test('401 without the secret', async () => {
  expect((await handleSkodaSyncCron(request())).status).toBe(401)
})

test('a not-configured run is still a 200 with its summary', async () => {
  const res = await handleSkodaSyncCron(request(`Bearer ${SECRET}`))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ outcome: 'failed', code: 'not_configured', stored: false })
})

test('an unexpected throw is a 500', async () => {
  control.throwFromSync = true
  expect((await handleSkodaSyncCron(request(`Bearer ${SECRET}`))).status).toBe(500)
})
```

Regenerate the route tree with the TanStack Start Vite plugin — **not** `bunx tsr` (the CLI isn't installed and a
floating version would mismatch the locked RC): run `bun run build`, then
`grep -q "/api/cron/skoda-sync" src/routeTree.gen.ts` and commit the regenerated file.

- [ ] **Step 6: Cron registration** — `vite.config.ts` crons, after Zaptec:
  `{ path: '/api/cron/skoda-sync', schedule: '7,22,37,52 * * * *' },` and in the comment block
  `// - Škoda car state every 15 min, offset to :07/:22/:37/:52 so its re-match never runs at the same`
  `//   time as Zaptec's hourly one (src/lib/vehicleState/skodaSyncCron.ts).`

- [ ] **Step 7: CLAUDE.md** — code map `api/cron/` gains `skoda-sync.ts every 15 min (:07 offset)`; `effects/` names
  `skoda` among the pulled clients; `services/` gains `vehicleState`; `db/ schema/{…}` gains `vehicleState`; a `lib/`
  line `vehicleState/  Škoda live-state poll: geofence (home point → boolean), sync + cron (ADR-0022)`; Stack
  "Effects": "Pulled integrations (Zaptec, elpris, Škoda)". Env vars: `SKODA_API_KEY`/`SKODA_VIN` (unset →
  `not_configured`; Vercel Production only — Preview has its own DB but shares the VIN's 20/h quota) and
  `SKODA_HOME_COORDINATES` (never committed/logged; unset → geofence off). ADR index row:
  `| Live vehicle-state attribution (Škoda poll, majority of known time, geofence) | **0022** |`.

- [ ] **Step 8:** `bunx vitest run src/lib/vehicleState src/lib/services/integrationSync` → PASS.
- [ ] **Step 9: Commit** `feat(charging): poll the Škoda API every 15 minutes`

---

### Task 7: procedures + Översikt UI (health, Bilens data, run history)

**Reviewers:** `code-reviewer` (incl. procedure gates: `vehicleStateLatest` and `syncNow` are `adminProcedure`) +
reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:** `src/lib/orpc/procedures/evCharging.ts`, `src/lib/integrationHealthMessage.ts`,
`src/components/evCharging/{SyncHealthAlert,SyncNowButton,VehicleLogCard}.tsx` (+ their `.browser.test.tsx`),
`src/routes/_authenticated/charging/index.tsx`, `messages/{sv,en}.json`.

**Interfaces:**
- Produces: `evCharging.syncStatus({ source: 'skoda' })`, `recentRuns({ source: 'skoda' })`,
  `syncNow({ source: 'skoda' }) → { outcome, code, upserted }`, `vehicleStateLatest() → { polledAt, capturedAt } | null`
  (admin); `useSyncNow().syncSource('skoda')`, `isPendingFor('skoda')`; `VehicleLogCard` optional props
  `live?: RouterOutputs['evCharging']['vehicleStateLatest']`, `liveLoadError?: LoadErrorQuery`,
  `onSyncLive?: () => void`, `syncingLive?: boolean`.

- [ ] **Step 1: Messages** (sv / en)

| key | sv | en |
|---|---|---|
| `charging_health_never_synced_skoda` | Bilens status har inte hämtats ännu. Den hämtas var 15:e minut. | The car's status hasn't been fetched yet. It's fetched every 15 minutes. |
| `charging_health_stale_skoda` | Bilens status har inte kunnat hämtas på ett tag. Nya laddningar räknas som vår bil tills det fungerar igen. | The car's status couldn't be fetched for a while. New sessions count as our car until it works again. |
| `integration_health_error_auth_failed_skoda` | Škoda-nyckeln fungerar inte längre (har den gått ut?). En admin behöver skapa en ny i MyŠkoda-appen. | The Škoda key no longer works (has it expired?). An admin needs to create a new one in the MyŠkoda app. |
| `charging_vehicle_log_title` (change) | Bilens data | Car data |
| `charging_vehicle_import_button` (change) | Importera laddlogg | Import charging log |
| `charging_vehicle_live_last_contact` | Senaste kontakt med bilen | Last contact with the car |
| `charging_vehicle_live_none` | Ingen kontakt med bilen ännu | No contact with the car yet |
| `charging_vehicle_live_error_title` | Senaste kontakten med bilen kunde inte läsas in | The car's last contact couldn't be loaded |
| `charging_sync_skoda_now` | Hämta bilens status | Fetch the car's status |
| `charging_sync_skoda_ok` | Bilens status är uppdaterad | The car's status is up to date |
| `charging_sync_skoda_failed` | Bilens status kunde inte hämtas | The car's status couldn't be fetched |

`charging_vehicle_log_description` stays "Används för att avgöra vilka laddningar som är vår bil." in PR 1 (live
status decides nothing until PR 2).

- [ ] **Step 2: Failing browser tests** (`renderWithProviders` returns `{ screen, queryClient }`; `screen` is the
  vitest-browser-react result, which has `container` and `unmount`)

Append to `SyncHealthAlert.browser.test.tsx`:

```tsx
test('Škoda has its own never-synced copy', async () => {
  const { screen } = await renderWithProviders(
    <SyncHealthAlert health={{ ...base, source: 'skoda', state: 'never_synced' }} isAdmin onRetry={() => {}} retrying={false} />,
  )
  await expect.element(screen.getByText(m.charging_health_never_synced_skoda())).toBeVisible()
})

test('Škoda has its own stale copy', async () => {
  const { screen } = await renderWithProviders(
    <SyncHealthAlert health={{ ...base, source: 'skoda', state: 'stale' }} isAdmin onRetry={() => {}} retrying={false} />,
  )
  await expect.element(screen.getByText(m.charging_health_stale_skoda())).toBeVisible()
})

test('an expired Škoda key says to create a new one', async () => {
  const { screen } = await renderWithProviders(
    <SyncHealthAlert health={{ ...failing, source: 'skoda' }} isAdmin onRetry={() => {}} retrying={false} />,
  )
  await expect.element(screen.getByText(/Škoda-nyckeln fungerar inte längre/)).toBeVisible()
})
```

Append to `VehicleLogCard.browser.test.tsx`:

```tsx
test('shows the last contact with the car as a <time>', async () => {
  const { screen } = await renderWithProviders(
    <VehicleLogCard
      coverage={null}
      live={{ polledAt: new Date('2026-05-04T09:08:13Z'), capturedAt: new Date('2026-05-04T09:08:10Z') }}
      onImport={() => {}}
    />,
  )
  await expect.element(screen.getByText(m.charging_vehicle_live_last_contact(), { exact: false })).toBeVisible()
  await expect.element(screen.getByText(/11:08/)).toBeVisible()
  expect(screen.container.querySelector('time')?.getAttribute('datetime')).toBe('2026-05-04T09:08:10.000Z')
})

test('says there has been no contact yet', async () => {
  const { screen } = await renderWithProviders(<VehicleLogCard coverage={null} live={null} onImport={() => {}} />)
  await expect.element(screen.getByText(m.charging_vehicle_live_none())).toBeVisible()
})

test('the card fetches the car status with its own labelled button', async () => {
  const onSyncLive = vi.fn()
  const { screen } = await renderWithProviders(
    <VehicleLogCard coverage={null} live={null} onImport={() => {}} onSyncLive={onSyncLive} syncingLive={false} />,
  )
  await screen.getByRole('button', { name: m.charging_sync_skoda_now() }).click()
  expect(onSyncLive).toHaveBeenCalledOnce()
})
```

In `SyncNowButton.browser.test.tsx`, add `'skoda'` to the `respond` helper's source type and a case mirroring the
existing elpris-retry test: `syncSource('skoda')` calls `syncNow` with `{ source: 'skoda' }` and toasts
`m.charging_sync_skoda_ok()`; and assert `isPending` stays false while only the Škoda mutation is in flight.

- [ ] **Step 3:** `bunx vitest run --project browser src/components/evCharging/SyncHealthAlert.browser.test.tsx src/components/evCharging/VehicleLogCard.browser.test.tsx src/components/evCharging/SyncNowButton.browser.test.tsx` → FAIL.

- [ ] **Step 4: Procedures** (`evCharging.ts`)
  - `const chargingSource = z.enum(['zaptec', 'elpris', 'skoda'])`; doc comment "sessions (Zaptec), spot prices
    (elpris) and the car's live state (Škoda)".
  - Imports `runSkodaSync` from `~/lib/vehicleState/sync` and `* as vehicleStateService from '~/lib/services/vehicleState'`.
  - After `vehicleRecordCoverage`:
    ```ts
      // Admin card: when the Škoda poll last heard from the car (ADR-0022). Times only.
      vehicleStateLatest: adminProcedure.handler(() => vehicleStateService.latestSnapshot()),
    ```
  - In `syncNow`, before the elpris branch:
    ```ts
        if (input?.source === 'skoda') {
          const run = await runSkodaSync({ trigger: 'admin', deps: { log: context.log } })
          if (context.timings) {
            context.timings.skodaSyncMs = run.durationMs
            context.timings.skodaFetchMs = run.fetchMs
            context.timings.skodaSnapshotMs = run.snapshotMs
            context.timings.skodaReattributeMs = run.reattributeMs
          }
          return { outcome: run.outcome, code: run.code, upserted: run.stored ? 1 : 0 }
        }
    ```

- [ ] **Step 5: Health copy** — `integrationHealthMessage.ts`:
  ```ts
      case 'auth_failed':
        // An expired key is the expected Škoda failure; say what fixes it.
        return options.source === 'skoda'
          ? m.integration_health_error_auth_failed_skoda({}, opts)
          : m.integration_health_error_auth_failed({ source }, opts)
  ```
  `SyncHealthAlert.tsx`: `neverSyncedCopy`/`staleCopy` skoda → the new messages; comment "…the car's state polls
  every 15 min and feeds attribution".

- [ ] **Step 6: `useSyncNow`** (`SyncNowButton.tsx`) — `type SyncSource = 'zaptec' | 'elpris' | 'skoda'`; add

```ts
  // The car's live state: an explicit admin action, so confirm either way.
  const car = useMutation(
    orpc.evCharging.syncNow.mutationOptions({
      onSuccess: (result) => {
        switch (result.outcome) {
          case 'ok':
            toast.success(m.charging_sync_skoda_ok())
            return
          case 'skipped':
            toast.info(m.charging_sync_skipped())
            return
          case 'failed':
          case 'error':
            toast.error(m.charging_sync_skoda_failed(), {
              description: integrationErrorMessage(result.code ?? 'internal_error', { source: 'skoda' }),
            })
            return
        }
      },
      onError: () =>
        toast.error(m.charging_sync_skoda_failed(), {
          description: integrationErrorMessage('internal_error', { source: 'skoda' }),
        }),
      onSettled: invalidate,
    }),
  )
```

  `syncSource`: skoda → `car.mutate({ source: 'skoda' })`; `isPendingFor('skoda')` → `car.isPending`. **`isPending`
  and `syncAll` stay Zaptec + elpris** (the heading button doesn't sync the car).

- [ ] **Step 7: Card** (`VehicleLogCard.tsx`) — props as in **Interfaces** (all optional; existing tests unchanged).
  `CardAction` keeps only the import button. `CardContent` becomes `className="flex flex-col gap-2 text-sm"` with,
  after the coverage block:

```tsx
        {liveFailed && liveLoadError ? (
          <LoadErrorAlert title={m.charging_vehicle_live_error_title()} query={liveLoadError} />
        ) : live !== undefined ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            {live ? (
              <p>
                {m.charging_vehicle_live_last_contact()}{' '}
                <time dateTime={(live.capturedAt ?? live.polledAt).toISOString()}>
                  {formatDateTime(live.capturedAt ?? live.polledAt)}
                </time>
              </p>
            ) : (
              <p className="text-muted-foreground">{m.charging_vehicle_live_none()}</p>
            )}
            {onSyncLive ? (
              <SyncNowButton onSync={onSyncLive} pending={syncingLive ?? false} label={m.charging_sync_skoda_now()} />
            ) : null}
          </div>
        ) : null}
```

  where `const liveFailed = liveLoadError !== undefined && loadFailed(liveLoadError)` and `formatDateTime` comes
  from `./format`. Component comment: "…the car's own log decides which sessions are ours (ADR-0021); the live
  poll's last contact shows here (ADR-0022)."

- [ ] **Step 8: Route** (`charging/index.tsx`)
  - Next to `pricesHealthQuery`:
    ```ts
    const skodaHealthQuery = orpc.evCharging.syncStatus.queryOptions({ input: { source: 'skoda' } })
    const skodaRunsQuery = orpc.evCharging.recentRuns.queryOptions({ input: { source: 'skoda', limit: RECENT_RUNS } })
    const vehicleLatestQuery = orpc.evCharging.vehicleStateLatest.queryOptions()
    ```
  - Loader (admin only, **prefetchQuery** — a failed read must not take the page down):
    `user.role === 'admin' ? queryClient.prefetchQuery(skodaHealthQuery) : null`, same for `skodaRunsQuery` and
    `vehicleLatestQuery`.
  - Component: `const { data: skodaHealth } = useQuery({ ...skodaHealthQuery, enabled: isAdmin })`,
    `const { data: skodaRuns } = useQuery({ ...skodaRunsQuery, enabled: isAdmin })`,
    `const vehicleLatest = useQuery({ ...vehicleLatestQuery, enabled: isAdmin })`.
  - After the prices alert:
    `{isAdmin && skodaHealth ? <SyncHealthAlert health={skodaHealth} isAdmin onRetry={() => syncNow.syncSource('skoda')} retrying={syncNow.isPendingFor('skoda')} /> : null}`
    with the comment "Admin-only like prices: a household member can't act on the car feed."
  - `VehicleLogCard`: `live={vehicleLatest.data}`, `liveLoadError={vehicleLatest}`,
    `onSyncLive={() => syncNow.syncSource('skoda')}`, `syncingLive={syncNow.isPendingFor('skoda')}`.
  - After the elpris runs card: `{isAdmin && skodaRuns ? <RecentRunsCard source="skoda" runs={skodaRuns} /> : null}`.

- [ ] **Step 9:** `bunx vitest run --project browser src/components/evCharging && bun run typecheck` → PASS.
- [ ] **Step 10: Commit** `feat(charging): show the Škoda poll's health and last contact`

### PR 1 close-out

- [ ] Before the first push: migration-guard + schema-design approval of 0009 (frozen after push).
- [ ] Branch review: `code-reviewer`, `migration-guard` + schema-design, `test-completeness`, a security pass on
  key/VIN/coordinate/presence handling. Fix every finding in this PR.
- [ ] Pre-PR gate (`docs/feature-workflow.md#pre-pr-gate`). Live (uses the real VIN quota — keep it to a few calls):
  `bun run dev`, admin "Hämta bilens status" on the card → a row appears, the card shows the time;
  `curl -H "Authorization: Bearer $CRON_SECRET" localhost:14600/api/cron/skoda-sync` → 200. Responsive check of
  Översikt at desktop / tablet / mobile.
- [ ] Open PR `feat(charging): poll the Škoda API for the car's state`. After merge the owner sets `SKODA_API_KEY`,
  `SKODA_VIN`, `SKODA_HOME_COORDINATES` in Vercel **Production** only (runbook lands in PR 3).

---

# PR 2 — `feat(charging): attribute new sessions from the car's live state`

Branch `feat/skoda-live-attribution` from `feat/skoda-state-poll`. After PR 1 squash-merges:
`git rebase --onto main <PR1 head> feat/skoda-live-attribution`, then check `drizzle/meta/_journal.json` and the
snapshot `prevId` chain.

### Task 8: `skoda_live` vehicle source + migration

**Reviewers:** `migration-guard` + schema-design reviewer.

**Files:** `src/lib/evCharging/vehicle.ts`, `src/components/evCharging/SessionVehicle.tsx`, `messages/{sv,en}.json`,
generated `drizzle/0010_vehicle_source_skoda_live.sql`.

- [ ] **Step 1:** `export const VEHICLE_SOURCES = ['default', 'skoda', 'skoda_live', 'admin'] as const`; doc comment
  "nobody decided (counts as ours), the car's exported log, the car's live state (ADR-0022), or an admin".
- [ ] **Step 2:** `bun run db:generate --name=vehicle_source_skoda_live && bun run db:migrate`. Expected SQL: DROP +
  ADD `ev_charge_session_vehicle_source_check` with the four values, nothing else (stop if anything more appears).
- [ ] **Step 3:** so the tree compiles, add `skoda_live: m.charging_vehicle_source_skoda_live` to `SOURCE_LABEL` in
  `SessionVehicle.tsx` and the message sv `"enligt bilens status"` / en `"according to the car's status"`.
- [ ] **Step 4:** `bun run typecheck && bunx vitest run src/lib/services/evCharging test/rls.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(charging): add the live Škoda vehicle source`

PR note: once `skoda_live` rows exist, an instant rollback to PR 1 code can't label them — roll forward instead.

### Task 9: the live rule in `reattributeSessions` + sync hook

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:** `src/lib/services/evCharging/attribution.ts` (+ test), `src/lib/vehicleState/sync.ts` (+ test),
`src/lib/orpc/procedures/evCharging.ts` (comment only).

**Interfaces:** `reattributeSessions({ sessionId? }) → { ours, other, changed }` — unchanged; counts include both
branches.

- [ ] **Step 1: Failing rule tests** — append to `attribution.test.ts` (import `insertSnapshot` from the fixtures):

```ts
// Live rule (ADR-0022): polls every `stepMin` between `from` and `to` (inclusive).
async function pollEvery(
  from: string,
  to: string,
  fields: { plugState?: string | null; atHome?: boolean | null } = {},
  stepMin = 15,
) {
  for (let t = at(from).getTime(); t <= at(to).getTime(); t += stepMin * 60_000) {
    await insertSnapshot({ polledAt: new Date(t), plugState: 'CONNECTED', atHome: true, ...fields })
  }
}
const liveSession = (start: string, end: string, extra: Partial<Parameters<typeof insertSession>[0]> = {}) =>
  insertSession({ startAt: at(start), endAt: at(end), ...extra })

test('live: plugged in at home throughout → ours, skoda_live', async () => {
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T12:00:00Z')
  await pollEvery('2026-10-02T08:45:00Z', '2026-10-02T12:15:00Z')
  expect(await reattributeSessions()).toEqual({ ours: 1, other: 0, changed: 1 })
  expect(await attribution(id)).toMatchObject({ vehicle: 'ours', source: 'skoda_live' })
})

test('live: unplugged throughout → guest', async () => {
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T12:00:00Z')
  await pollEvery('2026-10-02T08:45:00Z', '2026-10-02T12:15:00Z', { plugState: 'DISCONNECTED' })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ vehicle: 'other', source: 'skoda_live' })
})

test('live: connected but parked away (or moving) → guest', async () => {
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T12:00:00Z')
  await pollEvery('2026-10-02T08:45:00Z', '2026-10-02T12:15:00Z', { atHome: false })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ vehicle: 'other', source: 'skoda_live' })
})

test('live: connected with an unknown position → plug state alone → ours', async () => {
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T12:00:00Z')
  await pollEvery('2026-10-02T08:45:00Z', '2026-10-02T12:15:00Z', { atHome: null })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ vehicle: 'ours', source: 'skoda_live' })
})

test('live: stale CONNECTED at the start of a long guest session is outvoted → guest', async () => {
  const id = await liveSession('2026-10-02T12:00:00Z', '2026-10-02T15:00:00Z')
  // The session ends at 12:00; the car keeps claiming CONNECTED for ≈27 min more (as in the probe).
  await pollEvery('2026-10-02T12:00:00Z', '2026-10-02T12:30:00Z')
  await pollEvery('2026-10-02T12:45:00Z', '2026-10-02T15:00:00Z', { plugState: 'DISCONNECTED' })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ vehicle: 'other', source: 'skoda_live' })
})

test('live: the 10-min margin decides — with it ours, without it it would be guest', async () => {
  // Session 09:00–09:50, window 09:10–09:40. Intervals: D 08:58–09:12, C 09:12–09:30,
  // D 09:30–09:45, D 09:45–10:05. With the margin: here 18, away 12 → ours.
  // Without it (09:00–09:50): here 18, away 32 → guest.
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T09:50:00Z')
  await insertSnapshot({ polledAt: at('2026-10-02T08:58:00Z'), plugState: 'DISCONNECTED' })
  await insertSnapshot({ polledAt: at('2026-10-02T09:12:00Z') })
  await insertSnapshot({ polledAt: at('2026-10-02T09:30:00Z'), plugState: 'DISCONNECTED' })
  await insertSnapshot({ polledAt: at('2026-10-02T09:45:00Z'), plugState: 'DISCONNECTED' })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ vehicle: 'ours', source: 'skoda_live' })
})

test('live: a session under 40 minutes is never decided', async () => {
  // 35 min → a 15-min window; dense DISCONNECTED polls would otherwise decide guest.
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T09:35:00Z')
  await pollEvery('2026-10-02T08:47:00Z', '2026-10-02T09:47:00Z', { plugState: 'DISCONNECTED' }, 5)
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ source: 'default' })
})

test('live: known time under half the window leaves the session unchanged', async () => {
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T13:00:00Z')
  // Window 09:10–12:50 (220 min); two polls know 35 min (09:15–09:30, 09:30–09:50).
  await pollEvery('2026-10-02T09:15:00Z', '2026-10-02T09:30:00Z', { plugState: 'DISCONNECTED' })
  expect(await reattributeSessions()).toEqual({ ours: 0, other: 0, changed: 0 })
  expect(await attribution(id)).toMatchObject({ vehicle: 'ours', source: 'default' })
})

test('live: a long gap between polls is not bridged', async () => {
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T12:00:00Z')
  await insertSnapshot({ polledAt: at('2026-10-02T09:10:00Z'), plugState: 'DISCONNECTED' })
  await insertSnapshot({ polledAt: at('2026-10-02T11:30:00Z'), plugState: 'DISCONNECTED' })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ source: 'default' })
})

test("live: an unknown poll ends the previous poll's interval", async () => {
  // Window 09:10–10:50 (100 min). C 09:00, ? 09:15, C 09:30, ? 09:45, C 10:00, ? 10:15–10:45:
  // known here = 5 + 15 + 15 = 35 < 50 → unchanged. Dropping unknowns before lead() would count 50.
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T11:00:00Z')
  const polls = [
    ['09:00', 'CONNECTED'],
    ['09:15', null],
    ['09:30', 'CONNECTED'],
    ['09:45', null],
    ['10:00', 'CONNECTED'],
    ['10:15', null],
    ['10:30', null],
    ['10:45', null],
  ] as const
  for (const [time, plugState] of polls) {
    await insertSnapshot({ polledAt: at(`2026-10-02T${time}:00Z`), plugState, atHome: null })
  }
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ source: 'default' })
})

test('live: polls with no plug state are unknown, not evidence', async () => {
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T12:00:00Z')
  await pollEvery('2026-10-02T08:45:00Z', '2026-10-02T12:15:00Z', { plugState: null, atHome: true })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ source: 'default' })
})

test('live: polls far outside the window do not change the result', async () => {
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T12:00:00Z')
  await pollEvery('2026-10-02T08:45:00Z', '2026-10-02T12:15:00Z')
  await pollEvery('2026-10-01T00:00:00Z', '2026-10-02T08:00:00Z', { plugState: 'DISCONNECTED' }, 60)
  await pollEvery('2026-10-02T13:00:00Z', '2026-10-03T00:00:00Z', { plugState: 'DISCONNECTED' }, 60)
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ vehicle: 'ours', source: 'skoda_live' })
})

test('live: a session with an unreliable clock is left alone', async () => {
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T12:00:00Z', { reliableClock: false })
  await pollEvery('2026-10-02T08:45:00Z', '2026-10-02T12:15:00Z', { plugState: 'DISCONNECTED' })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ source: 'default' })
})

test('live: a tie goes to ours', async () => {
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T10:20:00Z')
  // Window 09:10–10:10: 30 min here, 30 min not here.
  await insertSnapshot({ polledAt: at('2026-10-02T09:10:00Z') })
  await insertSnapshot({ polledAt: at('2026-10-02T09:25:00Z') })
  await insertSnapshot({ polledAt: at('2026-10-02T09:40:00Z'), plugState: 'DISCONNECTED' })
  await insertSnapshot({ polledAt: at('2026-10-02T09:55:00Z'), plugState: 'DISCONNECTED' })
  await insertSnapshot({ polledAt: at('2026-10-02T10:10:00Z'), plugState: 'DISCONNECTED' })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ vehicle: 'ours', source: 'skoda_live' })
})

test('live: the exported log keeps deciding inside its coverage; admin tags stay', async () => {
  await seedCoverage() // 2026-02-01 → 2026-03-31
  const logged = await liveSession('2026-02-10T10:00:00Z', '2026-02-10T12:00:00Z')
  await pollEvery('2026-02-10T09:45:00Z', '2026-02-10T12:15:00Z') // would say ours
  const tagged = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T12:00:00Z')
  await setSessionVehicle(tagged, 'other')
  await pollEvery('2026-10-02T08:45:00Z', '2026-10-02T12:15:00Z')
  await reattributeSessions()
  expect(await attribution(logged)).toMatchObject({ vehicle: 'other', source: 'skoda' })
  expect(await attribution(tagged)).toMatchObject({ vehicle: 'other', source: 'admin' })
})

test('live: a second pass changes nothing; sessionId narrows the live branch too', async () => {
  const a = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T12:00:00Z')
  const b = await liveSession('2026-10-03T09:00:00Z', '2026-10-03T12:00:00Z')
  await pollEvery('2026-10-02T08:45:00Z', '2026-10-02T12:15:00Z')
  await pollEvery('2026-10-03T08:45:00Z', '2026-10-03T12:15:00Z', { plugState: 'DISCONNECTED' })
  expect(await reattributeSessions({ sessionId: a })).toEqual({ ours: 1, other: 0, changed: 1 })
  expect(await attribution(b)).toMatchObject({ source: 'default' })
  await reattributeSessions()
  expect(await reattributeSessions()).toEqual({ ours: 1, other: 1, changed: 0 })
})

test('live: setSessionVehicle(null) re-derives from the live state', async () => {
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T12:00:00Z')
  await pollEvery('2026-10-02T08:45:00Z', '2026-10-02T12:15:00Z', { plugState: 'DISCONNECTED' })
  await setSessionVehicle(id, 'ours')
  expect(await setSessionVehicle(id, null)).toEqual({ vehicle: 'other', vehicleSource: 'skoda_live' })
})
```

- [ ] **Step 2:** `bunx vitest run src/lib/services/evCharging/attribution.test.ts` → the `live:` tests FAIL, old ones
  PASS.

- [ ] **Step 3: Implement** — replace the doc comment and SQL of `reattributeSessions` (keep the non-uuid guard). Do
  **not** alias `${s}`: `countedSessionFilter()` and `${s.…}` render the qualified table name.

```ts
/**
 * Re-derives attribution (ADR-0021, ADR-0022). Precedence: admin > the car's
 * exported log inside its coverage > the car's live state > default.
 * - Exported log: a counted session starting inside the log's coverage is
 *   'ours' when a non-public record overlaps it, else 'other' (source 'skoda').
 * - Live state, for sessions outside that coverage, ≥ 40 min long and with a
 *   reliable clock: each poll holds until the next one (≤ 20 min) and is *here*
 *   (plug CONNECTED, not known to be away) or *not here* (DISCONNECTED, moving,
 *   or parked elsewhere); unknown polls count for neither but still end the
 *   previous poll's interval. Over the session trimmed by 10 min at each end,
 *   once known time covers half of it, the majority decides, a tie going to
 *   ours (source 'skoda_live'). Otherwise the row is left as it is.
 *   Polls are read per window through a LATERAL bounded on polled_at (index),
 *   so the cost doesn't grow with the snapshot table.
 * One statement; rows already right aren't written (updated_at untouched).
 * `ours`/`other` count every session a rule decided, `changed` the rows written.
 */
```

```ts
  const s = evChargeSession
  // Cross-service reads of vehicle_charge_record (services/vehicleCharge) and
  // vehicle_state_snapshot (services/vehicleState): deliberate, read-only, see
  // ADR-0021 and ADR-0022.
  const r = vehicleChargeRecord
  const p = vehicleStateSnapshot
  const onlyOne = opts.sessionId !== undefined ? sql`and ${s.id} = ${opts.sessionId}` : sql``
  const result = await db.execute<{ ours: string; other: string; changed: string }>(sql`
    with coverage as (
      select min(${r.startAt}) as from_at, max(${r.endAt}) as to_at from ${r}
    ),
    candidate as (
      select ${s.id} as id, ${s.startAt} as start_at, ${s.endAt} as end_at,
        ${s.reliableClock} as reliable_clock,
        (coverage.from_at is not null
          and ${s.startAt} between coverage.from_at and coverage.to_at) as in_log
      from ${s}, coverage
      where ${s.vehicleSource} <> 'admin' and ${countedSessionFilter()} ${onlyOne}
    ),
    logged as (
      select c.id,
        case when exists (
          select 1 from ${r}
          where not ${r.isPublic} and ${r.startAt} < c.end_at and ${r.endAt} > c.start_at
        ) then 'ours' else 'other' end as vehicle,
        'skoda'::text as source
      from candidate c
      where c.in_log
    ),
    live_window as (
      select c.id, c.start_at + interval '10 minutes' as w_from, c.end_at - interval '10 minutes' as w_to
      from candidate c
      where not c.in_log and c.reliable_clock and c.end_at - c.start_at >= interval '40 minutes'
    ),
    live_evidence as (
      select w.id, w.w_from, w.w_to,
        coalesce(sum(x.overlap_s) filter (where x.class = 'here'), 0) as here_s,
        coalesce(sum(x.overlap_s) filter (where x.class = 'not_here'), 0) as away_s
      from live_window w
      cross join lateral (
        select extract(epoch from least(q.to_at, w.w_to) - greatest(q.from_at, w.w_from)) as overlap_s, q.class
        from (
          select ${p.polledAt} as from_at,
            least(
              coalesce(lead(${p.polledAt}) over (order by ${p.polledAt}, ${p.id}), ${p.polledAt} + interval '20 minutes'),
              ${p.polledAt} + interval '20 minutes'
            ) as to_at,
            case
              when ${p.atHome} = false or ${p.plugState} = 'DISCONNECTED' then 'not_here'
              when ${p.plugState} = 'CONNECTED' then 'here'
            end as class
          from ${p}
          -- A poll before w_from − 20 min ends before the window; one at or after
          -- w_to starts after it. Polls in between (unknown ones included) are
          -- all that lead() and the overlap can need.
          where ${p.polledAt} > w.w_from - interval '20 minutes' and ${p.polledAt} < w.w_to
        ) q
        where q.class is not null and q.from_at < w.w_to and q.to_at > w.w_from
      ) x
      group by w.id, w.w_from, w.w_to
    ),
    live as (
      select e.id, case when e.here_s >= e.away_s then 'ours' else 'other' end as vehicle,
        'skoda_live'::text as source
      from live_evidence e
      where e.here_s + e.away_s >= extract(epoch from e.w_to - e.w_from) / 2
    ),
    target as (
      select id, vehicle, source from logged
      union all
      select id, vehicle, source from live
    ),
    -- target reads a snapshot from statement start. If an admin tags (or a
    -- sync voids) a row while this UPDATE waits on its lock, READ COMMITTED
    -- re-checks only this WHERE against the new row version, so the admin and
    -- counted rules are repeated here, or the re-match would overwrite the tag.
    updated as (
      update ${s} set vehicle = target.vehicle, vehicle_source = target.source, updated_at = now()
      from target
      where ${s.id} = target.id
        and ${s.vehicleSource} <> 'admin'
        and ${countedSessionFilter()}
        and (${s.vehicle} <> target.vehicle or ${s.vehicleSource} <> target.source)
      returning ${s.id}
    )
    select
      count(*) filter (where target.vehicle = 'ours') as ours,
      count(*) filter (where target.vehicle = 'other') as other,
      (select count(*) from updated) as changed
    from target
  `)
```

Add `vehicleStateSnapshot` to the schema import. Inside the lateral, `${p.polledAt}` renders
`"vehicle_state_snapshot"."polled_at"` — valid, since that subquery's FROM is `${p}`. (A reviewer verified this SQL,
rendered as Drizzle renders it, against Postgres: all `live:` tests and the old ones give the asserted results;
≈20–30 ms on 2–3 years of synthetic polls vs 5–10 s for an unbounded `lead()`.)

- [ ] **Step 4:** `bunx vitest run src/lib/services/evCharging` → PASS (all old tests, incl. the admin-tag race, and
  every `live:` test).

- [ ] **Step 5: Wire the re-match into the Škoda sync** — `sync.ts` imports
  `* as evChargingService from '~/lib/services/evCharging'` and, after `run.stored = true`:

```ts
      // A fresh poll can decide sessions the last Zaptec sync already imported.
      // Health tracks the poll, not attribution: a failure here only warns.
      const rematchStart = performance.now()
      try {
        if (signal.aborted) {
          log.warn('skoda sync: vehicle re-match skipped, run deadline reached')
        } else {
          const result = await withDeadline(
            evChargingService.reattributeSessions(),
            signal,
            () => new Error('vehicle re-match did not finish within the sync deadline'),
          )
          run.reattributeChanged = result.changed
        }
      } catch (error) {
        log.warn('skoda sync: vehicle re-match failed', { error })
      } finally {
        run.reattributeMs = Math.round(performance.now() - rematchStart)
      }
```

Append to `sync.test.ts` (imports: `* as evChargingService from '~/lib/services/evCharging'`; `insertSession`,
`insertSnapshot` from `~test/fixtures/evCharging`; `evChargeSession`; `eq` from `drizzle-orm`):

```ts
test('a poll re-derives attribution for sessions already imported', async () => {
  const id = await insertSession({
    startAt: new Date('2026-05-04T06:00:00Z'),
    endAt: new Date('2026-05-04T08:30:00Z'),
  })
  for (let t = Date.parse('2026-05-04T05:45:00Z'); t <= Date.parse('2026-05-04T08:45:00Z'); t += 900_000) {
    await insertSnapshot({ polledAt: new Date(t), plugState: 'DISCONNECTED' })
  }
  const result = await run(fakeSkoda(async () => reading()))
  expect(result.reattributeChanged).toBe(1)
  const [row] = await db.select().from(evChargeSession).where(eq(evChargeSession.id, id))
  expect(row).toMatchObject({ vehicle: 'other', vehicleSource: 'skoda_live' })
})

test('a failed re-match is a warning and the poll still counts', async () => {
  vi.spyOn(evChargingService, 'reattributeSessions').mockRejectedValueOnce(new Error('db hiccup'))
  const { log, entries } = capturingLogger()
  const result = await run(fakeSkoda(async () => reading()), { log })
  expect(result).toMatchObject({ outcome: 'ok', stored: true, reattributeChanged: 0 })
  expect(entries().some((e) => e.msg === 'skoda sync: vehicle re-match failed')).toBe(true)
})
```

In `evCharging.ts` `importVehicleRecords`, extend the comment: "`ours`/`other` count every session any rule decided —
including the live branch (ADR-0022) — not just the import's."

- [ ] **Step 6:** `bunx vitest run src/lib/vehicleState src/lib/services/evCharging` → PASS.
- [ ] **Step 7: Commit** `feat(charging): attribute sessions from the car's live state`

### Task 10: session-page copy + docs

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:** `src/components/evCharging/SessionVehicle.browser.test.tsx`, `messages/{sv,en}.json`,
`docs/adr/0021-charging-session-vehicle-attribution.md`, `docs/superpowers/specs/2026-09-28-ev-charging-scope-map.md`.

- [ ] **Step 1: Test** (append):

```tsx
test('a live-state attribution says it came from the car', async () => {
  const { screen } = await renderWithProviders(
    <SessionVehicle
      sessionId="00000000-0000-4000-8000-000000000001"
      vehicle="other"
      vehicleSource="skoda_live"
      isAdmin={false}
    />,
  )
  await expect
    .element(screen.getByText(`${m.charging_vehicle_other()} · ${m.charging_vehicle_source_skoda_live()}`))
    .toBeVisible()
})
```

- [ ] **Step 2: Copy** — `charging_vehicle_log_description` becomes sv "Bilens laddlogg och bilens senaste status avgör
  vilka laddningar som är vår bil." / en "The car's charging log and its latest status decide which sessions are our
  car."
- [ ] **Step 3: Docs** — ADR-0021 status `Accepted — extended by [ADR-0022](./0022-live-vehicle-state-attribution.md)`;
  its consequence "Sessions after the export are 'ours · antaget' until tagged" gains "— until ADR-0022's live poll
  decides them (sessions ≥ 40 min)". Scope map step 4: prefix `**Built 2026-10 (ADR-0022)** —` and note the majority
  rule replaced "any snapshot inside the window".
- [ ] **Step 4:** `bunx vitest run --project browser src/components/evCharging/SessionVehicle.browser.test.tsx` → PASS.
- [ ] **Step 5: Commit** `docs(charging): record live attribution in ADR-0021 and the scope map`

### PR 2 close-out

- [ ] 0010 approved by migration-guard + schema-design before the first push (then frozen).
- [ ] Branch review (`code-reviewer`, `test-completeness`, migration reviewers). Pre-PR gate. Live: with real polls
  stored locally from PR 1's runs, insert a session over a sampled window (or run a Zaptec sync) and confirm the
  session page shows "· enligt bilens status".
- [ ] Open PR `feat(charging): attribute new sessions from the car's live state`, base `feat/skoda-state-poll`; note
  the roll-forward-only point.

---

# PR 3 — `feat(charging): remind admins before the Škoda API key expires`

Branch `feat/skoda-key-reminder` from `feat/skoda-live-attribution` (same rebase-onto procedure after PR 2 merges).

### Task 11: credential-expiry vocabulary, columns + migration

**Reviewers:** `migration-guard` + schema-design reviewer.

**Files:** `src/lib/integrationHealth.ts`, `src/lib/db/schema/integrationSync.ts`, generated
`drizzle/0011_integration_sync_credential_expiry.sql`.

- [ ] **Step 1: Client-safe vocabulary** — append to `src/lib/integrationHealth.ts`:

```ts
/** Sources whose credential expires and is renewed by hand (ADR-0022). */
export const EXPIRING_CREDENTIAL_SOURCES = ['skoda'] as const
export type ExpiringCredentialSource = (typeof EXPIRING_CREDENTIAL_SOURCES)[number]
/** Admins see a warning from this many days before expiry (while the source is healthy). */
export const CREDENTIAL_WARN_DAYS = 30
/** Reminder emails, largest first; each sent once per expiry date. */
export const CREDENTIAL_REMINDER_DAYS = [30, 7] as const
export type CredentialReminderDays = (typeof CREDENTIAL_REMINDER_DAYS)[number]
```

- [ ] **Step 2: Columns** — in `integrationSync` after `lastErrorMessage`:

```ts
    // Last expiry the source's credential reported (Škoda's X-API-Key-Expires-At);
    // null for sources without one.
    credentialExpiresAt: timestamp('credential_expires_at', { withTimezone: true }),
    // The smallest reminder threshold already emailed for this expiry; reset to
    // null whenever credential_expires_at changes (a renewed key).
    credentialReminderDays: smallint('credential_reminder_days'),
```

CHECKs (import `smallint` and `CREDENTIAL_REMINDER_DAYS`):

```ts
    check(
      'integration_sync_credential_reminder_days_check',
      sql`${table.credentialReminderDays} IS NULL OR ${table.credentialReminderDays} IN (${sql.raw(CREDENTIAL_REMINDER_DAYS.join(', '))})`,
    ),
    check(
      'integration_sync_credential_reminder_expiry_check',
      sql`${table.credentialReminderDays} IS NULL OR ${table.credentialExpiresAt} IS NOT NULL`,
    ),
```

- [ ] **Step 3:** `bun run db:generate --name=integration_sync_credential_expiry && bun run db:migrate`; read the SQL
  (two nullable ADD COLUMNs + two CHECKs, `IN (30, 7)` literal; no rewrite).
- [ ] **Step 4:** `bunx vitest run src/lib/services/integrationSync test/rls.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(charging): track when an integration's credential expires`

### Task 12: credential expiry in the integrationSync service

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:** create `src/lib/services/integrationSync/credential.ts` (+ `credential.test.ts`); modify
`integrationSync.ts` (`adminDetail` gains `credentialExpiry`), `index.ts`, and typed `Health` fixtures flagged by
`bun run typecheck` (e.g. `SyncHealthAlert.browser.test.tsx`'s `failing.adminDetail`).

**Interfaces:**
- Produces:
  ```ts
  export type CredentialExpiry = { expiresAt: Date; daysLeft: number; warn: boolean }
  // IntegrationHealth.adminDetail: { lastErrorMessage: string | null; credentialExpiry: CredentialExpiry | null } | null
  export function credentialExpiryOf(expiresAt: Date | null, now: Date): CredentialExpiry | null
  export async function recordCredentialExpiry(source: IntegrationSource, expiresAt: Date | null): Promise<void>
  export type CredentialReminderClaim = { days: CredentialReminderDays; expiresAt: Date; previous: CredentialReminderDays | null }
  export async function claimCredentialReminder(source: IntegrationSource, now: Date): Promise<CredentialReminderClaim | null>
  export async function releaseCredentialReminder(source: IntegrationSource, claim: CredentialReminderClaim): Promise<void>
  ```

- [ ] **Step 1: Failing tests**

```ts
// src/lib/services/integrationSync/credential.test.ts
import { expect, test } from 'vitest'
import { setupDatabase } from '~test/setup'
import {
  claimCredentialReminder,
  credentialExpiryOf,
  recordCredentialExpiry,
  releaseCredentialReminder,
} from './credential'
import { beginAttempt, getHealth } from './integrationSync'

setupDatabase()

const EXPIRES = new Date('2027-01-15T12:00:00.500Z')
const daysBefore = (d: number) => new Date(EXPIRES.getTime() - d * 86_400_000)
const seed = () => beginAttempt('skoda', { now: daysBefore(200) }) // creates the row

test('credentialExpiryOf: days left rounded up, warning from 30 days', () => {
  expect(credentialExpiryOf(null, daysBefore(10))).toBeNull()
  expect(credentialExpiryOf(EXPIRES, daysBefore(31))).toEqual({ expiresAt: EXPIRES, daysLeft: 31, warn: false })
  expect(credentialExpiryOf(EXPIRES, daysBefore(30))).toEqual({ expiresAt: EXPIRES, daysLeft: 30, warn: true })
  expect(credentialExpiryOf(EXPIRES, daysBefore(0.5))).toMatchObject({ daysLeft: 1, warn: true })
  expect(credentialExpiryOf(EXPIRES, daysBefore(-1))).toMatchObject({ daysLeft: 0, warn: true })
})

test('no reminder before 30 days; one at 30, none again, one at 7, none again', async () => {
  await seed()
  await recordCredentialExpiry('skoda', EXPIRES)
  expect(await claimCredentialReminder('skoda', daysBefore(31))).toBeNull()
  expect(await claimCredentialReminder('skoda', daysBefore(30))).toEqual({ days: 30, expiresAt: EXPIRES, previous: null })
  expect(await claimCredentialReminder('skoda', daysBefore(20))).toBeNull()
  expect(await claimCredentialReminder('skoda', daysBefore(7))).toEqual({ days: 7, expiresAt: EXPIRES, previous: 30 })
  expect(await claimCredentialReminder('skoda', daysBefore(1))).toBeNull()
})

test('first seen at 5 days left claims only the 7-day reminder', async () => {
  await seed()
  await recordCredentialExpiry('skoda', EXPIRES)
  expect(await claimCredentialReminder('skoda', daysBefore(5))).toMatchObject({ days: 7, previous: null })
  expect(await claimCredentialReminder('skoda', daysBefore(4))).toBeNull()
})

test('two concurrent claims claim once', async () => {
  await seed()
  await recordCredentialExpiry('skoda', EXPIRES)
  const claims = await Promise.all([
    claimCredentialReminder('skoda', daysBefore(29)),
    claimCredentialReminder('skoda', daysBefore(29)),
  ])
  expect(claims.filter((c) => c !== null)).toHaveLength(1)
})

test('a released claim is claimed again on the next poll', async () => {
  await seed()
  await recordCredentialExpiry('skoda', EXPIRES)
  const claim = await claimCredentialReminder('skoda', daysBefore(7))
  if (!claim) throw new Error('expected a claim')
  await releaseCredentialReminder('skoda', claim)
  expect(await claimCredentialReminder('skoda', daysBefore(6))).toMatchObject({ days: 7 })
})

test('a renewed key resets the reminders; the same expiry again does not', async () => {
  await seed()
  await recordCredentialExpiry('skoda', EXPIRES)
  await claimCredentialReminder('skoda', daysBefore(30))
  await recordCredentialExpiry('skoda', EXPIRES)
  expect(await claimCredentialReminder('skoda', daysBefore(29))).toBeNull()
  const renewed = new Date('2027-07-14T10:00:00Z')
  await recordCredentialExpiry('skoda', renewed)
  expect(await claimCredentialReminder('skoda', daysBefore(29))).toBeNull() // ~6 months left
  expect(await claimCredentialReminder('skoda', new Date(renewed.getTime() - 30 * 86_400_000))).toMatchObject({
    days: 30,
    expiresAt: renewed,
  })
})

test('a null expiry (header missing) keeps the stored one; only admins see it', async () => {
  await seed()
  await recordCredentialExpiry('skoda', EXPIRES)
  await recordCredentialExpiry('skoda', null)
  const admin = await getHealth('skoda', { now: daysBefore(10), includeAdminDetail: true })
  expect(admin.adminDetail?.credentialExpiry).toEqual({ expiresAt: EXPIRES, daysLeft: 10, warn: true })
  const member = await getHealth('skoda', { now: daysBefore(10), includeAdminDetail: false })
  expect(member.adminDetail).toBeNull()
})

test('a source without a credential expiry reports null', async () => {
  const health = await getHealth('zaptec', { now: daysBefore(10), includeAdminDetail: true })
  expect(health.adminDetail?.credentialExpiry).toBeNull()
})
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement**

```ts
// src/lib/services/integrationSync/credential.ts
import { and, eq, gt, isNull, ne, or } from 'drizzle-orm'
import { db } from '~/lib/db'
import { integrationSync } from '~/lib/db/schema'
import {
  CREDENTIAL_REMINDER_DAYS,
  CREDENTIAL_WARN_DAYS,
  type CredentialReminderDays,
  type IntegrationSource,
} from '~/lib/integrationHealth'

const DAY_MS = 86_400_000

export type CredentialExpiry = { expiresAt: Date; daysLeft: number; warn: boolean }

/** Server-owned policy (never re-derived client-side): days left, rounded up, and whether to warn. */
export function credentialExpiryOf(expiresAt: Date | null, now: Date): CredentialExpiry | null {
  if (!expiresAt) return null
  const daysLeft = Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS))
  return { expiresAt, daysLeft, warn: daysLeft <= CREDENTIAL_WARN_DAYS }
}

/**
 * Stores the expiry a successful call reported. A changed date (a renewed key)
 * resets the reminder state; null (header missing) keeps what is stored — the
 * caller warns. Expects the source's row to exist (the sync's lease made it).
 */
export async function recordCredentialExpiry(source: IntegrationSource, expiresAt: Date | null): Promise<void> {
  if (!expiresAt) return
  await db
    .update(integrationSync)
    .set({ credentialExpiresAt: expiresAt, credentialReminderDays: null })
    .where(
      and(
        eq(integrationSync.source, source),
        or(isNull(integrationSync.credentialExpiresAt), ne(integrationSync.credentialExpiresAt, expiresAt)),
      ),
    )
}

export type CredentialReminderClaim = {
  days: CredentialReminderDays
  expiresAt: Date
  /** The reminder state before this claim, so a send that fails can release it. */
  previous: CredentialReminderDays | null
}

/**
 * Claims the reminder now due, if any: the smallest threshold ≥ days left that
 * hasn't been sent for this expiry. One conditional UPDATE, so two runs never
 * claim the same reminder; a claim whose emails all fail is released.
 */
export async function claimCredentialReminder(
  source: IntegrationSource,
  now: Date,
): Promise<CredentialReminderClaim | null> {
  const [row] = await db
    .select({ expiresAt: integrationSync.credentialExpiresAt, sent: integrationSync.credentialReminderDays })
    .from(integrationSync)
    .where(eq(integrationSync.source, source))
  const expiry = credentialExpiryOf(row?.expiresAt ?? null, now)
  if (!expiry || !row) return null
  const due = [...CREDENTIAL_REMINDER_DAYS].reverse().find((d) => expiry.daysLeft <= d)
  if (due === undefined) return null
  const [claimed] = await db
    .update(integrationSync)
    .set({ credentialReminderDays: due })
    .where(
      and(
        eq(integrationSync.source, source),
        eq(integrationSync.credentialExpiresAt, expiry.expiresAt),
        or(isNull(integrationSync.credentialReminderDays), gt(integrationSync.credentialReminderDays, due)),
      ),
    )
    .returning({ expiresAt: integrationSync.credentialExpiresAt })
  if (!claimed?.expiresAt) return null
  return { days: due, expiresAt: claimed.expiresAt, previous: (row.sent as CredentialReminderDays | null) ?? null }
}

/** Undoes a claim nobody was emailed for, so the next poll tries again. */
export async function releaseCredentialReminder(
  source: IntegrationSource,
  claim: CredentialReminderClaim,
): Promise<void> {
  await db
    .update(integrationSync)
    .set({ credentialReminderDays: claim.previous })
    .where(
      and(
        eq(integrationSync.source, source),
        eq(integrationSync.credentialExpiresAt, claim.expiresAt),
        eq(integrationSync.credentialReminderDays, claim.days),
      ),
    )
}
```

`integrationSync.ts`: `adminDetail` type becomes
`{ lastErrorMessage: string | null; credentialExpiry: CredentialExpiry | null } | null`; `toHealth` sets
`credentialExpiry: credentialExpiryOf(row?.credentialExpiresAt ?? null, now)` inside `adminDetail`. `index.ts`:
`export * from './credential'`. Update typed `Health` fixtures
(`adminDetail: { lastErrorMessage: …, credentialExpiry: null }`).
- [ ] **Step 4:** `bunx vitest run src/lib/services/integrationSync && bun run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(charging): decide when a credential reminder is due`

### Task 13: reminder email + queue topic

**Reviewers:** `code-reviewer` + reviewer loading `react-email` + `email-best-practices`.

**Files:**
- Create: `src/emails/CredentialExpiryEmail.tsx` (+ `.test.tsx`), `src/lib/queue/handlers/emailCredentialExpiry.ts` (+ `.test.ts`)
- Modify: `src/lib/i18n/format.ts` (`dateFnsLocaleFor`), `src/lib/effects/email/{email.ts,email.test.ts,adapters/smtp.ts,adapters/resend.ts,adapters/devLog.ts}`,
  `src/lib/effects/queue/queue.ts`, `src/lib/queue/index.ts`, `src/lib/queue/dispatch.test.ts` (handler table),
  `vite.config.ts` (trigger), `messages/{sv,en}.json`, `docs/adr/0007-background-job-queue-architecture.md` (topic
  lists), `docs/adr/0008-email-architecture.md` (template list)

**Interfaces:**
- Produces: queue topic `email_credential_expiry: { to: string; source: ExpiringCredentialSource; expiresAt: string; days: CredentialReminderDays; locale: Locale }`;
  `email.sendCredentialExpiry(input)` with the same fields; `renderCredentialExpiry(props: { source; expiresAt; days; locale }) → { subject, html, text }`;
  `dateFnsLocaleFor(locale: Locale): DateFnsLocale`.

- [ ] **Step 1: Messages**

| key | sv | en |
|---|---|---|
| `email_credential_expiry_heading` | Škoda-nyckeln går ut den {date} | The Škoda key expires on {date} |
| `email_credential_expiry_heading_final` | Sista påminnelsen: Škoda-nyckeln går ut den {date} | Final reminder: the Škoda key expires on {date} |
| `email_credential_expiry_preview` | Skapa en ny nyckel före den {date} | Create a new key before {date} |
| `email_credential_expiry_body` | API-nyckeln som Videbacken använder för att läsa bilens status går ut den {date}. Efter det märks nya laddningar inte längre automatiskt som vår bil eller gäst. Skapa en ny nyckel i MyŠkoda-appen (https://go.skoda.eu/api-keys), byt SKODA_API_KEY i Vercel (Production) och deploya om — eller be den som sköter Vercel-projektet. | The API key Videbacken uses to read the car's status expires on {date}. After that, new sessions are no longer marked as our car or a guest automatically. Create a new key in the MyŠkoda app (https://go.skoda.eu/api-keys), replace SKODA_API_KEY in Vercel (Production) and redeploy — or ask whoever manages the Vercel project. |
| `email_credential_expiry_button` | Visa laddningsöversikt | *(copy en `email_grid_tariff_button` verbatim)* |
| `email_credential_expiry_fallback` | Om knappen inte fungerar, kopiera och klistra in följande länk i din webbläsare: | *(copy en `email_grid_tariff_fallback` verbatim)* |
| `email_credential_expiry_footer` | Det här är ett automatiskt meddelande från Videbacken. | *(copy en `email_grid_tariff_footer` verbatim)* |

- [ ] **Step 2: Locale helper** — in `src/lib/i18n/format.ts`, next to `getDateFnsLocale`:

```ts
/** The date-fns locale for an explicit app locale — for code outside a request (emails). */
export function dateFnsLocaleFor(locale: Locale): DateFnsLocale {
  return locale === 'sv' ? sv : enGB
}
```

and make `getDateFnsLocale()` return `dateFnsLocaleFor(getLocale())` (import `type Locale` from
`~/paraglide/runtime` if it isn't already).

- [ ] **Step 3: Failing template test**

```tsx
// src/emails/CredentialExpiryEmail.test.tsx
import { beforeAll, expect, test } from 'vitest'
import { renderCredentialExpiry } from './CredentialExpiryEmail'

beforeAll(() => {
  process.env.BETTER_AUTH_URL ??= 'https://videbacken.example'
})

const EXPIRES = '2027-01-15T12:00:00.500Z'

test('the subject names the expiry date per locale', async () => {
  const [sv, en] = await Promise.all([
    renderCredentialExpiry({ source: 'skoda', expiresAt: EXPIRES, days: 30, locale: 'sv' }),
    renderCredentialExpiry({ source: 'skoda', expiresAt: EXPIRES, days: 30, locale: 'en' }),
  ])
  expect(sv.subject).toBe('Škoda-nyckeln går ut den 15 januari 2027')
  expect(en.subject).toBe('The Škoda key expires on 15 January 2027')
})

test('the date is the Stockholm calendar date', async () => {
  const { subject } = await renderCredentialExpiry({
    source: 'skoda',
    expiresAt: '2027-01-15T23:30:00Z',
    days: 30,
    locale: 'sv',
  })
  expect(subject).toBe('Škoda-nyckeln går ut den 16 januari 2027')
})

test('the 7-day reminder has its own subject', async () => {
  const { subject } = await renderCredentialExpiry({ source: 'skoda', expiresAt: EXPIRES, days: 7, locale: 'sv' })
  expect(subject).toBe('Sista påminnelsen: Škoda-nyckeln går ut den 15 januari 2027')
})

test('says how to renew, in html and text, both locales', async () => {
  for (const locale of ['sv', 'en'] as const) {
    const { html, text } = await renderCredentialExpiry({ source: 'skoda', expiresAt: EXPIRES, days: 30, locale })
    for (const out of [html, text]) {
      expect(out).toContain('https://go.skoda.eu/api-keys')
      expect(out).toContain('SKODA_API_KEY')
      expect(out).toContain('/charging')
    }
  }
})
```

- [ ] **Step 4: Implement the template**

```tsx
// src/emails/CredentialExpiryEmail.tsx
import { tz } from '@date-fns/tz'
import { format } from 'date-fns'
import { render } from 'react-email'
import { dateFnsLocaleFor } from '~/lib/i18n/format'
import type { CredentialReminderDays, ExpiringCredentialSource } from '~/lib/integrationHealth'
import { STOCKHOLM_TIME_ZONE } from '~/lib/time/stockholm'
import { m } from '~/paraglide/messages'
import type { Locale } from '~/paraglide/runtime'
import { BrandEmailLayout } from './BrandEmailLayout'

export interface CredentialExpiryEmailProps {
  // Only Škoda has an expiring credential today; the copy (MyŠkoda, SKODA_API_KEY)
  // assumes it — a second source needs its own strings.
  source: ExpiringCredentialSource
  expiresAt: string // ISO
  days: CredentialReminderDays
  // Explicit: rendered by the queue worker, outside any request (ADR-0008).
  locale: Locale
}

// The button points at the charging overview (BrandEmailLayout also takes the logo's origin from it).
const actionUrl = () => `${process.env.BETTER_AUTH_URL}/charging`

/** "15 januari 2027" / "15 January 2027", the Stockholm calendar date. */
function expiryDate(iso: string, locale: Locale): string {
  return format(new Date(iso), 'd MMMM yyyy', { locale: dateFnsLocaleFor(locale), in: tz(STOCKHOLM_TIME_ZONE) })
}

function heading({ expiresAt, days, locale }: CredentialExpiryEmailProps): string {
  const date = expiryDate(expiresAt, locale)
  return days === 7
    ? m.email_credential_expiry_heading_final({ date }, { locale })
    : m.email_credential_expiry_heading({ date }, { locale })
}

export const CredentialExpiryEmail = (props: CredentialExpiryEmailProps) => {
  const { expiresAt, locale } = props
  const date = expiryDate(expiresAt, locale)
  return (
    <BrandEmailLayout
      locale={locale}
      actionUrl={actionUrl()}
      preview={m.email_credential_expiry_preview({ date }, { locale })}
      heading={heading(props)}
      body={m.email_credential_expiry_body({ date }, { locale })}
      buttonLabel={m.email_credential_expiry_button({}, { locale })}
      fallbackText={m.email_credential_expiry_fallback({}, { locale })}
      footer={m.email_credential_expiry_footer({}, { locale })}
    />
  )
}

CredentialExpiryEmail.PreviewProps = {
  source: 'skoda',
  expiresAt: '2027-01-15T12:00:00.500Z',
  days: 30,
  locale: 'sv',
} satisfies CredentialExpiryEmailProps

export default CredentialExpiryEmail

export async function renderCredentialExpiry(props: CredentialExpiryEmailProps) {
  const [html, text] = await Promise.all([
    render(<CredentialExpiryEmail {...props} />),
    render(<CredentialExpiryEmail {...props} />, { plainText: true }),
  ])
  return { subject: heading(props), html, text }
}
```

(The `format(…, { in: tz(STOCKHOLM_TIME_ZONE) })` call is the pattern of `src/components/evCharging/format.ts`.)

- [ ] **Step 5: Effect + queue wiring**
  - `email.ts` `EmailEffects`:
    ```ts
      // Expiring-credential reminder (tier-3): `email_credential_expiry` queue topic,
      // one message per admin at the 30- and 7-day thresholds (ADR-0022).
      sendCredentialExpiry(input: {
        to: string
        source: ExpiringCredentialSource
        expiresAt: string
        days: CredentialReminderDays
        locale: Locale
      }): Promise<void>
    ```
    plus the proxy method `async sendCredentialExpiry(input) { const adapter = await getAdapter(); return adapter.sendCredentialExpiry(input) }`.
  - `smtp.ts`:
    ```ts
      async sendCredentialExpiry({ to, source, expiresAt, days, locale }) {
        const { subject, html, text } = await renderCredentialExpiry({ source, expiresAt, days, locale })
        await getTransport().sendMail({ from: process.env.EMAIL_FROM, to, subject, html, text })
        logger.info('credential expiry sent (smtp)', { to, source, days })
      },
    ```
  - `resend.ts`:
    ```ts
      async sendCredentialExpiry({ to, source, expiresAt, days, locale }) {
        const { subject, html, text } = await renderCredentialExpiry({ source, expiresAt, days, locale })
        const from = process.env.EMAIL_FROM
        if (!from) throw new Error('EMAIL_FROM is required when RESEND_API_KEY is set')
        const result = await getClient().emails.send({ from, to, subject, html, text })
        if (result.error) throw new Error(`Resend send failed: ${result.error.message}`)
        logger.info('credential expiry sent (resend)', { to, source, days, messageId: result.data?.id })
      },
    ```
  - `devLog.ts`: `async sendCredentialExpiry({ to, source, expiresAt, days }) { logger.info('credential expiry (devLog)', { to, source, expiresAt, days }) },`
  - `email.test.ts`: a test that `email.sendCredentialExpiry({ to: 'gus@test.videbacken.local', source: 'skoda', expiresAt: '2027-01-15T12:00:00.500Z', days: 30, locale: 'sv' })` resolves.
  - `queue.ts`: `| 'email_credential_expiry'` and the payload entry, commented: "published by the Škoda sync at the
    30/7-day thresholds, one per admin; a redelivery can repeat a send — acceptable for an admin reminder".
  - `handlers/emailCredentialExpiry.ts`:
    ```ts
    import { email } from '~/lib/effects'
    import type { QueuePayloadMap } from '~/lib/effects/queue/queue'
    import type { QueueHandler, QueueHandlerContext } from '~/lib/queue/dispatch'

    /** Thin send for `email_credential_expiry` (same shape as emailGridTariffAvailable.ts). */
    export async function handleEmailCredentialExpiryMessage(
      msg: QueuePayloadMap['email_credential_expiry'],
      { log }: QueueHandlerContext,
    ): Promise<void> {
      await email.sendCredentialExpiry({
        to: msg.to,
        source: msg.source,
        expiresAt: msg.expiresAt,
        days: msg.days,
        locale: msg.locale,
      })
      log.info('credential expiry email dispatched')
    }

    export const emailCredentialExpiryHandler: QueueHandler<'email_credential_expiry'> = {
      handle: handleEmailCredentialExpiryMessage,
      logFields: (msg) => ({ to: msg.to, source: msg.source, days: msg.days }),
    }
    ```
    and a test mirroring `emailGridTariffAvailable.test.ts` (resolves; `logFields` → `{ to, source, days }`).
  - `queue/index.ts`: `email_credential_expiry: emailCredentialExpiryHandler`; `dispatch.test.ts`'s handler table gains
    the same key; `vite.config.ts` queue triggers `{ topic: 'email_credential_expiry' },`.
  - ADR-0007: add the topic to the union snippet, the triggers snippet and the key-files list; ADR-0008: add the
    template to its list.
- [ ] **Step 6:** `bunx vitest run src/emails src/lib/effects/email src/lib/queue && bun run typecheck` → PASS.
- [ ] **Step 7: Commit** `feat(charging): add the Škoda key expiry reminder email`

### Task 14: the sync records the expiry and sends reminders

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:** `src/lib/vehicleState/sync.ts`, `src/lib/vehicleState/sync.test.ts`, `src/lib/orpc/procedures/evCharging.ts`
(one timing line).

- [ ] **Step 1: Failing tests** (append; `seedAdmin`, `reading`, `run`, `fakeSkoda`, `capturingLogger`, `publish` exist
  from Task 6)

```ts
const EXPIRES = new Date('2027-01-15T12:00:00Z')
const before = (days: number) => new Date(EXPIRES.getTime() - days * 86_400_000)
const withExpiry = (expiresAt: Date | null = EXPIRES) => fakeSkoda(async () => reading({}, expiresAt))
const reminders = () => publish.mock.calls.filter(([topic]) => topic === 'email_credential_expiry')

test('stores the key expiry and emails every admin once at 30 days, again at 7', async () => {
  await seedAdmin()
  await run(withExpiry(), { now: before(30) })
  await run(withExpiry(), { now: before(29) })
  expect(reminders()).toHaveLength(1)
  expect(reminders()[0]?.[1]).toMatchObject({
    to: 'a@example.com',
    source: 'skoda',
    expiresAt: EXPIRES.toISOString(),
    days: 30,
  })
  await run(withExpiry(), { now: before(7) })
  expect(reminders()).toHaveLength(2)
  expect(reminders()[1]?.[1]).toMatchObject({ days: 7 })
  const health = await getHealth('skoda', { now: before(7), includeAdminDetail: true })
  expect(health.adminDetail?.credentialExpiry).toMatchObject({ daysLeft: 7, warn: true })
})

test('no reminder with plenty of time left', async () => {
  await seedAdmin()
  await run(withExpiry(), { now: before(180) })
  expect(reminders()).toHaveLength(0)
})

test('a reminder nobody could be sent is retried on the next poll', async () => {
  await seedAdmin()
  publish.mockRejectedValueOnce(new Error('queue down'))
  const { log, entries } = capturingLogger()
  expect((await run(withExpiry(), { now: before(7), log })).outcome).toBe('ok')
  expect(entries().some((e) => e.msg === 'skoda sync: key reminder not sent, will retry')).toBe(true)
  await run(withExpiry(), { now: before(6) })
  expect(reminders().at(-1)?.[1]).toMatchObject({ days: 7 })
})

test('with no active admins the reminder is not used up', async () => {
  const { log, entries } = capturingLogger()
  await run(withExpiry(), { now: before(7), log })
  expect(entries().some((e) => e.msg === 'skoda sync: key reminder not sent, will retry')).toBe(true)
  await seedAdmin()
  await run(withExpiry(), { now: before(6) })
  expect(reminders()).toHaveLength(1)
})

test('a missing expiry header keeps the stored date and warns', async () => {
  await run(withExpiry(), { now: before(100) })
  const { log, entries } = capturingLogger()
  await run(withExpiry(null), { now: before(99), log })
  expect(entries().some((e) => e.msg === 'skoda sync: key expiry header missing')).toBe(true)
  const health = await getHealth('skoda', { now: before(99), includeAdminDetail: true })
  expect(health.adminDetail?.credentialExpiry?.expiresAt).toEqual(EXPIRES)
})
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** — `execute` destructures `const { state, keyExpiresAt } = await withDeadline(…)`; imports
  `* as integrationSyncService from '~/lib/services/integrationSync'` (and `type CredentialReminderClaim`),
  `* as userService from '~/lib/services/user'`, `queue` from `~/lib/effects`, `baseLocale` from `~/paraglide/runtime`.
  Add `reminderMs: number` to `SkodaSyncRun`, `init` (0), `logFields` and `timings`. After `run.stored = true`, before
  the re-match:

```ts
      // Key expiry (ADR-0022): stored on every success; a reminder at 30 and at 7
      // days is claimed atomically (no two runs claim it) and released again if
      // nobody could be emailed, so the next poll retries. Best effort: never
      // fails the poll.
      const reminderStart = performance.now()
      try {
        if (!keyExpiresAt) log.warn('skoda sync: key expiry header missing')
        await integrationSyncService.recordCredentialExpiry(SOURCE, keyExpiresAt)
        const claim = await integrationSyncService.claimCredentialReminder(SOURCE, now())
        if (claim) await sendReminder(claim, log)
      } catch (error) {
        log.warn('skoda sync: key reminder failed', { error })
      } finally {
        run.reminderMs = Math.round(performance.now() - reminderStart)
      }
```

```ts
async function sendReminder(claim: CredentialReminderClaim, log: Logger): Promise<void> {
  let sent = 0
  try {
    const admins = await userService.listActiveAdmins()
    const results = await Promise.allSettled(
      admins.map((admin) =>
        queue.publish('email_credential_expiry', {
          to: admin.email,
          source: SOURCE,
          expiresAt: claim.expiresAt.toISOString(),
          days: claim.days,
          locale: baseLocale,
        }),
      ),
    )
    sent = results.filter((r) => r.status === 'fulfilled').length
    const failed = results.length - sent
    if (failed > 0) log.warn('skoda sync: key reminder partly failed', { days: claim.days, sent, failed })
    else if (sent > 0) log.info('skoda sync: key reminder sent', { days: claim.days, admins: sent })
  } finally {
    if (sent === 0) {
      await integrationSyncService.releaseCredentialReminder(SOURCE, claim)
      log.warn('skoda sync: key reminder not sent, will retry', { days: claim.days })
    }
  }
}
```

In the `syncNow` skoda branch add `context.timings.skodaReminderMs = run.reminderMs`.
- [ ] **Step 4:** `bunx vitest run src/lib/vehicleState` → PASS.
- [ ] **Step 5: Commit** `feat(charging): remind admins as the Škoda key nears expiry`

### Task 15: in-app warning, card line, runbook, docs

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:** create `src/components/evCharging/CredentialExpiryAlert.tsx` (+ `.browser.test.tsx`),
`docs/runbooks/skoda-api-key.md`; modify `VehicleLogCard.tsx` (+ test), `charging/index.tsx`, `messages/{sv,en}.json`,
`docs/adr/0019-external-data-integrations.md`, `CLAUDE.md`, the scope map.

- [ ] **Step 1: Messages**

| key | sv | en |
|---|---|---|
| `charging_skoda_key_expiring_title` | Škoda-nyckeln går snart ut | The Škoda key expires soon |
| `charging_skoda_key_expiring_body` | plural on `days` (the `charging_sync_ok` pattern: `input date`, `input days`, `local daysPlural = days: plural`, `local daysFormatted = days: number`) — one: "Den går ut {date} (om {daysFormatted} dag). Skapa en ny i MyŠkoda-appen, byt SKODA_API_KEY i Vercel och deploya om." · other: "Den går ut {date} (om {daysFormatted} dagar). Skapa en ny i MyŠkoda-appen, byt SKODA_API_KEY i Vercel och deploya om." | one: "It expires on {date} (in {daysFormatted} day). Create a new one in the MyŠkoda app, replace SKODA_API_KEY in Vercel and redeploy." · other: "It expires on {date} (in {daysFormatted} days). Create a new one in the MyŠkoda app, replace SKODA_API_KEY in Vercel and redeploy." |
| `charging_vehicle_key_valid_until` | Nyckeln gäller till {date} | The key is valid until {date} |

- [ ] **Step 2: Failing browser tests**

```tsx
// src/components/evCharging/CredentialExpiryAlert.browser.test.tsx
import { expect, test } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { CredentialExpiryAlert } from './CredentialExpiryAlert'

const expiresAt = new Date('2027-01-15T12:00:00.500Z')

test('warns with the date and days left', async () => {
  const { screen } = await renderWithProviders(
    <CredentialExpiryAlert expiry={{ expiresAt, daysLeft: 12, warn: true }} />,
  )
  await expect.element(screen.getByRole('status')).toBeVisible()
  await expect.element(screen.getByText(/15 januari 2027/)).toBeVisible()
  await expect.element(screen.getByText(/om 12 dagar/)).toBeVisible()
})

test('renders nothing before the warning window, after expiry, or without an expiry', async () => {
  for (const expiry of [{ expiresAt, daysLeft: 40, warn: false }, { expiresAt, daysLeft: 0, warn: true }, null]) {
    const { screen } = await renderWithProviders(<CredentialExpiryAlert expiry={expiry} />)
    expect(screen.container.textContent).toBe('')
    await screen.unmount()
  }
})
```

In `VehicleLogCard.browser.test.tsx`: `keyExpiresAt={new Date('2027-01-15T12:00:00.500Z')}` shows
`/Nyckeln gäller till 15 januari 2027/`.

- [ ] **Step 3: Implement**

```tsx
// src/components/evCharging/CredentialExpiryAlert.tsx
import { KeyRoundIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatDate } from './format'

type Expiry = NonNullable<RouterOutputs['evCharging']['syncStatus']['adminDetail']>['credentialExpiry']

// Admin-only (the caller passes adminDetail, which only admins get): the Škoda
// key expires about every six months (ADR-0022). The server decides when to
// warn; once expired the health alert (auth_failed) takes over, so nothing here.
export function CredentialExpiryAlert({ expiry }: { expiry: Expiry }) {
  if (!expiry?.warn || expiry.daysLeft <= 0) return null
  return (
    <Alert role="status" variant={expiry.daysLeft <= 7 ? 'destructive' : 'default'}>
      <KeyRoundIcon />
      <AlertTitle>{m.charging_skoda_key_expiring_title()}</AlertTitle>
      <AlertDescription>
        {m.charging_skoda_key_expiring_body({ date: formatDate(expiry.expiresAt), days: expiry.daysLeft })}
      </AlertDescription>
    </Alert>
  )
}
```

`VehicleLogCard`: optional `keyExpiresAt?: Date | null`; when set,
`<p>{m.charging_vehicle_key_valid_until({ date: formatDate(keyExpiresAt) })}</p>` after the last-contact row. Route:
right after the Škoda `SyncHealthAlert`,
`{isAdmin && skodaHealth?.state === 'ok' ? <CredentialExpiryAlert expiry={skodaHealth.adminDetail?.credentialExpiry ?? null} /> : null}`;
the card gets `keyExpiresAt={skodaHealth?.adminDetail?.credentialExpiry?.expiresAt ?? null}`.

- [ ] **Step 4: Runbook** `docs/runbooks/skoda-api-key.md`:

```markdown
# Škoda API key

The car's live state (ADR-0022) is read with a MyŠkoda Public API key. Keys expire about every six months; admins see
a warning on /charging from 30 days before, and get emails at 30 and 7 days.

## Create or renew
1. On the phone (MyŠkoda app 8.16+), open https://go.skoda.eu/api-keys. Create a key, select the car, copy it.
2. Vercel → videbacken → Settings → Environment Variables → **Production** only (Preview has its own database but
   would share the car's 20 requests/h): set `SKODA_API_KEY` (on first setup also `SKODA_VIN`, and
   `SKODA_HOME_COORDINATES` = `lat,lon` of the charger). Never commit these.
3. Redeploy production (env changes apply only to new deployments).
4. /charging → "Bilens data" → **Hämta bilens status**. Expect "Bilens status är uppdaterad" and "Nyckeln gäller till …"
   with the new date; the warning disappears.

## Symptoms
- "Škoda: Fungerar inte", auth_failed → the key expired or was revoked: renew. (Emails after 3 failed polls.)
- forbidden → the key doesn't cover the VIN, or `SKODA_VIN` is wrong.
- rate_limited → over 20 requests/h for the VIN (the poll uses 4; local testing with the same key counts): wait an hour.
```

- [ ] **Step 5: Docs** — ADR-0019 amendment "2026-10 — Škoda (ADR-0022)": a 15-min pulled source; per-source
  `ALERT_AFTER_FAILURES`; generic `credential_expires_at`/`credential_reminder_days` with reminders at 30/7 days.
  CLAUDE.md: `emails/` line gains `CredentialExpiry`; the env-var line points at the runbook. Scope map "Risks"
  item 4: "addressed by ADR-0022 (warning + reminders)".
- [ ] **Step 6:** `bunx vitest run --project browser src/components/evCharging && bun run typecheck` → PASS.
- [ ] **Step 7: Commit** `feat(charging): warn admins in the app before the Škoda key expires`

### PR 3 close-out

- [ ] 0011 approved by migration-guard + schema-design before the first push (then frozen).
- [ ] Branch review (`code-reviewer`, `test-completeness`, migration reviewers, the email reviewer pair). Pre-PR gate.
  Live: in Drizzle Studio set the local `integration_sync` skoda row's `credential_expires_at` 10 days ahead and
  reload /charging as admin → the warning (a real poll overwrites it with the key's actual date); preview both
  emails with `bun run email:dev` (30- and 7-day `PreviewProps`). Restore the row.
- [ ] Open PR `feat(charging): remind admins before the Škoda API key expires`, base `feat/skoda-live-attribution`.
- [ ] After all three merge: memory note `charging-live-attribution-progress`; the owner follows the runbook.
