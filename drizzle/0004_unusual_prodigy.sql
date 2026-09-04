CREATE TABLE "briefing_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"send_at" text NOT NULL,
	"last_sent_on" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "briefing_settings_single_row" CHECK ("briefing_settings"."id"),
	CONSTRAINT "briefing_settings_send_at_format" CHECK ("briefing_settings"."send_at" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);
