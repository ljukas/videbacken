CREATE TABLE "vehicle_charge_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"source_session_id" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"energy_kwh" double precision NOT NULL,
	"start_soc_percent" smallint,
	"end_soc_percent" smallint,
	"is_public" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicle_charge_record_source_session_id_unique" UNIQUE("source","source_session_id"),
	CONSTRAINT "vehicle_charge_record_source_check" CHECK ("vehicle_charge_record"."source" IN ('skoda_export')),
	CONSTRAINT "vehicle_charge_record_end_at_check" CHECK ("vehicle_charge_record"."end_at" >= "vehicle_charge_record"."start_at"),
	CONSTRAINT "vehicle_charge_record_energy_kwh_nonneg_check" CHECK ("vehicle_charge_record"."energy_kwh" >= 0),
	CONSTRAINT "vehicle_charge_record_start_soc_percent_check" CHECK ("vehicle_charge_record"."start_soc_percent" IS NULL OR "vehicle_charge_record"."start_soc_percent" BETWEEN 0 AND 100),
	CONSTRAINT "vehicle_charge_record_end_soc_percent_check" CHECK ("vehicle_charge_record"."end_soc_percent" IS NULL OR "vehicle_charge_record"."end_soc_percent" BETWEEN 0 AND 100)
);
--> statement-breakpoint
ALTER TABLE "vehicle_charge_record" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ev_charge_session" ADD COLUMN "vehicle" text DEFAULT 'ours' NOT NULL;--> statement-breakpoint
ALTER TABLE "ev_charge_session" ADD COLUMN "vehicle_source" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "ev_charge_session" ADD CONSTRAINT "ev_charge_session_vehicle_check" CHECK ("ev_charge_session"."vehicle" IN ('ours', 'other'));--> statement-breakpoint
ALTER TABLE "ev_charge_session" ADD CONSTRAINT "ev_charge_session_vehicle_source_check" CHECK ("ev_charge_session"."vehicle_source" IN ('default', 'skoda', 'admin'));