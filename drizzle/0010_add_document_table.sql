CREATE TABLE "document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"name" text NOT NULL,
	"folder_id" uuid,
	"thumbnail_pathname" text,
	"search_haystack" text NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "document_file_id_unique" UNIQUE("file_id")
);
--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_folder_id_idx" ON "document" USING btree ("folder_id");--> statement-breakpoint
-- Backfill: every existing private file becomes a document row. Avatars
-- (access='public') stay as file rows alone. file.name is the source of truth
-- at backfill time; fall back to the pathname tail in the unlikely event it is
-- null. search_haystack starts as just the name — ADR-0010 Phase 2 enriches it
-- to `folder.path || ' ' || name` once folders exist.
-- Soft-deleted private files are INCLUDED (carrying their deleted_at) so the
-- DROP COLUMN below can't silently destroy a binned document's name and the
-- 1:1 file<->document invariant holds for every private file.
INSERT INTO "document" ("file_id", "name", "search_haystack", "deleted_at")
SELECT "id",
       COALESCE("name", substring("pathname" from '[^/]+$')),
       COALESCE("name", substring("pathname" from '[^/]+$')),
       "deleted_at"
FROM "file"
WHERE "access" = 'private';--> statement-breakpoint
-- Drops are data-destructive but safe: file.name/file.folder were document-only
-- (avatars never populated them) and every private file's name is preserved in
-- document.name above.
ALTER TABLE "file" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "file" DROP COLUMN "folder";