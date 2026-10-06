# Klimat, PR 1: each sensor's Shelly name in a clearer edit dialog — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Shelly webhook also sends the device's name from the Shelly app; we store it, a sensor without an
admin-set name shows it, and the edit dialog shows it (plus the MAC), says where the shown name comes from, and has
an "Återställ" button that clears the admin-set name.

**Architecture:** A nullable `sensor_device.shelly_name` column. `parseShellyQuery` reads an optional `name` param
that never fails the reading; `recordReading` writes it in the existing insert/upsert (absent → kept). The fallback
name and the MAC format live in a new client-safe `src/lib/sensor/deviceName.ts`, used by the service
(`displayName`) and the dialog (placeholder, helper, badge). The dialog is reshaped after `CredentialFieldRow`: a
label row with a live badge and a link button, then the bound input labelled by that row.

**Tech Stack:** Drizzle (Postgres, `node-postgres`), Zod, oRPC, TanStack Form v1 (`useAppForm`, `useStore`),
shadcn/Radix (`Badge`, `Label`, `Button`), Paraglide, Vitest (node + browser).

**Spec:** [`docs/superpowers/specs/2026-10-06-climate-readability-design.md`](../specs/2026-10-06-climate-readability-design.md)
("PR 1 — the Shelly name and the edit dialog"). PR 2 has its own plan:
[`2026-10-06-climate-2-page-readability.md`](./2026-10-06-climate-2-page-readability.md).

**Execution (owner, 2026-10-06):** subagent-driven (`superpowers:subagent-driven-development`): a fresh implementer per task, then the task's two reviewers in parallel, then a whole-branch review. Its own session.

**Roadmap:** [`2026-10-06-klimat-shelly-improvements.md`](../roadmaps/2026-10-06-klimat-shelly-improvements.md), step 1.

## Global Constraints

- Display name order: **own name → Shelly name → `Sensor <last 4 of MAC>`** (`Sensor eeff` for `aabbccddeeff`).
- The `name` param is **absent** (null) when missing, blank after trimming, `null`, `undefined`, starting with `${`,
  or longer than **80** characters. **A bad name never rejects the reading** (no 400 because of it).
- A reading without a name **never clears** a stored `shelly_name` (same rule as `batteryPct`).
- "Återställ" only empties the form field; Spara saves it, Avbryt drops it. No new procedure; `renameDevice` is
  unchanged (a blank name already clears to null).
- 14 px floor in the dialog: no `text-xs`; helper and box text `text-sm`.
- Muted text only on the card/dialog surface, never on `bg-muted`.
- Client code only `import type` from `~/lib/services/*`; `deviceName.ts` is client-safe (added to the guard).
- All `db` access in the service (ADR-0002). Logging via `~/lib/logger`; the webhook log gains `hasName` (a
  boolean, like `hasTemp`/`hasHum`), not the name.
- Schema change: `bun run db:generate --name=sensor_shelly_name`; **schema-design review + `migration-guard`**
  before code builds on it (Non-negotiable).
- User-facing text via Paraglide (`messages/sv.json` source, `en.json` key-complete).
- Conventional Commits, one hat per commit. PR title: `feat(sensor): show each sensor's name from the Shelly app`.

## Review Focus

1. **An unnamed Shelly device** sends `name=null`, an empty value, or the literal `${config.sys.device.name}`
   (Shelly copies a failed token verbatim). Expected: the reading is stored, no name. Pinned in Task 3
   (`parseShellyQuery` cases + one handler test with the literal token, URL-encoded as a device would send it).
2. **Devices still on the old webhook URL** (three of four until the owner edits them) keep sending readings without
   `name`. Expected: a stored Shelly name survives. Pinned in Task 2.
3. **The admin clears a name that was never set** (`name: null`, Shelly name known) or types only spaces. Expected:
   the badge says "Från Shelly-appen" (spaces count as empty), no Återställ button. Pinned in Task 4.
4. **A Shelly name longer than the column's intent or with odd characters** (`Källare NV/Ö`, emoji, 81 chars).
   Expected: Unicode kept as-is (the URL is decoded by `URLSearchParams`), 81 chars dropped. Pinned in Task 3.
5. **The dialog opened for a device whose `name` equals its Shelly name** (admin typed the same text). Expected: badge
   "Eget namn", Återställ shown; after Återställ the placeholder shows the same text and the badge "Från
   Shelly-appen". Pinned in Task 4.

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/db/schema/sensor.ts` (modify) | `shellyName: text('shelly_name')` |
| `drizzle/0020_sensor_shelly_name.sql` + `drizzle/meta/*` (generate) | `ALTER TABLE sensor_device ADD COLUMN shelly_name text` |
| `src/lib/sensor/deviceName.ts` (create) | Client-safe: `fallbackSensorName`, `sensorDisplayName`, `formatMac` |
| `src/lib/sensor/deviceName.test.ts` (create) | Node tests for the three helpers |
| `src/lib/sensor/clientSafe.browser.test.tsx` (modify) | Guard `deviceName.ts` |
| `src/lib/services/sensor/sensor.ts` (+ `sensor.test.ts`) (modify) | `recordReading` writes `shellyName`; `listDevices` returns it; displayName via `sensorDisplayName` |
| `src/lib/sensor/shellyWebhook.ts` (+ test) (modify) | Optional `name` param → `shellyName` |
| `docs/runbooks/shelly-webhook-setup.md` (modify) | URL gains `&name=${config.sys.device.name}`; length note; "already set up" step |
| `src/components/sensor/EditDeviceDialog.tsx` (+ browser test) (modify) | Enhet box, Namn row (badge, Återställ, helper, placeholder) |
| `src/components/sensor/CurrentReadingTiles.browser.test.tsx`, `src/routes/_authenticated/-sensorsRoute.browser.test.tsx` (modify) | Device fixtures gain `shellyName: null` |
| `messages/sv.json`, `messages/en.json` (modify) | New `sensors_*` keys; reworded `sensors_edit_description` |

---

### Task 0: Verify `main` and create the worktree

**Files:** none (read-only), then the worktree.

- [ ] **Step 1: Check the seams this plan names**

```bash
cd /Users/lukas/prog/videbacken && git fetch -q && git switch main && git pull -q
grep -n "name: text('name')\|location: text('location')" src/lib/db/schema/sensor.ts
grep -n "function displayNameFor\|updateSet\|export async function listDevices\|displayName: displayNameFor" src/lib/services/sensor/sensor.ts
grep -n "const querySchema\|export type ParsedShellyReading\|recordReading(parsed.value)" src/lib/sensor/shellyWebhook.ts
grep -n "export type EditableDevice\|field.TextField label={m.sensors_field_name()}" src/components/sensor/EditDeviceDialog.tsx
grep -n "labelledBy\|describedBy\|placeholder\|description" src/components/form/TextField.tsx | head -8
ls drizzle | tail -3
```

Expected: every grep prints a line; the newest migration is `0019_integration_sync_suspect_fields.sql`. If a newer
one exists, the generated file gets the next number; use whatever drizzle-kit names it.

- [ ] **Step 2: Create the worktree** (no `+` in the path; it hangs Vitest browser mode)

```bash
git worktree add .claude/worktrees/climate-shelly-name -b feat/sensor-shelly-name origin/main
cd .claude/worktrees/climate-shelly-name && cp ../../../.env .env 2>/dev/null; bun install && bun run db:up && bun run db:migrate
```

---

### Task 1: The `shelly_name` column

**Reviewers:** `migration-guard` · schema-design reviewer (a `general-purpose` agent that loads
`supabase-postgres-best-practices` and judges the column against the queries that run: the webhook's
`INSERT … ON CONFLICT (mac) DO UPDATE SET last_seen_at, battery_pct?, shelly_name?` and `listDevices`'
`SELECT * FROM sensor_device ORDER BY created_at, id`; ≈4 rows).

**Files:**
- Modify: `src/lib/db/schema/sensor.ts`
- Generate: `drizzle/0020_sensor_shelly_name.sql`, `drizzle/meta/_journal.json`, `drizzle/meta/0020_snapshot.json`

**Interfaces:**
- Produces: `sensorDevice.shellyName` (Drizzle column, `string | null`) for Task 2.

- [ ] **Step 1: Add the column**

In `src/lib/db/schema/sensor.ts`, replace the table comment's second sentence and add the column after `location`:

```ts
// One row per physical Shelly H&T Gen3, keyed by its MAC. `name`/`location` are
// null until an admin names it — devices auto-register on first webhook, then an
// admin labels them at /sensors. `shellyName` is the name the device reports
// from the Shelly app (`${config.sys.device.name}`), refreshed by every webhook
// that carries one; a sensor without an admin name shows it.
export const sensorDevice = pgTable('sensor_device', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Normalized MAC (lowercase, separators stripped) — the device identity from
  // `${config.sys.device.mac}`. Normalization lives in the service.
  mac: text('mac').notNull().unique(),
  name: text('name'),
  location: text('location'),
  shellyName: text('shelly_name'),
  batteryPct: integer('battery_pct'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}).enableRLS()
```

- [ ] **Step 2: Generate and apply the migration**

```bash
bun run db:generate --name=sensor_shelly_name && bun run db:migrate
cat drizzle/0020_sensor_shelly_name.sql
```

Expected SQL (one statement, nothing else):

```sql
ALTER TABLE "sensor_device" ADD COLUMN "shelly_name" text;
```

- [ ] **Step 3: Typecheck and the RLS test**

```bash
bun run typecheck && bunx vitest run test/rls.test.ts
```

Expected: no type errors; RLS test passes (the table already has RLS).

- [ ] **Step 4: Commit**

```bash
git add src/lib/db/schema/sensor.ts drizzle/
git commit -m "feat(sensor): store the name each sensor reports from the Shelly app"
```

- [ ] **Step 5: Dispatch both reviewers in parallel** (told to assume the change is wrong). Fix or rule on every
  finding before Task 2. A reviewer suggesting a `CHECK (char_length(shelly_name) <= 80)`: rule explicitly (the
  parser enforces 80; `name` has no CHECK either; a CHECK would make a future parser bug fail the whole reading's
  transaction — prefer no CHECK unless the reviewer shows a write path that skips the parser).

---

### Task 2: Fallback name helpers and the service

**Reviewers:** `code-reviewer` · `test-completeness`

**Files:**
- Create: `src/lib/sensor/deviceName.ts`, `src/lib/sensor/deviceName.test.ts`
- Modify: `src/lib/sensor/clientSafe.browser.test.tsx`
- Modify: `src/lib/services/sensor/sensor.ts`, `src/lib/services/sensor/sensor.test.ts`

**Interfaces:**
- Consumes: `sensorDevice.shellyName` (Task 1).
- Produces:
  - `fallbackSensorName(shellyName: string | null, mac: string): string`
  - `sensorDisplayName(name: string | null, shellyName: string | null, mac: string): string`
  - `formatMac(mac: string): string` — `'aabbccddeeff'` → `'AA:BB:CC:DD:EE:FF'`; anything not 12 hex is returned
    upper-cased as-is.
  - `RecordReadingInput.shellyName?: string | null`
  - `SensorDeviceRow.shellyName: string | null` (so `RouterOutputs['sensor']['listDevices'][number]` gains it).

- [ ] **Step 1: Write the failing helper tests**

`src/lib/sensor/deviceName.test.ts`:

```ts
import { expect, test } from 'vitest'
import { fallbackSensorName, formatMac, sensorDisplayName } from './deviceName'

test('the fallback is the Shelly name, else "Sensor" and the last four of the MAC', () => {
  expect(fallbackSensorName('Källare NV', 'aabbccddeeff')).toBe('Källare NV')
  expect(fallbackSensorName(null, 'aabbccddeeff')).toBe('Sensor eeff')
})

test('the display name is the own name first, then the fallback', () => {
  expect(sensorDisplayName('Under köket', 'Källare NV', 'aabbccddeeff')).toBe('Under köket')
  expect(sensorDisplayName(null, 'Källare NV', 'aabbccddeeff')).toBe('Källare NV')
  expect(sensorDisplayName(null, null, 'aabbccddeeff')).toBe('Sensor eeff')
})

test('a MAC reads as upper-case pairs joined by colons', () => {
  expect(formatMac('aabbccddeeff')).toBe('AA:BB:CC:DD:EE:FF')
  expect(formatMac('a4cf12ab34cd')).toBe('A4:CF:12:AB:34:CD')
})

test('a MAC that is not 12 hex digits is shown as it is, upper-cased', () => {
  expect(formatMac('abc')).toBe('ABC')
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `bunx vitest run src/lib/sensor/deviceName.test.ts`
Expected: FAIL — cannot resolve `./deviceName`.

- [ ] **Step 3: Write the helpers**

`src/lib/sensor/deviceName.ts`:

```ts
// Client-safe sensor naming, shared by the service (the displayName it returns)
// and the edit dialog (placeholder, helper, badge). No server imports.

/** The name a sensor shows without an admin-set name: its Shelly app name, else "Sensor" + the MAC's last four. */
export function fallbackSensorName(shellyName: string | null, mac: string): string {
  return shellyName ?? `Sensor ${mac.slice(-4)}`
}

/** Own name → Shelly name → "Sensor a1b2". */
export function sensorDisplayName(
  name: string | null,
  shellyName: string | null,
  mac: string,
): string {
  return name ?? fallbackSensorName(shellyName, mac)
}

/** A stored (normalized, 12-hex) MAC as the Shelly app shows it: `AA:BB:CC:DD:EE:FF`. */
export function formatMac(mac: string): string {
  const upper = mac.toUpperCase()
  return /^[0-9A-F]{12}$/.test(upper) ? (upper.match(/../g) ?? []).join(':') : upper
}
```

- [ ] **Step 4: Run the helper tests**

Run: `bunx vitest run src/lib/sensor/deviceName.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the module to the client-safe guard**

Append to `src/lib/sensor/clientSafe.browser.test.tsx`:

```ts
test('the sensor naming helpers are importable client-side', async () => {
  const mod = await import('~/lib/sensor/deviceName')
  expect(mod.fallbackSensorName(null, 'aabbccddeeff')).toBe('Sensor eeff')
})
```

- [ ] **Step 6: Write the failing service tests**

Append to `src/lib/services/sensor/sensor.test.ts`:

```ts
test('recordReading stores the Shelly name on first registration', async () => {
  await recordReading({ mac: 'aabbccddeeff', temperatureC: 20, shellyName: 'Källare NV' })
  const [device] = await db.select().from(sensorDevice)
  expect(device.shellyName).toBe('Källare NV')
})

test('a later reading with a new Shelly name replaces the stored one', async () => {
  await recordReading({ mac: 'aabbccddeeff', shellyName: 'Källare NV' })
  await recordReading({ mac: 'aabbccddeeff', shellyName: 'Källare nordväst' })
  const [device] = await db.select().from(sensorDevice)
  expect(device.shellyName).toBe('Källare nordväst')
})

test('a reading without a Shelly name keeps the stored one (a device on the old webhook URL)', async () => {
  await recordReading({ mac: 'aabbccddeeff', shellyName: 'Källare NV' })
  await recordReading({ mac: 'aabbccddeeff', temperatureC: 21 })
  await recordReading({ mac: 'aabbccddeeff', temperatureC: 22, shellyName: null })
  const [device] = await db.select().from(sensorDevice)
  expect(device.shellyName).toBe('Källare NV')
})

test('listDevices shows the own name, else the Shelly name, else "Sensor eeff"', async () => {
  const own = await recordReading({ mac: 'aabbccdd0001', shellyName: 'Shelly ett' })
  await renameDevice(own.deviceId, { name: 'Under köket', location: null })
  await recordReading({ mac: 'aabbccdd0002', shellyName: 'Shelly två' })
  await recordReading({ mac: 'aabbccddeeff' })
  const devices = await listDevices()
  expect(devices.map((d) => [d.displayName, d.shellyName])).toEqual([
    ['Under köket', 'Shelly ett'],
    ['Shelly två', 'Shelly två'],
    ['Sensor eeff', null],
  ])
})

test('clearing the own name falls back to the Shelly name', async () => {
  const { deviceId } = await recordReading({ mac: 'aabbccddeeff', shellyName: 'Källare NV' })
  await renameDevice(deviceId, { name: 'Under köket', location: null })
  await renameDevice(deviceId, { name: null, location: null })
  const [device] = await listDevices()
  expect(device.displayName).toBe('Källare NV')
  expect(device.name).toBeNull()
})
```

- [ ] **Step 7: Run them to see them fail**

Run: `bunx vitest run src/lib/services/sensor/sensor.test.ts`
Expected: FAIL — type error / `shellyName` undefined on the row (`RecordReadingInput` has no `shellyName`).

- [ ] **Step 8: Implement in the service**

In `src/lib/services/sensor/sensor.ts`:

1. Add the import (with the other imports at the top):

```ts
import { sensorDisplayName } from '~/lib/sensor/deviceName'
```

2. Delete `displayNameFor` (lines ≈28–30).

3. `RecordReadingInput` gains the field:

```ts
export type RecordReadingInput = {
  mac: string
  temperatureC?: number | null
  humidityPct?: number | null
  batteryPct?: number | null
  /** The name from the Shelly app; absent/null leaves the stored one as it is. */
  shellyName?: string | null
}
```

4. In `recordReading`, replace the comment above it and the `updateSet` + insert lines:

```ts
// Auto-registers the device by MAC (unknown → new unnamed row), inserts one
// reading, and bumps last-seen (+ battery and Shelly name when present) — all in
// one tx. A webhook without a battery reading keeps the previously-stored
// battery; one without a name (a device still on the old URL) keeps the stored
// Shelly name.
export async function recordReading(input: RecordReadingInput): Promise<{ deviceId: string }> {
  const mac = normalizeMac(input.mac)
  if (!isValidMac(mac)) throw new SensorDomainError('INVALID_MAC')
  const now = new Date()
  return db.transaction(async (tx) => {
    const updateSet: { lastSeenAt: Date; batteryPct?: number; shellyName?: string } = {
      lastSeenAt: now,
    }
    if (input.batteryPct != null) updateSet.batteryPct = input.batteryPct
    if (input.shellyName != null) updateSet.shellyName = input.shellyName
    const [device] = await tx
      .insert(sensorDevice)
      .values({
        mac,
        lastSeenAt: now,
        batteryPct: input.batteryPct ?? null,
        shellyName: input.shellyName ?? null,
      })
      .onConflictDoUpdate({ target: sensorDevice.mac, set: updateSet })
      .returning({ id: sensorDevice.id })
```

(the rest of the function is unchanged).

5. `SensorDeviceRow` gains `shellyName: string | null` after `location`, and the `listDevices` mapping:

```ts
    return {
      id: d.id,
      mac: d.mac,
      name: d.name,
      location: d.location,
      shellyName: d.shellyName,
      displayName: sensorDisplayName(d.name, d.shellyName, d.mac),
```

- [ ] **Step 9: Run the service and helper tests**

Run: `bunx vitest run src/lib/services/sensor src/lib/sensor/deviceName.test.ts`
Expected: PASS, including the existing `'Sensor eeff'` fallback tests.

- [ ] **Step 10: Fix the typed fixtures and typecheck**

`bun run typecheck` now fails in the two browser tests whose `Device` fixtures lack `shellyName`. Add
`shellyName: null,` after `location: null,` in:
- `src/components/sensor/CurrentReadingTiles.browser.test.tsx` (the `device` const)
- `src/routes/_authenticated/-sensorsRoute.browser.test.tsx` (the `device` const)

Run: `bun run typecheck`
Expected: no errors (`EditDeviceDialog`'s `EditableDevice` is still the narrow type; Task 4 widens it).

- [ ] **Step 11: Commit**

```bash
git add src/lib/sensor/deviceName.ts src/lib/sensor/deviceName.test.ts src/lib/sensor/clientSafe.browser.test.tsx \
  src/lib/services/sensor/sensor.ts src/lib/services/sensor/sensor.test.ts \
  src/components/sensor/CurrentReadingTiles.browser.test.tsx src/routes/_authenticated/-sensorsRoute.browser.test.tsx
git commit -m "feat(sensor): fall back to the Shelly name before Sensor a1b2"
```

- [ ] **Step 12: Dispatch both reviewers in parallel**; fix or rule on every finding.

---

### Task 3: The webhook's `name` param and the runbook

**Reviewers:** `code-reviewer` · security reviewer (a `general-purpose` agent: the public, token-gated
`/api/webhooks/shelly` endpoint now writes caller text into the DB — check it can't break the reading, can't grow
unbounded, and is rendered only as React text)

**Files:**
- Modify: `src/lib/sensor/shellyWebhook.ts`, `src/lib/sensor/shellyWebhook.test.ts`
- Modify: `docs/runbooks/shelly-webhook-setup.md`

**Interfaces:**
- Consumes: `RecordReadingInput.shellyName` (Task 2).
- Produces: `ParsedShellyReading.shellyName: string | null`; exported `SHELLY_NAME_MAX = 80`.

- [ ] **Step 1: Update the existing `toEqual` expectations**

Every `parseShellyQuery(...)` `toEqual({ ok: true, value: { … } })` in `shellyWebhook.test.ts` gains
`shellyName: null` at the end of `value` (7 places: the four "parses/accepts" tests at the top, "only humidity",
"only battery", and both objects in "treats an empty/whitespace numeric value as absent").

- [ ] **Step 2: Write the failing tests**

Add inside `describe('parseShellyQuery', …)`:

```ts
  test('reads the Shelly app name, trimmed', () => {
    const parsed = parseShellyQuery(q('mac=AABBCCDDEEFF&t=20&name=%20K%C3%A4llare%20NV%20'))
    expect(parsed).toEqual({
      ok: true,
      value: {
        mac: 'AABBCCDDEEFF',
        temperatureC: 20,
        humidityPct: null,
        batteryPct: null,
        shellyName: 'Källare NV',
      },
    })
  })

  test.each([
    ['missing', 'mac=AABBCCDDEEFF&t=20'],
    ['blank', 'mac=AABBCCDDEEFF&t=20&name=%20%20'],
    ['null (an unnamed device)', 'mac=AABBCCDDEEFF&t=20&name=null'],
    ['undefined', 'mac=AABBCCDDEEFF&t=20&name=undefined'],
    ['the token copied verbatim', 'mac=AABBCCDDEEFF&t=20&name=%24%7Bconfig.sys.device.name%7D'],
    ['81 characters', `mac=AABBCCDDEEFF&t=20&name=${'a'.repeat(81)}`],
  ])('a %s name is no name, and the reading still parses', (_case, query) => {
    const parsed = parseShellyQuery(q(query))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.shellyName).toBeNull()
      expect(parsed.value.temperatureC).toBe(20)
    }
  })

  // The bound counts UTF-16 code units, like Zod's `.max`.
  test('keeps an 80-character name and any Unicode', () => {
    const eighty = `Källare ${'ö'.repeat(72)}` // 8 + 72 = 80
    const parsed = parseShellyQuery(q(`mac=AABBCCDDEEFF&name=${encodeURIComponent(eighty)}`))
    expect(parsed.ok && parsed.value.shellyName).toBe(eighty)
  })
```

Add inside `describe('handleShellyWebhook', …)`:

```ts
  test('stores the Shelly name from the webhook', async () => {
    const res = await handleShellyWebhook(
      new Request(shellyUrl(`token=${TOKEN}&mac=AABBCCDDEEFF&t=20&name=K%C3%A4llare%20NV`)),
    )
    expect(res.status).toBe(204)
    const [device] = await db.select().from(sensorDevice)
    expect(device.shellyName).toBe('Källare NV')
  })

  test('an unnamed device (the token sent verbatim) still stores its reading, with no name', async () => {
    const res = await handleShellyWebhook(
      new Request(
        shellyUrl(`token=${TOKEN}&mac=AABBCCDDEEFF&t=20&name=%24%7Bconfig.sys.device.name%7D`),
      ),
    )
    expect(res.status).toBe(204)
    const [device] = await db.select().from(sensorDevice)
    expect(device.shellyName).toBeNull()
    expect(await db.select().from(sensorReading)).toHaveLength(1)
  })
```

- [ ] **Step 3: Run them to see them fail**

Run: `bunx vitest run src/lib/sensor/shellyWebhook.test.ts`
Expected: FAIL — `shellyName` missing from the parsed value.

- [ ] **Step 4: Implement**

In `src/lib/sensor/shellyWebhook.ts`:

1. `ParsedShellyReading` gains `shellyName: string | null`.

2. After `numParam`, add:

```ts
/** The longest Shelly name we keep; a longer one is dropped, not cut. Matches the admin name's bound. */
export const SHELLY_NAME_MAX = 80

// The device's name from the Shelly app (`${config.sys.device.name}`). An
// unnamed device sends `null`, an empty value, or — when Shelly can't evaluate
// the token — the token itself, copied verbatim; all of those, and an
// over-long value, mean "no name". Never a reason to reject the reading.
function nameParam(raw: string | null): string | null {
  const trimmed = raw?.trim()
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined' || trimmed.startsWith('${')) {
    return null
  }
  return trimmed.length > SHELLY_NAME_MAX ? null : trimmed
}
```

3. In `parseShellyQuery`'s success return, add `shellyName: nameParam(params.get('name')),` after `batteryPct`.

4. In `handleShellyWebhook`, the info log gains `hasName: parsed.value.shellyName != null,` after `hasHum`.
   (`recordReading(parsed.value)` already passes the whole object, so `shellyName` reaches the service.)

- [ ] **Step 5: Run the tests**

Run: `bunx vitest run src/lib/sensor/shellyWebhook.test.ts src/lib/services/sensor`
Expected: PASS.

- [ ] **Step 6: Update the runbook**

In `docs/runbooks/shelly-webhook-setup.md`, replace the URL block and its bullets with:

````markdown
```
<base>/api/webhooks/shelly?token=<SHELLY_WEBHOOK_TOKEN>&mac=${config.sys.device.mac}&t=${status["temperature:0"].tC}&h=${status["humidity:0"].rh}&batt=${status["devicepower:0"].battery.percent}&name=${config.sys.device.name}
```

- `<base>` is `http://<LAN-IP>:14600` for the local test, `https://<app-domain>` in production.
- The device URL-encodes interpolated values automatically.
- `name` carries the device's name from the Shelly app. A sensor without an admin-set name shows it on `/sensors`,
  and the edit dialog shows it so you can tell the devices apart. An unnamed device sends nothing usable; that's
  fine, the reading is still stored and the sensor shows as "Sensor <last 4 of MAC>".
- Length: the template is ≈270 characters with a `*.vercel.app` domain and a 44-character token; battery devices
  allow **300** (10 hooks). A domain more than ≈30 characters longer than `videbacken.vercel.app` won't fit — then
  drop `&name=…` (the dialog still shows the MAC).
- Unknown MACs **auto-register** as unnamed devices; name them at `/sensors` (admin only).

### Devices set up before the `name` parameter

Edit both webhooks (temperature and humidity change) on each device and append
`&name=${config.sys.device.name}`. The name arrives with the device's next reading.
````

- [ ] **Step 7: Commit**

```bash
git add src/lib/sensor/shellyWebhook.ts src/lib/sensor/shellyWebhook.test.ts docs/runbooks/shelly-webhook-setup.md
git commit -m "feat(sensor): read the Shelly app name from the webhook"
```

- [ ] **Step 8: Dispatch both reviewers in parallel**; fix or rule on every finding.

---

### Task 4: The edit dialog

**Reviewers:** `code-reviewer` · UI reviewer (loads `web-design-guidelines` + `vercel-react-best-practices`)

**Files:**
- Modify: `src/components/sensor/EditDeviceDialog.tsx`, `src/components/sensor/EditDeviceDialog.browser.test.tsx`
- Modify: `messages/sv.json`, `messages/en.json`

**Interfaces:**
- Consumes: `fallbackSensorName`, `formatMac` (Task 2); listDevices rows with `mac` + `shellyName` (Task 2) — the
  route already passes the roster row as `device`, so `sensors.tsx` needs no change.
- Produces: `EditableDevice = { id: string; name: string | null; location: string | null; mac: string; shellyName: string | null }`.

- [ ] **Step 1: Add the copy**

`messages/sv.json` (keep the file's key order: insert next to the other `sensors_*` keys, alphabetically):

```json
  "sensors_edit_description": "Namnet och platsen visas på Klimat-sidan.",
  "sensors_identity_heading": "Enhet",
  "sensors_identity_mac": "MAC",
  "sensors_identity_shelly_name": "I Shelly-appen",
  "sensors_identity_shelly_name_hint": "Sensorn skickar sitt namn från Shelly-appen när dess webhook har parametern name.",
  "sensors_identity_shelly_name_missing": "Inte skickat än",
  "sensors_name_badge_default": "Standardnamn",
  "sensors_name_badge_own": "Eget namn",
  "sensors_name_badge_shelly": "Från Shelly-appen",
  "sensors_name_hint": "Lämna tomt för att visa {fallback}.",
  "sensors_name_reset": "Återställ",
  "sensors_name_reset_label": "Återställ, Namn",
```

`messages/en.json`:

```json
  "sensors_edit_description": "The name and location show on the Climate page.",
  "sensors_identity_heading": "Device",
  "sensors_identity_mac": "MAC",
  "sensors_identity_shelly_name": "In the Shelly app",
  "sensors_identity_shelly_name_hint": "The sensor sends its Shelly app name once its webhook has the name parameter.",
  "sensors_identity_shelly_name_missing": "Not sent yet",
  "sensors_name_badge_default": "Default name",
  "sensors_name_badge_own": "Own name",
  "sensors_name_badge_shelly": "From the Shelly app",
  "sensors_name_hint": "Leave empty to show {fallback}.",
  "sensors_name_reset": "Reset",
  "sensors_name_reset_label": "Reset, Name",
```

(`sensors_edit_description` replaces the existing value.) Run: `bun run i18n:compile`.

- [ ] **Step 2: Write the failing tests**

In `EditDeviceDialog.browser.test.tsx`, add a fixture helper at the top (after the mock) and switch every existing
`device={{ … }}` to it, keeping each test's `name`/`location`:

```tsx
import type { EditableDevice } from './EditDeviceDialog'

const device = (over: Partial<EditableDevice> = {}): EditableDevice => ({
  id: 'a',
  name: null,
  location: null,
  mac: 'aabbccddeeff',
  shellyName: null,
  ...over,
})
// e.g. device={device({ name: 'Kitchen', location: 'Upstairs' })}
```

Then add:

```tsx
test('the Enhet box shows the Shelly name and the MAC as the Shelly app shows it', async () => {
  const { screen } = await renderWithProviders(
    <EditDeviceDialog open device={device({ shellyName: 'Källare NV' })} onOpenChange={() => {}} />,
  )
  await expect.element(screen.getByText('Källare NV', { exact: true })).toBeVisible()
  await expect.element(screen.getByText('AA:BB:CC:DD:EE:FF')).toBeVisible()
  expect(screen.getByText(m.sensors_identity_shelly_name_missing()).elements()).toHaveLength(0)
})

test('without a Shelly name the box says it has not been sent and how to get it', async () => {
  const { screen } = await renderWithProviders(
    <EditDeviceDialog open device={device()} onOpenChange={() => {}} />,
  )
  await expect.element(screen.getByText(m.sensors_identity_shelly_name_missing())).toBeVisible()
  await expect.element(screen.getByText(m.sensors_identity_shelly_name_hint())).toBeVisible()
})

test('the badge follows the field: own name, then the Shelly name, then the default', async () => {
  const { screen } = await renderWithProviders(
    <EditDeviceDialog
      open
      device={device({ name: 'Under köket', shellyName: 'Källare NV' })}
      onOpenChange={() => {}}
    />,
  )
  const input = screen.getByLabelText(m.sensors_field_name())
  await expect.element(screen.getByText(m.sensors_name_badge_own())).toBeVisible()
  await input.clear()
  await expect.element(screen.getByText(m.sensors_name_badge_shelly())).toBeVisible()
  // Spaces only clear the name server-side, so they count as empty here too.
  await input.fill('   ')
  await expect.element(screen.getByText(m.sensors_name_badge_shelly())).toBeVisible()
})

test('with no Shelly name an empty field shows the default badge, placeholder and helper', async () => {
  const { screen } = await renderWithProviders(
    <EditDeviceDialog open device={device()} onOpenChange={() => {}} />,
  )
  const input = screen.getByLabelText(m.sensors_field_name())
  await expect.element(screen.getByText(m.sensors_name_badge_default())).toBeVisible()
  await expect.element(input).toHaveAttribute('placeholder', 'Sensor eeff')
  await expect.element(screen.getByText(m.sensors_name_hint({ fallback: 'Sensor eeff' }))).toBeVisible()
})

test('Återställ empties the field, focuses it and goes away; the helper names the Shelly name', async () => {
  const { screen } = await renderWithProviders(
    <EditDeviceDialog
      open
      device={device({ name: 'Källare NV', shellyName: 'Källare NV' })}
      onOpenChange={() => {}}
    />,
  )
  const input = screen.getByLabelText(m.sensors_field_name())
  await expect.element(screen.getByText(m.sensors_name_badge_own())).toBeVisible()
  await screen.getByRole('button', { name: m.sensors_name_reset_label() }).click()
  await expect.element(input).toHaveValue('')
  await expect.element(input).toHaveFocus()
  await expect.element(input).toHaveAttribute('placeholder', 'Källare NV')
  await expect.element(screen.getByText(m.sensors_name_badge_shelly())).toBeVisible()
  await expect
    .element(screen.getByText(m.sensors_name_hint({ fallback: 'Källare NV' })))
    .toBeVisible()
  expect(screen.getByRole('button', { name: m.sensors_name_reset_label() }).elements()).toHaveLength(0)
})

test('no Återställ while the field is empty', async () => {
  const { screen } = await renderWithProviders(
    <EditDeviceDialog open device={device({ shellyName: 'Källare NV' })} onOpenChange={() => {}} />,
  )
  await expect.element(screen.getByLabelText(m.sensors_field_name())).toBeVisible()
  expect(screen.getByRole('button', { name: m.sensors_name_reset_label() }).elements()).toHaveLength(0)
})

test('Återställ then Spara clears the name; Avbryt after Återställ saves nothing', async () => {
  const onOpenChange = vi.fn()
  renameFn.mockClear()
  const { screen } = await renderWithProviders(
    <EditDeviceDialog open device={device({ name: 'Old' })} onOpenChange={onOpenChange} />,
  )
  await screen.getByRole('button', { name: m.sensors_name_reset_label() }).click()
  await screen.getByRole('button', { name: m.common_cancel() }).click()
  expect(onOpenChange).toHaveBeenCalledWith(false)
  expect(renameFn).not.toHaveBeenCalled()
})

test('Återställ then Spara submits an empty name', async () => {
  renameFn.mockClear()
  const { screen } = await renderWithProviders(
    <EditDeviceDialog open device={device({ name: 'Old' })} onOpenChange={() => {}} />,
  )
  await screen.getByRole('button', { name: m.sensors_name_reset_label() }).click()
  await screen.getByRole('button', { name: m.common_save() }).click()
  await vi.waitFor(() => expect(renameFn).toHaveBeenCalledWith({ id: 'a', name: '', location: '' }))
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `bunx vitest run --project browser src/components/sensor/EditDeviceDialog.browser.test.tsx`
Expected: FAIL — the new texts and the Återställ button don't exist (and `EditableDevice` lacks `mac`).

- [ ] **Step 4: Implement the dialog**

Replace `src/components/sensor/EditDeviceDialog.tsx`'s imports, `EditableDevice`, and `EditDeviceForm` with:

```tsx
import { isDefinedError } from '@orpc/client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { z } from 'zod'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Label } from '~/components/ui/label'
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '~/components/ui/responsive-dialog'
import { useAppForm, useStore } from '~/hooks/form'
import { orpc } from '~/lib/orpc/client'
import { sensorErrorMessage } from '~/lib/orpc/sensorErrorMessage'
import { fallbackSensorName, formatMac } from '~/lib/sensor/deviceName'
import { m } from '~/paraglide/messages'

export type EditableDevice = {
  id: string
  name: string | null
  location: string | null
  mac: string
  shellyName: string | null
}

// The name input keeps its default id (the field name); the row header labels it.
const NAME_INPUT_ID = 'name'
const NAME_LABEL_ID = 'sensor-name-label'
const NAME_BADGE_ID = 'sensor-name-badge'
const IDENTITY_HEADING_ID = 'sensor-identity-heading'
```

(`formSchema`, `Props` and `EditDeviceDialog` stay as they are.)

```tsx
function EditDeviceForm({ device, onDone }: { device: EditableDevice; onDone: () => void }) {
  const queryClient = useQueryClient()
  const rename = useMutation(
    orpc.sensor.renameDevice.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.sensor.key() })
        toast.success(m.sensors_saved())
      },
      onError: (err) => {
        toast.error(isDefinedError(err) ? sensorErrorMessage(err.code) : m.sensors_save_error())
      },
    }),
  )

  const form = useAppForm({
    defaultValues: { name: device.name ?? '', location: device.location ?? '' },
    validators: { onSubmit: formSchema },
    onSubmit: ({ value }) => {
      // Instant close; the toast + query invalidation reconcile in the
      // background (same pattern as EditUserDialog).
      rename.mutate({ id: device.id, name: value.name, location: value.location })
      onDone()
    },
  })

  // What the page will show for the name as typed: blank (spaces too — the
  // server clears them) falls back to the Shelly name, else "Sensor a1b2".
  const name = useStore(form.store, (s) => s.values.name)
  const hasOwnName = name.trim() !== ''
  const fallback = fallbackSensorName(device.shellyName, device.mac)
  const badge = hasOwnName
    ? m.sensors_name_badge_own()
    : device.shellyName
      ? m.sensors_name_badge_shelly()
      : m.sensors_name_badge_default()

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        form.handleSubmit()
      }}
    >
      <div className="flex flex-col gap-5">
        <DeviceIdentity device={device} />

        {/* The row header names the input and says where the shown name comes
            from (CredentialFieldRow's shape): the badge is real text, never
            colour alone, and is announced with the input. */}
        <div className="flex flex-col gap-2">
          <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1">
            <Label id={NAME_LABEL_ID} htmlFor={NAME_INPUT_ID}>
              {m.sensors_field_name()}
            </Label>
            <Badge id={NAME_BADGE_ID} variant="outline" className="text-muted-foreground">
              {badge}
            </Badge>
            {hasOwnName ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                // 44 px on touch without growing the header: the extra height overlaps the gap.
                className="ml-auto h-7 px-1 pointer-coarse:-my-2 pointer-coarse:h-11"
                aria-label={m.sensors_name_reset_label()}
                onClick={() => {
                  form.setFieldValue('name', '')
                  // The button unmounts with the text; focus stays in the form.
                  document.getElementById(NAME_INPUT_ID)?.focus()
                }}
              >
                {m.sensors_name_reset()}
              </Button>
            ) : null}
          </div>
          <form.AppField
            name="name"
            children={(field) => (
              <field.TextField
                labelledBy={NAME_LABEL_ID}
                describedBy={NAME_BADGE_ID}
                placeholder={fallback}
                description={m.sensors_name_hint({ fallback })}
                autoFocus
              />
            )}
          />
        </div>

        <form.AppField
          name="location"
          children={(field) => <field.TextField label={m.sensors_field_location()} />}
        />
      </div>

      <ResponsiveDialogFooter className="mt-6">
        <form.AppForm>
          <form.CancelButton onClick={onDone}>{m.common_cancel()}</form.CancelButton>
          <form.SubmitButton label={m.common_save()} />
        </form.AppForm>
      </ResponsiveDialogFooter>
    </form>
  )
}

// Which physical device this is, as the Shelly app names it: its app name and
// its MAC (the app's device information). Read-only.
function DeviceIdentity({ device }: { device: EditableDevice }) {
  return (
    <section aria-labelledby={IDENTITY_HEADING_ID} className="rounded-lg border p-3 text-sm">
      <h3 id={IDENTITY_HEADING_ID} className="font-medium font-sans text-sm tracking-normal">
        {m.sensors_identity_heading()}
      </h3>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">{m.sensors_identity_shelly_name()}</dt>
        <dd className="break-words">
          {device.shellyName ?? m.sensors_identity_shelly_name_missing()}
        </dd>
        <dt className="text-muted-foreground">{m.sensors_identity_mac()}</dt>
        <dd className="font-mono tabular-nums">{formatMac(device.mac)}</dd>
      </dl>
      {device.shellyName ? null : (
        <p className="mt-2 text-muted-foreground">{m.sensors_identity_shelly_name_hint()}</p>
      )}
    </section>
  )
}
```

Notes for the implementer:
- `h1/h2/h3` get `font-heading tracking-tight` from `@layer base` (ADR-0015); the box heading is a small label, so it
  opts back to the body face (`font-sans tracking-normal`). If the UI reviewer prefers the heading face, keep it —
  but keep it 14 px.
- `form.setFieldValue` is TanStack Form v1's API on the form instance (Context7 `/tanstack/form` if in doubt).
- `TextField` with `labelledBy` renders no label of its own (its `LabelProps` union), so `getByLabelText(Namn)`
  resolves through `aria-labelledby`.

- [ ] **Step 5: Run the dialog tests**

Run: `bunx vitest run --project browser src/components/sensor/EditDeviceDialog.browser.test.tsx`
Expected: PASS (the four existing tests on the fixture helper + the new ones).

- [ ] **Step 6: Run the sensors route tests** (the dialog opens from there)

Run: `bunx vitest run --project browser src/routes/_authenticated/-sensorsRoute.browser.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/sensor/EditDeviceDialog.tsx src/components/sensor/EditDeviceDialog.browser.test.tsx messages/
git commit -m "feat(sensor): show the Shelly name and a reset in the sensor dialog"
```

- [ ] **Step 8: Dispatch both reviewers in parallel**; fix or rule on every finding.

---

### Task 5: Review the branch, verify, open the PR

**Files:** whatever the reviews change; the PR.

- [ ] **Step 1: Branch review** ([feature-workflow Phase 5](../../feature-workflow.md#5-review-the-branch)): in
  parallel — `migration-guard` + schema-design reviewer (schema changed), `test-completeness` (service changed),
  `code-reviewer`, and a security pass on the webhook. Fix every confirmed finding in this branch.

- [ ] **Step 2: Pre-PR gate** ([pre-PR gate](../../feature-workflow.md#pre-pr-gate)): `bun run check`,
  `bun run check:ci`, `bun run build`, `bun run db:up && bun run db:migrate`, `bun run test` (wait until
  `pgrep -fl vitest` shows no other session's run first), the sv/en key check. All green.

- [ ] **Step 3: Live check (dev server, Playwright or Chrome)**
  - Fake a named device locally: `curl "http://localhost:14600/api/webhooks/shelly?token=$SHELLY_WEBHOOK_TOKEN&mac=aabbccdd0101&t=20&name=K%C3%A4llare%20NV"`,
    and an unnamed one with `&name=%24%7Bconfig.sys.device.name%7D`.
  - `/sensors`: the named one's tile reads "Källare NV", the other "Sensor 0102" (or its MAC's last four).
  - Open each dialog at 1440, 820 and 390 px, light and dark: the Enhet box, badge changes while typing,
    Återställ (and its 44 px target on a touch emulation), helper text, Spara/Avbryt.

- [ ] **Step 3b: Update the roadmap** in this branch: step 1's row gets the PR link and status `PR open`
  (after merge, the merging session sets `merged`; the checkpoint result goes in the last column).

- [ ] **Step 4: Open the PR** with `.github/PULL_REQUEST_TEMPLATE.md`. Title
  `feat(sensor): show each sensor's name from the Shelly app`. In the body: the spec link, the gate output, and
  **the real-world check as an unchecked box for the owner** (it can only run after merge: the devices post to
  prod, and Preview has its own database):
  - [ ] Owner appends `&name=${config.sys.device.name}` to **one** device's two webhooks and wakes it; we read
    `SELECT mac, shelly_name FROM sensor_device` on prod (read-only): `shelly_name` must equal the name in the
    Shelly app. If it's null or the device ID, the app name isn't stored on the device — stop and re-shape (the MAC
    still matches devices). Then the other three devices.
  - [ ] The MAC in the dialog reads like the Shelly app's device information.

- [ ] **Step 5: Merge when CI is green and the owner approves**; the migration runs on the production deploy
  (`vercel-build`). Then run the real-world check with the owner and record the result in the PR (or a follow-up
  docs commit). A missing app name changes no code that shipped: the sensors keep showing "Sensor a1b2", and the
  dialog still shows the MAC.
