CREATE TABLE "vehicle_drivers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drivers" ALTER COLUMN "phone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "document_hash" text;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "license_expires_on" date;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "license_restriction" text;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "internal_number" text;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "brand" text;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "model_year" integer;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "fuel" text;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "engine_number" text;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "chassis_number" text;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "weight_kg" integer;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "registered_on" date;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "owner_name" text;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "owner_document_encrypted" text;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "vehicle_drivers" ADD CONSTRAINT "vehicle_drivers_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_drivers" ADD CONSTRAINT "vehicle_drivers_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_drivers_key" ON "vehicle_drivers" USING btree ("vehicle_id","driver_id");--> statement-breakpoint
CREATE INDEX "vehicle_drivers_driver_idx" ON "vehicle_drivers" USING btree ("driver_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drivers_document_hash_key" ON "drivers" USING btree ("document_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicles_internal_number_key" ON "vehicles" USING btree ("internal_number");