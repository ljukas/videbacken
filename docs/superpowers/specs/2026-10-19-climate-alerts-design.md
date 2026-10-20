# Climate alerts: design

- **Date:** 2026-10-19
- **Status:** Approved by the owner 2026-10-20
- **Decision record:** [ADR-0028](../../adr/0028-climate-alerts.md)
- **Builds on:** ADR-0001 (effects after success), ADR-0002 (services), ADR-0007 (queue), ADR-0008 (email),
  ADR-0013 (dialogs), ADR-0017 (auth: the own-data exception), ADR-0018 (polled, never pushed)

## Intent

The house has Shelly H&T Gen3 sensors under and around it (today: Fack 1 and Fack 3 in the krypgrund, Förråd).
The Klimat page shows their readings, but nobody watches it at 03:00 when the krypgrund freezes or Förråd drops
under 5 °C. The owner wants the app to tell them by email when a sensor needs attention: a value past a limit, a
sensor that stopped reporting, or batteries that need replacing. Nothing in the house can be controlled from the
app, so an alert only informs: **one email when a problem starts, one when it's over**, never a stream.

Alerts are **personal**. A user sets up their own rules; the emails go only to them; only they see their rules and
their alert history.

## What prod data says (read-only, 2026-10-19, last 30 days)

| Sensor | Readings | Gap between readings | Temp | Humidity | Battery |
|---|---|---|---|---|---|
| Fack 1 | 241 | 120 min (p10–p90 120–121) | 10.6–14.2 °C | 68.8–88 % | 94 → 72 % since 2026-07-21 |
| Fack 3 | 243 | 120 min (p10–p90 120–121) | 11.7–15.1 °C | 62.2–85 % | 97 → 79 % since 2026-07-21 |
| Förråd | 459 | median **1 min**, p90 121 min | 9.3–25.4 °C | 47.1–83.1 % | 83 → 68 % since 2026-10-07 |

- Every webhook carries temperature, humidity and battery (all 1,373 readings have a battery value).
- Förråd reports in **bursts**: several readings within a minute of each other, then about two hours of quiet.
  Counting raw readings would make "2 in a row" mean one minute.
- Battery wobbles by 1–3 % between readings (Fack 1: 71, 72, 73, 74 % within one week).
- Krypgrund humidity is already 62–88 % this season, so a humidity limit around 80 % would trip often. That's the
  owner's to set; the form doesn't pre-fill a limit.

## Goals

1. A user creates, edits, pauses and deletes **their own** alert rules, per sensor, from the Klimat page.
2. Four rule kinds:
   - **Temperature**: below or above a limit (°C).
   - **Humidity**: below or above a limit (%).
   - **Battery**: below a limit (%), default 20 %.
   - **Silence**: no reading for N hours, default 6 h.
3. One alert email when a rule starts firing, one recovery email when it stops. Nothing in between.
4. A history of the user's own alerts per sensor (started, ended, how long), kept after a rule is deleted.
5. The Klimat page stays focused on data: alerts live behind a bell on each sensor tile.

## Non-goals (first slice)

- Push notifications, SMS, or any channel besides email.
- Repeated reminders while a rule keeps firing.
- Shared or household alerts, or one user's rules emailing another user.
- Admins seeing or managing other users' rules.
- Alert markers on the climate charts.
- Rules spanning several sensors ("any sensor goes silent") or combined conditions (temperature AND humidity).
- Duration-based conditions ("below 5 °C for 4 hours"). The owner chose counted readings.
- Control of anything in the house.

## Anti-goals (failure even if it technically works)

- **An email storm.** A value hovering around a limit (4.9 → 5.1 → 4.9 °C), a Förråd burst, or two webhooks
  racing must never send more than one email per transition.
- **A silent miss.** A rule that should have fired and didn't, with nothing in the logs to say why.
- **Someone else's alerts reaching you,** or anyone seeing a rule or history entry that isn't theirs.
- **A cluttered Klimat page.** The tiles stay about readings.
- **A slower webhook.** The Shelly is a battery device that waits for our response; evaluating rules mustn't
  noticeably lengthen it.

## Behaviour

### Merged readings

The value rules (temperature, humidity, battery) count **merged readings**. A group starts at a reading and
takes in every reading within **10 minutes of that first reading**; the next reading after the window starts a new
group. Windows don't chain, so a sensor reporting every few minutes still forms a new group every 10 minutes.
The group's value is its latest reading so far. On the 2-hourly sensors every reading is its own group; Förråd's
bursts each become one. *(10 minutes and the fixed window are my calls: well above burst spacing, well below the
2-hour cadence.)* A reading that lacks the rule's measure (no temperature in the webhook) is skipped: it doesn't
count either way and doesn't break a run.

**Judged immediately (owner's decision).** Rules are evaluated as each reading arrives, on the groups as they
stand, including the still-open latest group. So a burst's first value (4.8 °C) can fire a rule before a later
reading in the same burst (5.2 °C) replaces it. The owner accepted that rare case in exchange for alerts within
seconds. With a count of at least 2 it can't produce an alert/recovery storm: recovery also needs x groups on the
normal side.

### Value rules (temperature, humidity, battery)

A rule has a direction (`below`, `above`; battery is always `below`), a limit, and a count **x** (default 2).

- **Wrong side:** `below` means strictly less than the limit; `above` means strictly greater. Equal to the limit
  is the normal side.
- **Fires** when the latest x merged readings are all on the wrong side, and the rule is armed. The alert email
  goes out once; the rule is now *firing*, since the first reading of the earliest of those x groups.
- **Recovers** when the latest x merged readings are all back on the normal side while firing. The recovery email
  goes out once; the rule is *armed* again.
- So a value going 4.9 → 5.1 → 4.9 °C with x = 2 sends nothing extra, and a night below freezing sends one email.
- **Counting includes readings stored before the rule existed.** A rule created while Krypgrund is already
  freezing fires on its next reading if the run is long enough. *(My call.)*

### Silence rules

A rule has a number of hours N (default 6).

- **Fires** when the sensor's last reading is more than N hours old. An hourly cron checks this, so the alert can
  arrive up to an hour after the threshold. The alert email goes out once.
- **Recovers** on the sensor's next reading, from the webhook, without waiting for the cron. The recovery email
  goes out once.
- A sensor that has never reported doesn't fire. *(My call.)*

### Lifecycle and state

- **States:** `armed` or `firing` (with the time it started), plus `paused` when the user switches the rule off.
- **Pausing a firing rule** ends its running alert quietly (no email). Switching back on starts counting fresh.
  Readings from before the switch-on still count, same as a new rule. *(My call.)*
- **Editing a rule** (kind, direction, limit, count, hours) restarts it as if new. A running alert ends quietly.
  *(My call.)*
- **Deleting a rule** ends a running alert quietly. Its history stays.
- **Deleting a sensor** (admin action) deletes its rules and their history. *(My call: the history names a sensor
  that no longer exists.)*
- **A revoked (soft-deleted) user's** rules are skipped entirely: not evaluated, no state change, no email. If
  the user is re-invited they're evaluated again from the next reading, against the stored readings like a new
  rule. *(My call.)*
- **Exactly one email per transition**, even when Förråd's bursts deliver two webhooks within a second. The state
  change and the decision to send happen together, with a guard (row lock or conditional update) so a concurrent
  evaluation sees the new state.

### Emails

Swedish, the shared branded layout (`BrandEmailLayout`), sent through the queue like the other alert emails (a
throw retries the send). Mockups were approved; wording below is the approved draft.

| Kind | Alert subject | Recovery subject |
|---|---|---|
| Temperature / humidity | `⚠️ Förråd: temperaturen är under 5 °C` | `✅ Förråd: temperaturen är tillbaka över 5 °C` |
| Battery | `⚠️ Förråd: batteriet är under 20 %` | `✅ Förråd: batteriet är OK igen (95 %)` |
| Silence | `⚠️ Fack 3 har inte hört av sig på 6 timmar` | `✅ Fack 3 hör av sig igen` |

The alert body has a heading ("Förråd behöver tillsyn"), one sentence on what happened ("…har legat under din
gräns på 5 °C i 2 mätningar i rad"), a facts box (latest value, your limit, on the wrong side since), "Du får inga
fler mejl om det här förrän…", an "Öppna Klimat" button linking to `/sensors`, and a footer: you got this because
you set up the alert; pause or delete it under the bell on that sensor. The recovery body has the latest value and
the period on the wrong side with its duration. Silence emails show the time of the last reading instead of a
value. The sensor's name is its display name (`sensorDisplayName`).

### History

One history entry per alert: the sensor, the kind, the rule as it was when it fired (e.g. "under 5 °C, 2
mätningar", so the entry still reads right after the rule is edited or deleted), started at, ended at (empty while
firing), and how it ended (recovered, paused, edited, deleted). Only the owner sees their entries. Kept when the
rule is deleted; deleted with the sensor.

## Screens

The owner chose **a bell on each sensor tile** (option B of the mockups). The Klimat page is otherwise unchanged.

### The bell on the tile

On every tile of "Just nu", for every signed-in user, next to the admin's pencil (same 40 px ghost icon button):

- **No rules** for this sensor: a plain bell.
- **Rules, none firing:** a bell with a neutral badge counting your rules that are switched on. Only paused rules:
  a plain bell. *(My call.)*
- **A rule firing:** the bell in the destructive colour with the count of firing rules, and the tile border in
  that colour. *(The red border is from the mockup the owner approved.)*

The bell's state counts only the viewer's rules. It refreshes with the page's existing 60 s poll (ADR-0018).

### "Larm för <sensor>" dialog

A responsive overlay (dialog on desktop, bottom sheet on phones) with URL dialog state (ADR-0013), opened by the
bell. Two views that replace each other in one overlay:

1. **List view**
   - Caption: "Bara du får dessa mejl."
   - Your rules for this sensor, each with a state dot (red firing / green OK / grey paused), a one-line
     description ("Temperatur under 5 °C · 2 mätningar", "Tyst i 6 h", "Batteri under 20 %"), "sedan 03:10" while
     firing, a pencil (40 px ghost icon button, like the admin's on the tiles) that opens it in the form view, and
     an on/off switch.
   - "+ Nytt larm" opens an empty form.
   - "Senaste larm": your latest 10 history entries for this sensor (what, from–to, duration; "pågår" while
     firing), with "Visa fler" loading the next 10.
   - Empty state when you have no rules (shared `Empty` component, ADR-0016).
2. **Form view** (`useAppForm`, ADR-0005)
   - **Bevaka:** Temperatur / Luftfuktighet / Batteri / Tystnad (segmented).
   - **Temperature / humidity:** direction under/över + limit with its unit.
   - **Battery:** limit (%), pre-filled 20.
   - **Silence:** hours, pre-filled 6.
   - **I rad** (not for silence): count, pre-filled 2, with a hint of what that means for this sensor, e.g.
     "≈ 2–4 timmar för Förråd", from the sensor's recent typical gap between merged readings.
   - "Tillbaka" returns to the list; "Spara" saves and returns. Editing also offers "Ta bort".

**Bounds** (validated on both sides): count **2** to 10 and silence **3** to 72 h. Those minimums are the owner's
decision: count 1 has no hysteresis, and a silence shorter than the 2-hour cadence would fire every cycle, so
neither can storm. My calls: temperature limit −40 to 60 °C in 0.5 steps, humidity 1 to 99 %, battery 5 to 95 %.
No pre-filled limit for temperature or humidity.

Responsive at desktop, tablet and phone widths; all text in `messages/{sv,en}.json`.

## Constraints

- **Auth (ADR-0017):** every signed-in user may create, edit, pause and delete only their own rules, scoped to
  `context.user.id`. This extends the "own account" exception, recorded in ADR-0028. Every read and write of
  rules and history is filtered by the owner; another user's rule id behaves as not found.
- **Services own DB access** (ADR-0002) with an `AlertDomainError` (or similar) for invariants such as a rule not
  found. **Effects after success** (ADR-0001): emails go through the queue (ADR-0007), published only once the
  state change is committed.
- **The webhook stays fast and stores the reading first.** A failure in rule evaluation must never lose a
  reading or make the webhook return an error. It is logged loudly instead (it would otherwise be a silent miss).
  Work after the response goes through `waitUntil`, never fire-and-forget (CLAUDE.md gotcha).
- **No held connections** (ADR-0018): the bell and the dialog poll like the rest of the page.
- **New cron** for silence, hourly, secret-gated like the other `/api/cron/*` routes and scheduled in
  `vite.config.ts`.
- **Schema:** new tables with `.enableRLS()`, `timestamptz` everywhere, and the mandatory schema-design review
  plus `migration-guard` before anything builds on it.
- **Timings:** heavier procedures record `context.timings` sub-timings.
- **Logging** via `~/lib/logger`, never `console.*`; never log email addresses beyond what existing alert logs do.

## Left to the builder

- Table design: rules, per-rule state, history (the review gate judges it).
- Whether evaluation runs inline in the webhook request after the reading is stored, or in `waitUntil`, or as a
  queue job, within the "webhook stays fast, one email per transition" constraints.
- How the "typical gap" for the count hint is computed (e.g. median gap between merged readings over 7 days) and
  where it's served from.
- Procedure names and shapes, the queue topic(s) and payloads, and the email components (one template with kinds,
  or one per kind).
- How the dialog's two views map onto URL state.
- PR slicing (likely backend + emails first, then the bell UI).

## Deferred (follow-ups noted, not built)

- Alert markers on the climate charts.
- Other channels (web push).
- An "any sensor" silence rule.
- Repeated reminders for long-running alerts.
