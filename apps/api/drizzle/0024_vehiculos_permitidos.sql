ALTER TABLE "vehicle_drivers" ADD COLUMN "origen" text DEFAULT 'listado' NOT NULL;--> statement-breakpoint
-- Desde esta versión solo se puede abrir turno en un vehículo permitido
-- (18/11/2026). Para que nadie amanezca bloqueado al desplegar, al conductor
-- que hoy no tiene ningún vínculo se le permiten los móviles en los que abrió
-- turno los últimos 30 días. Quedan marcados como asignados en el panel: la
-- oficina los revisa y los quita desde la tarjeta del conductor.
INSERT INTO "vehicle_drivers" ("id", "vehicle_id", "driver_id", "role", "origen")
SELECT gen_random_uuid(), s."vehicle_id", s."driver_id", 'relevador', 'panel'
FROM (
	SELECT DISTINCT "driver_id", "vehicle_id"
	FROM "driver_shifts"
	WHERE "started_at" > now() - interval '30 days'
) s
JOIN "drivers" d ON d."id" = s."driver_id" AND d."eliminado_at" IS NULL
WHERE NOT EXISTS (SELECT 1 FROM "vehicle_drivers" v WHERE v."driver_id" = s."driver_id")
ON CONFLICT DO NOTHING;
