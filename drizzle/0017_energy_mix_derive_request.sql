CREATE TABLE "energy_mix_derive_request" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "energy_mix_derive_request_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"from_day" date NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "energy_mix_derive_request" ENABLE ROW LEVEL SECURITY;