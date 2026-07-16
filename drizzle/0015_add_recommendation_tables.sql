CREATE TABLE "recommendation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "recommendation_lat_range_check" CHECK ("recommendation"."lat" BETWEEN -90 AND 90),
	CONSTRAINT "recommendation_lng_range_check" CHECK ("recommendation"."lng" BETWEEN -180 AND 180)
);
--> statement-breakpoint
CREATE TABLE "recommendation_photo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recommendation_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recommendation_photo_file_id_unique" UNIQUE("file_id"),
	CONSTRAINT "recommendation_photo_sort_order_nonneg_check" CHECK ("recommendation_photo"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "recommendation_tag" (
	"recommendation_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "recommendation_tag_recommendation_id_tag_id_pk" PRIMARY KEY("recommendation_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_photo" ADD CONSTRAINT "recommendation_photo_recommendation_id_recommendation_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."recommendation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_photo" ADD CONSTRAINT "recommendation_photo_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_tag" ADD CONSTRAINT "recommendation_tag_recommendation_id_recommendation_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."recommendation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_tag" ADD CONSTRAINT "recommendation_tag_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recommendation_author_id_idx" ON "recommendation" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "recommendation_active_idx" ON "recommendation" USING btree ("created_at" desc) WHERE "recommendation"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "recommendation_photo_recommendation_id_idx" ON "recommendation_photo" USING btree ("recommendation_id");--> statement-breakpoint
CREATE INDEX "recommendation_tag_tag_id_idx" ON "recommendation_tag" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "tag_sort_order_idx" ON "tag" USING btree ("sort_order");