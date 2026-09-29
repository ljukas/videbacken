CREATE TABLE "electricity_tariff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"valid_from" date NOT NULL,
	"retail_markup_ore" double precision NOT NULL,
	"grid_transfer_ore" double precision NOT NULL,
	"energy_tax_ore" double precision NOT NULL,
	"vat_percent" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "electricity_tariff_valid_from_unique" UNIQUE("valid_from"),
	CONSTRAINT "electricity_tariff_ore_check" CHECK ("electricity_tariff"."retail_markup_ore" BETWEEN -1000 AND 1000 AND "electricity_tariff"."grid_transfer_ore" BETWEEN 0 AND 1000 AND "electricity_tariff"."energy_tax_ore" BETWEEN 0 AND 1000),
	CONSTRAINT "electricity_tariff_vat_percent_check" CHECK ("electricity_tariff"."vat_percent" BETWEEN 0 AND 100)
);
--> statement-breakpoint
ALTER TABLE "electricity_tariff" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spot_price" (
	"zone" text NOT NULL,
	"slot_start" timestamp with time zone NOT NULL,
	"slot_end" timestamp with time zone NOT NULL,
	"sek_per_kwh" double precision NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spot_price_pk" PRIMARY KEY("zone","slot_start"),
	CONSTRAINT "spot_price_zone_check" CHECK ("spot_price"."zone" IN ('SE3')),
	CONSTRAINT "spot_price_slot_check" CHECK ("spot_price"."slot_end" > "spot_price"."slot_start" AND "spot_price"."slot_end" - "spot_price"."slot_start" <= interval '1 hour'),
	CONSTRAINT "spot_price_sek_per_kwh_check" CHECK ("spot_price"."sek_per_kwh" > -100 AND "spot_price"."sek_per_kwh" < 100)
);
--> statement-breakpoint
ALTER TABLE "spot_price" ENABLE ROW LEVEL SECURITY;