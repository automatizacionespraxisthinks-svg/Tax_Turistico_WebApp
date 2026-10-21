-- Borrado por lotes del histórico de GPS (§9.3).
--
-- La versión anterior borraba todo lo caducado en una sola sentencia. Con el
-- volumen real —62 taxis mandando posición cada 10 s son unas 270.000 filas
-- al día, ocho millones al mes— eso es una transacción enorme: infla el WAL
-- de golpe, mantiene los bloqueos durante minutos y deja a autovacuum detrás
-- con una tabla llena de filas muertas. Justo el pico que no puede notarse
-- mientras se despachan carreras.
--
-- Ahora cada llamada borra como mucho `batch_size` filas y devuelve cuántas
-- se llevó. Quien la llama repite con pausas hasta que devuelve 0, así que el
-- trabajo se reparte en transacciones pequeñas en vez de una grande.

DROP FUNCTION IF EXISTS purge_driver_positions(int);

CREATE OR REPLACE FUNCTION purge_driver_positions(
  retention_days int,
  batch_size int DEFAULT 5000
)
RETURNS bigint AS $$
DECLARE
  removed bigint;
BEGIN
  -- Si otra cosa tiene bloqueadas esas filas, se rinde en seguida y el
  -- siguiente lote lo reintenta. Esperar aquí sería encolar al resto.
  SET LOCAL lock_timeout = '2s';

  -- El subselect va por `driver_positions_recorded_idx`, así que coge las
  -- más antiguas sin recorrer la tabla entera.
  DELETE FROM driver_positions
   WHERE id IN (
     SELECT id
       FROM driver_positions
      WHERE recorded_at < now() - make_interval(days => retention_days)
      ORDER BY recorded_at
      LIMIT batch_size
   );

  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION purge_driver_positions(int, int) IS
  'Borra un lote del histórico de GPS más antiguo que retention_days y devuelve cuántas filas quitó. Se llama en bucle con pausas (§9.3).';
