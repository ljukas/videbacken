CREATE TABLE "battery_pool_day" (
	"day" date PRIMARY KEY NOT NULL,
	"stored_kwh" double precision NOT NULL,
	"grid_kwh" double precision NOT NULL,
	"grid_spot_sek_sum" double precision NOT NULL,
	"solar_kwh" double precision NOT NULL,
	"solar_spot_sek_sum" double precision NOT NULL,
	"unpriced_kwh" double precision NOT NULL,
	"capacity_kwh" double precision NOT NULL,
	"derive_version" smallint NOT NULL,
	"derived_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "battery_pool_day_kwh_nonneg_check" CHECK ("battery_pool_day"."stored_kwh" >= 0 AND "battery_pool_day"."stored_kwh" < 1000 AND "battery_pool_day"."grid_kwh" >= 0 AND "battery_pool_day"."solar_kwh" >= 0
        AND "battery_pool_day"."unpriced_kwh" >= 0),
	CONSTRAINT "battery_pool_day_stored_sum_check" CHECK (abs("battery_pool_day"."stored_kwh" - ("battery_pool_day"."grid_kwh" + "battery_pool_day"."solar_kwh" + "battery_pool_day"."unpriced_kwh"))
        <= 1e-9 * "battery_pool_day"."stored_kwh" + 1e-9),
	CONSTRAINT "battery_pool_day_spot_sums_finite_check" CHECK ("battery_pool_day"."grid_spot_sek_sum" > '-Infinity' AND "battery_pool_day"."grid_spot_sek_sum" < 'Infinity'
        AND "battery_pool_day"."solar_spot_sek_sum" > '-Infinity' AND "battery_pool_day"."solar_spot_sek_sum" < 'Infinity'),
	CONSTRAINT "battery_pool_day_derive_version_check" CHECK ("battery_pool_day"."derive_version" >= 1),
	CONSTRAINT "battery_pool_day_capacity_kwh_check" CHECK ("battery_pool_day"."capacity_kwh" > 0 AND "battery_pool_day"."capacity_kwh" < 100)
);
--> statement-breakpoint
ALTER TABLE "battery_pool_day" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ev_charge_energy_mix" (
	"session_id" uuid NOT NULL,
	"slot_start" timestamp with time zone NOT NULL,
	"kwh" double precision NOT NULL,
	"grid_kwh" double precision NOT NULL,
	"solar_kwh" double precision NOT NULL,
	"battery_grid_kwh" double precision NOT NULL,
	"battery_grid_spot_sek" double precision,
	"battery_solar_kwh" double precision NOT NULL,
	"battery_solar_spot_sek" double precision,
	"battery_unpriced_kwh" double precision NOT NULL,
	"no_house_data_kwh" double precision NOT NULL,
	CONSTRAINT "ev_charge_energy_mix_pk" PRIMARY KEY("session_id","slot_start"),
	CONSTRAINT "ev_charge_energy_mix_slot_start_check" CHECK (date_bin('15 minutes', "ev_charge_energy_mix"."slot_start", timestamptz '2000-01-01 00:00:00+00') = "ev_charge_energy_mix"."slot_start"),
	CONSTRAINT "ev_charge_energy_mix_kwh_nonneg_check" CHECK ("ev_charge_energy_mix"."kwh" > 0 AND "ev_charge_energy_mix"."kwh" < 1000 AND "ev_charge_energy_mix"."grid_kwh" >= 0 AND "ev_charge_energy_mix"."solar_kwh" >= 0
        AND "ev_charge_energy_mix"."battery_grid_kwh" >= 0 AND "ev_charge_energy_mix"."battery_solar_kwh" >= 0
        AND "ev_charge_energy_mix"."battery_unpriced_kwh" >= 0 AND "ev_charge_energy_mix"."no_house_data_kwh" >= 0),
	CONSTRAINT "ev_charge_energy_mix_parts_sum_check" CHECK (abs("ev_charge_energy_mix"."kwh" - ("ev_charge_energy_mix"."grid_kwh" + "ev_charge_energy_mix"."solar_kwh" + "ev_charge_energy_mix"."battery_grid_kwh"
        + "ev_charge_energy_mix"."battery_solar_kwh" + "ev_charge_energy_mix"."battery_unpriced_kwh" + "ev_charge_energy_mix"."no_house_data_kwh"))
        <= 1e-9 * "ev_charge_energy_mix"."kwh" + 1e-9),
	CONSTRAINT "ev_charge_energy_mix_battery_grid_spot_check" CHECK (("ev_charge_energy_mix"."battery_grid_kwh" > 0) = ("ev_charge_energy_mix"."battery_grid_spot_sek" IS NOT NULL)
        AND ("ev_charge_energy_mix"."battery_grid_spot_sek" IS NULL
          OR ("ev_charge_energy_mix"."battery_grid_spot_sek" > '-Infinity' AND "ev_charge_energy_mix"."battery_grid_spot_sek" < 'Infinity'))),
	CONSTRAINT "ev_charge_energy_mix_battery_solar_spot_check" CHECK (("ev_charge_energy_mix"."battery_solar_kwh" > 0) = ("ev_charge_energy_mix"."battery_solar_spot_sek" IS NOT NULL)
        AND ("ev_charge_energy_mix"."battery_solar_spot_sek" IS NULL
          OR ("ev_charge_energy_mix"."battery_solar_spot_sek" > '-Infinity' AND "ev_charge_energy_mix"."battery_solar_spot_sek" < 'Infinity')))
);
--> statement-breakpoint
ALTER TABLE "ev_charge_energy_mix" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ev_charge_energy_mix" ADD CONSTRAINT "ev_charge_energy_mix_session_id_ev_charge_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ev_charge_session"("id") ON DELETE cascade ON UPDATE no action;