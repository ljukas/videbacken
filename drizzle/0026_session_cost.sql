CREATE TABLE "ev_session_cost" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"priced_generation" integer,
	"pricing_version" integer,
	"estimated" boolean,
	CONSTRAINT "ev_session_cost_generation_check" CHECK ("ev_session_cost"."generation" >= 0 AND ("ev_session_cost"."priced_generation" IS NULL
        OR ("ev_session_cost"."priced_generation" >= 0 AND "ev_session_cost"."priced_generation" <= "ev_session_cost"."generation"))),
	CONSTRAINT "ev_session_cost_priced_check" CHECK (("ev_session_cost"."priced_generation" IS NULL) = ("ev_session_cost"."pricing_version" IS NULL)
        AND ("ev_session_cost"."priced_generation" IS NULL) = ("ev_session_cost"."estimated" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "ev_session_cost" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ev_session_cost_month" (
	"session_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"kwh" double precision NOT NULL,
	"grid_kwh" double precision NOT NULL,
	"full_kwh" double precision NOT NULL,
	"no_price_kwh" double precision NOT NULL,
	"no_tariff_kwh" double precision NOT NULL,
	"spot_sek" double precision NOT NULL,
	"fees_sek" double precision NOT NULL,
	"total_sek" double precision NOT NULL,
	"solar_kwh" double precision NOT NULL,
	"battery_kwh" double precision NOT NULL,
	"no_house_data_kwh" double precision NOT NULL,
	"solar_value_sek" double precision NOT NULL,
	"solar_priced_kwh" double precision NOT NULL,
	"solar_unpriced_kwh" double precision NOT NULL,
	CONSTRAINT "ev_session_cost_month_pk" PRIMARY KEY("session_id","year","month"),
	CONSTRAINT "ev_session_cost_month_month_check" CHECK ("ev_session_cost_month"."month" BETWEEN 1 AND 12),
	CONSTRAINT "ev_session_cost_month_finite_check" CHECK ("ev_session_cost_month"."kwh" > '-Infinity' AND "ev_session_cost_month"."kwh" < 'Infinity' AND "ev_session_cost_month"."grid_kwh" > '-Infinity' AND "ev_session_cost_month"."grid_kwh" < 'Infinity' AND "ev_session_cost_month"."full_kwh" > '-Infinity' AND "ev_session_cost_month"."full_kwh" < 'Infinity' AND "ev_session_cost_month"."no_price_kwh" > '-Infinity' AND "ev_session_cost_month"."no_price_kwh" < 'Infinity' AND "ev_session_cost_month"."no_tariff_kwh" > '-Infinity' AND "ev_session_cost_month"."no_tariff_kwh" < 'Infinity' AND "ev_session_cost_month"."spot_sek" > '-Infinity' AND "ev_session_cost_month"."spot_sek" < 'Infinity' AND "ev_session_cost_month"."fees_sek" > '-Infinity' AND "ev_session_cost_month"."fees_sek" < 'Infinity' AND "ev_session_cost_month"."total_sek" > '-Infinity' AND "ev_session_cost_month"."total_sek" < 'Infinity' AND "ev_session_cost_month"."solar_kwh" > '-Infinity' AND "ev_session_cost_month"."solar_kwh" < 'Infinity' AND "ev_session_cost_month"."battery_kwh" > '-Infinity' AND "ev_session_cost_month"."battery_kwh" < 'Infinity' AND "ev_session_cost_month"."no_house_data_kwh" > '-Infinity' AND "ev_session_cost_month"."no_house_data_kwh" < 'Infinity' AND "ev_session_cost_month"."solar_value_sek" > '-Infinity' AND "ev_session_cost_month"."solar_value_sek" < 'Infinity' AND "ev_session_cost_month"."solar_priced_kwh" > '-Infinity' AND "ev_session_cost_month"."solar_priced_kwh" < 'Infinity' AND "ev_session_cost_month"."solar_unpriced_kwh" > '-Infinity' AND "ev_session_cost_month"."solar_unpriced_kwh" < 'Infinity')
);
--> statement-breakpoint
ALTER TABLE "ev_session_cost_month" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ev_session_cost" ADD CONSTRAINT "ev_session_cost_session_id_ev_charge_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ev_charge_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_session_cost_month" ADD CONSTRAINT "ev_session_cost_month_session_id_ev_session_cost_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ev_session_cost"("session_id") ON DELETE cascade ON UPDATE no action;