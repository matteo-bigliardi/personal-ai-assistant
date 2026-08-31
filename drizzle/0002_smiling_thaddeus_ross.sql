CREATE TYPE "public"."reminder_status" AS ENUM('pending', 'delivered', 'snoozed', 'cancelled');--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text NOT NULL,
	"message" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" "reminder_status" DEFAULT 'pending' NOT NULL,
	"job_id" text,
	"snooze_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "reminders_pending_not_delivered" CHECK ("reminders"."status" <> 'pending' OR "reminders"."delivered_at" IS NULL),
	CONSTRAINT "reminders_delivered_has_timestamp" CHECK ("reminders"."status" NOT IN ('delivered', 'snoozed') OR "reminders"."delivered_at" IS NOT NULL),
	CONSTRAINT "reminders_snooze_count_non_negative" CHECK ("reminders"."snooze_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX "reminders_due_idx" ON "reminders" USING btree ("status","due_at");