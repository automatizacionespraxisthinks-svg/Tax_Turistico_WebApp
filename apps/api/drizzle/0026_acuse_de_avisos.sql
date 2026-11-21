ALTER TABLE "ride_offers" ADD COLUMN "aviso" text;--> statement-breakpoint
ALTER TABLE "ride_offers" ADD COLUMN "aviso_enviado_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ride_offers" ADD COLUMN "recibida_at" timestamp with time zone;