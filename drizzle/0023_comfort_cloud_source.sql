ALTER TABLE "integration_credential" DROP CONSTRAINT "integration_credential_source_check";--> statement-breakpoint
ALTER TABLE "integration_sync" DROP CONSTRAINT "integration_sync_source_check";--> statement-breakpoint
ALTER TABLE "integration_sync_run" DROP CONSTRAINT "integration_sync_run_source_check";--> statement-breakpoint
ALTER TABLE "integration_credential" ADD CONSTRAINT "integration_credential_source_check" CHECK ("integration_credential"."source" IN ('zaptec', 'skoda', 'emaldo', 'comfortCloud', 'gridTariff'));--> statement-breakpoint
ALTER TABLE "integration_sync" ADD CONSTRAINT "integration_sync_source_check" CHECK ("integration_sync"."source" IN ('zaptec', 'elpris', 'skoda', 'emaldo', 'comfortCloud'));--> statement-breakpoint
ALTER TABLE "integration_sync_run" ADD CONSTRAINT "integration_sync_run_source_check" CHECK ("integration_sync_run"."source" IN ('zaptec', 'elpris', 'skoda', 'emaldo', 'comfortCloud'));