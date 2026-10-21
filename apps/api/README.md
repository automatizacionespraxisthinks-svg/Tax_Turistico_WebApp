# @tax/api — monolito modular

Un solo proceso Node con la API, el motor de despacho, el relay del outbox y
el socket de tiempo real, como fija el ADR-01. Reutiliza el PostgreSQL 16 y el
Redis 7 que ya existen en el VPS; no añade ningún servicio más.

## Arrancar en local

```bash
pnpm db:up
```

Levanta PostgreSQL 16 y Redis 7 en contenedores **solo para desarrollo**
(`docker-compose.dev.yml`). En el VPS no se despliega ese archivo: allí la
base `tax` vive dentro del PostgreSQL existente con un usuario propio.

```bash
cp apps/api/.env.example apps/api/.env
```

```bash
pnpm --filter @tax/api db:migrate && pnpm --filter @tax/api db:seed
```

El `seed` imprime una clave de API para n8n **una sola vez**: de ahí en
adelante solo queda su hash Argon2 en la base.

```bash
pnpm dev:api
```

## Módulos

Ocho módulos con fronteras estrictas. Cada uno expone una interfaz y ninguno
lee las tablas de otro (§4.1).

| Módulo | Es dueño de | Expone |
| --- | --- | --- |
| `rides` | Ciclo de vida, edición de dirección, historial | `POST /v1/rides`, comandos de estado |
| `dispatch` | Oleadas, candidatos, ofertas, aceptación atómica | Aceptar, rechazar, relanzar, asignar |
| `fleet` | Conductores, vehículos, turnos, posición en vivo | Búsqueda de candidatos por radio y tipo |
| `pricing` | Tabla de precios, polígonos, catálogo de lugares | `quote()`, `classify()` |
| `integrations` | Outbox y entrega firmada a n8n | `enqueue()` dentro de una transacción |
| `identity` | Usuarios, roles, sesiones, claves de API | Guardas de autorización |
| `reports` | Consultas de lectura y exportaciones | Agregados en SQL |
| `audit` | Bitácora de solo inserción con hash encadenado | Lectura para administradores |

## Las tres garantías

Son las que el documento declara críticas y las únicas que no se pueden
simplificar.

### 1. Exclusividad: decide la base, no la aplicación

`DispatchService.accept` es una sola sentencia condicional. Si dos conductores
aceptan a la vez, PostgreSQL serializa los `UPDATE` y solo el primero
encuentra la fila en `NOTIFIED`; al segundo le devuelve cero filas.

```sql
update rides
   set status = 'ASSIGNED', driver_id = $driver, assigned_at = now(), version = version + 1
 where id = $ride and status = 'NOTIFIED'
   and exists (select 1 from ride_offers o
                where o.ride_id = $ride and o.driver_id = $driver
                  and o.expires_at > now() and o.revoked_at is null)
returning id;
```

Detrás hay un respaldo estructural: el índice único parcial
`one_active_ride_per_driver`. Aunque la lógica fallara, la base rechaza la
segunda asignación.

Verificado con 50 conductores concurrentes:

```bash
pnpm --filter @tax/api test
```

### 2. Entrega de eventos: outbox transaccional

`OutboxService.enqueue` recibe siempre la transacción que está cambiando el
dominio, así que el evento y el cambio se confirman o se descartan juntos. Eso
es lo que impide que el agente prometa algo que no ocurrió, y que algo ocurra
sin que nadie avise.

El relay entrega con cabeceras firmadas (`X-Tax-Event-Id`, `X-Tax-Timestamp`,
`X-Tax-Signature`), reintenta con backoff de 1 s a 15 min durante 10 intentos
y entierra el evento en cola muerta, visible en el panel. Un barrido cada 30 s
recoge lo que quedara pendiente tras un reinicio: el aviso por Redis es una
optimización, la verdad está en Postgres.

### 3. Temporizadores que sobreviven a un reinicio

Las oleadas vencen con trabajos diferidos de BullMQ sobre Redis, no con
`setTimeout`. Si el contenedor cae con una oleada en vuelo, al levantar vence
igual y la carrera sigue su camino.

## Idempotencia de entrada (§7.1)

La misma `Idempotency-Key` con el mismo cuerpo devuelve la respuesta original
sin volver a ejecutar nada; con un cuerpo distinto es un 409, porque significa
que quien llama está reutilizando una clave por error. Las claves viven 24 h.

Una trampa al depurar esto: la respuesta repetida sale de una columna `jsonb`,
y `jsonb` **reordena las claves** al guardarlas (por longitud y luego
alfabéticamente). Puestas una al lado de la otra, las dos respuestas parecen
tener campos distintos cuando solo están en otro orden. `e2e-dispatch.ts`
compara ordenando las claves en profundidad y comprueba que son los mismos 32
campos con los mismos valores y el mismo código de estado.

## Claves de API

Las claves no se crean por HTTP: se emiten desde el servidor, y el secreto se
imprime una sola vez porque en la base solo queda el hash Argon2 (§8.1).

```bash
pnpm --filter @tax/api exec tsx src/cli/crear-clave-api.ts n8n rides:write rides:read
```

El script vive dentro de `src/` para que se compile a `dist/` y exista también
en el contenedor de producción, donde no hay `tsx`; allí se llama con
`node dist/cli/crear-clave-api.js`.

Los ámbitos importan: `rides:write` crea carreras, `rides:read` las consulta.
Una clave a la que le falte uno recibe `403 FORBIDDEN` con el ámbito que le
falta en el detalle.

## Pruebas de extremo a extremo

Con la API en marcha y una clave con ambos ámbitos:

```bash
pnpm --filter @tax/api exec tsx src/test/e2e-dispatch.ts <clave-de-api>
```

Recorre el camino real —turno, posición, creación por el contrato de n8n,
oleada, aceptación simultánea— y comprueba que exactamente un conductor gana y
los demás reciben `RIDE_ALREADY_TAKEN`.

```bash
pnpm --filter @tax/api exec tsx src/test/e2e-totp.ts
```

Recorre el segundo factor de la oficina: una cuenta sin él que no puede usar
el panel, el alta con el QR, el acceso pidiendo el código, el rechazo del
mismo código dos veces, el código de respaldo y el bloqueo tras cinco
intentos. Deja la cuenta como estaba, así que se puede repetir.

```bash
pnpm --filter @tax/api exec tsx src/test/e2e-push.ts <clave-de-api>
```

Comprueba la mitad de Web Push que vive en el servidor: levanta un servicio de
push falso, registra una suscripción real apuntando ahí y verifica que el
aviso sale firmado con VAPID, cifrado en `aes128gcm`, con TTL 60 y urgencia
alta, que las cabeceras en claro no llevan teléfono ni dirección, y que un
`410 Gone` borra la suscripción.

El falso tiene que hablar HTTPS, porque `web-push` llama siempre a
`https.request` sin mirar el protocolo del endpoint. Hace falta un certificado
autofirmado y que la API confíe en él:

```bash
cd apps/api && mkdir -p .certs
openssl req -x509 -newkey rsa:2048 -nodes -days 3650   -keyout .certs/localhost.key -out .certs/localhost.crt   -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

NODE_EXTRA_CA_CERTS=.certs/localhost.crt node -r dotenv/config dist/main.js
```

`NODE_EXTRA_CA_CERTS` añade esa autoridad a las de siempre en vez de apagar la
verificación con `NODE_TLS_REJECT_UNAUTHORIZED`: lo que se prueba sigue siendo
el camino real, con TLS verificado. El directorio `.certs/` está ignorado y es
solo de desarrollo.

## Segundo factor de la oficina (§8.1)

TOTP de seis dígitos cada 30 segundos, RFC 6238, lo que leen Google
Authenticator, Aegis o 1Password. El teléfono no necesita señal para generar
el código: solo el secreto compartido y el reloj.

Está escrito a mano en `src/common/totp.ts` en vez de traer una dependencia,
porque son treinta líneas que los RFC especifican al detalle **y** publican
sus vectores de prueba: `src/test/totp.spec.ts` comprueba los diez de RFC 4226
y los seis de RFC 6238. Una dependencia aquí sería más superficie y menos
certeza.

Cuatro cosas que no son obvias y sin las cuales esto sería decorativo:

- **El secreto va cifrado en la base** (AES-256-GCM con `ENCRYPTION_KEY`).
  En claro, quien lea la tabla genera códigos válidos para siempre.
- **Cada código vale una sola vez.** Dentro de sus 30 segundos un TOTP es
  correcto muchas veces, así que `totp_last_counter` guarda el último
  intervalo aceptado. Sin eso, verlo por encima del hombro basta.
- **El servidor cierra la puerta, no la interfaz.** Una sesión cuya cuenta no
  tiene el segundo factor activo recibe `TOTP_SETUP_REQUIRED` en todo salvo
  `/v1/auth/me`, el alta y la salida. Si fuera solo un aviso del panel, quien
  tuviera la contraseña se saltaría el panel.
- **Hay códigos de respaldo.** Diez, de un solo uso, con Argon2 como las
  contraseñas. Una oficina a las tres de la mañana con el celular roto no
  puede quedarse fuera hasta que alguien aparezca.

Queda una grieta conocida: quien tenga la contraseña de una cuenta recién
creada puede darse de alta él mismo el segundo factor antes que su dueño. Por
eso el alta se fuerza en el primer acceso, cuando la cuenta se acaba de crear
y nadie más la conoce. Cerrarla del todo pide un código de invitación de un
solo uso al crear la cuenta, que es trabajo para cuando exista la gestión de
usuarios desde el panel.

Lo que TOTP **no** resuelve: una página falsa que pida el código y lo reenvíe
al panel real en ese momento. Las llaves de paso (WebAuthn) sí atan el acceso
al dominio, a cambio de un teléfono moderno por operador y un repuesto si se
pierde. Para un panel interno de cuatro o cinco personas, TOTP es la decisión
del documento y es razonable.

## Retención del histórico de GPS (§9.3)

`driver_positions` es la tabla que crece de verdad: la PWA manda posición cada
10 segundos con el turno abierto, así que 62 taxis a 12 horas son **267.840
filas al día**. Medido, cada fila ocupa unos 142 bytes con sus índices, así
que con el plazo de seis meses del documento la tabla se estabiliza en torno a
**6,4 GB** — y sin purga, crece sin tope.

Pero el motivo no es el disco, es lo que hay dentro: el recorrido minuto a
minuto de 62 personas. Pasados unos meses no sirve para operar —el mapa en
vivo mira Redis, y las excepciones se revisan en días— y sigue siendo un
riesgo si alguien se lleva un volcado.

El plazo del documento son **6 meses**, marcado ahí mismo como «a confirmar
con la empresa». Vive en `POSITION_RETENTION_DAYS`, no incrustado en el
código, porque cambiarlo es una decisión suya.

### Por qué por lotes

Un `DELETE` de ocho millones de filas es una transacción enorme: infla el WAL
de golpe, mantiene los bloqueos durante minutos y deja a autovacuum detrás.
Eso es un pico, y a las cuatro de la mañana también puede haber una carrera en
curso.

`purge_driver_positions(dias, lote)` borra como mucho `lote` filas por llamada
y devuelve cuántas quitó. El trabajo la llama en bucle con pausas hasta que
devuelve 0, con un tope por ejecución: si una noche no acaba, sigue a la
siguiente. Además la función pone `lock_timeout = 2s`, así que si algo tiene
las filas bloqueadas se rinde en lugar de encolar al resto detrás.

Medido con 300.000 filas de atraso, golpeando `/status` —que consulta de
verdad `rides` y `outbox_events`— mientras la purga corría:

| | p50 | p95 | peor |
| --- | --- | --- | --- |
| API durante la purga | 3,3 ms | **17 ms** | 60,8 ms |

60 lotes, sin una sola petición esperando un bloqueo. Entre ejecuciones el p95
se ha movido entre 7 y 17 ms y la peor petición entre 12 y 61 ms, según lo que
estuviera haciendo la máquina; aquí van los peores valores observados. Lo que
importa es el orden de magnitud: decenas de milisegundos, no segundos.

La referencia «en reposo» que imprime la prueba sale peor que la medida
durante la purga (p95 de 117 ms) y no sirve para comparar: se toma justo
después de insertar las filas de prueba, con Postgres todavía digiriendo. Lo
que se exige es el valor absoluto durante el borrado, no la diferencia.
`e2e-purga.ts` mide exactamente eso y falla si el p95 pasa de 250 ms o si
alguna petición supera 1 s.

Dos trampas que esa prueba aprendió a evitar, porque las dos dieron un
resultado estupendo sin haber medido nada:

- **Medir contra un endpoint que no toca la base.** La primera versión usaba
  `/v1/zones`, que responde 401 antes de llegar a Postgres: estaba midiendo el
  guardia de autenticación. Ahora exige un 200 y aborta si no lo recibe.
- **Medir el limitador de tasa.** Muestreando a 20 peticiones por segundo
  contra un límite de 240 por minuto, la mitad salían 429. El muestreo va a
  ritmo bajo y la prueba falla si no junta muestras suficientes.
- **Dar por propia la bitácora de otro.** Buscaba la última entrada de los
  diez minutos anteriores, y una purga anterior que siguiera corriendo dejaba
  la suya: la prueba daba por bueno un borrado que no era el suyo. Ahora
  anota el `seq` máximo antes de encolar y exige una entrada posterior.

```bash
pnpm --filter @tax/api exec tsx src/test/e2e-purga.ts 400000
```

Dos cosas que conviene saber: el espacio **no vuelve al disco**, autovacuum lo
deja reutilizable para las filas siguientes, que es justo lo que se quiere (la
tabla llega a un tamaño de equilibrio en vez de crecer); y cada ejecución
queda en la bitácora con las filas, los lotes y el plazo aplicado, porque
borrar datos personales por retención tiene que poder demostrarse.

La oficina puede verlo y lanzarlo a mano, solo administradores:

```
GET  /v1/admin/maintenance/retention        → plazo, total y cuántas caducaron
POST /v1/admin/maintenance/purge-positions  → 202, encola la misma purga
```

Las demás filas de la tabla de §9.3 siguen pendientes: fotos del lugar (30
días, el endpoint aún no existe), conversaciones de Chatwoot (12 meses, sin
integrar) y carreras, tarifas y auditoría (5 años). Esta última necesitará
otro mecanismo: la bitácora tiene `DELETE` revocado a propósito.

## Decisiones que se apartan del documento

- **NestJS 12 en vez de 11.** El documento fijó la 11; la 12 es el estable
  actual y la API de módulos e inyección no cambia en nada de lo que se usa
  aquí.
- **zod 4 y sin `zod-to-openapi`.** zod 4 convierte a JSON Schema de forma
  nativa, que es exactamente lo que necesita OpenAPI 3.1. Una dependencia
  menos en el camino crítico.
- **Transición `PENDING → UNASSIGNED` añadida.** La tabla de §5.3 da por
  supuesto que la oleada 1 siempre encuentra a alguien. Cuando no hay ningún
  conductor —de madrugada, o en una vereda sin cobertura— la carrera nunca
  llegaba a Notificada y se quedaba muda en Pendiente. Ahora acaba igualmente
  en Sin asignar y la oficina se entera. **Conviene confirmarlo con la
  empresa**, porque cambia la tabla de estados del documento.
- **`install_id` en los dispositivos.** El documento habla de dispositivos
  registrados pero no dice cómo se reconoce al mismo celular entre accesos.
  Sin eso cada acceso creaba una fila nueva en `driver_devices`, y como los
  avisos de push salen a todos los dispositivos vivos del conductor, uno que
  vuelve a entrar varias veces recibiría la misma oferta repetida. Ahora la
  PWA se genera un identificador la primera vez y lo guarda; no autentica
  nada, para llegar a usarlo hay que haber pasado código, placa y PIN.

## Superficies

Tres clientes con tres mecanismos de acceso distintos (§8.1), y por eso tres
grupos de rutas:

| Prefijo | Quién | Autentica con |
| --- | --- | --- |
| `/v1/rides`, `/v1/quotes`, `/v1/zones` | n8n (el agente) | Clave de API con ámbitos |
| `/v1/admin/*`, `/v1/reports/*`, `/v1/audit` | Panel de oficina | Cookie de sesión |
| `/v1/driver/*` | PWA del conductor | Token al portador del dispositivo |

No es duplicación: el agente y el operador pueden hacer cosas distintas sobre
la misma carrera, y la bitácora tiene que poder distinguir quién fue.

## Lo que falta

- **Adaptador de Chatwoot y WAHA** (capa anticorrupción) y el endpoint de
  fotos con URL firmada.
- **Exportaciones** a Excel y PDF en segundo plano.
- **Retención de las demás tablas de §9.3**: fotos, conversaciones y el
  archivado a cinco años de carreras y bitácora.
