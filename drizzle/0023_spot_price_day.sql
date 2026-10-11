CREATE TABLE "spot_price_day" (
	"zone" text NOT NULL,
	"day" date NOT NULL,
	"avg_sek_per_kwh" double precision NOT NULL,
	"covered_seconds" integer NOT NULL,
	CONSTRAINT "spot_price_day_pk" PRIMARY KEY("zone","day"),
	CONSTRAINT "spot_price_day_zone_check" CHECK ("spot_price_day"."zone" IN ('SE3')),
	CONSTRAINT "spot_price_day_covered_seconds_check" CHECK ("spot_price_day"."covered_seconds" > 0 AND "spot_price_day"."covered_seconds" <= 90000)
);
--> statement-breakpoint
ALTER TABLE "spot_price_day" ENABLE ROW LEVEL SECURITY;