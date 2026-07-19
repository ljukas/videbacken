CREATE TABLE "sensor_device" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mac" text NOT NULL,
	"name" text,
	"location" text,
	"battery_pct" integer,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sensor_device_mac_unique" UNIQUE("mac")
);
--> statement-breakpoint
CREATE TABLE "sensor_reading" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"temperature_c" real,
	"humidity_pct" real,
	"battery_pct" integer,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sensor_reading_temp_range_check" CHECK ("sensor_reading"."temperature_c" IS NULL OR "sensor_reading"."temperature_c" BETWEEN -60 AND 100),
	CONSTRAINT "sensor_reading_humidity_range_check" CHECK ("sensor_reading"."humidity_pct" IS NULL OR "sensor_reading"."humidity_pct" BETWEEN 0 AND 100),
	CONSTRAINT "sensor_reading_battery_range_check" CHECK ("sensor_reading"."battery_pct" IS NULL OR "sensor_reading"."battery_pct" BETWEEN 0 AND 100)
);
--> statement-breakpoint
ALTER TABLE "sensor_reading" ADD CONSTRAINT "sensor_reading_device_id_sensor_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."sensor_device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sensor_reading_device_recorded_idx" ON "sensor_reading" USING btree ("device_id","recorded_at");