CREATE TABLE "heat_pump_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_on" date NOT NULL,
	"heat_pump_id" uuid,
	"kind" text NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "heat_pump_event_kind_check" CHECK ("heat_pump_event"."kind" IN ('service', 'filter', 'setting', 'other')),
	CONSTRAINT "heat_pump_event_note_check" CHECK (char_length("heat_pump_event"."note") BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "heat_pump_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "heat_pump_event" ADD CONSTRAINT "heat_pump_event_heat_pump_id_heat_pump_id_fk" FOREIGN KEY ("heat_pump_id") REFERENCES "public"."heat_pump"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heat_pump_event" ADD CONSTRAINT "heat_pump_event_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "heat_pump_event_occurred_on_idx" ON "heat_pump_event" USING btree ("occurred_on");