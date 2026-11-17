ALTER TABLE "driver_shifts" ADD COLUMN "fuera_de_listado" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Un conductor, un celular activo (17/11/2026). Los que hoy tienen varios
-- se quedan con el último que usaron; los demás se cierran y pierden el push.
UPDATE "driver_devices" d
   SET "revoked_at" = now(), "push_subscription" = NULL
 WHERE d."revoked_at" IS NULL
   AND d."id" <> (
     SELECT x."id" FROM "driver_devices" x
      WHERE x."driver_id" = d."driver_id" AND x."revoked_at" IS NULL
      ORDER BY x."last_seen_at" DESC NULLS LAST, x."created_at" DESC
      LIMIT 1
   );
