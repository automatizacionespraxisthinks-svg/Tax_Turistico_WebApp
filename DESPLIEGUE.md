# Despliegue en Dokploy

Guía para poner Tax Turístico en el VPS. Supone lo que ya tienes: un dominio
propio apuntando al servidor, y PostgreSQL 16 y Redis 7 corriendo ahí para
otros servicios, pero sin base ni usuario para Tax Turístico todavía.

Son tres aplicaciones en Dokploy, las tres desde el mismo repositorio:

| Aplicación | Qué es | Subdominio |
| --- | --- | --- |
| `tax-api` | La API de NestJS | `api.TUDOMINIO` |
| `tax-panel` | El panel de oficina | `panel.TUDOMINIO` |
| `tax-conductor` | La PWA del conductor | `conductor.TUDOMINIO` |

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

### 0.4 Crea el usuario de Redis

Tax Turístico comparte el Redis con otros servicios, así que se le da un
usuario limitado a sus propias claves:

```
ACL SETUSER tax on >LA_DE_REDISPASSWORD_TAX ~tax:* +@all -@dangerous
ACL SAVE
```

`~tax:*` es la parte importante: aunque la API tuviera un fallo, no puede leer
ni borrar las claves de n8n.

Comprueba también que la política de memoria sea `noeviction`:

```
CONFIG GET maxmemory-policy
```

Si devuelve otra cosa, cámbiala. Con `allkeys-lru`, Redis puede descartar
trabajos de BullMQ cuando le falte memoria, y eso significa carreras que nunca
se despachan.

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
`@tax/shared`, que vive en `packages/`. Con el contexto en `apps/api` la
construcción falla al no encontrarlo.

### Environment

Pega esto y reemplaza lo que está en mayúsculas. Las cinco primeras salen de
`apps/api/.env.produccion.local`:

```
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

DATABASE_URL=postgres://tax:PGPASSWORD_TAX@HOST_POSTGRES:5432/tax
DATABASE_POOL_MAX=10

REDIS_URL=redis://tax:REDISPASSWORD_TAX@HOST_REDIS:6379
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

- **`HOST_POSTGRES` y `HOST_REDIS`** no son `localhost`. Desde dentro del
  contenedor, `localhost` es el propio contenedor. Si PostgreSQL corre en
  Dokploy, usa el nombre del servicio; si corre en el host, usa
  `host.docker.internal` o la IP de la red de Docker.
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

### 4.1 Siembra los datos mínimos

La base está vacía: sin zonas ni tarifas, la primera carrera falla con
`NO_FARE_RULE`. Desde el terminal del contenedor `tax-api` en Dokploy:

```bash
node dist/db/seed.js
```

Revisa antes `apps/api/src/db/seed.ts`: siembra conductores y vehículos de
ejemplo que en producción habrá que sustituir por los reales.

### 4.2 Crea el usuario de la oficina

El de ejemplo trae una contraseña de desarrollo. Crea el real y borra el otro.

### 4.3 Da de alta el segundo factor

Entra a `https://panel.TUDOMINIO`. Como la cuenta aún no tiene segundo factor,
el panel no te deja pasar de la pantalla de alta: escanea el QR con tu
aplicación de autenticación, escribe el código y **guarda los diez códigos de
respaldo**. No se vuelven a mostrar.

### 4.4 Emite la clave de API para n8n

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
