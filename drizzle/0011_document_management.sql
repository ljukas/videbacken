-- pg_trgm powers the GIN trigram indexes on search_haystack columns below.
-- Pinned to `public` so concurrent per-test schema workers don't race: the
-- first worker to win installs in public; the rest hit IF NOT EXISTS as a
-- no-op and still see gin_trgm_ops via the `public` entry on search_path.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;--> statement-breakpoint
CREATE TYPE "public"."document_event_kind" AS ENUM('upload', 'rename', 'move', 'soft_delete', 'restore', 'hard_delete');--> statement-breakpoint
CREATE TYPE "public"."folder_event_kind" AS ENUM('create', 'rename', 'move', 'soft_delete', 'restore', 'hard_delete');--> statement-breakpoint
CREATE TABLE "document_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid,
	"actor_id" uuid,
	"kind" "document_event_kind" NOT NULL,
	"from_value" jsonb,
	"to_value" jsonb,
	"correlation_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folder" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"search_haystack" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "folder_name_no_slash_check" CHECK (position('/' in "folder"."name") = 0),
	CONSTRAINT "folder_path_format_check" CHECK ("folder"."path" LIKE '/%' AND "folder"."path" LIKE '%/')
);
--> statement-breakpoint
CREATE TABLE "folder_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"folder_id" uuid,
	"actor_id" uuid,
	"kind" "folder_event_kind" NOT NULL,
	"from_value" jsonb,
	"to_value" jsonb,
	"correlation_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_event" ADD CONSTRAINT "document_event_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_event" ADD CONSTRAINT "document_event_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder" ADD CONSTRAINT "folder_parent_id_folder_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."folder"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder" ADD CONSTRAINT "folder_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_event" ADD CONSTRAINT "folder_event_folder_id_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folder"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_event" ADD CONSTRAINT "folder_event_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_event_document_id_occurred_at_idx" ON "document_event" USING btree ("document_id","occurred_at" desc);--> statement-breakpoint
CREATE INDEX "document_event_actor_id_occurred_at_idx" ON "document_event" USING btree ("actor_id","occurred_at" desc);--> statement-breakpoint
CREATE INDEX "document_event_correlation_id_idx" ON "document_event" USING btree ("correlation_id") WHERE "document_event"."correlation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "folder_parent_id_idx" ON "folder" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "folder_path_idx" ON "folder" USING btree ("path");--> statement-breakpoint
CREATE INDEX "folder_search_haystack_trgm_idx" ON "folder" USING gin ("search_haystack" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "folder_unique_name_per_parent_idx" ON "folder" USING btree (coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid), "name") WHERE "folder"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "folder_event_folder_id_occurred_at_idx" ON "folder_event" USING btree ("folder_id","occurred_at" desc);--> statement-breakpoint
CREATE INDEX "folder_event_actor_id_occurred_at_idx" ON "folder_event" USING btree ("actor_id","occurred_at" desc);--> statement-breakpoint
CREATE INDEX "folder_event_correlation_id_idx" ON "folder_event" USING btree ("correlation_id") WHERE "folder_event"."correlation_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_folder_id_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folder"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_search_haystack_trgm_idx" ON "document" USING gin ("search_haystack" gin_trgm_ops);