-- Identidad estable del dispositivo.
--
-- Hasta aquí cada acceso del conductor insertaba una fila nueva en
-- `driver_devices`, aunque fuera el mismo celular de siempre. Como los avisos
-- de Web Push se mandan a todos los dispositivos vivos del conductor, un
-- conductor que vuelve a entrar varias veces acabaría recibiendo la misma
-- oferta repetida, una vez por acceso.
--
-- `install_id` lo genera el propio celular la primera vez y lo guarda. No
-- autentica: para llegar a usarlo hay que haber pasado código, placa y PIN.

ALTER TABLE "driver_devices" ADD COLUMN "install_id" text;

-- Una instalación viva por conductor. El índice es parcial para que los
-- dispositivos revocados queden como historial sin estorbar a uno nuevo, y
-- para no chocar con las filas antiguas, que no tienen `install_id`.
CREATE UNIQUE INDEX "one_live_device_per_install"
  ON "driver_devices" ("driver_id", "install_id")
  WHERE "revoked_at" IS NULL AND "install_id" IS NOT NULL;
