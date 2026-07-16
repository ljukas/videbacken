CREATE TYPE "public"."booking_target" AS ENUM('share', 'extra_early', 'extra_late');--> statement-breakpoint
CREATE TYPE "public"."slot_kind" AS ENUM('rotation', 'extra');--> statement-breakpoint
CREATE TABLE "season_booking" (
	"year" integer PRIMARY KEY NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "season_slot" (
	"year" integer NOT NULL,
	"first_week" integer NOT NULL,
	"last_week" integer NOT NULL,
	"kind" "slot_kind" NOT NULL,
	"holder" "share_code",
	CONSTRAINT "season_slot_year_first_week_pk" PRIMARY KEY("year","first_week"),
	CONSTRAINT "season_slot_first_week_range" CHECK ("season_slot"."first_week" BETWEEN 1 AND 53),
	CONSTRAINT "season_slot_last_week_range" CHECK ("season_slot"."last_week" BETWEEN 1 AND 53),
	CONSTRAINT "season_slot_week_order" CHECK ("season_slot"."last_week" > "season_slot"."first_week"),
	CONSTRAINT "season_slot_rotation_held" CHECK ("season_slot"."kind" = 'extra' OR "season_slot"."holder" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "season_wish" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"year" integer NOT NULL,
	"share_code" "share_code" NOT NULL,
	"target_kind" "booking_target" NOT NULL,
	"target_share" "share_code",
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "season_wish_unique" UNIQUE NULLS NOT DISTINCT("year","share_code","target_kind","target_share"),
	CONSTRAINT "season_wish_target_share_iff_share_kind" CHECK (("season_wish"."target_kind" = 'share') = ("season_wish"."target_share" IS NOT NULL)),
	CONSTRAINT "season_wish_no_self_target" CHECK ("season_wish"."target_share" IS NULL OR "season_wish"."target_share" <> "season_wish"."share_code")
);
--> statement-breakpoint
ALTER TABLE "season_booking" ADD CONSTRAINT "season_booking_locked_by_user_id_fk" FOREIGN KEY ("locked_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_slot" ADD CONSTRAINT "season_slot_year_season_booking_year_fk" FOREIGN KEY ("year") REFERENCES "public"."season_booking"("year") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_wish" ADD CONSTRAINT "season_wish_year_season_booking_year_fk" FOREIGN KEY ("year") REFERENCES "public"."season_booking"("year") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_wish" ADD CONSTRAINT "season_wish_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;