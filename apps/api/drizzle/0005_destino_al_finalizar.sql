ALTER TABLE "rides" ADD COLUMN "dropoff_source" text;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "distance_km" double precision;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "fare_final" integer;