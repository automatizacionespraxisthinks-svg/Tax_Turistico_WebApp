CREATE TABLE "ride_photos" (
	"ride_id" uuid PRIMARY KEY NOT NULL,
	"content" "bytea" NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rides" ALTER COLUMN "fare_estimate" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rides" ALTER COLUMN "fare_rule_version" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "pickup_photo_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ride_photos" ADD CONSTRAINT "ride_photos_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "public"."rides"("id") ON DELETE cascade ON UPDATE no action;