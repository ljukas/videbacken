# Climate alerts, step 2: value alerts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Temperature, humidity and battery rules are judged on every Shelly reading. A rule that starts firing
sends its owner one alert email, and one recovery email when it stops. The bell turns red while a rule fires, the
list rows show each rule's state, and the dialog lists the user's "Senaste larm". Silence rules still don't fire
(step 3).

**Architecture:** A pure judge (`src/lib/sensor/alertJudge.ts`) decides fire / recover / nothing for one rule from
the device's merged readings. Firing state is an **open `sensor_alert_event` row** (`ended_at` null, at most one
per rule by a partial unique index), which is also the history. The `sensorAlert` service evaluates one device in
a single transaction that row-locks its enabled rules, so racing webhooks serialize; it returns the transitions
and a glue module publishes one `email_sensor_alert` queue message per transition after the commit (ADR-0001).
The webhook stores the reading first, then hands the evaluation to `waitUntil` and answers at once.

**Tech Stack:** Drizzle (pg), oRPC (+ `@orpc/tanstack-query` infinite queries), React Email, Vercel Queues /
BullMQ, `@vercel/functions` `waitUntil`, date-fns + `@date-fns/tz`, Paraglide, Vitest (node + browser).

**Spec:** [`docs/superpowers/specs/2026-10-19-climate-alerts-design.md`](../specs/2026-10-19-climate-alerts-design.md),
[ADR-0028](../../adr/0028-climate-alerts.md), [roadmap](../roadmaps/2026-10-20-climate-alerts.md),
[step 1 plan](./2026-10-20-climate-alerts-1-rules.md) (the shapes this builds on).

## Global Constraints

- Value kinds: `temperature` (`temperature_c`), `humidity` (`humidity_pct`), `battery` (`battery_pct`). Silence
  rules are never evaluated in this step.
- **Wrong side:** `below` = strictly less than the threshold, `above` = strictly greater; equal is normal.
- A reading without the rule's measure is dropped **before** merging (it neither counts nor breaks a run). Groups
  are `mergeReadings` (step 1: 10-minute fixed windows); a group's value is its **latest** reading. The open group
  is judged as it stands (owner's decision: alerts within seconds).
- **Fires** when the rule has no open event and the latest `count` groups are all on the wrong side.
  `started_at` = the first reading of the earliest of those groups. **Recovers** when it has an open event and the
  latest `count` groups are all normal; `ended_at` = the first reading of the earliest of those groups (owner,
  2026-10-20). Fewer than `count` groups in the lookback → nothing happens.
- Lookback: readings of the last **7 days** (`ALERT_LOOKBACK_MS`).
- Quiet ends (no email; `ended_at` = now): pausing → `paused`; an edit that **changes** the device, kind, direction,
  threshold, count or silence hours → `edited` (an unchanged save leaves the alert running; owner, 2026-10-20);
  deleting → `deleted`. A deleted rule's history stays (`rule_id` set null); a deleted sensor deletes its history.
- Rules of a soft-deleted user (`user.deleted_at` not null) are skipped: no evaluation, no state change, no email.
- **At most 20 rules per user per sensor** (`ALERT_RULES_PER_SENSOR_MAX`, owner 2026-10-20): `TOO_MANY_RULES`.
- **Exactly one email per transition:** the transition write is conditional (insert on the partial unique index
  `DO NOTHING`; recovery `UPDATE … WHERE ended_at IS NULL`), and only a write that returned a row publishes.
- Emails are Swedish (`baseLocale`, like the integration alerts), `BrandEmailLayout`, through the queue; the
  button opens `${BETTER_AUTH_URL}/sensors`. Sensor name = `sensorDisplayName(name, shellyName, mac)`.
- The webhook's status and latency don't change: evaluation runs in `waitUntil`, never throws, and logs
  `logger.error('sensor alert evaluation failed', …)` on failure. A failed publish logs
  `logger.error('sensor alert email publish failed', …)` (the transition stays; never a silent miss).
- The switch on each rule row is named **"Bevaka: {description}"** (owner, 2026-10-20; was "Larmet på: …").
- Schema: `.enableRLS()`, `timestamptz`, `bun run db:generate --name=sensor_alert_event` (next number 0030; re-check
  for a sibling session's 0030 first). Schema gate after Task 2.
- All new copy in `messages/{sv,en}.json` (sv source of truth). The new queries poll (`refetchInterval: 60_000`).

## Review Focus

1. **Two webhooks of one Förråd burst evaluated at once** → one event row, one publish. (Task 4: two concurrent
   `evaluateValueRules` calls.)
2. **Pausing, editing or deleting a rule while an evaluation of its device is in flight** → no email after the
   quiet end, no open event left behind on a paused rule, no FK error on delete. (Task 3 + Task 4: the lock
   ordering test.)
3. **A value hovering at the limit** (4.9 → 5.0 → 4.9 → 5.1 with `below 5`, count 2) and a battery wobbling 19 ↔ 21
   → at most one alert and one recovery. (Task 1 table tests.)
4. **Evaluation throwing** (DB error, publish error) → the webhook still answered 204, the reading is stored, an
   error log names the device. (Task 6.)
5. **Deleting a sensor or hard-deleting a user that has a firing rule** → succeeds, removes its events; deleting
   only the rule keeps an ended `deleted` entry. (Task 2 schema test, Task 3 service test.)

---

### Task 0: Check `main` still matches this plan

**Files:** none (read-only), unless the plan needs fixing.

- [ ] **Step 1:** Confirm: the latest migration is `drizzle/0029_sensor_alert_rule.sql`; `src/lib/db/schema/sensorAlert.ts` exports `sensorAlertRule` with the columns of step 1's plan; `src/lib/services/sensorAlert/rules.ts` exports `listOwnRules`, `createRule`, `updateRule`, `setRuleEnabled`, `deleteRule`; `src/lib/sensor/shellyWebhook.ts` exports `handleShellyWebhook` calling `recordReading` (which returns `{ deviceId }`); `QueueTopic` in `src/lib/effects/queue/queue.ts` has six topics and `vite.config.ts` lists the same six; `CurrentReadingTiles` takes `alertCounts`; `SensorAlertsDialog`'s `RuleRow` names its switch with `sensors_alert_enabled_named`.
- [ ] **Step 2:** If anything differs, fix this plan first and commit `docs(climate): align step 2 plan with main`.

---

### Task 1: Vocabulary + the pure judge

**Files:**
- Modify: `src/lib/sensor/alerts.ts`
- Create: `src/lib/sensor/alertJudge.ts`, `src/lib/sensor/alertTime.ts`
- Test: `src/lib/sensor/alertJudge.test.ts`, `src/lib/sensor/alertTime.test.ts`
- Modify: `src/lib/sensor/clientSafe.browser.test.tsx` (add the two new modules)

**Interfaces — Produces:**
- `alerts.ts` adds: `VALUE_ALERT_KINDS = ['temperature','humidity','battery'] as const`, `ValueAlertKind`;
  `SENSOR_ALERT_END_REASONS = ['recovered','paused','edited','deleted'] as const`, `SensorAlertEndReason`;
  `ALERT_RULES_PER_SENSOR_MAX = 20`; `ALERT_LOOKBACK_MS = 7 * 24 * 60 * 60_000`; and
  ```ts
  /** A rule in the viewer's list: firingSince is its open alert's start, null when not firing. */
  export type SensorAlertRuleListItem = SensorAlertRuleDto & { firingSince: Date | null }
  /** One history entry: the rule as it was when it fired. */
  export type SensorAlertEventDto = {
    id: string; kind: SensorAlertKind
    direction: SensorAlertDirection | null; threshold: number | null
    count: number | null; silenceHours: number | null
    startedAt: Date; endedAt: Date | null; endReason: SensorAlertEndReason | null
  }
  ```
- `alertJudge.ts`:
  ```ts
  export type AlertReading = { recordedAt: Date; temperatureC: number | null; humidityPct: number | null; batteryPct: number | null }
  export type ValueRule = { kind: ValueAlertKind; direction: SensorAlertDirection; threshold: number; count: number }
  export type ValueJudgement =
    | { action: 'none' }
    | { action: 'fire'; since: Date; value: number }
    | { action: 'recover'; endedAt: Date; value: number }
  export function judgeValueRule(rule: ValueRule, firing: boolean, ascending: AlertReading[]): ValueJudgement
  ```
  `value` = the latest group's value.
- `alertTime.ts`: `formatAlertDuration(ms: number): string` → `"45 min"`, `"2 h"`, `"6 h 30 min"`, `"1 d 3 h"`
  (whole minutes, rounded down; under a minute → `"0 min"`; a zero part is left out).

- [ ] **Step 1: Write the failing tests.** Readings 2 h apart unless stated (`at(minutes)` helper); rule `{ kind:'temperature', direction:'below', threshold:5, count:2 }`:
  - armed, 6 / 4.9 / 4.8 → `fire`, `since` = the 4.9 reading's time, `value` 4.8.
  - armed, 4.9 / 5.1 / 4.9 → `none`; firing, same → `none`; armed, 4.9 / 5.0 → `none` (5.0 is normal).
  - firing, 4.8 / 5.0 / 5.2 → `recover`, `endedAt` = the 5.0 reading's time, `value` 5.2.
  - hover 4.9, 5.0, 4.9, 5.1, 4.9, 5.0 walked reading by reading with the state the previous judgement leaves → no transition at all (Review Focus 3).
  - battery `below 20`, values 19, 21, 19, 21, then 19, 18 → exactly one `fire` (at the 18), uses `batteryPct`.
  - burst: 4.8 @0, 4.8 @120, 5.2 @121 → judged after the second reading `fire`; after all three (one group, value 5.2) armed → `none`.
  - a humidity-only reading between two cold readings is dropped: 4.9 @0, `{ temperatureC: null, humidityPct: 70 }` @60, 4.8 @120 → `fire`.
  - one group only, count 2 → `none`; `[]` → `none`.
  - humidity `above 80`: 81 / 82 → `fire`; 80 / 80 while firing → `recover`.
  - `formatAlertDuration`: 0 → `"0 min"`, 45 min → `"45 min"`, 120 min → `"2 h"`, 390 min → `"6 h 30 min"`, 27 h → `"1 d 3 h"`.
- [ ] **Step 2:** `bunx vitest run src/lib/sensor/alertJudge.test.ts src/lib/sensor/alertTime.test.ts` → FAIL.
- [ ] **Step 3:** Implement. The judge filters by the kind's measure, merges with `mergeReadings`, and looks only at the last `count` groups.
- [ ] **Step 4:** Rerun → PASS; `bunx vitest run --project browser src/lib/sensor/clientSafe.browser.test.tsx` → PASS.
- [ ] **Step 5: Commit** `feat(climate): add the value alert judge`.

---

### Task 2: `sensor_alert_event` schema + migration (schema gate after)

**Files:**
- Modify: `src/lib/db/schema/sensorAlert.ts` (the barrel already exports the file)
- Create (generated): `drizzle/0030_sensor_alert_event.sql`, `drizzle/meta/*`
- Test: `src/lib/db/schema/sensorAlert.test.ts` (add cases)

**Interfaces — Produces:** `sensorAlertEvent`:

| column | type | notes |
|---|---|---|
| `id` | uuid pk `defaultRandom()` | |
| `rule_id` | uuid null → `sensor_alert_rule.id` **set null** | null once the rule is deleted |
| `user_id` | uuid not null → `user.id` **cascade** | owner; every read filters on it |
| `device_id` | uuid not null → `sensor_device.id` **cascade** | |
| `kind`, `direction`, `threshold`, `count`, `silence_hours` | as on the rule | snapshot when it fired |
| `started_at` | timestamptz not null | |
| `ended_at` | timestamptz null | null = firing |
| `end_reason` | text `$type<SensorAlertEndReason>()` null | |
| `created_at` | timestamptz not null default now | |

CHECKs: `kind` in kinds; `direction` null or in directions; `end_reason` null or in end reasons;
`(ended_at IS NULL) = (end_reason IS NULL)`; `ended_at IS NULL OR ended_at >= started_at`. No shape CHECK: the
service writes the snapshot only from a valid rule. Don't add a CHECK tying `rule_id` to
`ended_at`: a sensor or user delete cascades into both tables, and the rule's `SET NULL` may reach an open event
before its own cascade delete does.

Indexes: `sensor_alert_event_open_rule_idx` **unique** on `(rule_id)` `WHERE ended_at IS NULL` (the firing state;
also serves the open-event lookups); `sensor_alert_event_history_idx` on `(user_id, device_id, started_at DESC, id DESC)`
("Senaste larm" keyset paging).

- [ ] **Step 1: Write the failing tests:** a firing and an ended event insert; a second open event for the same rule violates `sensor_alert_event_open_rule_idx`, while a second ended one doesn't; `ended_at` without `end_reason` and `ended_at < started_at` violate their CHECKs; deleting the rule keeps the (ended) event with `rule_id` null; **deleting the device, and hard-deleting the user, while an event is open succeeds** and removes the event (Review Focus 5).
- [ ] **Step 2:** `bunx vitest run src/lib/db/schema/sensorAlert.test.ts` → FAIL.
- [ ] **Step 3:** Add the table; `bun run db:generate --name=sensor_alert_event && bun run db:migrate`. Check the SQL has `ENABLE ROW LEVEL SECURITY`, `ON DELETE set null`, two `ON DELETE cascade` and the partial index's `WHERE`.
- [ ] **Step 4:** Rerun the test and `bunx vitest run test/rls.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(climate): add the sensor_alert_event table`.
- [ ] **Step 6: Schema gate.** Dispatch `migration-guard` and a schema-design reviewer (`general-purpose`, loading `supabase-postgres-best-practices`) in parallel, judging against: Task 4's evaluation (enabled value rules of one device `FOR UPDATE OF sensor_alert_rule`, joined to `user` where `deleted_at is null`, left-joined to the open event; readings of 7 days by `(device_id, recorded_at)`; the conditional insert / update), Task 3's quiet ends and the list's left join, and the history page (`user_id = $1 AND device_id = $2` ordered `started_at DESC, id DESC` after a cursor, limit 11). Fix or rule on every finding before Task 3.

---

### Task 3: Rule lifecycle, list state, history and the cap (service)

**Files:**
- Modify: `src/lib/services/sensorAlert/{errors.ts,rules.ts,index.ts}`
- Create: `src/lib/services/sensorAlert/history.ts`
- Test: `src/lib/services/sensorAlert/rules.test.ts` (add cases), `src/lib/services/sensorAlert/history.test.ts`

**Interfaces:**
- Consumes: Task 1 types, Task 2 table.
- Produces:
  - `SensorAlertDomainErrorCode` gains `'TOO_MANY_RULES'` (comment: the user already has
    `ALERT_RULES_PER_SENSOR_MAX` rules on that sensor).
  - `listOwnRules(userId): Promise<SensorAlertRuleListItem[]>` (left join of the open event's `started_at`).
  - `createRule` throws `TOO_MANY_RULES` when the user has 20 rules on the device; `updateRule` does too when it
    moves a rule to a device where they already have 20. A count-then-insert in the transaction is enough (a race
    past 20 by one is harmless: the cap guards against a runaway, it isn't an invariant).
  - `setRuleEnabled(…, false)`, `updateRule` (only when a defining column changes: device, kind, direction,
    threshold, count, silence hours) and `deleteRule` end the rule's open event in the **same transaction**, with
    `ended_at = now` and reason `paused` / `edited` / `deleted`. Each locks the rule row first (the owned
    `UPDATE`/`SELECT … FOR UPDATE`), the same lock the evaluation takes. `deleteRule` ends the event (filtered by
    `rule_id` **and** `user_id`) before deleting the rule, and throws `RULE_NOT_FOUND` (rolling back) when no
    owned rule was deleted.
  - `history.ts`: `listOwnHistory(userId: string, deviceId: string, before?: { startedAt: Date; id: string }): Promise<{ entries: SensorAlertEventDto[]; next: { startedAt: Date; id: string } | null }>`,
    10 per page (`ALERT_HISTORY_PAGE = 10`, exported), newest first, keyset on `(started_at, id)` descending.

- [ ] **Step 1: Write the failing tests** (seed as in the existing `rules.test.ts`; open events inserted directly):
  - `listOwnRules` → `firingSince` = the open event's `startedAt`; an ended event → `null`; another user's open event on the same device doesn't show.
  - pause a firing rule → event ended `paused`, `ended_at` set; resume → no new event, `firingSince` null.
  - update a firing rule's threshold → ended `edited`; update with **identical** values → the event stays open (owner's call).
  - delete a firing rule → the event remains with `end_reason` `deleted` and `rule_id` null; user B deleting A's rule → `RULE_NOT_FOUND` and A's event is still open.
  - create the 21st rule on one device → `TOO_MANY_RULES`; the 21st on another device is fine; moving a rule onto a full device → `TOO_MANY_RULES`.
  - `history.test.ts`: 12 events → first page 10 newest with `next`, second page 2 and `next: null`; equal `started_at` ordered by id without a duplicate or a gap across pages; B sees none of A's; another device's events are left out.
- [ ] **Step 2:** `bunx vitest run src/lib/services/sensorAlert` → FAIL.
- [ ] **Step 3:** Implement (a private `endOpenEvent(tx, where, reason, now)` shared by the three).
- [ ] **Step 4:** Rerun → PASS.
- [ ] **Step 5: Commit** `feat(climate): end alerts quietly on pause, edit and delete`.

---

### Task 4: Evaluating a device (service)

**Files:**
- Create: `src/lib/services/sensorAlert/evaluate.ts`; Modify: `index.ts`
- Test: `src/lib/services/sensorAlert/evaluate.test.ts`

**Interfaces:**
- Consumes: Task 1 `judgeValueRule`, `ALERT_LOOKBACK_MS`; Task 2 table; `sensorDisplayName`.
- Produces:
  ```ts
  export type SensorAlertTransition = {
    transition: 'fired' | 'recovered'
    ruleId: string; eventId: string; to: string   // the owner's email
    sensorName: string
    kind: ValueAlertKind; direction: SensorAlertDirection; threshold: number; count: number
    value: number; since: Date; endedAt: Date | null   // endedAt set on 'recovered'
  }
  export async function evaluateValueRules(deviceId: string, now: Date): Promise<SensorAlertTransition[]>
  ```
  One `db.transaction`: (1) the device's enabled value rules joined to their non-deleted owner and the device,
  left-joined to the open event, `.for('update', { of: sensorAlertRule })`; none → return `[]` without reading
  readings; (2) the device's readings in `[now − ALERT_LOOKBACK_MS, now]` ascending; (3) per rule, judge; a fire
  inserts the snapshot event with `onConflictDoNothing` on the partial index (`target: ruleId`, `where: ended_at is
  null`) and `.returning`; a recovery updates the open event `where id = $ and ended_at is null` to `ended_at`,
  `end_reason 'recovered'` and `.returning`; only a returned row becomes a transition.

- [ ] **Step 1: Write the failing tests** (readings inserted with explicit `recordedAt`):
  - a `below 5` count-2 rule over 6 / 4.9 / 4.8 → one `fired` transition with the owner's email, display name, `since`, value; one open event with the rule's snapshot; evaluating again → `[]`.
  - then 5.2 / 5.3 → one `recovered`, event ended `recovered` at the 5.2 reading.
  - **two concurrent calls** (`Promise.all`) on a firing condition → exactly one transition in total, one event (Review Focus 1).
  - a paused rule, a silence rule, and a rule of a soft-deleted user → no transition, no event; the soft-deleted user's firing rule keeps its open event untouched.
  - pause racing an evaluation (Review Focus 2): hold the rule's lock in a test transaction (`SELECT … FOR UPDATE`), start `evaluateValueRules` (it blocks), pause the rule inside the held transaction and commit → the evaluation sees the rule disabled and returns `[]`; and the other order: evaluate fires, then pause → the event ends `paused`, and evaluating again on the same readings → `[]`, no open event.
  - a rule created after the cold readings were stored fires on the next evaluation (the spec counts readings from before the rule).
  - readings older than 7 days don't count; a device with rules but no readings → `[]`.
- [ ] **Step 2:** `bunx vitest run src/lib/services/sensorAlert/evaluate.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun → PASS.
- [ ] **Step 5: Commit** `feat(climate): evaluate value alert rules for a device`.

---

### Task 5: The alert email and its queue topic

**Files:**
- Modify: `src/emails/BrandEmailLayout.tsx` (optional `facts?: { label: string; value: string }[]` box and `note?: string`, rendered between the body and the button; nothing renders when absent)
- Create: `src/emails/SensorAlertEmail.tsx`, `src/emails/SensorAlertEmail.test.tsx`
- Modify: `src/lib/effects/email/{email.ts,adapters/devLog.ts,adapters/smtp.ts,adapters/resend.ts}` (`sendSensorAlert`)
- Modify: `src/lib/effects/queue/queue.ts` (topic `email_sensor_alert`), `src/lib/queue/index.ts`, `vite.config.ts` (trigger)
- Create: `src/lib/queue/handlers/emailSensorAlert.ts`, `emailSensorAlert.test.ts`
- Modify: `messages/{sv,en}.json`

**Interfaces — Produces:**
- `QueuePayloadMap['email_sensor_alert']` = `{ to: string; locale: Locale; transition: 'fired' | 'recovered'; sensorName: string; kind: ValueAlertKind; direction: SensorAlertDirection; threshold: number; count: number; value: number; since: string; endedAt: string | null }` (ISO strings; step 3 widens it for silence). The same object is `sendSensorAlert`'s input and `SensorAlertEmailProps`.
- `renderSensorAlert(props): Promise<{ subject; html; text }>`; the handler logs `logFields: { to, transition, kind }`.

Copy (sv; en mirrors it). `{measure}` = temperaturen / luftfuktigheten / batteriet; `{dir}` = under / över (the
rule's), `{back}` = the opposite; `{limit}` = "5 °C" / "80 %" (number in the payload's locale, `Intl.NumberFormat`
`sv-SE` / `en-GB`, at most one decimal; temperature with one decimal for `value`); times Stockholm `d MMM HH:mm`.

| | fired | recovered |
|---|---|---|
| subject | `⚠️ {name}: {measure} är {dir} {limit}` | `✅ {name}: {measure} är tillbaka {back} {limit}`; battery: `✅ {name}: batteriet är OK igen ({value})` |
| heading | `{name} behöver tillsyn` | `{name} är OK igen` |
| body | `{Measure} på {name} har legat {dir} din gräns på {limit} i {count} mätningar i rad.` | `{Measure} på {name} är tillbaka {back} din gräns på {limit} i {count} mätningar i rad.` |
| facts | Senaste mätning: {value} · Din gräns: {dir} {limit} · {Dir} gränsen sedan: {since} | Senaste mätning: {value} · {Dir} gränsen: {since} – {endedAt} ({duration}) |
| note | `Du får inga fler mejl om det här förrän {measure} är tillbaka {back} {limit}.` | — |

Button `Öppna Klimat`; the fallback sentence as the other emails; footer `Du får det här mejlet för att du har
ställt in larmet. Pausa eller ta bort det under klockan på {name} i Klimat.`; preview = the body.
`{duration}` = `formatAlertDuration`.

- [ ] **Step 1: Write the failing tests:** `SensorAlertEmail.test.tsx` renders the fired temperature mail with subject `⚠️ Förråd: temperaturen är under 5 °C`, the body sentence, "4,8 °C", the `since` time and a link to `/sensors`; the recovered battery mail has subject `✅ Förråd: batteriet är OK igen (95 %)` and the period with its duration; an `above` humidity recovery says "tillbaka under 80 %". The other emails' existing tests still pass (layout unchanged without `facts`). `emailSensorAlert.test.ts` follows `emailCredentialExpiry.test.ts`.
- [ ] **Step 2:** `bunx vitest run src/emails src/lib/queue` → FAIL.
- [ ] **Step 3:** Implement (copy `CredentialExpiryEmail.tsx` and the credential-expiry adapter methods; register the handler; add `{ topic: 'email_sensor_alert' }` beside the others in `vite.config.ts`).
- [ ] **Step 4:** Rerun → PASS; `bun run typecheck` clean.
- [ ] **Step 5: Commit** `feat(climate): add the sensor alert email`.

---

### Task 6: Evaluate after each reading (webhook glue)

**Files:**
- Create: `src/lib/sensor/evaluateAfterReading.ts` (server-only), `src/lib/sensor/evaluateAfterReading.test.ts`
- Modify: `src/lib/sensor/shellyWebhook.ts`, `src/lib/sensor/shellyWebhook.test.ts`

**Interfaces:**
- Consumes: Task 4 `evaluateValueRules`, Task 5 topic.
- Produces: `evaluateAfterReading(deviceId: string, now?: Date): Promise<void>`: never rejects. Evaluates, then
  publishes one `email_sensor_alert` per transition (`locale: baseLocale`, dates as ISO), each publish's failure
  logged on its own (`'sensor alert email publish failed'`, `{ ruleId, eventId, transition, error }`) without
  stopping the others; logs `'sensor alert transition'` `{ ruleId, eventId, deviceId, kind, transition }` per
  transition; on an evaluation error logs `'sensor alert evaluation failed'` `{ deviceId, error }`.
  `handleShellyWebhook` calls `waitUntil(evaluateAfterReading(deviceId))` (from `@vercel/functions`) after the
  stored-reading log line and before returning 204.

- [ ] **Step 1: Write the failing tests:** `evaluateAfterReading` with a firing condition publishes one message with the payload of Task 5 (`vi.spyOn(queue, 'publish')`); an evaluation that throws (`vi.spyOn` the service to reject) resolves and logs the error; a publish that rejects for the first of two transitions still publishes the second. `shellyWebhook.test.ts` (`vi.mock('@vercel/functions')` capturing the promise): a valid reading returns 204 and hands one promise to `waitUntil`; when the evaluation fails the response is still 204 and the reading is stored (Review Focus 4); an invalid MAC → 400 and no `waitUntil`.
- [ ] **Step 2:** `bunx vitest run src/lib/sensor` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun → PASS.
- [ ] **Step 5: Commit** `feat(climate): evaluate alert rules after each Shelly reading`.

---

### Task 7: Procedures (list state, history, the cap)

**Files:**
- Modify: `src/lib/orpc/procedures/sensorAlerts.ts`, `src/lib/orpc/sensorAlertErrorMessage.ts`, `messages/{sv,en}.json`
- Test: `src/lib/orpc/procedures/sensorAlerts.test.ts` (add cases)

**Interfaces — Produces:**
- `list` → `{ rules: SensorAlertRuleListItem[]; typicalGapMinutes }` (unchanged shape otherwise).
- `history`: `protectedProcedure`, input `{ deviceId: z.uuid(), before: z.object({ startedAt: z.date(), id: z.uuid() }).optional() }`
  → `listOwnHistory(context.user.id, …)`; records `context.timings.alertHistoryMs`.
- Errors gain `TOO_MANY_RULES: { status: 409 }`; message `sensors_alert_error_too_many` = "Du har redan {max} larm
  på den här sensorn" / "You already have {max} alerts on this sensor".

- [ ] **Step 1: Write the failing tests:** `list` returns `firingSince` for the caller's firing rule; `history` returns only the caller's entries for the device, pages with `before`; unauthenticated `history` → `UNAUTHORIZED`; the 21st `create` → `TOO_MANY_RULES` (409).
- [ ] **Step 2:** `bunx vitest run src/lib/orpc/procedures/sensorAlerts.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun → PASS.
- [ ] **Step 5: Commit** `feat(climate): serve alert state and history`.

---

### Task 8: The red bell, row states and "Senaste larm"

**Files:**
- Modify: `src/components/sensor/CurrentReadingTiles.tsx` (+ browser test), `src/routes/_authenticated/sensors.tsx`, `src/components/sensor/SensorAlertsDialog.tsx` (+ browser test), `src/components/sensor/alertRuleCopy.ts`, `messages/{sv,en}.json`
- Create: `src/components/sensor/SensorAlertHistory.tsx`, `SensorAlertHistory.browser.test.tsx`

**Interfaces:**
- Consumes: Task 7 procedures.
- Produces: `CurrentReadingTiles` gains `firingCounts: Record<string, number>` (route: rules with `firingSince`).
  `alertRuleDescription` takes `Pick<SensorAlertRuleDto, 'kind' | 'direction' | 'threshold' | 'count' | 'silenceHours'>`.
  `SensorAlertHistory({ deviceId, open })`.

Behaviour:
- **Tile:** firing > 0 → the bell `text-destructive`, a `destructive` badge with the **firing** count (instead of the
  neutral one), the tile `border-destructive`; label `sensors_alerts_open_named_firing` "Larm för {name}, {count}
  larmar nu" (en "Alerts for {name}, {count} firing now").
- **Rule row:** a `size-2` dot before the description, `bg-destructive` firing / `bg-success` on / `bg-muted-foreground`
  paused, with visually hidden text "Larmar" / "På" / "Pausad"; while firing, "sedan {time}" after the description
  (`HH:mm` today, `d MMM HH:mm` otherwise, Stockholm; `sensors_alert_firing_since`). The switch's name becomes
  `sensors_alert_enabled_named` = "Bevaka: {description}" / "Watch: {description}".
- **Senaste larm** (list view only, under the rules, also with no rules once an entry exists): heading
  "Senaste larm"; `useInfiniteQuery(orpc.sensor.alerts.history.infiniteOptions(…))` (check the `@orpc/tanstack-query`
  docs via Context7), `enabled: open`, `refetchInterval: 60_000`; each entry: the description, "{start} – {end} ·
  {duration}" or "{start} – pågår", and for a quiet end "· avslutad (pausad | ändrad | borttaget)"; "Visa fler"
  while there's a next page; no entries → nothing renders; a failed load → a one-line muted error.

- [ ] **Step 1: Write the failing tests:** tile with `firingCounts {d1: 1}` → label "Larm för Förråd, 1 larmar nu", badge "1"; the dialog row of a firing rule shows "sedan 03:10" and the hidden "Larmar"; the switch is named "Bevaka: Temperatur under 5 °C · 2 mätningar"; history renders 10 entries and "Visa fler" fetches with `before` = the 10th entry; an edited entry reads "avslutad (ändrad)"; an open entry reads "pågår".
- [ ] **Step 2:** `bunx vitest run --project browser src/components/sensor` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun → PASS, then `bunx vitest run --project browser` once → PASS.
- [ ] **Step 5: Commit** `feat(climate): show firing alerts and the alert history`.

---

### Task 9: Bones, docs, live check

**Files:**
- Regenerate if the tile layout changed: `src/bones/sensors-tiles.bones.json` (`bun run bones:capture /sensors`, dev server on :14610)
- Modify: `CLAUDE.md` (code map: `alertJudge.ts`, `alertTime.ts`, `evaluateAfterReading.ts`, the event table in the schema list, the `email_sensor_alert` topic, `SensorAlertEmail`), `docs/adr/0028-climate-alerts.md` ("Notes from step 2": the open event row is the firing state; the cap; an unchanged save; the recovery end time), the roadmap (row 2: plan link, PR, `PR open`; "Changes since the spec": the cap, the unchanged save, the end time, the switch name)

- [ ] **Step 1:** Live check locally (dev + `bun run dev:worker` + Mailpit): post readings to `/api/webhooks/shelly` with `curl` (token from `.env`) under a `below` rule → one Mailpit mail, the bell red, the row "sedan …", "Senaste larm" "pågår"; edit the rule → no mail, "avslutad (ändrad)"; a new rule recovering → one recovery mail. Desktop, tablet and phone widths.
- [ ] **Step 2:** Bones if needed; `bunx vitest run test/sectionSkeletonBones.test.ts` → PASS.
- [ ] **Step 3:** Pre-PR gate (`docs/feature-workflow.md`), including the sv/en key check.
- [ ] **Step 4: Commit** `docs(climate): record step 2 in the code map, ADR-0028 and the roadmap` (bones separately: `chore(climate): recapture the sensor tile bones`).

---

## Step review (Phase 5)

Core three (`code-reviewer`, correctness, spec) plus: `migration-guard` + schema-design reviewer (Task 2),
`test-completeness` (the service, `errors.ts`'s new code, the email adapters), a security reviewer loading
`better-auth-security-best-practices` (history and list scoped by the caller; the webhook's new work stays behind
its token; no address of one user reaching another's email), a UI reviewer loading `web-design-guidelines` +
`vercel-react-best-practices` (tile, rows, history), and an email reviewer loading `react-email` +
`email-best-practices` (the template and the layout change). Every reviewer gets this plan's Review Focus.

PR: `feat(climate): email value alerts from the sensor readings`.
