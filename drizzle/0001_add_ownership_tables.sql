CREATE TYPE "public"."share_code" AS ENUM('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J');--> statement-breakpoint
CREATE TABLE "ownership_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"part_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"assigned_from" date NOT NULL,
	"assigned_to" date,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "season" (
	"year" integer PRIMARY KEY NOT NULL,
	"start_week" integer NOT NULL,
	"start_share" "share_code" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_part" (
	"id" text PRIMARY KEY NOT NULL,
	"share_code" "share_code" NOT NULL,
	"part_number" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ownership_assignment" ADD CONSTRAINT "ownership_assignment_part_id_share_part_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."share_part"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_assignment" ADD CONSTRAINT "ownership_assignment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ownership_assignment_part_id_idx" ON "ownership_assignment" USING btree ("part_id");--> statement-breakpoint
CREATE INDEX "ownership_assignment_user_id_idx" ON "ownership_assignment" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ownership_assignment_one_current_per_part_idx" ON "ownership_assignment" USING btree ("part_id") WHERE "ownership_assignment"."assigned_to" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "share_part_share_code_part_number_idx" ON "share_part" USING btree ("share_code","part_number");