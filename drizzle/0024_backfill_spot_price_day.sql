-- Server latency step 6: every stored day's average, from the slots already in
-- spot_price. The same aggregate as spotPrice.replaceDay's upsert (keep the two
-- in step), summed in slot order so the float result is deterministic.
-- Idempotent: re-running it rewrites the rows with the same values.
INSERT INTO "spot_price_day" ("zone", "day", "avg_sek_per_kwh", "covered_seconds")
SELECT "zone",
       ("slot_start" AT TIME ZONE 'Europe/Stockholm')::date,
       sum("sek_per_kwh" * extract(epoch FROM "slot_end" - "slot_start") ORDER BY "slot_start")
         / sum(extract(epoch FROM "slot_end" - "slot_start")),
       sum(extract(epoch FROM "slot_end" - "slot_start"))::integer
FROM "spot_price"
GROUP BY 1, 2
ON CONFLICT ("zone", "day") DO UPDATE
  SET "avg_sek_per_kwh" = excluded."avg_sek_per_kwh",
      "covered_seconds" = excluded."covered_seconds";
