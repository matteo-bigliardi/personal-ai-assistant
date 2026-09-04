CREATE TYPE "public"."audit_event_type" AS ENUM('tool_call', 'agent_turn');--> statement-breakpoint
CREATE TYPE "public"."audit_status" AS ENUM('ok', 'error');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"event_type" "audit_event_type" NOT NULL,
	"tool" text,
	"arguments" jsonb,
	"status" "audit_status" NOT NULL,
	"error_code" text,
	"latency_ms" integer,
	"model" text,
	"iterations" integer,
	"token_cost_metadata" jsonb
);
--> statement-breakpoint
CREATE INDEX "audit_events_timestamp_idx" ON "audit_events" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "audit_events_tool_idx" ON "audit_events" USING btree ("tool","timestamp");