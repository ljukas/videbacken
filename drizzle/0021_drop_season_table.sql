-- ADR-0019: seasons are computed from the append-only season_era table; the
-- per-year season table is retired. Destructive by design — prod's season
-- table had zero rows (verified against Neon 2026-07-05); pre-launch posture
-- per ADR-0018.
DROP TABLE "season" CASCADE;