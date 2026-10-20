# ADR 0028 — Climate Alerts (personal sensor alert rules)

- **Status**: Accepted
- **Date**: 2026-10-19
- **Deciders**: Lukas
- **Decision in one line**: Every signed-in user may keep their own alert rules on the climate sensors
  (temperature, humidity, battery, silence), evaluated as readings arrive (silence by an hourly cron) over
  merged readings, with one email when a rule starts firing and one when it recovers, and a personal history.

**Spec**: [climate alerts design](../superpowers/specs/2026-10-19-climate-alerts-design.md).
**Builds on**: [ADR-0017](./0017-authentication.md) (roles; extends the own-account exception),
[ADR-0007](./0007-background-job-queue-architecture.md) (queue), [ADR-0008](./0008-email-architecture.md) (email),
[ADR-0018](./0018-polled-sync-replaces-realtime-sse.md) (polled UI).

---

## Context

The Shelly H&T sensors (Fack 1, Fack 3 in the krypgrund; Förråd) post a reading by webhook roughly every two hours.
Förråd posts in bursts of several readings within a minute. Every reading carries temperature, humidity and
battery. The owner wants an email when a sensor needs attention: frost in the krypgrund, Förråd below 5 °C, high
humidity, a sensor gone quiet, or a battery to replace. Nothing can be controlled from the app, so an alert only
informs.

ADR-0017 makes the app read-only for `user`s: every mutation is `adminProcedure`, except a user's own profile,
onboarding and avatar.

## Decision

1. **Alert rules are personal data, owned by a user,** and the own-account exception in ADR-0017 extends to them:
   any signed-in user creates, edits, pauses and deletes **only their own** rules, scoped to `context.user.id`. A
   user's rules email only that user. Nobody, admins included, sees another user's rules or history. Shared house
   data (sensors, readings, names) stays admin-only to mutate.
2. **Four rule kinds, one per sensor per rule:** temperature or humidity below/above a limit, battery below a
   limit, silence for N hours.
3. **Counted merged readings, not durations.** A value rule fires after x readings in a row on the wrong side,
   counting readings within 10 minutes of a group's first reading as one (Förråd's bursts). It re-arms after x
   readings back on the normal side, which gives hysteresis without a second limit. x is at least 2 and silence at
   least 3 h, so no setting can send a stream of emails. Readings are judged as they arrive, open group included,
   for alerts within seconds; a burst's first value may rarely fire before a later one corrects it.
4. **One email per transition:** one alert when a rule starts firing, one recovery when it stops; none while it
   stays firing. The transition and the decision to send are made atomically, so racing webhooks can't send twice.
   Emails go through the queue after the state change commits.
5. **Value rules are evaluated on ingest** (the Shelly webhook, after the reading is stored, without slowing the
   response or risking the reading). **Silence is evaluated by an hourly cron,** because silence produces no
   webhook. A silent sensor recovers on its next webhook.
6. **History is personal and outlives the rule:** each alert is recorded with a snapshot of the rule as it fired,
   kept when the rule is deleted, removed with the sensor.

## Alternatives considered

- **Admin-only rules** (ADR-0017 untouched). Rejected: the owner wants alerts per person ("if I set it up for my
  user it would only alert me"), and the data is the user's own, like their profile.
- **Duration conditions** ("below 5 °C for 4 h"). Independent of report rate, but the owner thinks in
  measurements; merged readings fix the burst problem that made raw counts unsafe.
- **Raw reading counts.** Rejected: on Förråd "2 in a row" would often mean one minute.
- **Re-arm after one normal reading.** Rejected: a value hovering at the limit would email repeatedly.
- **Evaluate everything in a frequent cron.** Simpler (no webhook coupling, no bursts racing), but alerts would lag
  by the cron interval and the cron would run all day for a reading every two hours. Kept for silence only.
- **Repeat reminders while firing.** Rejected by the owner: nothing can be done from the app, one email is enough.

## Consequences

- ADR-0017's rule becomes "admins mutate shared data; any user manages their own account **and their own alert
  rules**". The mutation procedures for rules are `protectedProcedure` + owner scoping, so a security review must
  check every one of them for the owner filter.
- The Shelly webhook gains a second responsibility. A failure in evaluation must be logged and must not fail the
  webhook or lose the reading.
- A new hourly cron (`/api/cron/…`) and new queue topic(s).
- Deleting a sensor now also deletes users' rules and alert history on it.

## Notes from step 1 (2026-10-20)

- **Delete confirmation is inline** in the rule form ("Ta bort larmet?" Avbryt / Ta bort), an exception to
  [ADR-0013](./0013-form-presentation-and-dialog-architecture.md)'s centered `AlertDialog` for confirmations: the form
  is already inside an open overlay (a bottom sheet on phones), and a second overlay stacked on it is worse.

## Notes from step 2 (2026-10-20)

- **The open event row is the firing state.** A partial unique index on `rule_id where ended_at is null` allows one
  open event per rule. Evaluation locks the device's rules (`FOR UPDATE`, ordered by id), then reads open events
  and writes conditionally. Pause, edit and delete lock the rule row first, then end the event.
- **At most 20 rules per sensor** (owner). It bounds the emails one reading can cause.
- **An unchanged save keeps a firing alert** (owner). Only a changed kind, direction, limit, count or hours restarts it.
- **A recovery ends at the first reading back on the normal side** (owner), not at the last of the x readings.
- **The switch is named "Bevaka: …"** (owner).
- **For step 3:** the webhook's end of a device's silence alerts must take the same rule lock as the cron, and the
  cron re-reads the device's latest reading after taking it (schema review). End silence events through the rule
  join, or add a `device_id` index on the event table.
