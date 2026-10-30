ALTER TABLE "drivers" ADD COLUMN "acepta_pago_electronico" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "suspendido_hasta" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "motivo_suspension" text;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "pago_electronico" boolean DEFAULT false NOT NULL;