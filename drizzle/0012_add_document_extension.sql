ALTER TABLE "document" ADD COLUMN "extension" text;
--> statement-breakpoint
-- Backfill: split the existing full filename into base + extension. Mirrors
-- splitExtension() in src/utils/filename.ts — a non-leading dot followed by at
-- least one non-dot char to the end. Rows without a detectable extension
-- (dotfiles, no dot, trailing dot) are left untouched (extension stays NULL).
-- search_haystack already contains the full old name (= base + '.' + ext), so
-- it remains valid and needs no rewrite here.
UPDATE "document"
SET "extension" = regexp_replace("name", '^.*\.([^.]+)$', '\1'),
    "name"      = regexp_replace("name", '\.[^.]+$', '')
WHERE "name" ~ '.\.[^.]+$';
