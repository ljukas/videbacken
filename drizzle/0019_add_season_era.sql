CREATE TABLE "season_era" (
	"from_year" integer PRIMARY KEY NOT NULL,
	"start_week" integer NOT NULL,
	"start_share" "share_code" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "season_era_start_week_check" CHECK ("season_era"."start_week" BETWEEN 1 AND 33)
);
