-- One-off (solar-cost step 2b): clear the Emaldo day watermark so the hourly
-- sync re-fetches the whole history and fills house_energy_reading.battery_soc_pct.
-- The lease goes too: a run in flight while this commits then loses its lease,
-- and its outcome is discarded instead of writing the watermark back.
-- Health reads last_success_at, which this leaves alone. No row (Emaldo never ran) → no-op.
UPDATE "integration_sync"
SET "last_success_started_at" = NULL, "running_since" = NULL, "lease_until" = NULL, "lease_token" = NULL
WHERE "source" = 'emaldo';
