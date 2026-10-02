CREATE TABLE "vehicle_state_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"polled_at" timestamp with time zone NOT NULL,
	"captured_at" timestamp with time zone,
	"charging_state" text,
	"charge_type" text,
	"plug_state" text,
	"charge_power_kw" double precision,
	"parking_state" text,
	"at_home" boolean,
	"soc_percent" smallint,
	"odometer_km" integer,
	"odometer_captured_at" timestamp with time zone,
	CONSTRAINT "vehicle_state_snapshot_charging_state_length_check" CHECK ("vehicle_state_snapshot"."charging_state" IS NULL OR char_length("vehicle_state_snapshot"."charging_state") <= 64),
	CONSTRAINT "vehicle_state_snapshot_charge_type_length_check" CHECK ("vehicle_state_snapshot"."charge_type" IS NULL OR char_length("vehicle_state_snapshot"."charge_type") <= 64),
	CONSTRAINT "vehicle_state_snapshot_plug_state_length_check" CHECK ("vehicle_state_snapshot"."plug_state" IS NULL OR char_length("vehicle_state_snapshot"."plug_state") <= 64),
	CONSTRAINT "vehicle_state_snapshot_parking_state_length_check" CHECK ("vehicle_state_snapshot"."parking_state" IS NULL OR char_length("vehicle_state_snapshot"."parking_state") <= 64),
	CONSTRAINT "vehicle_state_snapshot_charge_power_nonneg_check" CHECK ("vehicle_state_snapshot"."charge_power_kw" IS NULL OR "vehicle_state_snapshot"."charge_power_kw" >= 0),
	CONSTRAINT "vehicle_state_snapshot_soc_percent_check" CHECK ("vehicle_state_snapshot"."soc_percent" IS NULL OR "vehicle_state_snapshot"."soc_percent" BETWEEN 0 AND 100),
	CONSTRAINT "vehicle_state_snapshot_odometer_nonneg_check" CHECK ("vehicle_state_snapshot"."odometer_km" IS NULL OR "vehicle_state_snapshot"."odometer_km" >= 0)
);
--> statement-breakpoint
ALTER TABLE "vehicle_state_snapshot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "vehicle_state_snapshot_polled_at_idx" ON "vehicle_state_snapshot" USING btree ("polled_at");