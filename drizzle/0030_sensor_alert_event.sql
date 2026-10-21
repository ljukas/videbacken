CREATE TABLE "sensor_alert_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"direction" text,
	"threshold" real,
	"count" integer,
	"silence_hours" integer,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sensor_alert_event_kind_check" CHECK ("sensor_alert_event"."kind" IN ('temperature', 'humidity', 'battery', 'silence')),
	CONSTRAINT "sensor_alert_event_direction_check" CHECK ("sensor_alert_event"."direction" IS NULL OR "sensor_alert_event"."direction" IN ('below', 'above')),
	CONSTRAINT "sensor_alert_event_end_reason_check" CHECK ("sensor_alert_event"."end_reason" IS NULL OR "sensor_alert_event"."end_reason" IN ('recovered', 'paused', 'edited', 'deleted')),
	CONSTRAINT "sensor_alert_event_end_check" CHECK (("sensor_alert_event"."ended_at" IS NULL) = ("sensor_alert_event"."end_reason" IS NULL)),
	CONSTRAINT "sensor_alert_event_ended_after_started_check" CHECK ("sensor_alert_event"."ended_at" IS NULL OR "sensor_alert_event"."ended_at" >= "sensor_alert_event"."started_at")
);
--> statement-breakpoint
ALTER TABLE "sensor_alert_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sensor_alert_event" ADD CONSTRAINT "sensor_alert_event_rule_id_sensor_alert_rule_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."sensor_alert_rule"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensor_alert_event" ADD CONSTRAINT "sensor_alert_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensor_alert_event" ADD CONSTRAINT "sensor_alert_event_device_id_sensor_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."sensor_device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sensor_alert_event_open_rule_idx" ON "sensor_alert_event" USING btree ("rule_id") WHERE "sensor_alert_event"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "sensor_alert_event_history_idx" ON "sensor_alert_event" USING btree ("user_id","device_id","started_at" DESC NULLS LAST,"id" DESC NULLS LAST);