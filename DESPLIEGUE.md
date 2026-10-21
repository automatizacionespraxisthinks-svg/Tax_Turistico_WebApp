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

PUBLIC_ORIGINS=https://panel.TUDOMINIO,https://conductor.TUDOMINIO

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

---

## 4. Primer arranque

### 4.1 Siembra zonas y tarifas

La base está vacía: sin zonas ni tarifas, la primera carrera falla con
`NO_FARE_RULE`. Desde el terminal del contenedor `tax-api` en Dokploy:

```bash
node dist/cli/sembrar-produccion.js
```

Crea las 7 zonas de Paipa con su factor de tortuosidad y sus oleadas, y las 4
reglas tarifarias vigentes. Es idempotente: repetirlo no duplica nada.

> **No ejecutes `dist/db/seed.js` aquí.** Ese es el sembrado de desarrollo y
> además de zonas y tarifas crea cinco conductores de mentira **con el PIN
> `4821`**, un usuario de oficina con la contraseña
> `desarrollo-no-usar-en-produccion` y tres líneas de WhatsApp inventadas.
> Cualquiera que haya leído el repositorio podría entrar como conductor y
> aceptar carreras. Los dos comparten las zonas y tarifas (`db/datos-base.ts`),
> así que no hay riesgo de que se desincronicen.

### 4.2 Crea el usuario de la oficina

```bash
node dist/cli/crear-usuario.js ana@TUDOMINIO "Ana Gómez" administrador
```

Imprime una contraseña aleatoria **una sola vez**; en la base queda solo el
hash Argon2. El tercer argumento es `administrador` u `operador`.

El segundo factor no se activa aquí a propósito: lo da de alta la propia
persona al entrar, escaneando el QR con su teléfono. Así el secreto TOTP nunca
pasa por las manos de quien crea la cuenta.

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
con cualquier placa dada de alta, no solo con la suya.

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
- **Borra `apps/api/.env.produccion.local`** de tu máquina cuando los secretos
  estén en Dokploy y en el gestor de contraseñas de la empresa.
