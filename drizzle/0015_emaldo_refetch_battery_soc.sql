-- One-off (solar-cost step 2b): clear the Emaldo day watermark so the hourly
-- sync re-fetches the whole history and fills house_energy_reading.battery_soc_pct.
-- Health reads last_success_at, which this leaves alone. No row (Emaldo never ran) → no-op.
UPDATE "integration_sync" SET "last_success_started_at" = NULL WHERE "source" = 'emaldo';
