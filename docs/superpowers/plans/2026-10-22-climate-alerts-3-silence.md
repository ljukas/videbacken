# Climate alerts, step 3: silence alerts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Silence rules fire. An hourly cron opens a silence alert when a sensor's last reading is more than the
rule's hours old and emails its owner once. The sensor's next reading ends it from the webhook, with one
recovery email.

**Architecture:** A pure `judgeSilenceRule` beside step 2's value judge. The `sensorAlert` service gets a cron
entry point, `evaluateDeviceSilence`. It locks the sensor, then the device's enabled silence rules, re-reads the
device's latest reading and opens events. Step 2's per-reading evaluation, renamed `evaluateReading`, now locks
**all** of the device's enabled rules and runs the same silence judging, which ends an open silence alert. Both
paths share one silence helper, the event table and the conditional writes, so a transition still publishes
exactly once. The email payload becomes a union with a `silence` member. One shared publish helper serves the
webhook glue and the new cron handler.

**Tech Stack:** Drizzle (pg), Vercel Cron (`vite.config.ts`), Vercel Queues / BullMQ, React Email, Paraglide,
Vitest (node).

**Spec:** [`docs/superpowers/specs/2026-10-19-climate-alerts-design.md`](../specs/2026-10-19-climate-alerts-design.md),
[ADR-0028](../../adr/0028-climate-alerts.md) (read "Notes from step 2", the last bullet is for this step),
[roadmap](../roadmaps/2026-10-20-climate-alerts.md), [step 2 plan](./2026-10-20-climate-alerts-2-value-alerts.md).

## Global Constraints

- **Fires** when the rule has no open event, the device has at least one reading, and `now − lastReadingAt` is
  **strictly more than** `silenceHours` hours. A sensor that has never reported doesn't fire.
- **The alert starts at the last reading** (owner, 2026-10-22): `started_at` = `lastReadingAt`, so "sedan …",
  the history and the recovery email show the whole gap ("18:00 – 02:30 · 8 h 30 min").
- **Recovers** when the rule has an open event and the device has a reading newer than its `started_at`;
  `ended_at` = the **first** reading after `started_at` (`recorded_at > started_at`), reason `recovered`.
- `lastReadingAt` is the device's newest reading at or before `now`, with **no lookback bound**: a sensor dead for
  three weeks still fires with its real last reading. The step 2 value lookback (7 days, ≤ 300 readings) is unchanged.
- **Both paths judge silence:** the cron (fire, plus recovery as a backstop when a webhook's evaluation failed) and
  every reading's evaluation (recovery within seconds). One helper, one judge.
- **Lock order** (ADR-0028 step 2 notes): sensor `FOR KEY SHARE`, then rules `FOR UPDATE OF sensor_alert_rule`
  ordered by id. The reading path locks every enabled rule of the device; the cron locks the device's enabled
  silence rules (a subset, same order). Each path reads open events and the latest reading **after** taking the locks.
- Rules of a soft-deleted user are skipped by both paths (no state change, no email). Paused rules are skipped. Pause,
  edit and delete already end a silence event quietly (step 2's `endOpenEvent`); nothing changes there.
- **Exactly one email per transition:** the same conditional writes as step 2 (insert `ON CONFLICT DO NOTHING` on
  the partial unique index; recovery `UPDATE … WHERE ended_at IS NULL`); only a returned row publishes.
- Cron: `GET /api/cron/sensor-silence`, `Authorization: Bearer $CRON_SECRET` (`verifyCronSecret`), schedule
  `15 * * * *` (UTC; clear of :00, :07/:22/:37/:52, :20, :30 and :45). It awaits all its work in the request:
  no `waitUntil`, no fire-and-forget.
- One device failing in the cron is logged (`'sensor silence evaluation failed'`, `{ deviceId, error }`) and doesn't
  stop the others; the cron still answers 200 with a `failed` count. Only a failure before any device is evaluated
  (listing the devices) is a 500, logged as `'sensor silence check failed'`.
- No schema change: open events are found by `rule_id` (`sensor_alert_event_open_rule_idx`), readings by
  `sensor_reading_device_recorded_idx`. If a task finds it needs one, stop and re-plan (schema gate).
- Emails: Swedish (`baseLocale`), `BrandEmailLayout`, through the existing `email_sensor_alert` topic, whose payload
  widens to a union. Messages already in the queue (value kinds) must stay valid. Copy in `messages/{sv,en}.json`.
- Logging via `~/lib/logger`; never log an email address outside the queue handler's existing `logFields`.

## Review Focus

1. **The sensor comes back while the cron runs** (cron and a reading's evaluation on one device at once) → no
   deadlock, and at the end no open silence event; any alert the cron opened has exactly one recovery. (Task 2:
   concurrent `evaluateDeviceSilence` + `evaluateReading`.)
2. **The cron runs twice at once** (an overlapping retry) → one event, one transition. (Task 2.)
3. **Pausing or editing a silence rule while the cron holds its lock** → the quiet end wins or the alert is ended
   quietly afterwards; never an open event on a paused rule. (Task 2: the held-lock test.)
4. **A sensor silent beyond the 7-day value lookback, then back** → fires with the real last reading as `since`;
   the recovery finds the first new reading. (Tasks 2 and 3.)
5. **One device's evaluation throws in the cron** → the other devices still evaluate and email; 200 with
   `failed: 1`; an error log names the device. (Task 5.)

---

### Task 0: Check `main` still matches this plan

**Files:** none (read-only), unless the plan needs fixing.

- [ ] **Step 1:** Confirm: `src/lib/services/sensorAlert/evaluate.ts` exports `evaluateValueRules(deviceId, now)` and
  `SensorAlertTransition` (value fields only), locking the device `FOR KEY SHARE` then rules `.for('update', { of: sensorAlertRule })` filtered by `VALUE_ALERT_KINDS`; `src/lib/sensor/alertJudge.ts` exports `judgeValueRule`; `QueuePayloadMap['email_sensor_alert']` has value fields only; `src/lib/sensor/evaluateAfterReading.ts` is the only caller of `evaluateValueRules` outside tests; `vite.config.ts` lists six crons and no `sensor-silence`; the latest migration is `drizzle/0030_sensor_alert_event.sql`.
- [ ] **Step 2:** If anything differs, fix this plan first and commit `docs(climate): align step 3 plan with main`.

---

### Task 1: The silence judge

**Files:**
- Modify: `src/lib/sensor/alertJudge.ts`, `src/lib/sensor/alertJudge.test.ts`

**Interfaces — Produces:**
```ts
export type SilenceJudgement =
  | { action: 'none' }
  | { action: 'fire'; since: Date } // since = lastReadingAt
  | { action: 'recover' }           // the caller finds the first reading after the open start
export function judgeSilenceRule(
  silenceHours: number,
  openStartedAt: Date | null,
  lastReadingAt: Date | null,
  now: Date,
): SilenceJudgement
```

- [ ] **Step 1: Write the failing tests** (`silenceHours` 6, `now` fixed):
  - no reading (`lastReadingAt` null), not open → `none`; open with no reading → `none`.
  - last reading 6 h ago exactly → `none`; 6 h + 1 ms ago → `fire` with `since` = that reading.
  - open since T, last reading = T → `none` (still silent); last reading T + 1 s → `recover`.
  - open, last reading 30 days ago → `none` (no bound on how old); not open, last reading 30 days ago → `fire`, `since` = it.
- [ ] **Step 2:** `bunx vitest run src/lib/sensor/alertJudge.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun → PASS.
- [ ] **Step 5: Commit** `feat(climate): add the silence alert judge`.

---

### Task 2: Silence in the evaluation service

**Files:**
- Modify: `src/lib/services/sensorAlert/evaluate.ts`, `src/lib/services/sensorAlert/evaluate.test.ts`
- Modify (rename only): `src/lib/sensor/evaluateAfterReading.ts`, `src/lib/sensor/shellyWebhook.test.ts`
  (`evaluateValueRules` → `evaluateReading`)

**Interfaces:**
- Consumes: Task 1 `judgeSilenceRule`.
- Produces:
  ```ts
  type TransitionBase = {
    transition: 'fired' | 'recovered'
    ruleId: string; eventId: string; to: string; sensorName: string
    since: Date            // value: the first wrong-side reading; silence: the last reading before the gap
    endedAt: Date | null   // set on 'recovered'
  }
  export type SensorAlertTransition = TransitionBase & (
    | { kind: ValueAlertKind; direction: SensorAlertDirection; threshold: number; count: number; value: number }
    | { kind: 'silence'; silenceHours: number }
  )
  /** Was evaluateValueRules: value rules as before, plus silence judging for the device. */
  export async function evaluateReading(deviceId: string, now: Date): Promise<SensorAlertTransition[]>
  /** Devices with at least one enabled silence rule of a non-deleted user. */
  export async function listSilenceDeviceIds(): Promise<string[]>
  /** The cron's per-device evaluation: its own transaction. */
  export async function evaluateDeviceSilence(deviceId: string, now: Date): Promise<SensorAlertTransition[]>
  ```
- Shape: a private rule-lock helper (device `FOR KEY SHARE`, then the device's enabled rules of non-deleted owners,
  optionally limited to `['silence']`, joined to `user` and `sensorDevice`, ordered by id, `FOR UPDATE OF
  sensor_alert_rule`) and a private `judgeSilenceRules(tx, deviceId, silenceRules, openByRule, now)` used by both
  entry points. It reads `lastReadingAt` = `max(recorded_at)` of the device `<= now` (no lookback). Per rule it
  calls the judge. A fire inserts the snapshot event (`kind 'silence'`, `silenceHours`, direction / threshold /
  count null, `started_at = since`) with step 2's `onConflictDoNothing`. A recovery reads `min(recorded_at)` of
  the device `> started_at` and `<= now`, clamps it to at least `started_at` like the value path, and updates
  `WHERE id AND ended_at IS NULL`. `evaluateReading` reads value readings only when a value rule exists.

- [ ] **Step 1: Write the failing tests** (step 2's `seed`, `readings`, `secondConnection` helpers; a silence rule `{ kind: 'silence', deviceId, silenceHours: 6 }`):
  - last reading 7 h ago → `evaluateDeviceSilence` returns one `fired` with `kind 'silence'`, `silenceHours 6`, `since` = that reading, the owner's email and display name; one open event with the snapshot (direction/threshold/count null). Again → `[]`.
  - last reading 5 h ago → `[]`; a device with the rule but no readings → `[]`.
  - a reading 30 days old only → fires with `since` = it (Review Focus 4).
  - then a reading arrives (two readings at `now − 2 min` and `now − 1 min`): `evaluateReading` returns one `recovered` with `since` = the old reading, `endedAt` = the `now − 2 min` reading; the event is ended `recovered` there.
  - the same recovery through `evaluateDeviceSilence` (backstop) → one `recovered`; then `evaluateReading` → `[]`.
  - a paused silence rule and a soft-deleted owner's rule → no event; the soft-deleted owner's open event stays open after both entry points run.
  - `listSilenceDeviceIds` → only devices with an enabled silence rule of a non-deleted user (not a paused rule's device, not a value-only device).
  - `evaluateReading` with value rules behaves as before (step 2's tests, renamed) and with a value rule **and** a firing silence rule on the device returns both kinds' transitions from one call.
  - **cron twice at once** (`Promise.all` of two `evaluateDeviceSilence`) → one transition, one event (Review Focus 2).
  - **cron and reading at once**: a silent device with a stored new reading; `Promise.all([evaluateDeviceSilence, evaluateReading])` → no open event afterwards, and the number of `fired` equals the number of `recovered` (0 or 1 each) (Review Focus 1).
  - **pause while the cron waits**: hold the silence rule's lock on a second connection, start `evaluateDeviceSilence` (wait until blocked), pause the rule in the held transaction and commit → `[]`, no event (Review Focus 3).
- [ ] **Step 2:** `bunx vitest run src/lib/services/sensorAlert/evaluate.test.ts` → FAIL.
- [ ] **Step 3:** Implement; rename the callers; `bun run typecheck` clean.
- [ ] **Step 4:** `bunx vitest run src/lib/services/sensorAlert src/lib/sensor` → PASS.
- [ ] **Step 5: Commit** `feat(climate): judge silence rules in the alert evaluation`.

---

### Task 3: The silence email

**Files:**
- Modify: `src/lib/effects/queue/queue.ts` (the payload union), `src/emails/SensorAlertEmail.tsx`,
  `src/emails/SensorAlertEmail.test.tsx`, `src/lib/effects/email/adapters/devLog.ts` (only if the union breaks its
  destructuring), `messages/{sv,en}.json`

**Interfaces — Produces:** `QueuePayloadMap['email_sensor_alert']` =
`{ to; locale; transition; sensorName; since: string; endedAt: string | null } & ({ kind: ValueAlertKind; direction; threshold; count; value } | { kind: 'silence'; silenceHours: number })`.
`SensorAlertEmailProps` is the same type; `renderSensorAlert` keeps its signature.

Copy (new keys, `email_sensor_alert_silence_*`; heading, button, fallback and footer reuse the existing keys).
`{lastAt}`/`{since}`/`{endedAt}` = `formatAlertDayTime`, `{duration}` = `formatAlertDuration(endedAt − since)`.

| | sv | en |
|---|---|---|
| subject fired | `⚠️ {name} har inte hört av sig på {hours} timmar` | `⚠️ {name} hasn't reported in {hours} hours` |
| subject recovered | `✅ {name} hör av sig igen` | `✅ {name} is reporting again` |
| body fired | `{name} har inte skickat någon mätning sedan {lastAt}, längre än din gräns på {hours} timmar.` | `{name} hasn't sent a reading since {lastAt}, longer than your limit of {hours} hours.` |
| body recovered | `{name} hör av sig igen efter {duration} utan mätningar.` | `{name} is reporting again after {duration} without readings.` |
| facts fired | Senaste mätning: {lastAt} · Din gräns: `{hours} timmar utan mätning` | Latest reading · Your limit: `{hours} hours without a reading` |
| facts recovered | `Utan mätningar`: {since} – {endedAt} ({duration}) (the existing period value) | `Without readings` |
| note (fired) | `Du får inga fler mejl om det här förrän {name} hör av sig igen.` | `You won't get more emails about this until {name} reports again.` |

- [ ] **Step 1: Write the failing tests:** fired silence (`sensorName 'Fack 3'`, `silenceHours 6`, `since` 2027-01-15T17:00Z) → subject `⚠️ Fack 3 har inte hört av sig på 6 timmar`, the body with "15 jan. 18:00", the limit fact "6 timmar utan mätning", a link to `/sensors`; recovered (`endedAt` 2027-01-16T01:30Z) → subject `✅ Fack 3 hör av sig igen`, "8 h 30 min" and the period; an English fired silence mail; a CR/LF in the name stays one line in the subject. The existing value-kind tests pass unchanged.
- [ ] **Step 2:** `bunx vitest run src/emails/SensorAlertEmail.test.tsx src/lib/queue` → FAIL.
- [ ] **Step 3:** Implement: branch on `kind === 'silence'` for subject, body, facts and note; the value path keeps its code.
- [ ] **Step 4:** Rerun → PASS; `bun run typecheck` clean.
- [ ] **Step 5: Commit** `feat(climate): add the silence alert email`.

---

### Task 4: Publish silence transitions from the reading's evaluation

**Files:**
- Create: `src/lib/sensor/publishAlertTransitions.ts` (server-only), `src/lib/sensor/publishAlertTransitions.test.ts`
- Modify: `src/lib/sensor/evaluateAfterReading.ts`, `src/lib/sensor/evaluateAfterReading.test.ts`

**Interfaces — Produces:** `publishAlertTransitions(deviceId: string, transitions: SensorAlertTransition[]): Promise<void>`:
never rejects. It moves step 2's per-transition log line (`'sensor alert transition'`) and its publish with the
per-publish catch (`'sensor alert email publish failed'`) out of `evaluateAfterReading`. It maps a transition to the
Task 3 payload: ISO dates, `locale: baseLocale`, `silenceHours` for silence, the value fields otherwise.
`evaluateAfterReading` = `evaluateReading` + this.

- [ ] **Step 1: Write the failing tests:** a silence transition publishes `{ kind: 'silence', silenceHours: 6, since: <ISO>, endedAt: <ISO>, transition: 'recovered', … }` with no value fields; a value transition publishes exactly step 2's payload; a rejecting first publish still publishes the second. `evaluateAfterReading` with a firing silence alert and a new stored reading publishes one `recovered` silence message.
- [ ] **Step 2:** `bunx vitest run src/lib/sensor` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun → PASS.
- [ ] **Step 5: Commit** `feat(climate): email silence recoveries from the readings`.

---

### Task 5: The hourly silence cron

**Files:**
- Create: `src/lib/sensor/silenceCron.ts` (server-only), `src/lib/sensor/silenceCron.test.ts`,
  `src/routes/api/cron/sensor-silence.ts` (route binding, like `comfort-cloud-sync.ts`)
- Modify: `vite.config.ts` (crons + their comment), `src/routeTree.gen.ts` (regenerated by the dev server/build, never by hand)

**Interfaces — Produces:**
- `checkSilence(now: Date): Promise<{ devices: number; failed: number; fired: number; recovered: number }>`:
  `listSilenceDeviceIds()`, then each device **in turn** (`evaluateDeviceSilence` then `publishAlertTransitions`), a
  device's throw caught and logged (`'sensor silence evaluation failed'`, `{ deviceId, error }`); one summary line
  `logger.info('sensor silence check', { devices, failed, fired, recovered, durationMs })`.
- `handleSilenceCron(request: Request): Promise<Response>`: `verifyCronSecret` → 401 without it (nothing runs);
  else 200 `Response.json(summary)`; a throw out of `checkSilence` → `logger.error('sensor silence check failed', { error })`, 500.
- `vite.config.ts`: `{ path: '/api/cron/sensor-silence', schedule: '15 * * * *' }` with a comment line in the
  existing list ("Climate silence alerts hourly at :15 …, src/lib/sensor/silenceCron.ts", ADR-0028).

- [ ] **Step 1: Write the failing tests** (`setupDatabase()`; `CRON_SECRET` stubbed as in `catalogueCheckCron.test.ts`; `vi.spyOn(queue, 'publish')`):
  - no / wrong bearer → 401, no publish; `CRON_SECRET` empty → 401.
  - two devices silent past a 6 h rule → 200 `{ devices: 2, failed: 0, fired: 2, recovered: 0 }`, two `email_sensor_alert` silence publishes; again → `fired: 0`.
  - `evaluateDeviceSilence` rejecting for the first device (`vi.spyOn` the service module) → 200, `failed: 1`, the second device still fires and publishes, the error log names the first device (Review Focus 5).
  - `listSilenceDeviceIds` rejecting → 500 and the `'sensor silence check failed'` log.
- [ ] **Step 2:** `bunx vitest run src/lib/sensor/silenceCron.test.ts` → FAIL.
- [ ] **Step 3:** Implement; `bun run build` regenerates the route tree and passes the chunk and server-entry checks.
- [ ] **Step 4:** Rerun → PASS.
- [ ] **Step 5: Commit** `feat(climate): check silence rules hourly`.

---

### Task 6: Docs, live check, gate

**Files:**
- Modify: `CLAUDE.md` (code map: `api/cron/` gains `sensor-silence.ts hourly at :15`; `sensor/` mentions the alert
  judge, the evaluation glue and the silence cron), `docs/adr/0028-climate-alerts.md` ("Notes from step 3": the start
  at the last reading (owner); no lookback for the last reading; the cron's backstop recovery; the shared lock order),
  the roadmap (row 3: plan link, PR, `PR open`; "Changes since the spec": the start time, the cron minute)

- [ ] **Step 1: Live check locally** (dev + `bun run dev:worker` + Mailpit): a silence rule (3 h) on a sensor whose last reading is older than 3 h (insert an old reading for a test device), `curl -H "Authorization: Bearer $CRON_SECRET" localhost:14600/api/cron/sensor-silence` → one Mailpit mail with the approved subject, the bell red, the row "sedan …", "Senaste larm" "pågår"; again → no mail; a webhook reading for that MAC (`curl` `/api/webhooks/shelly`) → one recovery mail, the history entry with the gap's duration. Delete the test device afterwards.
- [ ] **Step 2:** Pre-PR gate (`docs/feature-workflow.md`), including the sv/en key check.
- [ ] **Step 3: Commit** `docs(climate): record step 3 in the code map, ADR-0028 and the roadmap`.

---

## Step review (Phase 5)

Core three (`code-reviewer`, correctness, spec) plus `test-completeness` (the service's new entry points, the
email union), a security reviewer loading `better-auth-security-best-practices` (the new cron endpoint's secret
gate, one user's alert reaching only that user, no address in the new logs) and an email reviewer loading
`react-email` + `email-best-practices` (the silence copy and the union). No schema or UI change, so no schema or UI
reviewers. Each reviewer gets this plan's Review Focus. The correctness reviewer also checks the lock order
against a sensor delete and the step 2 rule mutations.

PR: `feat(climate): email silence alerts from an hourly check`.
