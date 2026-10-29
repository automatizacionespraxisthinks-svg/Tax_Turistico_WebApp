# Despliegue en Dokploy

Guía para poner Tax Turístico en el VPS. Supone lo que ya tienes: un dominio
propio apuntando al servidor, y Dokploy sobre Docker Swarm con PostgreSQL y
Redis ya corriendo para otros servicios.

Las versiones del VPS son **PostgreSQL 18** y **Redis 8**, por delante de las
16 y 7 del documento de arquitectura. Comprobado contra esas versiones: las
migraciones aplican enteras, la exclusividad por índice parcial sigue siendo
atómica, la bitácora de solo inserción rechaza `UPDATE` y `DELETE` incluso
desde un superusuario, y BullMQ acepta Redis 8.

Son tres aplicaciones en Dokploy, las tres desde el mismo repositorio:

| Aplicación | Qué es | Subdominio |
| --- | --- | --- |
| `tax-api` | La API de NestJS | `api.TUDOMINIO` |
| `tax-panel` | El panel de oficina | `panel.TUDOMINIO` |
| `tax-conductor` | La PWA del conductor | `conductor.TUDOMINIO` |

### Aplicación, no Compose

Las tres se crean en Dokploy como **Application**, no como Compose. Compose
tiene sentido cuando varios contenedores forman una unidad: comparten
volúmenes, dependen del arranque del otro, se despliegan juntos o nunca.

Aquí no es el caso. Son tres piezas independientes con tres dominios, tres
`Dockerfile` y tres argumentos de construcción distintos, y la ventaja real
está en poder desplegarlas por separado: reconstruir el panel sin reiniciar la
API, revertir una sola, o volver a desplegar el conductor sin que la API
vuelva a pasar por sus migraciones. Con Compose, cada cambio mueve el conjunto.

Además, los dominios y los argumentos de construcción se configuran en la
propia interfaz de Dokploy. En Compose habría que escribir a mano las
etiquetas de Traefik de cada servicio, que es más trabajo y más sitios donde
equivocarse.

**Despliégalas de una en una.** Cada construcción instala el monorepo entero,
y tres a la vez en un VPS modesto pueden agotar la memoria y morir a mitad.
Empieza por `tax-api`, comprueba `/ready`, y solo entonces sigue.

**Por qué tres subdominios del mismo dominio y no dominios distintos:** la
sesión del panel va en una cookie `SameSite=Lax`. Entre subdominios del mismo
dominio el navegador la considera «mismo sitio» y la manda; desde un dominio
distinto no la mandaría y nadie podría entrar. Si cambias este esquema, hay
que tocar la cookie.

---

## 0. Antes de tocar Dokploy

### 0.1 Sube los archivos de despliegue

Los `Dockerfile` son nuevos. Sin ellos Dokploy no tiene nada que construir:

```bash
git add -A && git commit -m "Añade Dockerfiles y configuración de despliegue" && git push
```

### 0.2 Apunta el DNS al VPS

Tres registros `A` hacia la IP del servidor:

```
api.TUDOMINIO        A    <IP del VPS>
panel.TUDOMINIO      A    <IP del VPS>
conductor.TUDOMINIO  A    <IP del VPS>
```

Hazlo ya: Let's Encrypt comprueba el DNS al emitir el certificado, y la
propagación puede tardar. Si llegas a Dokploy antes de que resuelva, el
certificado falla y hay que reintentarlo.

### 0.3 Crea la base y el usuario en PostgreSQL

Entra al servidor por SSH y abre `psql` como superusuario. Las contraseñas
están en `apps/api/.env.produccion.local`, que **no** está en el repositorio.

```sql
CREATE USER tax WITH PASSWORD 'LA_DE_PGPASSWORD_TAX';
CREATE DATABASE tax OWNER tax;
```

Eso es todo: no hacen falta extensiones. Las migraciones crean el esquema
entero —tablas, índices, secuencias, funciones y el disparador de la bitácora—
al arrancar el contenedor, y los identificadores los genera la aplicación, no
la base.

**El usuario `tax` solo puede tocar la base `tax`.** No le des superusuario:
si algún día la API se ve comprometida, el daño se queda en su propia base y
no alcanza a n8n ni a lo demás que vive en ese PostgreSQL.

### 0.4 Prepara Redis

Tax Turístico comparte la instancia de Redis con otros servicios del VPS, pero
**no crea usuario**: usa el usuario por defecto y se separa con una base
lógica propia y un prefijo de claves.

No hay nada que ejecutar aquí. La separación se configura en la URL de la
aplicación, en el paso siguiente:

```
REDIS_URL=redis://default:CONTRASEÑA@tax-turistico-waha-db-lrgghu:6379/1
REDIS_PREFIX=tax:
```

El `/1` es el índice de base lógica.

**La contraseña es obligatoria** si el Redis la tiene puesta, y el de Dokploy
la tiene. Esto despista: `redis-cli` **dentro** del contenedor funciona sin
pedirla, porque Dokploy le deja la variable `REDISCLI_AUTH` y `redis-cli` la
usa sola. Desde fuera no hay tal ayuda y la API se queda así, reintentando sin
parar:

```
ReplyError: NOAUTH HELLO must be called with the client already authenticated
```

Para sacarla:

```bash
docker ps --format "{{.Names}}" | grep waha-db | head -1 | xargs -I{} docker exec {} env | grep -iE "password|auth"
```

Si la contraseña lleva `@`, `/`, `:`, `#` o `?`, hay que codificarla para la
URL (`@` → `%40`, y así) o la URL se parte por donde no debe. Comprobado con BullMQ 6 e ioredis 6: las
claves aterrizan en la base 1 y la 0 queda intacta.

**Por qué no una ACL, que sería más estricta.** Porque en una instancia de
Redis arrancada sin fichero de configuración —como la que despliega Dokploy—
`ACL SAVE` y `CONFIG REWRITE` fallan los dos: el usuario existiría solo en
memoria y desaparecería en el primer reinicio, dejando a la API sin conectar
de madrugada y sin aviso. Una separación que no sobrevive a un reinicio es
peor que ninguna, porque da una falsa sensación de aislamiento.

**Lo que esto no te da.** A diferencia de Postgres, donde el usuario `tax` no
alcanza la base de n8n, aquí no hay barrera: quien entre al Redis ve y borra
todo, también tus colas. Se acepta porque está en la red interna del Swarm y,
sobre todo, porque **la verdad no vive en Redis**: las carreras, el outbox, las
claves de idempotencia y la bitácora están en Postgres. Si este Redis se
vacía, el barrido del outbox recupera los eventos pendientes y las posiciones
se rehacen en diez segundos. Se pierden temporizadores de oleada en vuelo, no
datos.

Si algún día hace falta aislamiento de verdad, la salida no es la ACL: es
darle a Tax Turístico su propia instancia de Redis.

### 0.5 Comprueba la política de memoria

Esto sí hay que mirarlo, y es la única condición que puede invalidar lo
anterior:

```bash
docker exec CONTENEDOR_REDIS redis-cli CONFIG GET maxmemory-policy
docker exec CONTENEDOR_REDIS redis-cli CONFIG GET maxmemory
```

Tienen que decir `noeviction` y `0`, que son los valores por defecto de Redis.

**Si devuelve otra política** —`allkeys-lru` o parecida—, no compartas esta
instancia: Redis puede descartar claves cuando le falte memoria, y las que
descarte pueden ser trabajos de BullMQ, es decir carreras que nunca se
despachan. Y sin fichero de configuración tampoco podrías corregirlo de forma
duradera. En ese caso, Redis propio.

---

## 1. La API (`tax-api`)

En Dokploy: **Create Application** → nombre `tax-api`.

### Source

| Campo | Valor |
| --- | --- |
| Provider | GitHub |
| Repository | `automatizacionespraxisthinks-svg/Tax_Turistico_WebApp` |
| Branch | `main` |

### Build

| Campo | Valor |
| --- | --- |
| Build Type | **Dockerfile** |
| Docker File | `apps/api/Dockerfile` |
| Build Path / Context | `/` |

El contexto es la raíz, **no** `apps/api`. Es un monorepo: la API importa
`@tax/shared`, que vive en `packages/`, y el `pnpm-lock.yaml` está en la raíz.

**Este es el error número uno al desplegar esto.** Si Dokploy deja vacío el
campo del contexto, usa la carpeta del Dockerfile y la construcción muere así:

```
ERR_PNPM_NO_LOCKFILE  Cannot install with "frozen-lockfile"
because pnpm-lock.yaml is absent
```

Se reconoce antes incluso de llegar ahí, mirando la línea
`transferring context` del log: tiene que rondar los **4 MB** (el repositorio
entero). Si dice unos 500 kB, está mandando solo `apps/api` y va a fallar.
Rellena el campo de contexto con `.` explícitamente, aunque parezca que el
valor por defecto ya es ese.

### Environment

Pega esto y reemplaza lo que está en mayúsculas. Las cinco primeras salen de
`apps/api/.env.produccion.local`:

```
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

DATABASE_URL=postgres://tax:PGPASSWORD_TAX@tax-turistico-database-ja1hse:5432/tax
DATABASE_POOL_MAX=10

REDIS_URL=redis://default:CONTRASEÑA@tax-turistico-waha-db-lrgghu:6379/1
REDIS_PREFIX=tax:

SESSION_SECRET=...
ENCRYPTION_KEY=...
SESSION_TTL_HOURS=12

VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:soporte@TUDOMINIO

GOOGLE_GEOCODING_API_KEY=...

# Solo mientras se prueba: ver la nota de abajo.
OLEADA_FINAL_A_TODOS=true

# Monitor de las líneas de WhatsApp: ver la nota de abajo.
WAHA_URL=http://NOMBRE-DEL-SERVICIO-WAHA:3000
WAHA_API_KEY=...

PUBLIC_ORIGINS=https://panel.TUDOMINIO,https://conductor.TUDOMINIO

# Operadores activos a la vez; los administradores no cuentan.
MAX_OPERADORES=5

# Minutos a bordo antes de poder finalizar (0 lo desactiva, 120 es el máximo;
# la PWA lo recibe al abrir, sin recompilarla), y días que se guarda la foto
# del lugar.
MIN_DURACION_CARRERA_MIN=10
PHOTO_RETENTION_DAYS=30

POSITION_MAX_AGE_SECONDS=60
ARRIVAL_RADIUS_METERS=150
OUTBOX_MAX_ATTEMPTS=10

POSITION_RETENTION_DAYS=180
POSITION_PURGE_BATCH=5000
POSITION_PURGE_PAUSE_MS=2000
POSITION_PURGE_MAX_ROWS=2000000
POSITION_PURGE_CRON=0 4 * * *
PURGE_TIMEZONE=America/Bogota
```

Tres cosas que se equivocan siempre:

- **Los anfitriones son nombres de servicio de Swarm**, no `localhost` ni el
  nombre del contenedor. Dentro del contenedor, `localhost` es el propio
  contenedor; y el nombre que sale en `docker ps`
  —`tax-turistico-database-ja1hse.1.abc123…`— es el de la **tarea**, que
  cambia en cada despliegue. El que resuelve siempre es el del servicio, el
  que lista `docker service ls`. Ambos servicios y la aplicación tienen que
  estar en la red `dokploy-network`.
- **`PUBLIC_ORIGINS`** sin barra final y con `https://`. Si no coincide
  exactamente con lo que el navegador manda, el panel recibe un error de CORS
  y no carga.
- **`OLEADA_FINAL_A_TODOS`** añade, tras la tercera oleada, una ronda que
  avisa a **todos** los conductores disponibles sin mirar distancia, tipo de
  vehículo ni antigüedad del GPS. Sirve para probar los avisos con pocos
  conductores: con uno solo en turno lejos del punto, las oleadas por radio
  no lo encuentran nunca. Viene encendida por defecto mientras se prueba;
  para volver al despacho por radio, `false`. Un conductor en pausa no la
  recibe, y quien rechazó la carrera tampoco.
- **`GOOGLE_GEOCODING_API_KEY`** convierte las direcciones que el cliente
  escribe por WhatsApp en coordenadas. Necesita la API de Geocoding
  habilitada en el proyecto de Google. **Es opcional**: sin ella la API no
  adivina direcciones y exige que la carrera llegue con coordenadas, así que
  el agente tendrá que pedirle la ubicación al cliente en todos los casos.
  Conviene restringirla por IP a la del VPS.
- **`WAHA_URL`** enciende el monitor de las líneas de WhatsApp: cada minuto
  le pregunta a WAHA por sus sesiones y, si una deja de atender, suena una
  alerta en el panel, queda un letrero rojo arriba hasta que vuelva y sale el
  evento `waha.line_down` hacia n8n. Es el nombre del **servicio** de WAHA en
  la red interna (`docker service ls | grep waha`) con su puerto, que por
  defecto es el 3000; no hace falta publicarlo en internet. **`WAHA_API_KEY`**
  es la clave en texto plano que WAHA exige en `X-Api-Key`, la misma que usa
  Chatwoot para hablarle. Sin `WAHA_URL` el monitor no arranca y *Sistema*
  lo dice; antes la página prometía «revisión cada minuto» sin que nada
  revisara.
- **`ENCRYPTION_KEY`** cifra el secreto TOTP de cada operador. Si la pierdes o
  la cambias, nadie de la oficina puede entrar y hay que volver a dar de alta
  el segundo factor de todos. Guárdala en el gestor de contraseñas antes de
  seguir.

### Domains

| Campo | Valor |
| --- | --- |
| Host | `api.TUDOMINIO` |
| Container Port | `3000` |
| HTTPS | sí, Let's Encrypt |

### Despliega

**Deploy**. Mira los logs: deben aparecer `→ Aplicando migraciones…`,
`Migraciones al día.` y después las rutas que registra Nest. La primera vez
tarda varios minutos porque construye el monorepo entero.

Cuando termine:

```bash
curl https://api.TUDOMINIO/health
curl https://api.TUDOMINIO/ready
```

`/health` dice que el proceso vive. **`/ready` es el que importa**: comprueba
de verdad PostgreSQL y Redis. Si devuelve `"postgres": false` o
`"redis": false`, el problema está en las URL de conexión del paso anterior,
no en la aplicación.

---

## 2. El panel (`tax-panel`)

**Create Application** → `tax-panel`. Mismo repositorio y rama.

### Build

| Campo | Valor |
| --- | --- |
| Build Type | **Dockerfile** |
| Docker File | `apps/admin/Dockerfile` |
| Build Path / Context | `/` |

### Build Arguments

```
VITE_API_BASE=https://api.TUDOMINIO
```

**Esto es un argumento de construcción, no una variable de entorno.** Vite
incrusta las `VITE_*` dentro del JavaScript al compilar. Si lo pones en
Environment, el panel se construirá apuntando a `localhost:3000` y no
funcionará. Y si algún día cambias el dominio de la API, hay que **reconstruir**,
no solo reiniciar.

### Domains

| Campo | Valor |
| --- | --- |
| Host | `panel.TUDOMINIO` |
| Container Port | `80` |
| HTTPS | sí |

---

## 3. La PWA del conductor (`tax-conductor`)

Igual que el panel, cambiando:

| Campo | Valor |
| --- | --- |
| Docker File | `apps/driver/Dockerfile` |
| Build Argument | `VITE_API_BASE=https://api.TUDOMINIO` |
| Host | `conductor.TUDOMINIO` |
| Container Port | `80` |

**HTTPS no es opcional aquí.** Sin él no hay service worker, y sin service
worker no hay Web Push: los conductores solo verían las ofertas con la
aplicación abierta en pantalla.

### Cómo la instalan los conductores

La aplicación se ofrece a sí misma, distinto en cada sistema:

- **Android**: aparece un botón «Instalar aplicación» en la pantalla de
  acceso. Para que Chrome lo permita, el manifiesto necesita iconos **PNG** de
  192 y 512; con solo SVG el evento de instalación no se dispara nunca y no
  hay botón. Los genera `apps/driver/scripts/generar-iconos.mjs`.
- **iPhone**: no existe nada programático, así que la pantalla explica los tres
  toques (Compartir → Añadir a pantalla de inicio → abrirla desde el icono).

**En iPhone instalar no es opcional**: Web Push solo funciona con la
aplicación en la pantalla de inicio (iOS 16.4+). Un conductor que la use desde
Safari no recibirá ofertas con el teléfono bloqueado, y la oleada 1 dura 45
segundos.

Dile a los conductores de iPhone que **la instalen antes de entrar**: la
aplicación instalada tiene su propio almacenamiento, separado del de Safari,
así que quien entre primero en el navegador tendrá que escribir su código otra
vez dentro. La pantalla ya lo advierte.

---

## 4. Primer arranque

### 4.1 Siembra las zonas

La base está vacía: sin zonas no hay dónde despachar. Desde el terminal del
contenedor `tax-api` en Dokploy:

```bash
node dist/cli/sembrar-produccion.js
```

Crea las 7 zonas de Paipa con su factor de tortuosidad y sus oleadas. Es
idempotente: repetirlo no duplica nada. Ya no siembra tarifas: el sistema no
maneja precios.

Las zonas son círculos, guardados como polígonos de 64 lados. Si la base se
sembró cuando todavía eran rectángulos, la migración `0014_zonas_circulares`
las cambia sola al desplegar; solo toca las que siguen siendo el rectángulo de
la siembra.

> **No ejecutes `dist/db/seed.js` aquí.** Ese es el sembrado de desarrollo y
> además de las zonas crea cinco conductores de mentira **con el PIN
> `4821`**, un usuario de oficina con la contraseña
> `desarrollo-no-usar-en-produccion` y tres líneas de WhatsApp inventadas.
> Cualquiera que haya leído el repositorio podría entrar como conductor y
> aceptar carreras. Los dos comparten las zonas (`db/datos-base.ts`),
> así que no hay riesgo de que se desincronicen.

### 4.2 Crea el usuario de la oficina

```bash
node dist/cli/crear-usuario.js ana@TUDOMINIO "Ana Gómez" administrador
```

El primero tiene que ser un administrador, y **los administradores solo se
crean así**, desde el terminal. El usuario puede ser un correo o un nombre de
usuario corto (`ana.gomez`); el tercer argumento es `administrador` u
`operador`.

Imprime una contraseña **temporal** una sola vez: caduca a las 72 horas y, al
entrar con ella, el panel obliga a cambiarla antes de nada. En la base solo
queda el hash Argon2.

El segundo factor no se activa aquí a propósito: lo da de alta la propia
persona al entrar, justo después de cambiar la contraseña, escaneando el QR
con su teléfono. Así el secreto TOTP nunca pasa por las manos de quien crea la
cuenta.

### 4.2.0 Los operadores, desde el panel

Con el administrador dentro, los operadores se crean en *Sistema › Usuarios ›
Nuevo operador*: nombre y usuario (correo o nombre corto). El panel enseña la
contraseña temporal una sola vez, con un botón que copia un mensaje listo para
mandárselo por WhatsApp: la dirección del panel, el usuario, la contraseña y
cuándo caduca.

Al entrar, el operador pasa por dos pantallas antes del panel: elegir su
contraseña y activar el segundo factor. No son avisos de la interfaz: hasta
cambiar la temporal, el servidor responde `PASSWORD_CHANGE_REQUIRED` a todo
salvo al propio cambio; y hasta activar el segundo factor, `TOTP_SETUP_REQUIRED`.
El orden importa: quien creó la cuenta conoce la temporal, y si el segundo
factor fuera primero podría adelantarse y dar de alta su propio teléfono.

Caben **cinco operadores activos** (`MAX_OPERADORES`). Para dar de alta a otro
con el cupo lleno, se desactiva a quien ya no esté en la oficina: deja de poder
entrar en el acto y sus sesiones se cierran, pero no se borra, porque su
nombre sigue en la bitácora y en las carreras que despachó.

### 4.2.1 Si pierdes la contraseña

La contraseña **no se puede recuperar**: en la base solo vive su hash Argon2.
Lo que sí se puede, desde el terminal del contenedor, es ver qué usuarios hay
y generar una nueva.

```bash
node dist/cli/usuarios.js
```

Lista correo, nombre, rol, si tiene segundo factor activo y el último acceso.
El correo no es secreto; la contraseña no aparece por ninguna parte.

```bash
node dist/cli/usuarios.js ana@TUDOMINIO
```

Genera una contraseña temporal y la imprime una vez: al entrar habrá que
cambiarla. **Conserva el segundo factor**, así que seguirás necesitando el
código de tu aplicación o uno de tus códigos de respaldo. Lo mismo hace
*Reiniciar contraseña* en *Sistema › Usuarios*.

Si además perdiste el teléfono y los códigos de respaldo:

```bash
node dist/cli/usuarios.js ana@TUDOMINIO --reiniciar-segundo-factor
```

Eso desactiva el segundo factor y borra los códigos de respaldo viejos: al
entrar tendrás que darlo de alta otra vez desde cero. Úsalo solo en ese caso,
porque deja la cuenta un rato protegida por contraseña a secas.

Las dos operaciones quedan en la bitácora como «Terminal del servidor».

### 4.3 Da de alta el segundo factor

Entra a `https://panel.TUDOMINIO`. Como la cuenta aún no tiene segundo factor,
el panel no te deja pasar de la pantalla de alta: escanea el QR con tu
aplicación de autenticación, escribe el código y **guarda los diez códigos de
respaldo**. No se vuelven a mostrar.

Esto no es un aviso de la interfaz: el servidor responde `TOTP_SETUP_REQUIRED`
a todo lo demás hasta que el alta esté hecha.

### 4.4 Da de alta los conductores

Sin esto nadie puede entrar a la PWA: el sembrado de producción no crea
conductores a propósito.

**Todos de una vez, desde el listado maestro** (el Excel «Listado Maestro»
de la empresa, hoja «Taxis»). El script crea los móviles con su ficha y su
propietario, los conductores y relevadores con su licencia, y quién maneja
cada móvil. Por defecto **simula**: hace todo, lo deshace e informa.

Desde tu computador, sube el Excel al VPS y pásaselo al contenedor por la
entrada estándar (el `-`), sin copiarlo dentro:

```bash
scp "Listado Maestro.xlsx" root@tu-vps:/root/listado.xlsx
ssh root@tu-vps
# Dokploy llama al contenedor «tax-turistico-api-…» y le cambia el sufijo en
# cada despliegue: se busca por nombre en vez de copiarlo.
API=$(docker ps --filter name=tax-turistico-api -q | head -1)
docker exec -i "$API" node dist/cli/importar-listado-maestro.js - < /root/listado.xlsx
```

Se ejecuta **en el VPS, no dentro del contenedor**: el `<` lo resuelve la
consola donde se escribe, y el Excel está en el VPS. Desde la consola del
contenedor (`docker exec -it … sh`) sale «Permission denied», porque allí
`/root` es otra carpeta y el usuario de la app no puede leerla. Va con `-i` y
sin `-t`: con `-t` el archivo llega estropeado.

Lee el informe: cuántos móviles y conductores crearía, quién queda sin
celular, los avisos del Excel. Si está bien, repítelo con `--aplicar`; los
PIN de los nuevos salen en pantalla **una sola vez**, y con `--pines` además
en un CSV dentro del contenedor, que sacas y borras:

```bash
docker exec -i "$API" node dist/cli/importar-listado-maestro.js - --aplicar --pines=/tmp/pines.csv < /root/listado.xlsx
docker cp "$API":/tmp/pines.csv ./pines.csv && docker exec "$API" rm /tmp/pines.csv
rm /root/listado.xlsx   # lleva cédulas: no lo dejes en el servidor
```

- Los códigos son consecutivos desde **101** (`--desde=` cambia el inicio) y
  se saltan los ya usados. Son de la persona, no del taxi: si cambia de
  móvil, conserva el suyo. El número interno del móvil va aparte y llega a
  n8n en `ride.assigned` como `data.driver.movil`.
- **Se puede repetir con el Excel de cada mes.** Al móvil se le reconoce por
  su número interno y a la persona por la huella de su cédula: lo que ya
  está se actualiza (celular, licencia, propietario, quién maneja qué), y
  nadie pierde su código ni su PIN.
- Lo que está en la base y ya no en el Excel solo se informa. Con
  `--desactivar-ausentes` se desactiva: hazlo cuando estés seguro de que no
  falta una fila por error.
- Un número interno o una placa repetidos en el Excel detienen la carga.
- Las cédulas se guardan cifradas; la bitácora registra la carga con códigos
  y números internos, nunca cédulas ni PIN.

**O con un script SQL, desde un cliente de PostgreSQL** (DBeaver, pgAdmin,
psql), sin entrar al contenedor. Se genera en tu computador a partir del
Excel:

```bash
node dist/cli/generar-sql-listado-maestro.js "Listado Maestro.xlsx" carga.sql
```

El `.sql` hace lo mismo que el comando de arriba, en una sola transacción:
en la línea marcada con `>>>` se pega la `ENCRYPTION_KEY` de tax-api (con ella
Postgres calcula la huella de cada cédula), se ejecuta entero contra la base
`tax`, y al final muestra el resumen, los PIN de los nuevos y lo que está en
la base pero no en el Excel. Para probar, se cambia el `commit;` final por
`rollback;`. Diferencias con el comando:

- Los PIN se sortean y se pasan por Argon2 al generar el archivo, porque
  Postgres no tiene Argon2: **el `.sql` trae los PIN**, y se borra al
  entregarlos.
- La cédula cifrada queda vacía, porque Postgres no cifra con AES-GCM como la
  app. La huella basta para reconocer a cada persona; si luego se corre una
  vez el comando `importar-listado-maestro --aplicar`, completa las cédulas
  cifradas de los conductores y de los propietarios.
- La entrada de la bitácora la escribe el propio script, con el mismo
  encadenado de hashes que la API.

**Uno por uno**, para un conductor que entra a mitad de mes:

```bash
node dist/cli/crear-conductor.js 101 "Jairo Pérez" +573118889900 UBP472 sedan
```

El último argumento es `sedan`, `camioneta` o `van`. Crea también el vehículo
si esa placa no existía. Imprime un PIN de cuatro dígitos **una sola vez**.

Dáselo al conductor por un canal distinto del que usa para su código: el
código circula entre compañeros y la placa es pública, así que el PIN es lo
único que de verdad autentica (§8.1). Lo que lo protege no es su longitud
—cuatro dígitos se teclean con guantes a las cinco de la mañana— sino el
bloqueo a los cinco intentos fallidos.

La relación conductor-vehículo es por turno, no fija (§6): puede abrir turno
con cualquier placa dada de alta, no solo con la suya. El vínculo del listado
maestro (conductor o relevador de un móvil) es lo que ve la oficina en
*Flota*; no restringe con qué taxi se abre turno, salvo que el móvil esté
inactivo.

### 4.5 Emite la clave de API para n8n

Desde el terminal del contenedor `tax-api` en Dokploy:

```bash
node dist/cli/crear-clave-api.js n8n rides:write rides:read
```

Los dos ámbitos hacen falta: `rides:write` para crear carreras y `rides:read`
para consultarlas. Con uno solo, n8n recibe un `403` al leer.

El secreto se imprime **una sola vez** y en la base solo queda su hash:
cópialo directo a las credenciales de n8n.

---

## 5. Comprobaciones finales

- `https://api.TUDOMINIO/ready` → `ok: true`, postgres y redis en `true`.
- En el panel, *Sistema › Estado*: cada servicio se comprueba de verdad en
  cada consulta y dice qué vio —versión de PostgreSQL y Redis, eventos a n8n
  atascados o en cola muerta, la clave de API que usa n8n y su antigüedad—.
  Las líneas de WhatsApp aparecen en menos de un minuto, con el número que
  tiene vinculado cada sesión. Si una pide el QR, *Ver QR* lo trae de WAHA
  para escanearlo desde ahí.
- El panel carga, entras con contraseña + código, y el mapa de Paipa se ve.
- En la PWA, abre turno con un conductor de prueba: debe pedir permiso de
  notificaciones y de ubicación.
- Crea una carrera desde n8n con la clave de API y comprueba que la oferta
  llega al teléfono.
- A la mañana siguiente, mira la bitácora: si había posiciones caducadas,
  debe haber una entrada `Borrado por retención`.

---

## Lo que falta y conviene saber

- **Copias de seguridad.** Dokploy puede programar volcados de PostgreSQL;
  configúralo antes de que haya datos reales. La bitácora es de solo
  inserción, pero eso no la protege de perder el disco.
- **Una sola réplica.** Las migraciones se aplican al arrancar el contenedor.
  Con dos réplicas arrancando a la vez, migrarían a la vez. Si algún día
  escalas, saca las migraciones a un paso previo.
- **El `ENCRYPTION_KEY` y las claves VAPID son irremplazables en caliente.**
  Cambiar el VAPID invalida todas las suscripciones de push y los conductores
  tienen que volver a activarlas; cambiar el `ENCRYPTION_KEY` deja a la
  oficina fuera.
- **Avisar al equipo técnico de una línea caída** es cosa de n8n. La API
  manda `waha.line_down` y `waha.line_up` al mismo webhook que los eventos de
  carrera, sin `rideId` y con un `data.message` ya redactado («Se cayó la
  línea «principal» (+57…): pide escanear el QR otra vez»). El flujo de
  avisos al cliente los deja pasar de largo; para que lleguen a alguien hace
  falta una rama que los filtre y los mande por el canal que se quiera. Sin
  ella, la alerta del panel funciona igual.
- **La migración `0009_monitor_de_lineas` borra las tres líneas inventadas**
  que dejaba el sembrado de desarrollo (`line-1`, `line-2`, `line-3`, con sus
  números de mentira). Si se quedaran, el monitor no las encontraría en WAHA y
  alertaría de la caída de dos líneas que nunca existieron. Las de verdad las
  escribe el monitor.
- **Sin precios, el flujo del agente de n8n cambia.** `POST /v1/quotes` ya
  no existe: en el flujo «Agente de carreras» hay que borrar la herramienta
  `cotizar_tarifa` y la sección «LA TARIFA» del prompt. Si se quedan, el agente
  intentará cotizar, recibirá un 404 y no sabrá qué decirle al cliente.
- **Lo que n8n recibe y puede mandar desde la migración `0012_fotos_y_sin_tarifas`:**
  - `ride.assigned` trae `data.driver` con `code`, `name`, `plate` y
    `vehicleType`, y `GET /v1/rides/:id` trae lo mismo en `driver`: con eso se
    arma el «ya va en camino» con código y placa.
  - La foto del lugar: `pickupPhotoUrl` al crear la carrera (el `data_url` del
    adjunto de Chatwoot), o después `POST /v1/rides/:id/photo` con la imagen
    como cuerpo (`content-type: image/jpeg`, «n8n Binary File» en el nodo HTTP
    Request) o con `{ "url": "…" }`. Hasta 5 MB; JPEG, PNG o WebP.
  - Ningún evento lleva ya `fareEstimate` ni `fareFinal`.
  - Los botones «Ir con Maps» e «Ir con Waze» de la PWA salen de lo que n8n
    ya manda: `pickup.text` (la nomenclatura), `pickup.reference` y, si el
    cliente compartió su ubicación, `pickup.point`. No hay que mandar enlaces
    ni la precisión: la API sabe si el punto es la ubicación compartida, una
    dirección geocodificada o una sin ubicar, y la PWA avisa al conductor en
    los dos últimos casos. Al destino solo hay botones si llega
    `dropoff.point`.
- **Reportes cambió de endpoints (migración `0013_marcas_de_prueba`).** El
  tablero se pide entero a `GET /v1/reports/dashboard` y sus opciones a
  `GET /v1/reports/filters`; ya no existen `summary`, `rides-by-hour`,
  `assignment-times`, `demand-by-zone` ni `automation-rate`. Solo los usaba el
  panel, así que no hay que tocar n8n. La migración añade `es_prueba` a
  `customers` y a `drivers`, en falso: hasta que alguien marque un teléfono o
  una cuenta de conductor, «No incluir pruebas» no deja nada fuera.
- **`MIN_DURACION_CARRERA_MIN`** (10 por defecto): minutos con el pasajero a
  bordo antes de poder finalizar. **`PHOTO_RETENTION_DAYS`** (30): cuánto se
  guarda la foto del lugar; se borra con la purga de madrugada.
- **Las exportaciones no necesitan volumen.** Los Excel y PDF se guardan en
  la tabla `report_exports` (migración `0011_exportaciones`) y se borran solos
  a los siete días. Llevan nombres y teléfonos de clientes, así que viajan con
  las copias de la base, como el resto de los datos. Las librerías nuevas
  (`exceljs`, `pdfkit`) están en `pnpm-lock.yaml`: sin él, el
  `--frozen-lockfile` del Dockerfile rechaza el despliegue.
- **Borra `apps/api/.env.produccion.local`** de tu máquina cuando los secretos
  estén en Dokploy y en el gestor de contraseñas de la empresa.
