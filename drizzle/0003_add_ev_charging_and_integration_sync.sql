CREATE TABLE "ev_charge_interval" (
	"session_id" uuid NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"energy_kwh" double precision NOT NULL,
	CONSTRAINT "ev_charge_interval_pk" PRIMARY KEY("session_id","start_at"),
	CONSTRAINT "ev_charge_interval_end_at_check" CHECK ("ev_charge_interval"."end_at" > "ev_charge_interval"."start_at"),
	CONSTRAINT "ev_charge_interval_energy_kwh_nonneg_check" CHECK ("ev_charge_interval"."energy_kwh" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ev_charge_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zaptec_session_id" text NOT NULL,
	"charger_id" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"energy_kwh" double precision NOT NULL,
	"authorized_user_email" text,
	"authorized_user_name" text,
	"token_name" text,
	"voided" boolean DEFAULT false NOT NULL,
	"replaced_by_zaptec_session_id" text,
	"offline" boolean DEFAULT false NOT NULL,
	"reliable_clock" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ev_charge_session_zaptec_session_id_unique" UNIQUE("zaptec_session_id"),
	CONSTRAINT "ev_charge_session_energy_kwh_nonneg_check" CHECK ("ev_charge_session"."energy_kwh" >= 0),
	CONSTRAINT "ev_charge_session_end_at_check" CHECK ("ev_charge_session"."end_at" >= "ev_charge_session"."start_at")
);
--> statement-breakpoint
CREATE TABLE "ev_charger" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"installation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_sync" (
	"source" text PRIMARY KEY NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_success_started_at" timestamp with time zone,
	"failing_since" timestamp with time zone,
	"running_since" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"lease_token" uuid,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"last_error_message" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_sync_source_check" CHECK ("integration_sync"."source" IN ('zaptec', 'elpris', 'skoda')),
	CONSTRAINT "integration_sync_consecutive_failures_nonneg_check" CHECK ("integration_sync"."consecutive_failures" >= 0),
	CONSTRAINT "integration_sync_error_code_check" CHECK ("integration_sync"."error_code" IS NULL OR "integration_sync"."error_code" IN ('auth_failed', 'forbidden', 'rate_limited', 'unreachable', 'unexpected_response', 'not_configured', 'internal_error')),
	CONSTRAINT "integration_sync_last_error_message_length_check" CHECK ("integration_sync"."last_error_message" IS NULL OR char_length("integration_sync"."last_error_message") <= 500),
	CONSTRAINT "integration_sync_failures_error_code_check" CHECK (("integration_sync"."consecutive_failures" = 0) = ("integration_sync"."error_code" IS NULL)),
	CONSTRAINT "integration_sync_error_code_failing_since_check" CHECK (("integration_sync"."error_code" IS NULL) = ("integration_sync"."failing_since" IS NULL)),
	CONSTRAINT "integration_sync_last_error_message_error_code_check" CHECK ("integration_sync"."last_error_message" IS NULL OR "integration_sync"."error_code" IS NOT NULL),
	CONSTRAINT "integration_sync_running_since_lease_until_check" CHECK (("integration_sync"."running_since" IS NULL) = ("integration_sync"."lease_until" IS NULL)),
	CONSTRAINT "integration_sync_lease_until_token_check" CHECK (("integration_sync"."lease_until" IS NULL) = ("integration_sync"."lease_token" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "integration_sync_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"trigger" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"outcome" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"since" timestamp with time zone,
	"pages" integer DEFAULT 0 NOT NULL,
	"sessions_seen" integer DEFAULT 0 NOT NULL,
	"upserted" integer DEFAULT 0 NOT NULL,
	"voided" integer DEFAULT 0 NOT NULL,
	"timings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "integration_sync_run_source_check" CHECK ("integration_sync_run"."source" IN ('zaptec', 'elpris', 'skoda')),
	CONSTRAINT "integration_sync_run_trigger_check" CHECK ("integration_sync_run"."trigger" IN ('cron', 'admin')),
	CONSTRAINT "integration_sync_run_duration_ms_nonneg_check" CHECK ("integration_sync_run"."duration_ms" >= 0),
	CONSTRAINT "integration_sync_run_outcome_check" CHECK ("integration_sync_run"."outcome" IN ('ok', 'failed', 'error')),
	CONSTRAINT "integration_sync_run_error_code_check" CHECK ("integration_sync_run"."error_code" IS NULL OR "integration_sync_run"."error_code" IN ('auth_failed', 'forbidden', 'rate_limited', 'unreachable', 'unexpected_response', 'not_configured', 'internal_error')),
	CONSTRAINT "integration_sync_run_error_message_length_check" CHECK ("integration_sync_run"."error_message" IS NULL OR char_length("integration_sync_run"."error_message") <= 500),
	CONSTRAINT "integration_sync_run_outcome_error_code_check" CHECK (("integration_sync_run"."outcome" = 'ok') = ("integration_sync_run"."error_code" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "ev_charge_interval" ADD CONSTRAINT "ev_charge_interval_session_id_ev_charge_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ev_charge_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_charge_session" ADD CONSTRAINT "ev_charge_session_charger_id_ev_charger_id_fk" FOREIGN KEY ("charger_id") REFERENCES "public"."ev_charger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ev_charge_session_start_at_idx" ON "ev_charge_session" USING btree ("start_at");--> statement-breakpoint
CREATE INDEX "integration_sync_run_source_started_idx" ON "integration_sync_run" USING btree ("source","started_at" DESC NULLS LAST);