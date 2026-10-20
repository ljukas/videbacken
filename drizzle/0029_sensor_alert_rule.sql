CREATE TABLE "sensor_alert_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"direction" text,
	"threshold" real,
	"count" integer,
	"silence_hours" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sensor_alert_rule_kind_check" CHECK ("sensor_alert_rule"."kind" IN ('temperature', 'humidity', 'battery', 'silence')),
	CONSTRAINT "sensor_alert_rule_direction_check" CHECK ("sensor_alert_rule"."direction" IS NULL OR "sensor_alert_rule"."direction" IN ('below', 'above')),
	CONSTRAINT "sensor_alert_rule_shape_check" CHECK (("sensor_alert_rule"."kind" IN ('temperature', 'humidity') AND "sensor_alert_rule"."direction" IS NOT NULL AND "sensor_alert_rule"."threshold" IS NOT NULL AND "sensor_alert_rule"."count" IS NOT NULL AND "sensor_alert_rule"."silence_hours" IS NULL)
        OR ("sensor_alert_rule"."kind" = 'battery' AND "sensor_alert_rule"."direction" IS NOT NULL AND "sensor_alert_rule"."direction" = 'below' AND "sensor_alert_rule"."threshold" IS NOT NULL AND "sensor_alert_rule"."count" IS NOT NULL AND "sensor_alert_rule"."silence_hours" IS NULL)
        OR ("sensor_alert_rule"."kind" = 'silence' AND "sensor_alert_rule"."silence_hours" IS NOT NULL AND "sensor_alert_rule"."direction" IS NULL AND "sensor_alert_rule"."threshold" IS NULL AND "sensor_alert_rule"."count" IS NULL)),
	CONSTRAINT "sensor_alert_rule_threshold_check" CHECK ("sensor_alert_rule"."threshold" IS NULL
        OR ("sensor_alert_rule"."kind" = 'temperature' AND "sensor_alert_rule"."threshold" BETWEEN -40 AND 60 AND "sensor_alert_rule"."threshold" * 2 = round("sensor_alert_rule"."threshold" * 2))
        OR ("sensor_alert_rule"."kind" = 'humidity' AND "sensor_alert_rule"."threshold" BETWEEN 1 AND 99 AND "sensor_alert_rule"."threshold" = round("sensor_alert_rule"."threshold"))
        OR ("sensor_alert_rule"."kind" = 'battery' AND "sensor_alert_rule"."threshold" BETWEEN 5 AND 95 AND "sensor_alert_rule"."threshold" = round("sensor_alert_rule"."threshold"))),
	CONSTRAINT "sensor_alert_rule_count_check" CHECK ("sensor_alert_rule"."count" IS NULL OR "sensor_alert_rule"."count" BETWEEN 2 AND 10),
	CONSTRAINT "sensor_alert_rule_silence_hours_check" CHECK ("sensor_alert_rule"."silence_hours" IS NULL OR "sensor_alert_rule"."silence_hours" BETWEEN 3 AND 72)
);
--> statement-breakpoint
ALTER TABLE "sensor_alert_rule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sensor_alert_rule" ADD CONSTRAINT "sensor_alert_rule_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensor_alert_rule" ADD CONSTRAINT "sensor_alert_rule_device_id_sensor_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."sensor_device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sensor_alert_rule_user_idx" ON "sensor_alert_rule" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "sensor_alert_rule_device_idx" ON "sensor_alert_rule" USING btree ("device_id");