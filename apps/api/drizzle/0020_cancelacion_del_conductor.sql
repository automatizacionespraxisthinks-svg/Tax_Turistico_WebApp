ALTER TABLE "rides" ADD COLUMN "cancelled_by" "transition_actor";--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "cancel_code" text;--> statement-breakpoint
-- Las canceladas de antes: quién lo hizo sale de la bitácora de la carrera,
-- el último paso a «Cancelada». Así Reportes cuenta también las viejas.
UPDATE "rides" r
   SET "cancelled_by" = h."actor"
  FROM (
    SELECT DISTINCT ON ("ride_id") "ride_id", "actor"
      FROM "ride_status_history"
     WHERE "to_status" = 'CANCELLED'
     ORDER BY "ride_id", "at" DESC
  ) h
 WHERE h."ride_id" = r."id" AND r."status" = 'CANCELLED';
