CREATE TABLE "report_exports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"format" text NOT NULL,
	"params" jsonb NOT NULL,
	"title" text NOT NULL,
	"file_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"size_bytes" integer,
	"content" "bytea",
	"requested_by_id" uuid,
	"requested_by_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "report_exports_created_idx" ON "report_exports" USING btree ("created_at");