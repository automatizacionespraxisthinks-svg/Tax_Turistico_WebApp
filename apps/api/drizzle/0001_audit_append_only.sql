-- Bitácora de auditoría: solo inserción (§6, RNF Auditoría).
--
-- El hash encadenado detecta una manipulación, pero no la impide. Quitarle a
-- la aplicación el permiso de UPDATE y DELETE sobre esta tabla sí: aunque
-- alguien consiguiera ejecutar SQL con el usuario de la API, no podría
-- reescribir la bitácora que lo registró.
--
-- Se aplica sobre el usuario actual, que es el de la aplicación. Un
-- administrador de la base sigue pudiendo tocarla; eso es inevitable y queda
-- cubierto por el control de acceso al servidor.

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "audit_log" FROM CURRENT_USER;
--> statement-breakpoint

-- Defensa adicional: un disparador rechaza el cambio aunque los permisos se
-- devolvieran por error en una migración futura.
CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log es de solo inserción: % no está permitido', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_log_no_update ON "audit_log";
--> statement-breakpoint

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();
--> statement-breakpoint

-- Borrado programado de posiciones GPS: retención de 6 meses (§9.3).
-- La tarea de BullMQ llama a esta función; tenerla en la base evita traerse
-- millones de filas al proceso solo para borrarlas.
CREATE OR REPLACE FUNCTION purge_driver_positions(retention_days int)
RETURNS bigint AS $$
DECLARE
  removed bigint;
BEGIN
  DELETE FROM driver_positions
   WHERE recorded_at < now() - make_interval(days => retention_days);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$ LANGUAGE plpgsql;
