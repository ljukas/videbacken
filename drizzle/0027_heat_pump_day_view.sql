-- Per-unit Stockholm day sums of heat_pump_reading (ADR-0027 decision 6, amended 2026-10-15; heat pumps step 2b).
-- The heat pump sum reads take whole days from here and a range's partial first and last day from the readings
-- (by primary key), so a request never scans the readings. Refreshed once per Comfort Cloud run that stored hours
-- (heatPump.refreshDaySums). A reading is one whole UTC hour and Stockholm's offsets are whole hours, so every hour
-- lies in one Stockholm day (DST days have 23 or 25). Temperatures keep a sum and an hour count, so any range of
-- days gets the exact hour-weighted mean.
CREATE MATERIALIZED VIEW "heat_pump_day" AS
SELECT
  "heat_pump_id",
  ("hour_start" AT TIME ZONE 'Europe/Stockholm')::date AS "day",
  sum("energy_kwh") AS "kwh",
  sum("energy_kwh" * coalesce("heat_share", 0)) AS "heat_kwh",
  sum("energy_kwh" * coalesce("cool_share", 0)) AS "cool_kwh",
  sum("inside_c") AS "inside_c_sum",
  count("inside_c")::int AS "inside_c_hours",
  sum("outside_c") AS "outside_c_sum",
  count("outside_c")::int AS "outside_c_hours",
  sum("setpoint_c") AS "setpoint_c_sum",
  count("setpoint_c")::int AS "setpoint_c_hours",
  count(*)::int AS "hours",
  min("hour_start") AS "first_hour",
  max("hour_start") AS "last_hour"
FROM "heat_pump_reading"
GROUP BY 1, 2;
--> statement-breakpoint
-- REFRESH … CONCURRENTLY needs a unique index over every row.
CREATE UNIQUE INDEX "heat_pump_day_heat_pump_id_day_idx" ON "heat_pump_day" ("heat_pump_id", "day");
--> statement-breakpoint
-- No RLS on a materialized view: keep Supabase's API roles off it (no-op where they don't exist, e.g. local and CI).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON "heat_pump_day" FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON "heat_pump_day" FROM authenticated; END IF;
END $$;
