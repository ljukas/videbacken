# Roadmap — dishwasher energy (parked)

**Status: parked until we have a metering smart plug on the dishwasher.** Nothing is designed or built yet. Pick it
up by asking for "the dishwasher roadmap" once the plug is installed; the session then starts at
`docs/feature-workflow.md` Phase 0 with the decisions below as its input.

Goal: show the dishwasher's energy use in Videbacken the way the heat pumps' is shown
([ADR-0027](../../adr/0027-heat-pump-energy-data.md)), taking it out of "Övrigt hus" on Energi › Översikt.

## Status

| # | Step | Status |
|---|---|---|
| 0 | Feasibility spike: can Home Connect give us the dishwasher's kWh? | done 2026-10-12 (no, see below) |
| — | **Owner:** buy and install a metering smart plug (or in-wall meter) on the dishwasher's circuit | waiting |
| 1 | Shape (spec + ADR + step plans) with the plug in hand: probe what it sends, then design | not started |

## Decision (owner, 2026-10-13)

**Measure the dishwasher with a metering smart plug.** Not chosen:

- **Home Connect run times + Emaldo excess load.** A cron every ~5 min to catch run start and end costs Vercel
  invocations around the clock, and the kWh would still be an estimate (excess over a guessed baseline).
- **Emaldo load alone.** A kettle or the oven makes the same ~2 kW bursts, so runs would be guessed.
- **Program label estimates.** Not a measurement.

## What the spike found (2026-10-12)

The probe was throwaway (scratch scripts, nothing in the repo). Appliance: Bosch **SMP4ECW72S/60**, Home Connect
connected, programs Eco50, Auto2, Intensiv70, Kurz60, NightWash, MachineCare, PreRinse.

- **The official Home Connect API has no measured consumption.** REST gives only `EnergyForecast` / `WaterForecast`
  as percentages (Eco 50°: 71 % / 42 %). The run-summary and counter keys answer 409 `SDK.Error.UnsupportedStatus`
  over REST.
- **The EU Data Act event stream has no kWh either.** With "EU Data Act raw data" enabled on the developer app, the
  SSE stream (`GET /api/homeappliances/{haId}/events`) adds program phases (pre-rinse, main wash, final rinse,
  drying), a lifetime start counter and, at the end, `ProgramSessionSummary.Latest` (start, end, program, options,
  four undecoded detail values: 1, true, 0, 5). SSE needs a held connection, which ADR-0018 rules out anyway.
- **Where the app's usage statistics come from is unknown**; they may be estimated in the app.
- **Emaldo's house load shows the run.** The Eco 50° run of 2026-10-12 (18:14–22:46 UTC) had two ~+2 kW heater
  bursts (18:30–18:40, 20:10–20:35) over a ~1.1 kW baseline: about **0.8 kWh** excess. Useful as a sanity check
  for the plug's first readings.

## Notes for the shaping session

- **Hardware.** The heater draws ~2 kW (≈ 9 A at 230 V): check the plug's or meter's rated current. The outlet behind
  an integrated dishwasher is often in the next cabinet, so an in-wall meter (Shelly PM type) may fit better than a
  plug.
- **Push, not poll.** The existing Shelly webhook (`/api/webhooks/shelly`, token in the query string,
  [runbook](../../runbooks/shelly-webhook-setup.md)) shows the pattern: the device calls us, no cron. Probe whether
  the chosen device can push its energy counter on a schedule or on run end, so Vercel isn't invoked every few
  minutes. A pulled Shelly Cloud source is the fallback (ADR-0019).
- **Storage shape.** Like `heat_pump_reading`: hourly kWh, so Användning can subtract it from the load next to
  laddning and the heat pumps.
- **Home Connect is optional extra.** Program names and phases per run could be added later through the API; the
  developer app (Device Flow, Data Act raw data on) exists, and `HOMECONNECT_CLIENT_ID` / `HOMECONNECT_CLIENT_SECRET`
  are in `.env.local` and Vercel Production (unused by the app). It would need a stored, encrypted refresh token
  (ADR-0026), since the device-flow consent can't be redone without the owner.
