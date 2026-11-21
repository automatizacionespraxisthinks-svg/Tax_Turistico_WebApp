CREATE TABLE "ride_driver_cancellations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ride_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"motivo" text NOT NULL,
	"motivo_texto" text NOT NULL,
	"desde" text NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ride_driver_cancellations" ADD CONSTRAINT "ride_driver_cancellations_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "public"."rides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ride_driver_cancellations" ADD CONSTRAINT "ride_driver_cancellations_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ride_driver_cancellations_ride_idx" ON "ride_driver_cancellations" USING btree ("ride_id");--> statement-breakpoint
CREATE INDEX "ride_driver_cancellations_fecha_idx" ON "ride_driver_cancellations" USING btree ("created_at");