CREATE TABLE "ownership_assignment_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"note" text
);
--> statement-breakpoint
-- Pre-prod clean slate: existing per-part assignments predate the event model.
-- No backfill — every assignment from here on belongs to an event.
DELETE FROM "ownership_assignment";--> statement-breakpoint
ALTER TABLE "ownership_assignment" ADD COLUMN "event_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "ownership_assignment_event" ADD CONSTRAINT "ownership_assignment_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ownership_assignment_event_created_at_idx" ON "ownership_assignment_event" USING btree ("created_at" desc);--> statement-breakpoint
ALTER TABLE "ownership_assignment" ADD CONSTRAINT "ownership_assignment_event_id_ownership_assignment_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."ownership_assignment_event"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ownership_assignment_event_id_idx" ON "ownership_assignment" USING btree ("event_id");