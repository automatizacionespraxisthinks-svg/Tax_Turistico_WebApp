ALTER TABLE "zones" ADD COLUMN "es_referencia" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "zones_una_referencia" ON "zones" USING btree ("es_referencia") WHERE "zones"."es_referencia";--> statement-breakpoint
-- El punto de partida de las carreras sin ubicar: la zona que se llame
-- Centro y, si no hay, la urbana más antigua. Antes salía «la primera
-- urbana» en el orden que devolviera la base, y en producción era Lago
-- Sochagota. Desde el panel se puede elegir otra.
UPDATE "zones" SET "es_referencia" = true
 WHERE "id" = (
   SELECT "id" FROM "zones"
    WHERE "active" AND "kind" = 'urbano'
    ORDER BY (lower("name") = 'centro') DESC, "created_at" ASC
    LIMIT 1
 );
