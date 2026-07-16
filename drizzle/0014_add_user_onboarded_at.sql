ALTER TABLE "user" ADD COLUMN "onboarded_at" timestamp with time zone;
--> statement-breakpoint
-- Backfill: existing verified users have already been using the app, so mark
-- them onboarded (stamp their creation time) — otherwise the _authenticated
-- loader would bounce every current owner into the onboarding wizard. Pending
-- invitees (email_verified = false) stay NULL so they onboard on first sign-in.
UPDATE "user" SET "onboarded_at" = COALESCE("created_at", now()) WHERE "email_verified" = true;