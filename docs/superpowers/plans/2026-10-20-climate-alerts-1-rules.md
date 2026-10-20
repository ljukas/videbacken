# Climate alerts, step 1: rules — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every signed-in user can create, edit, pause and delete their own alert rules per sensor from a bell on
each Klimat tile. Nothing evaluates the rules or sends email yet (steps 2 and 3).

**Architecture:** A client-safe vocabulary (`src/lib/sensor/alerts.ts`) feeds the `sensor_alert_rule` table's
CHECKs, a shared Zod input schema, and the UI. A new `sensorAlert` service owns the table, every function scoped by
`userId`. `sensor.alerts.*` procedures are `protectedProcedure` and take the owner only from `context.user.id`
(ADR-0028 extends ADR-0017's own-account exception). A pure merged-readings module groups readings (10-minute
windows); step 1 uses it for the form's count hint, step 2 for evaluation.

**Tech Stack:** Drizzle (pg), oRPC, Zod v4, TanStack Query/Form (`useAppForm`), shadcn/Radix (`toggle-group`,
`switch`, `responsive-dialog`), Paraglide, Vitest (node + browser).

**Spec:** [`docs/superpowers/specs/2026-10-19-climate-alerts-design.md`](../specs/2026-10-19-climate-alerts-design.md),
[ADR-0028](../../adr/0028-climate-alerts.md), [roadmap](../roadmaps/2026-10-20-climate-alerts.md).

## Global Constraints

- Rule kinds `temperature`, `humidity`, `battery`, `silence`; directions `below`, `above`. Battery is always `below`.
- Bounds (validated in Zod and backed by DB CHECKs): count **2–10** (default 2); silence hours **3–72** (default 6);
  temperature −40 to 60 °C in 0.5 steps; humidity 1–99 % whole; battery 5–95 % whole (default 20). No pre-filled
  limit for temperature or humidity.
- Merged readings: a group starts at a reading and takes every reading **within 10 minutes of that first reading**;
  windows don't chain.
- The owner of a rule is only ever `context.user.id`. No procedure takes a user id. Another user's rule id behaves
  exactly like a missing one (`RULE_NOT_FOUND`).
- Deleting a sensor deletes its rules (FK cascade). Deleting a user deletes theirs (cascade; users are normally
  soft-deleted, and `requireAuth` already refuses them).
- All user-facing text in `messages/{sv,en}.json` (sv source of truth). The bell is visible to every signed-in user.
- Schema: `.enableRLS()`, `timestamptz`, migration via `bun run db:generate --name=sensor_alert_rule` (next number
  0029; re-check for a sibling session's 0029 first). Schema gate after Task 2.
- No held connections: the rules query polls with the page (`refetchInterval: 60_000`).

## Review Focus

1. **Another user's rule id** sent to `update`, `setEnabled` or `delete` → `RULE_NOT_FOUND`, row unchanged; `list`
   never returns it. (Task 4 procedure test.)
2. **Changing a rule's kind on edit** (temperature → silence, silence → battery) must null the fields the new kind
   doesn't use, or the DB CHECK fails as a 500. (Task 3 service test.)
3. **A sensor deleted while the dialog is open** → `UNKNOWN_SENSOR` (422) with a toast, not a 500; a rule saved on a
   missing device id likewise. (Task 3 service test, Task 4 mapping.)
4. **Swedish decimal input** "4,5" in the limit field saves 4.5; "4,3" (not a 0.5 step) and "abc" show a field error
   instead of submitting. (Task 6 browser test.)
5. **A sensor with fewer than two merged groups in 7 days** (new, or silent) → no hint, never "NaN" or "0–0".
   (Task 1 pure test, Task 6 browser test.)

---

### Task 0: Check `main` still matches this plan

**Files:** none (read-only), unless the plan needs fixing.

- [ ] **Step 1:** Confirm: the latest migration is `drizzle/0028_*` (else renumber the expectations); `src/lib/db/schema/sensor.ts` exports `sensorDevice` with a `uuid` id; `src/lib/orpc/procedures/sensor.ts` exports `sensorRouter`; `src/components/sensor/CurrentReadingTiles.tsx` props are `{ devices, isAdmin, onEdit }`; `src/routes/_authenticated/sensors.tsx` search has `dialog: z.enum(['edit'])` and `deviceId`; `src/components/form/NumberField.tsx`, `src/lib/parseDecimal.ts`, `src/components/ui/{toggle-group,switch,responsive-dialog}.tsx` exist.
- [ ] **Step 2:** If anything differs, fix this plan first and commit `docs(climate): align step 1 plan with main`.

---

### Task 1: Vocabulary + merged readings (pure, client-safe)

**Files:**
- Create: `src/lib/sensor/alerts.ts` (dependency-free; the schema imports it by relative path)
- Create: `src/lib/sensor/alertGroups.ts`
- Create: `src/lib/sensor/alertRuleInput.ts` (Zod; imported by the procedure and the form)
- Test: `src/lib/sensor/alertGroups.test.ts`, `src/lib/sensor/alertRuleInput.test.ts`
- Modify: `src/lib/sensor/clientSafe.browser.test.tsx` (add the three modules)

**Interfaces — Produces:**
- `alerts.ts`: `SENSOR_ALERT_KINDS = ['temperature','humidity','battery','silence'] as const`, `SensorAlertKind`;
  `SENSOR_ALERT_DIRECTIONS = ['below','above'] as const`, `SensorAlertDirection`; `ALERT_COUNT_MIN = 2`,
  `ALERT_COUNT_MAX = 10`, `ALERT_COUNT_DEFAULT = 2`; `SILENCE_HOURS_MIN = 3`, `SILENCE_HOURS_MAX = 72`,
  `SILENCE_HOURS_DEFAULT = 6`; `TEMPERATURE_MIN = -40`, `TEMPERATURE_MAX = 60`; `HUMIDITY_MIN = 1`,
  `HUMIDITY_MAX = 99`; `BATTERY_MIN = 5`, `BATTERY_MAX = 95`, `BATTERY_DEFAULT = 20`;
  `MERGE_WINDOW_MS = 10 * 60_000`; and
  ```ts
  export type SensorAlertRuleDto = {
    id: string; deviceId: string; kind: SensorAlertKind; enabled: boolean
    direction: SensorAlertDirection | null   // temperature/humidity: set; battery: 'below'; silence: null
    threshold: number | null                 // °C or %; silence: null
    count: number | null                     // silence: null
    silenceHours: number | null              // only silence
  }
  ```
- `alertGroups.ts`: `mergeReadings<T extends { recordedAt: Date }>(ascending: T[]): T[][]` (fixed windows from each
  group's first reading, `recordedAt - start < MERGE_WINDOW_MS`); `typicalGapMinutes(ascending: { recordedAt: Date }[]): number | null`
  (median of the gaps between consecutive group starts, rounded to whole minutes; `null` with < 2 groups);
  `alertSpanMinutes(count: number, gapMinutes: number): { lowMin: number; highMin: number }` = `(count−1)·gap` to
  `count·gap`.
- `alertRuleInput.ts`: `sensorAlertRuleInput` = `z.discriminatedUnion('kind', [...])` with `deviceId: z.uuid()` on
  every branch: temperature/humidity `{ direction, threshold, count }`, battery `{ threshold, count }`, silence
  `{ silenceHours }`; type `SensorAlertRuleInput = z.infer<…>`. Temperature threshold: finite, within bounds,
  `Number.isInteger(threshold * 2)`; humidity/battery: integer within bounds; count/silenceHours: integers within bounds.

- [ ] **Step 1: Write the failing tests.** `alertGroups.test.ts` (times as `new Date('2026-10-19T10:00:00Z')` offsets):
  - `mergeReadings`: readings at 0, 1, 9 min → one group; 0, 9, 11 → two groups `[0,9]`, `[11]`; 0, 5, 10 → `[0,5]`, `[10]` (10 min is outside); readings every 4 min for 40 min → groups start at 0, 12, 24, 36 (no chaining); `[]` → `[]`.
  - `typicalGapMinutes`: readings every 120 min (4 of them) → 120; Förråd-like bursts (0,1 / 120,121,122 / 241) → 121 (group starts 0, 120, 241; gaps 120 and 121; median 120.5, rounded); one reading → `null`; one burst only → `null`.
  - `alertSpanMinutes(2, 120)` → `{ lowMin: 120, highMin: 240 }`; `(3, 60)` → `{ 120, 180 }`.
  `alertRuleInput.test.ts`: accepts `{ kind:'temperature', deviceId, direction:'below', threshold:4.5, count:2 }`; rejects threshold 4.3, −40.5, 60.5, count 1 and 11; humidity 80.5 rejected, 99 ok, 100 rejected; battery 4 rejected, 20 ok; silence 2 and 73 rejected, 3 ok; a silence input carrying `threshold` is stripped (parsed output has no `threshold`).
- [ ] **Step 2:** `bunx vitest run src/lib/sensor/alertGroups.test.ts src/lib/sensor/alertRuleInput.test.ts` → FAIL (modules missing).
- [ ] **Step 3:** Implement the three modules per the Interfaces block. `alerts.ts` keeps the `heatPump/events.ts` header comment style (dependency-free, why). Add the three modules to `clientSafe.browser.test.tsx`'s list.
- [ ] **Step 4:** Rerun → PASS. `bunx vitest run --project browser src/lib/sensor/clientSafe.browser.test.tsx` → PASS.
- [ ] **Step 5: Commit** `feat(climate): add the alert rule vocabulary and merged readings` (`git add` the six paths).

---

### Task 2: `sensor_alert_rule` schema + migration (schema gate after)

**Files:**
- Create: `src/lib/db/schema/sensorAlert.ts`
- Modify: `src/lib/db/schema/index.ts` (alphabetical export)
- Create (generated): `drizzle/0029_sensor_alert_rule.sql`, `drizzle/meta/*`
- Test: `src/lib/db/schema/sensorAlert.test.ts` (CHECK behaviour via `test/expectConstraintViolation.ts`)

**Interfaces — Produces:** `sensorAlertRule` table:

| column | type | notes |
|---|---|---|
| `id` | uuid pk `defaultRandom()` | |
| `user_id` | uuid not null → `user.id` **cascade** | |
| `device_id` | uuid not null → `sensor_device.id` **cascade** | |
| `kind` | text `$type<SensorAlertKind>()` not null | CHECK in kinds |
| `direction` | text `$type<SensorAlertDirection>()` null | |
| `threshold` | real null | |
| `count` | integer null | |
| `silence_hours` | integer null | |
| `enabled` | boolean not null default true | |
| `created_at`, `updated_at` | timestamptz not null default now (`updated_at` `$onUpdate`) | |

CHECKs (named `sensor_alert_rule_<x>_check`, bounds via `sql.raw(String(CONST))` from `../../sensor/alerts`):
- `kind`: in kinds; `direction`: null or in directions.
- `shape`: temperature/humidity → direction, threshold, count not null and silence_hours null; battery → direction =
  'below', threshold, count not null, silence_hours null; silence → silence_hours not null, direction/threshold/count null.
- `threshold`: per kind bounds (temperature −40..60, humidity 1..99, battery 5..95), null passes.
- `count` between 2 and 10; `silence_hours` between 3 and 72.

Index: `sensor_alert_rule_user_device_idx` on `(user_id, device_id)` (the list query). Step 2 will add what its
evaluation query needs; the reviewer judges whether `device_id` alone should lead instead.

- [ ] **Step 1: Write the failing test** (`setupDatabase()` first; insert a user and a sensor_device inline): a valid row of each kind inserts; `expectConstraintViolation` for: silence with a threshold; temperature without direction; battery with `above`; count 1; silence_hours 2; humidity threshold 100; deleting the device deletes its rule; deleting the user deletes its rule.
- [ ] **Step 2:** `bun run db:up` then `bunx vitest run src/lib/db/schema/sensorAlert.test.ts` → FAIL.
- [ ] **Step 3:** Write the schema, export it from the barrel, `bun run db:generate --name=sensor_alert_rule && bun run db:migrate`. Check the SQL contains `ENABLE ROW LEVEL SECURITY` and both `ON DELETE cascade`.
- [ ] **Step 4:** Rerun the test and `bunx vitest run test/rls.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(climate): add the sensor_alert_rule table`.
- [ ] **Step 6: Schema gate.** Dispatch `migration-guard` and a schema-design reviewer (`general-purpose`, loading `supabase-postgres-best-practices`) in parallel, judging against: Task 3's list (`where user_id = $1`), its owner-scoped update/delete (`where id = $1 and user_id = $2`), the bell counts, and step 2's evaluation (all enabled rules of one device, joined to `user` where `deleted_at is null`, on every webhook). Fix or rule on every finding before Task 3.

---

### Task 3: `sensorAlert` service (owner-scoped CRUD + gap hints)

**Files:**
- Create: `src/lib/services/sensorAlert/{errors.ts,rules.ts,hints.ts,index.ts}`
- Test: `src/lib/services/sensorAlert/rules.test.ts`, `src/lib/services/sensorAlert/hints.test.ts`

**Interfaces:**
- Consumes: Task 1 types and `typicalGapMinutes`/`mergeReadings`; Task 2 table.
- Produces:
  - `errors.ts`: `SensorAlertDomainErrorCode = 'RULE_NOT_FOUND' | 'UNKNOWN_SENSOR'`; `class SensorAlertDomainError`
    (shape of `services/heatPump/errors.ts`).
  - `rules.ts`: `listOwnRules(userId: string): Promise<SensorAlertRuleDto[]>` (by `created_at, id`);
    `createRule(userId: string, input: SensorAlertRuleInput): Promise<SensorAlertRuleDto>`;
    `updateRule(userId: string, id: string, input: SensorAlertRuleInput): Promise<SensorAlertRuleDto>` (may move the
    rule to another device; writes **every** column from the input, nulling the ones its kind doesn't use, and keeps
    `enabled`); `setRuleEnabled(userId: string, id: string, enabled: boolean): Promise<SensorAlertRuleDto>`;
    `deleteRule(userId: string, id: string): Promise<void>`. Update/setEnabled/delete filter `and(eq(id), eq(userId))`
    and throw `RULE_NOT_FOUND` on no row. A missing device → FK violation → `UNKNOWN_SENSOR`
    (`isForeignKeyViolation(err, 'sensor_alert_rule_device_id_sensor_device_id_fk')`; confirm the generated name).
  - `hints.ts`: `typicalGapsByDevice(now: Date): Promise<Record<string, number | null>>`: one query of
    `(device_id, recorded_at)` for the 7 days before `now`, ordered by device then time, grouped per device in TS.
    Every device appears (no readings → `null`).

- [ ] **Step 1: Write the failing tests** (`setupDatabase()` first; users A and B and two devices inline):
  - create → listOwnRules(A) returns it with the input's values; listOwnRules(B) is `[]`.
  - update by B on A's id → `RULE_NOT_FOUND`, A's row unchanged; same for setRuleEnabled and deleteRule.
  - updating a temperature rule to `{ kind:'silence', silenceHours: 6 }` → direction/threshold/count are null; then to battery → direction `'below'`, silence_hours null.
  - setRuleEnabled(false) then update keeps `enabled: false`.
  - create with a random device uuid → `UNKNOWN_SENSOR`; same for update.
  - `deleteDevice` (sensor service) removes the device's rules.
  - `hints.test.ts`: readings 2-hourly for 3 days on device 1 → 120; bursts on device 2 as in Task 1 → 121; device 3 with none → `null`; a reading 8 days old is ignored.
- [ ] **Step 2:** `bunx vitest run src/lib/services/sensorAlert` → FAIL.
- [ ] **Step 3:** Implement (copy the `services/heatPump/heatPumpEvents.ts` shape: a `DTO` select object, `.returning(DTO)`, an FK mapper). Map the input to columns with one exhaustive `switch (input.kind)`.
- [ ] **Step 4:** Rerun → PASS.
- [ ] **Step 5: Commit** `feat(climate): add the owner-scoped alert rule service`.

---

### Task 4: `sensor.alerts` procedures

**Files:**
- Create: `src/lib/orpc/procedures/sensorAlerts.ts`, `src/lib/orpc/sensorAlertErrorMessage.ts`
- Modify: `src/lib/orpc/procedures/sensor.ts` (add `alerts: sensorAlertsRouter`, like `heatPump.events`)
- Test: `src/lib/orpc/procedures/sensorAlerts.test.ts`

**Interfaces — Produces** (`orpc.sensor.alerts.*`, all `protectedProcedure`, owner = `context.user.id`):
- `list`: no input → `{ rules: SensorAlertRuleDto[]; typicalGapMinutes: Record<string, number | null> }`; runs the two
  service reads in parallel and records `context.timings.alertRulesMs` and `alertHintsMs`.
- `create`: `sensorAlertRuleInput` → DTO. `update`: `sensorAlertRuleInput` extended with `id: z.uuid()` → DTO.
  `setEnabled`: `{ id: z.uuid(), enabled: z.boolean() }` → DTO. `delete`: `{ id: z.uuid() }` → void.
- Errors: `{ RULE_NOT_FOUND: { status: 404 }, UNKNOWN_SENSOR: { status: 422 } } satisfies Record<SensorAlertDomainErrorCode, …>`;
  rethrow `errors[err.code]()` (the `mapEventError` shape). Log `'user created sensor alert rule'` etc. with
  `{ ruleId, deviceId, kind }`.
- `sensorAlertErrorMessage(code: SensorAlertDomainErrorCode): string` (exhaustive switch, Paraglide).

- [ ] **Step 1: Write the failing test** (pattern of `procedures/heatPumpEvents.test.ts`: `call`, `vi.spyOn(auth.api,'getSession')`):
  - a `user`-role caller can create, list, update, setEnabled and delete its own rule.
  - user B: `list` doesn't include A's rule; `update`/`setEnabled`/`delete` on A's id → `RULE_NOT_FOUND` (404) and A's rule is unchanged afterwards.
  - unknown device → `UNKNOWN_SENSOR` (422); count 1 → input validation error (400).
  - unauthenticated `list` → `UNAUTHORIZED`.
- [ ] **Step 2:** `bunx vitest run src/lib/orpc/procedures/sensorAlerts.test.ts` → FAIL.
- [ ] **Step 3:** Implement; add the i18n keys `sensors_alert_error_rule_not_found` ("Larmet finns inte längre") and `sensors_alert_error_unknown_sensor` ("Sensorn finns inte längre") to sv and en.
- [ ] **Step 4:** Rerun → PASS; `bun run typecheck` → clean.
- [ ] **Step 5: Commit** `feat(climate): add the own-scoped alert rule procedures`.

---

### Task 5: The bell on each tile

**Files:**
- Modify: `src/components/sensor/CurrentReadingTiles.tsx`, `src/components/sensor/CurrentReadingTiles.browser.test.tsx`
- Modify: `src/routes/_authenticated/sensors.tsx` (rules query + `onOpenAlerts`; the dialog itself lands in Task 6)
- Modify: `src/routes/_authenticated/-sensorsRoute.browser.test.tsx` (seed `orpc.sensor.alerts.list`)
- Modify: `messages/{sv,en}.json`

**Interfaces:**
- Consumes: `orpc.sensor.alerts.list`.
- Produces: `CurrentReadingTiles` props gain `alertCounts: Record<string, number>` (switched-on rules per device;
  missing = 0) and `onOpenAlerts: (deviceId: string) => void`. Route: `sensorAlertsQuery()` =
  `orpc.sensor.alerts.list.queryOptions({ refetchInterval: 60_000 })`, read with `useQuery` (not in the loader's
  `critical`; the bell renders a plain bell until it arrives, and on its error).

Bell: a ghost icon `Button` (`BellIcon`, `size-9`) before the admin pencil (the pencil also `size-9`; keep the
negative top/right margin on the last button only), `aria-label` = `m.sensors_alerts_open_named({ name })`
("Larm för {name}"). A count > 0 shows a small neutral `Badge` with the number on the bell (and the label reads
"Larm för {name}, {count} aktiva"). Step 2 adds the red state.

- [ ] **Step 1: Write the failing tests:** a tile shows a "Larm för Förråd" button for a non-admin too; count 2 → badge "2" and the label includes 2; count 0 → no badge; clicking it calls `onOpenAlerts('<id>')`; the route test seeds `alerts.list` and still renders the tiles when that query fails (plain bells).
- [ ] **Step 2:** `bunx vitest run --project browser src/components/sensor/CurrentReadingTiles.browser.test.tsx src/routes/_authenticated/-sensorsRoute.browser.test.tsx` → FAIL.
- [ ] **Step 3:** Implement; derive `alertCounts` in the route from `rules.filter(r => r.enabled)`.
- [ ] **Step 4:** Rerun → PASS.
- [ ] **Step 5: Commit** `feat(climate): add the alerts bell to the sensor tiles`.

---

### Task 6: The "Larm för …" dialog (list + form)

**Files:**
- Create: `src/components/sensor/SensorAlertsDialog.tsx` (lazy-loaded; the list view and the view switch),
  `src/components/sensor/SensorAlertRuleForm.tsx`, `src/components/sensor/alertRuleCopy.ts` (one-line descriptions
  and kind labels, Paraglide)
- Test: `src/components/sensor/SensorAlertsDialog.browser.test.tsx`, `src/components/sensor/SensorAlertRuleForm.browser.test.tsx`
- Modify: `src/routes/_authenticated/sensors.tsx` (search `dialog: z.enum(['edit','alerts'])`, `alertId: z.string().optional()`;
  `clearKeys: ['deviceId','alertId']`; `LazyDialogMount` for every user; `useIdlePreload(true, [loadSensorAlertsDialog])`)
- Modify: `messages/{sv,en}.json`

**Interfaces:**
- Consumes: Task 1 (`sensorAlertRuleInput`, defaults, bounds, `alertSpanMinutes`), Task 4 procedures,
  `sensorAlertErrorMessage`, the device list (display name).
- Produces: `SensorAlertsDialog({ open, device, rules, typicalGapMinutes, view, onView, onClose })` where `view` is
  `'list' | 'new' | <ruleId>` from `alertId` (absent = list; an id that isn't among the device's rules = list).

**List view:** title `Larm för {name}`, description "Bara du får dessa mejl."; each of the device's rules as a row:
the description from `alertRuleCopy` ("Temperatur under 5 °C · 2 mätningar", "Luftfuktighet över 80 % · 3
mätningar", "Batteri under 20 % · 2 mätningar", "Tyst i 6 h"), a `Switch` (`setEnabled`, label "Larmet på"), the
row itself a button opening the form. "+ Nytt larm" opens `'new'`. No rules → the shared `Empty` ("Inga larm än",
"Lägg till ett larm så mejlar vi dig när {name} behöver tillsyn.") with the same button.

**Form view** (`useAppForm`, Zod `sensorAlertRuleInput` adapted from strings via `parseDecimal`): "Bevaka" as a
`ToggleGroup` (Temperatur / Luftfuktighet / Batteri / Tystnad); temperature/humidity: "Larma när den är" under/över
(`ToggleGroup`) + limit `NumberField` with suffix °C / %; battery: limit `NumberField` pre-filled 20, suffix %;
silence: "Timmar utan mätning" `NumberField` pre-filled 6; every kind but silence: "I rad" `NumberField` pre-filled 2,
suffix "mätningar", with the hint `m.sensors_alert_count_hint({ low, high, name })` ("≈ 2–4 timmar för Förråd";
minutes under 60 shown as minutes) when `typicalGapMinutes[deviceId]` isn't null. Switching kind keeps the count and
resets the limit to that kind's default (empty for temperature/humidity). Footer: "Tillbaka" (to list), "Spara";
editing adds "Ta bort", which asks once inline ("Ta bort larmet?" Avbryt / Ta bort). Every mutation invalidates
`orpc.sensor.alerts.key()`, toasts on success ("Larmet sparat" / "Larmet borttaget") and returns to the list; errors
toast `sensorAlertErrorMessage(code)` or a generic save error.

- [ ] **Step 1: Write the failing tests** (oRPC mocked as in `EditDeviceDialog.browser.test.tsx`):
  - list: renders the device's rules with their descriptions and switches; toggling a switch calls `setEnabled({ id, enabled: false })`; no rules → the empty state.
  - form, new temperature rule: under, "4,5", count 2 → `create` called with `{ kind:'temperature', deviceId, direction:'below', threshold: 4.5, count: 2 }`.
  - "4,3" and "abc" → a field error, `create` not called (Review Focus 4).
  - battery pre-fills 20 and count 2; silence pre-fills 6 and shows no count field; count "1" → field error.
  - the hint reads "≈ 2–4 timmar för Förråd" with gap 120; is absent with gap `null` (Review Focus 5).
  - editing: fields pre-filled from the rule; "Ta bort" → confirm → `delete({ id })`.
  - `update` rejecting with `RULE_NOT_FOUND` toasts "Larmet finns inte längre".
- [ ] **Step 2:** `bunx vitest run --project browser src/components/sensor/SensorAlert*.browser.test.tsx` → FAIL.
- [ ] **Step 3:** Implement; wire the route (bell → `open('alerts', { deviceId })`; `view` from `alertId`).
- [ ] **Step 4:** Rerun → PASS. Then the whole browser project once: `bunx vitest run --project browser` → PASS.
- [ ] **Step 5: Commit** `feat(climate): add the alert rules dialog`.

---

### Task 7: Bones, docs, live check

**Files:**
- Regenerate: `src/bones/sensors-tiles.bones.json` (`bun run bones:capture /sensors`; needs the dev server on :14610)
- Modify: `CLAUDE.md` (code map: `sensorAlert` service, `sensor/alerts.ts` + `alertGroups.ts`, the `sensor_alert_rule` schema file; ADR index row 0028), `docs/adr/0017-authentication.md` (one line under the own-account exception pointing to ADR-0028), the roadmap row (PR link, `PR open`)

- [ ] **Step 1:** Capture bones; `bunx vitest run test/sectionSkeletonBones.test.ts` → PASS.
- [ ] **Step 2:** Live check in a browser (dev, signed in as admin and as a plain user) at desktop, tablet and phone widths: create one rule of each kind, pause, edit to another kind, delete; the second account sees none of them; tile names still readable with two icon buttons.
- [ ] **Step 3:** Pre-PR gate (`docs/feature-workflow.md`), including the sv/en key check.
- [ ] **Step 4: Commit** `docs(climate): record step 1 in the code map, ADR-0017 and the roadmap` (and the bones commit separately: `chore(climate): recapture the sensor tile bones`).

---

## Step review (Phase 5)

Core three (`code-reviewer`, correctness, spec) plus: `migration-guard` + schema-design reviewer (Task 2),
`test-completeness` (the service and `errors.ts`), a security reviewer loading `better-auth-security-best-practices`
(the own-scoped mutations: every query filtered by the caller's id; no user id accepted from input), and a UI
reviewer loading `web-design-guidelines` + `vercel-react-best-practices` (tiles, dialog, form). Every reviewer gets
this plan's Review Focus.

PR: `feat(climate): add personal alert rules on the sensors` (one concern: rules, no evaluation yet).
