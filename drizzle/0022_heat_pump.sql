CREATE TABLE "heat_pump" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guid" text NOT NULL,
	"name" text NOT NULL,
	"model" text NOT NULL,
	"registered_on" date,
	"history_complete_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "heat_pump_guid_unique" UNIQUE("guid")
);
--> statement-breakpoint
ALTER TABLE "heat_pump" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "heat_pump_reading" (
	"heat_pump_id" uuid NOT NULL,
	"hour_start" timestamp with time zone NOT NULL,
	"energy_kwh" double precision NOT NULL,
	"heat_share" double precision,
	"cool_share" double precision,
	"setpoint_c" double precision,
	"inside_c" double precision,
	"outside_c" double precision,
	CONSTRAINT "heat_pump_reading_pkey" PRIMARY KEY("heat_pump_id","hour_start"),
	CONSTRAINT "heat_pump_reading_hour_aligned_check" CHECK (date_bin('1 hour', "heat_pump_reading"."hour_start", timestamptz '2000-01-01 00:00:00+00') = "heat_pump_reading"."hour_start"),
	CONSTRAINT "heat_pump_reading_energy_kwh_check" CHECK ("heat_pump_reading"."energy_kwh" >= 0 AND "heat_pump_reading"."energy_kwh" < 5),
	CONSTRAINT "heat_pump_reading_heat_share_check" CHECK ("heat_pump_reading"."heat_share" BETWEEN 0 AND 1),
	CONSTRAINT "heat_pump_reading_cool_share_check" CHECK ("heat_pump_reading"."cool_share" BETWEEN 0 AND 1),
	CONSTRAINT "heat_pump_reading_setpoint_c_check" CHECK ("heat_pump_reading"."setpoint_c" BETWEEN -60 AND 60),
	CONSTRAINT "heat_pump_reading_inside_c_check" CHECK ("heat_pump_reading"."inside_c" BETWEEN -60 AND 60),
	CONSTRAINT "heat_pump_reading_outside_c_check" CHECK ("heat_pump_reading"."outside_c" BETWEEN -60 AND 60)
);
--> statement-breakpoint
ALTER TABLE "heat_pump_reading" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "heat_pump_reading" ADD CONSTRAINT "heat_pump_reading_heat_pump_id_heat_pump_id_fk" FOREIGN KEY ("heat_pump_id") REFERENCES "public"."heat_pump"("id") ON DELETE cascade ON UPDATE no action;