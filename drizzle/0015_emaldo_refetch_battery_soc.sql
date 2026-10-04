-- One-off (solar-cost step 2b): clear the Emaldo day watermark so the hourly
-- sync re-fetches the whole history and fills house_energy_reading.battery_soc_pct.
-- A held lease gets a new token but keeps its expiry: a run in flight while
-- this commits then loses its lease (its outcome is discarded instead of
-- writing the watermark back), and no second run starts until the lease
-- expires, as after a crashed run.
-- Health reads last_success_at, which this leaves alone. No row (Emaldo never ran) → no-op.
UPDATE "integration_sync"
SET
  "last_success_started_at" = NULL,
  "lease_token" = CASE WHEN "lease_token" IS NOT NULL THEN gen_random_uuid() END
WHERE "source" = 'emaldo';
