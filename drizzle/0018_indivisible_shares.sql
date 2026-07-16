-- ADR-0018: shares become indivisible. Destructive by design (pre-launch):
-- part-level assignment rows cannot be mapped to whole-share rows, so the
-- ownership tables are dropped and recreated. The share_code enum survives
-- (season.start_share uses it); share_part and the event parent table go away.
DROP TABLE "ownership_assignment";--> statement-breakpoint
DROP TABLE "ownership_assignment_event";--> statement-breakpoint
DROP TABLE "share_part";--> statement-breakpoint
CREATE TABLE "ownership_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"share_code" "share_code" NOT NULL,
	"user_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"assigned_from" date NOT NULL,
	"assigned_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ownership_assignment_range_check" CHECK ("assigned_to" IS NULL OR "assigned_to" > "assigned_from")
);--> statement-breakpoint
ALTER TABLE "ownership_assignment" ADD CONSTRAINT "ownership_assignment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_assignment" ADD CONSTRAINT "ownership_assignment_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ownership_assignment_share_code_idx" ON "ownership_assignment" USING btree ("share_code");--> statement-breakpoint
CREATE INDEX "ownership_assignment_user_id_idx" ON "ownership_assignment" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ownership_assignment_one_current_per_share_idx" ON "ownership_assignment" USING btree ("share_code") WHERE "assigned_to" IS NULL;
