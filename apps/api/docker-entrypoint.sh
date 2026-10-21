#!/bin/sh
set -e

# Arranque de la API en el VPS.
#
# Las migraciones se aplican antes de servir la primera petición, no a mano
# después: si el contenedor nuevo arranca contra un esquema viejo, lo que
# falla no es el despliegue sino la primera carrera que entre.
#
# Es seguro repetirlo. El migrador de Drizzle lleva su propia tabla de
# control, así que un reinicio no vuelve a aplicar nada, y cada migración va
# en su transacción: o entra entera o no entra.
#
# Ojo si algún día hay más de una réplica: dos contenedores arrancando a la
# vez migrarían a la vez. Con una sola réplica —que es el caso— no pasa.

echo "→ Aplicando migraciones…"
node dist/db/migrate.js

echo "→ Arrancando la API"
exec "$@"
