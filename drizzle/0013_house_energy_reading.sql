CREATE TABLE "house_energy_reading" (
	"bucket_start" timestamp with time zone PRIMARY KEY NOT NULL,
	"grid_import_kwh" double precision NOT NULL,
	"grid_export_kwh" double precision NOT NULL,
	"solar_kwh" double precision NOT NULL,
	"load_kwh" double precision NOT NULL,
	"battery_discharge_kwh" double precision NOT NULL,
	"battery_charge_solar_kwh" double precision NOT NULL,
	"battery_charge_grid_kwh" double precision NOT NULL,
	"battery_charge_ac_kwh" double precision NOT NULL,
	CONSTRAINT "house_energy_reading_bucket_aligned_check" CHECK (date_bin('5 minutes', "house_energy_reading"."bucket_start", timestamptz '2000-01-01 00:00:00+00') = "house_energy_reading"."bucket_start"),
	CONSTRAINT "house_energy_reading_grid_import_kwh_check" CHECK ("house_energy_reading"."grid_import_kwh" >= 0 AND "house_energy_reading"."grid_import_kwh" < 10),
	CONSTRAINT "house_energy_reading_grid_export_kwh_check" CHECK ("house_energy_reading"."grid_export_kwh" >= 0 AND "house_energy_reading"."grid_export_kwh" < 10),
	CONSTRAINT "house_energy_reading_solar_kwh_check" CHECK ("house_energy_reading"."solar_kwh" >= 0 AND "house_energy_reading"."solar_kwh" < 10),
	CONSTRAINT "house_energy_reading_load_kwh_check" CHECK ("house_energy_reading"."load_kwh" >= 0 AND "house_energy_reading"."load_kwh" < 10),
	CONSTRAINT "house_energy_reading_battery_discharge_kwh_check" CHECK ("house_energy_reading"."battery_discharge_kwh" >= 0 AND "house_energy_reading"."battery_discharge_kwh" < 10),
	CONSTRAINT "house_energy_reading_battery_charge_solar_kwh_check" CHECK ("house_energy_reading"."battery_charge_solar_kwh" >= 0 AND "house_energy_reading"."battery_charge_solar_kwh" < 10),
	CONSTRAINT "house_energy_reading_battery_charge_grid_kwh_check" CHECK ("house_energy_reading"."battery_charge_grid_kwh" >= 0 AND "house_energy_reading"."battery_charge_grid_kwh" < 10),
	CONSTRAINT "house_energy_reading_battery_charge_ac_kwh_check" CHECK ("house_energy_reading"."battery_charge_ac_kwh" >= 0 AND "house_energy_reading"."battery_charge_ac_kwh" < 10)
);
--> statement-breakpoint
ALTER TABLE "house_energy_reading" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_sync" DROP CONSTRAINT "integration_sync_source_check";--> statement-breakpoint
ALTER TABLE "integration_sync_run" DROP CONSTRAINT "integration_sync_run_source_check";--> statement-breakpoint
ALTER TABLE "integration_sync" ADD CONSTRAINT "integration_sync_source_check" CHECK ("integration_sync"."source" IN ('zaptec', 'elpris', 'skoda', 'emaldo'));--> statement-breakpoint
ALTER TABLE "integration_sync_run" ADD CONSTRAINT "integration_sync_run_source_check" CHECK ("integration_sync_run"."source" IN ('zaptec', 'elpris', 'skoda', 'emaldo'));