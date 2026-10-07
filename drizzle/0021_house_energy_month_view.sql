-- Monthly house-energy sums (ADR-0024, amended 2026-10-07). The query the
-- Energi pages ran on every request, now refreshed once per Emaldo sync run
-- (houseEnergy.refreshMonthSums). Sums per UTC hour first: Stockholm's offsets
-- are whole hours, so every hour lies in one Stockholm month and only the
-- hours are converted. The SoC values are primary-key probes per month.
CREATE MATERIALIZED VIEW "house_energy_month" AS
WITH "hourly" AS (
  SELECT
    date_bin('1 hour', "bucket_start", timestamptz '2000-01-01 00:00:00+00') AS "hour",
    sum("grid_import_kwh") AS "grid_import_kwh",
    sum("grid_export_kwh") AS "grid_export_kwh",
    sum("solar_kwh") AS "solar_kwh",
    sum("load_kwh") AS "load_kwh",
    sum("battery_discharge_kwh") AS "battery_discharge_kwh",
    sum("battery_charge_solar_kwh") AS "battery_charge_solar_kwh",
    sum("battery_charge_grid_kwh" + "battery_charge_ac_kwh") AS "battery_charge_grid_kwh",
    count(*) AS "buckets",
    min("bucket_start") AS "first_bucket",
    max("bucket_start") AS "last_bucket"
  FROM "house_energy_reading"
  GROUP BY 1
), "monthly" AS (
  SELECT
    extract(year FROM "hour" AT TIME ZONE 'Europe/Stockholm')::int AS "year",
    extract(month FROM "hour" AT TIME ZONE 'Europe/Stockholm')::int AS "month",
    sum("grid_import_kwh") AS "grid_import_kwh",
    sum("grid_export_kwh") AS "grid_export_kwh",
    sum("solar_kwh") AS "solar_kwh",
    sum("load_kwh") AS "load_kwh",
    sum("battery_discharge_kwh") AS "battery_discharge_kwh",
    sum("battery_charge_solar_kwh") AS "battery_charge_solar_kwh",
    sum("battery_charge_grid_kwh") AS "battery_charge_grid_kwh",
    sum("buckets")::int AS "buckets",
    min("first_bucket") AS "first_bucket",
    max("last_bucket") AS "last_bucket"
  FROM "hourly"
  GROUP BY 1, 2
)
SELECT
  "m"."year", "m"."month",
  "m"."grid_import_kwh", "m"."grid_export_kwh", "m"."solar_kwh", "m"."load_kwh",
  "m"."battery_discharge_kwh", "m"."battery_charge_solar_kwh", "m"."battery_charge_grid_kwh",
  "m"."buckets", "m"."first_bucket", "m"."last_bucket",
  (SELECT "p"."battery_soc_pct" FROM "house_energy_reading" "p"
    WHERE "p"."bucket_start" BETWEEN "m"."first_bucket" AND "m"."last_bucket"
      AND "p"."battery_soc_pct" IS NOT NULL
    ORDER BY "p"."bucket_start" ASC LIMIT 1) AS "first_soc_pct",
  (SELECT "p"."battery_soc_pct" FROM "house_energy_reading" "p"
    WHERE "p"."bucket_start" BETWEEN "m"."first_bucket" AND "m"."last_bucket"
      AND "p"."battery_soc_pct" IS NOT NULL
    ORDER BY "p"."bucket_start" DESC LIMIT 1) AS "last_soc_pct"
FROM "monthly" "m";
--> statement-breakpoint
-- REFRESH … CONCURRENTLY needs a unique index over every row.
CREATE UNIQUE INDEX "house_energy_month_year_month_idx" ON "house_energy_month" ("year", "month");
