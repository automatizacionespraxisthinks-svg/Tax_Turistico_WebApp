DROP INDEX "one_offer_per_driver_per_wave";--> statement-breakpoint
ALTER TABLE "ride_offers" ADD COLUMN "intento" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "intento_despacho" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "one_offer_per_driver_per_wave" ON "ride_offers" USING btree ("ride_id","driver_id","wave","intento");--> statement-breakpoint
-- Las carreras que ya pasaron por el despacho cuentan como intento 1: sus
-- ofertas quedan con intento 1 por defecto, y si la carrera se quedara en 0
-- el proximo relanzamiento seria tambien el intento 1 y chocaria contra
-- ellas, que es exactamente el fallo que esta migracion corrige.
UPDATE "rides" SET "intento_despacho" = 1
 WHERE jsonb_array_length("wave_log") > 0
    OR EXISTS (SELECT 1 FROM "ride_offers" o WHERE o."ride_id" = "rides"."id");
