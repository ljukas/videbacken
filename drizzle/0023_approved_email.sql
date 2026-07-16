CREATE TABLE "approved_email" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"added_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approved_email_email_unique" UNIQUE("email")
);
--> statement-breakpoint
DROP TABLE "season_booking" CASCADE;--> statement-breakpoint
DROP TABLE "season_slot" CASCADE;--> statement-breakpoint
DROP TABLE "season_wish" CASCADE;--> statement-breakpoint
DROP TABLE "document" CASCADE;--> statement-breakpoint
DROP TABLE "document_event" CASCADE;--> statement-breakpoint
DROP TABLE "folder" CASCADE;--> statement-breakpoint
DROP TABLE "folder_event" CASCADE;--> statement-breakpoint
DROP TABLE "ownership_assignment" CASCADE;--> statement-breakpoint
DROP TABLE "season_era" CASCADE;--> statement-breakpoint
DROP TABLE "recommendation" CASCADE;--> statement-breakpoint
DROP TABLE "recommendation_photo" CASCADE;--> statement-breakpoint
DROP TABLE "recommendation_tag" CASCADE;--> statement-breakpoint
DROP TABLE "tag" CASCADE;--> statement-breakpoint
DROP TYPE "public"."booking_target";--> statement-breakpoint
DROP TYPE "public"."slot_kind";--> statement-breakpoint
DROP TYPE "public"."document_event_kind";--> statement-breakpoint
DROP TYPE "public"."folder_event_kind";--> statement-breakpoint
DROP TYPE "public"."share_code";