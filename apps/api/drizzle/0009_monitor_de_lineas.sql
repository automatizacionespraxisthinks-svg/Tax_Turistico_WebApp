ALTER TYPE "public"."outbox_event_type" ADD VALUE 'waha.line_down';--> statement-breakpoint
ALTER TYPE "public"."outbox_event_type" ADD VALUE 'waha.line_up';--> statement-breakpoint
ALTER TABLE "waha_sessions" ALTER COLUMN "phone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD COLUMN "connected" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD COLUMN "status_since" timestamp with time zone;--> statement-breakpoint
-- Hasta ahora esta tabla solo la escribía el sembrado de desarrollo, con tres
-- líneas y números inventados. Desde aquí la escribe el monitor a partir de
-- WAHA; si quedaran, el monitor no las encontraría en WAHA y alertaría de la
-- caída de dos líneas que nunca existieron.
DELETE FROM "waha_sessions"
 WHERE ("id", "phone") IN (('line-1', '+57 310 842 1190'),
                           ('line-2', '+57 320 455 7731'),
                           ('line-3', '+57 315 668 2204'));