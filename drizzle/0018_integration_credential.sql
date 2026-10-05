CREATE TABLE "integration_credential" (
	"source" text PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"fields_set" text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "integration_credential_source_check" CHECK ("integration_credential"."source" IN ('zaptec', 'skoda', 'emaldo', 'gridTariff')),
	CONSTRAINT "integration_credential_ciphertext_check" CHECK ("integration_credential"."ciphertext" LIKE 'v1.%'),
	CONSTRAINT "integration_credential_fields_set_check" CHECK (cardinality("integration_credential"."fields_set") > 0)
);
--> statement-breakpoint
ALTER TABLE "integration_credential" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_sync" DROP CONSTRAINT "integration_sync_error_code_check";--> statement-breakpoint
ALTER TABLE "integration_sync_run" DROP CONSTRAINT "integration_sync_run_error_code_check";--> statement-breakpoint
ALTER TABLE "integration_credential" ADD CONSTRAINT "integration_credential_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_sync" ADD CONSTRAINT "integration_sync_error_code_check" CHECK ("integration_sync"."error_code" IS NULL OR "integration_sync"."error_code" IN ('auth_failed', 'forbidden', 'rate_limited', 'unreachable', 'unexpected_response', 'not_configured', 'credentials_unreadable', 'internal_error'));--> statement-breakpoint
ALTER TABLE "integration_sync_run" ADD CONSTRAINT "integration_sync_run_error_code_check" CHECK ("integration_sync_run"."error_code" IS NULL OR "integration_sync_run"."error_code" IN ('auth_failed', 'forbidden', 'rate_limited', 'unreachable', 'unexpected_response', 'not_configured', 'credentials_unreadable', 'internal_error'));