# Tax Turístico — primera versión de las interfaces

Monorepo con las dos interfaces del producto y los contratos de dominio que
comparten. Sigue la *Arquitectura técnica — Tax Turístico* (21 de octubre de
2026): mismo stack de frontends (React 19 + Vite + TypeScript, pnpm
workspaces), mismos estados, mismas reglas.

Las tres piezas están conectadas: el panel y la PWA hablan con la API por
HTTP y reciben los cambios por socket. Ya no queda nada simulado.

## Qué hay

| Paquete | Qué es |
| --- | --- |
| `apps/admin` | Panel de oficina: operación en vivo, carreras, flota, zonas, reportes, sistema |
| `apps/driver` | PWA de conductores: una pantalla por estado, botones de 64 px, cola sin conexión |
| `packages/ui` | Sistema de diseño: tokens, vocabulario de movimiento y componentes |
| `packages/shared` | Dominio compartido: estados, tabla de transiciones, geometría, eventos |
| `packages/tiles` | Genera el archivo PMTiles de Paipa desde OpenStreetMap |
| `apps/api` | Monolito NestJS: API, despacho, outbox y tiempo real en un proceso |

## Arrancar

```bash
pnpm install
```

Primero la base y la API, que es de quien viven las interfaces:

```bash
pnpm db:up && pnpm --filter @tax/api db:migrate && pnpm --filter @tax/api db:seed && pnpm dev:api
```

`pnpm db:up` levanta PostgreSQL 16 y Redis 7 en contenedores **solo para
desarrollo**. En el VPS se reutilizan los que ya están, con usuario propio y
prefijo de claves. El `seed` imprime una clave de API para n8n y crea un
usuario de oficina y cinco conductores de prueba; detalles en
[apps/api/README.md](apps/api/README.md).

El mapa de Paipa es un archivo estático que se genera una vez:

```bash
pnpm build:tiles
```

Tarda unos minutos y produce unos 3 MB en `apps/admin/public/tiles/`. Sin él
el panel funciona, pero el mapa aparece vacío con las instrucciones para
generarlo. Detalles en [packages/tiles/README.md](packages/tiles/README.md).

Después las dos interfaces:

```bash
pnpm dev
```

Panel en <http://localhost:5173> y PWA en <http://localhost:5174>. Para una
sola, `pnpm dev:admin` o `pnpm dev:driver`.

El panel pide correo y contraseña; la PWA, código de conductor, placa y PIN.
Las credenciales de desarrollo las imprime el `seed`.

```bash
pnpm typecheck && pnpm build
```

## Identidad de marca con tema único (HU-UI-01)

Un solo tema, claro, hecho con los cuatro colores del logo: el azul del
engranaje guía la interfaz, la tinta escribe, y el verde y el rojo dicen si algo
va bien o pide atención. Todo el color vive en
`packages/ui/src/styles/tokens.css`, en un solo bloque `:root`: los
hexadecimales solo están ahí y ningún componente escribe un color a mano. Hasta
el `theme-color` del HTML y los colores del manifiesto de la PWA se leen de ese
archivo al compilar (`packages/ui/marca.vite.ts`).

- **Paleta.** Los tokens de la HU (`--ink`, `--brand`, `--success*`,
  `--danger*`, `--warning*`, `--bg`, `--surface`, `--map-*`, `--legend-*`,
  `--plate`) y, debajo, la capa semántica que leen los componentes (`--c-*`,
  `--t-*`). Para cambiar un color se toca la paleta, nunca la capa de abajo.
- **Sin tema oscuro.** No hay interruptor ni preferencia guardada, y
  `color-scheme: light` hace que el modo oscuro del sistema no cambie nada.
- **Tonos de estado.** Verde es bien o disponible, azul es en curso, ámbar es
  pausa y rojo es atención. Los estados de carrera y de conductor se mapean a un
  tono en `packages/shared/src/domain/labels.ts`, así que el color de un estado
  se decide una sola vez. El color sólido de cada estado vivo de una carrera
  (ámbar buscando taxi, azul en camino, rojo en el lugar, verde en curso) está
  en `BANDA_DE_ESTADO`, en `packages/ui`: lo usan las columnas del tablero y
  los botones de la PWA, así que «Aceptar» es ámbar, «Llegué» azul,
  «Pasajero a bordo» rojo y «Finalizar» verde. La HU-UI-01 dejaba el del lugar
  en azul; la empresa lo pidió igual al panel.
- **Tarjetas.** Blancas sobre el fondo azul claro, separadas por sombra y no
  por borde.
- **Tipografía.** Atkinson Hyperlegible 400 y 700, servida desde la propia app
  con `font-display: swap` y precacheada en la PWA: el conductor la ve aunque
  su celular tenga otra fuente y aunque no tenga señal. Números tabulares en
  todo dato que se actualiza.
- **Logo.** El original está en `packages/ui/src/assets/`: un PNG de 687 px
  con fondo transparente, sacado del logo oficial que entregó la empresa
  (`logo-taxturistico.jpeg`). Los íconos de la PWA, los favicon y los logos
  del panel (barra lateral y acceso) y de la PWA (acceso y cabecera) salen de
  él con `node apps/driver/scripts/generar-iconos.mjs`. Si llega el vector, se
  exporta a 1024 px y se vuelve a correr.
- **Acceso del panel.** El logo oficial a 64 px y la franja de marca arriba de
  la pantalla y de la tarjeta, igual en las cuatro pantallas previas al panel
  (acceso, cambio de contraseña, alta del segundo factor y códigos de
  respaldo).
- **Gráficas.** Colores de serie en orden fijo (azul, verde, ámbar), nunca
  ciclados. El rojo no entra en el orden: lo lleva a mano la serie que mide
  algo fuera de objetivo, como el p95.

## Movimiento definido

`packages/ui/src/motion.ts` es el vocabulario completo. Cinco duraciones
(90 / 150 / 240 / 380 / 560 ms) y cuatro curvas; nada fuera de esa tabla.

- Entrar es más lento que salir: aparecer se nota, desaparecer no estorba.
- Solo se animan `opacity` y `transform`.
- El movimiento informa: la dirección dice de dónde viene algo. En la PWA, las
  pantallas entran por la derecha al avanzar en la carrera y por la izquierda
  al retroceder.
- Un solo elemento viaja entre posiciones en vez de dos parpadeos: el fondo de
  la sección activa en la barra lateral, el del control segmentado, el
  subrayado de las pestañas.
- Lo que está pasando ahora late (halo que se expande y se apaga); lo que
  acaba de cambiar destella una vez.
- `MotionConfig reducedMotion="user"` más un bloque
  `prefers-reduced-motion` en CSS: la app funciona entera sin una sola
  animación.

## Reglas del dominio que ya están implementadas

El panel no inventa acciones: cada botón sale de la tabla de transiciones.

- **Máquina de estados** (`domain/ride.ts`): los ocho estados de la carrera y
  las transiciones permitidas con su actor y su condición. `transitionsFrom()`
  es lo que decide qué acciones ve el operador.
- **Oleadas**: radio, número de candidatos y vencimiento por zona, en
  *Zonas*.
- **ETA sin servidor de rutas**: distancia en línea recta × factor de
  tortuosidad de la zona, como fija el ADR-08.
- **Sin precios**: la empresa no maneja tarifas desde el sistema. Ni la PWA,
  ni el panel, ni los informes muestran dinero; la API no calcula ninguno y
  `POST /v1/quotes` ya no existe. La tabla `fare_rules` se conserva solo como
  histórico de las carreras viejas.
- **Mínimo a bordo** (`MIN_DURACION_CARRERA_MIN`, diez minutos por defecto):
  «Finalizar» queda bloqueado en la PWA con una cuenta atrás, y la API lo
  rechaza con `RIDE_TOO_SHORT` si alguien se lo salta. El número vive solo en
  el entorno de la API: la PWA lo pide al abrir, así que cambiarlo no obliga a
  recompilarla, y con `0` la restricción queda desactivada. La oficina sí
  puede cerrar antes.
- **Foto del lugar**: el cliente la manda por WhatsApp y n8n la entrega con la
  carrera (`pickupPhotoUrl`) o después (`POST /v1/rides/:id/photo`, el archivo
  o un enlace). El conductor la ve mientras va a recogerlo, la oficina en la
  ficha, y se borra a los 30 días.
- **Al aceptar**, el evento `ride.assigned` lleva `driver: { code, name,
  plate }`, y la carrera guarda el taxi con el que va.
- **Reportes como tablero**: una sola consulta (`GET /v1/reports/dashboard`)
  con periodo por días de Paipa (hasta 93), sectores y líneas de opción
  múltiple, urbano o veredas y conductor de opción única, y «No incluir
  pruebas». Trae el resumen en palabras, las cifras contra las metas de
  `METAS`, las gráficas y una fila por conductor con ofertas y horas de turno;
  con un conductor elegido, lo compara con el grupo. Los filtros viven en la
  dirección de la página, y el Excel y el PDF salen con los mismos.
- **Pruebas fuera de las cifras**: un teléfono (desde la ficha de una de sus
  carreras) o una cuenta de conductor (desde *Flota*) se marcan como de
  prueba, y con «No incluir pruebas» Reportes deja fuera todo lo suyo, también
  lo de antes de marcarlo.
- **Zonas y lugares desde el panel**: en *Zonas*, una ventana sobre la vista
  crea zonas (círculos que no pueden montarse sobre otra; solo
  administradores) y lugares del catálogo con sus palabras clave, como los
  nombran los clientes. Una carrera sin ubicación compartida se ubica así:
  con nomenclatura («Calle 25 #18-40») primero el geocodificador; sin ella
  («frente a la terminal») primero el catálogo, y queda con `pickup_source =
  'catalogo'`. Las oleadas de cada zona ya se guardan de verdad. Prueba:
  `src/test/e2e-catalogo.ts`.
- **Listado maestro**: `cli/importar-listado-maestro.ts` carga el Excel de la
  empresa (hoja «Taxis»): móviles con su número interno, ficha y propietario
  (cédula cifrada), conductores y relevadores con licencia y restricción, y
  quién maneja cada uno (`vehicle_drivers`). Simula por defecto; con
  `--aplicar` guarda y reparte PIN. Se repite cada mes sin duplicar: a la
  persona se la reconoce por `document_hash`, un HMAC de la cédula. Cómo
  correrlo en el servidor: DESPLIEGUE §4.4. Pruebas: `listado-maestro.spec.ts`
  y `e2e-listado-maestro.ts`, con un Excel de mentira. Para cargarlo desde un
  cliente de PostgreSQL, `cli/generar-sql-listado-maestro.ts` convierte el
  Excel en un `.sql` equivalente: huella HMAC calculada en Postgres con la
  clave que pega quien lo ejecuta, PIN ya hasheados con Argon2 y la entrada
  de la bitácora encadenada igual que la API.
- **Outbox**: estados de entrega, reintentos y cola muerta. Ya no se ven en el
  panel —la empresa dejó *Sistema* con solo Usuarios y Auditoría—, pero
  la API reintenta igual, `/status` cuenta la cola muerta y
  `GET /v1/admin/outbox` sigue disponible.
- **Líneas de WhatsApp vigiladas**: un monitor pregunta a WAHA cada minuto.
  Una caída clara (FAILED, STOPPED, pide QR, la sesión desapareció) alerta en
  el acto; una dudosa (STARTING, WAHA sin contestar) solo si se repite en la
  revisión siguiente, porque un reinicio de WAHA pasa por ahí en segundos y
  alertaría de una caída y una vuelta cada vez. La lógica está aparte, en
  `waha-monitor.ts`, con sus pruebas.
- **Exportaciones a Excel y PDF**: las genera una cola en segundo plano
  (`exportaciones`), se guardan en la base siete días y el panel las descarga
  solas al terminar. El Excel del periodo trae todas las carreras y las tablas
  por conductor, zona, día y hora; el PDF es el resumen para imprimir; desde
  *Carreras* se exporta lo que se está viendo, con sus filtros. Horas y fechas
  en hora de Paipa. Prueba: `src/test/e2e-exportaciones.ts`.
- **Alta de operadores desde el panel**, hasta cinco activos: contraseña
  temporal de 72 horas que se muestra una vez, y al entrar, primero el cambio
  de contraseña y después el segundo factor, los dos impuestos por el servidor.
  Los administradores siguen creándose solo desde el terminal.
- **Página de estado sin textos fijos**: PostgreSQL, Redis, los webhooks de
  n8n, WAHA y la clave de API se comprueban en cada consulta, y la memoria
  se compara con el límite real del contenedor.
- **Privacidad**: el conductor no ve el teléfono del cliente hasta aceptar; el
  GPS solo existe con turno abierto.
- **Pago electrónico**: cada conductor dice si lo recibe (`drivers.
  acepta_pago_electronico`, desde la ficha en *Flota*) y cada carrera si el
  cliente paga así (`rides.pago_electronico`). Es un filtro más del despacho,
  como el tipo de vehículo: las oleadas y sus radios por zona son los mismos,
  solo que entre los que lo reciben. Si nadie con pago electrónico la toma,
  queda «sin asignar» sin abrirse a los demás; la oficina, o n8n, le pregunta
  al cliente si puede pagar en efectivo, la cambia (`PATCH …/payment`) y la
  relanza. La asignación manual respeta la misma regla. El conductor ve el
  medio de pago en la oferta y en la carrera. Prueba: `e2e-pago-y-suspension.ts`.
- **Sin destino en la PWA**: el cliente casi nunca lo dice al pedir, y en la
  pantalla del conductor se confundía con la dirección de recogida. Se sigue
  guardando si llega, y el panel lo muestra.
- **Suspensión con fecha**: además de desactivar, la oficina puede suspender a
  un conductor por unos días con un motivo (reglamento interno). Mientras dura
  no entra en las oleadas, no entra a la PWA —al intentarlo ve hasta cuándo— ni
  abre turno; si estaba en turno se le cierra, y si llevaba una carrera la
  termina y el turno se le cierra al finalizarla. Al cumplirse vuelve solo, sin
  que nadie tenga que reactivarlo.
- **Un carro, varios conductores**: la placa se repite entre el conductor y
  sus relevadores. Dar de alta un conductor con una placa existente lo vincula
  a ese móvil; en el listado maestro, las filas con la misma placa se juntan en
  un solo móvil. Y si quien entrega el carro olvidó cerrar su turno, el que lo
  recibe lo abre igual: el turno anterior se cierra solo (relevo) y a ese
  teléfono le llega el aviso, salvo que el carro esté en plena carrera.

## Contrato con n8n: pago electrónico y ubicación

Los flujos no viven en este repositorio. Su versión integrada con esto está
en `Flujos/Principales/Actualizados 2026-10-30` (carpeta de la empresa). Lo
que usan de la API:

1. **Medio de pago.** `POST /v1/rides` con `"pagoElectronico": true` o
   `false`, booleano. Sin el campo se toma efectivo, así que un flujo viejo
   sigue funcionando. Viene en `ride.created`, `ride.assigned` y
   `ride.no_driver`.
2. **Enlace de ubicación.** `pickup.link` (en `POST /v1/rides` y en
   `PATCH …/address`) es el enlace tal como lo mandó el cliente. La carrera
   lo guarda (`pickup_link`) y «Ir con Maps» del conductor lo abre; «Ir con
   Waze» va al mismo punto. Si no viene `pickup.point`, el punto se lee del
   enlace. Solo cuentan enlaces de mapas (Google, `maps.app.goo.gl`, Waze,
   Apple, OpenStreetMap): otro se ignora. Si la ubicación cae a menos de 60 m
   de un lugar del catálogo, su nombre va delante de la dirección.
3. **Sin taxis con pago electrónico.** `ride.no_driver` con
   `pagoElectronico: true`: se le pregunta al cliente si puede pagar en
   efectivo y, si acepta, `PATCH /v1/rides/:id/payment` con
   `{ "pagoElectronico": false, "relanzar": true }` cambia y relanza en una
   llamada. Solo con la carrera sin asignar (`INVALID_TRANSITION` si no).
4. **Asignación manual** (`POST /v1/rides/:id/assign`) responde
   `DRIVER_NO_ELECTRONIC_PAYMENT` o `DRIVER_SUSPENDED` si el conductor no
   cumple la regla.
5. **`PATCH …/address`** acepta también el cuerpo envuelto en `pickup`, como
   lo mandaba el flujo hasta octubre de 2026 (antes respondía
   `VALIDATION_FAILED`). Prueba: `src/test/e2e-enlace-de-ubicacion.ts`.

## Cómo se mantienen al día las pantallas

El reparto es deliberado, y es lo que hace que el panel aguante una señal
mala sin mentir:

- **El socket avisa** de que algo cambió y la pantalla responde al momento,
  sin esperar a nadie.
- **La API es la verdad.** Tras cada aviso, y al reconectar, el panel vuelve
  a pedir el estado completo.

Si el socket se pierde un evento —y en señal rural se pierde—, el refresco lo
corrige. Al revés, fiarlo todo al socket, deja a la oficina mirando datos
viejos sin saber que lo son.

La PWA hace lo mismo y añade una cola: una acción marcada sin cobertura se
guarda y se reenvía al volver la señal, porque el conductor no puede quedarse
esperando en mitad de una vereda.

## Lo que falta

Web Push y el TOTP de la oficina ya están, los dos probados de extremo a
extremo. Del segundo factor queda sin comprobar en un teléfono real solo la
mitad que vive en el navegador de los avisos push, porque el navegador de
pruebas deniega las notificaciones.

Pendiente de las siguientes fases, en orden:

1. **Cola sin conexión**: ya funciona sobre `localStorage`; pasa a IndexedDB
   el día que haya que encolar fotos y no solo comandos.
2. **Chatwoot** tras la capa anticorrupción (de WAHA ya se vigilan las
   líneas y se trae el QR).
3. **Retención de las demás tablas de §9.3**: fotos del lugar, conversaciones
   de Chatwoot y el archivado a cinco años. El histórico de GPS ya se purga
   solo, de madrugada y por lotes.

## Decisiones tomadas en esta versión

- **Tailwind v4 con tokens en `@theme`** en vez de shadcn/ui completo. Los
  componentes son propios y pequeños; la base (Tailwind + utilidades) es la
  misma que pide shadcn/ui, así que añadir sus componentes después no obliga a
  reescribir nada.
- **Gráficas en SVG propio** en vez de Apache ECharts. Son cuatro formas
  sencillas, pesan unos pocos KB y se controla cada detalle de color,
  interacción y tabla equivalente. Si los reportes crecen, ECharts sigue siendo
  la opción del documento.
- **Escritor de PMTiles propio.** El paquete `pmtiles` de npm solo lee y el
  escritor oficial es un binario de Go; implementarlo deja el pipeline del
  mapa corriendo con `pnpm`, sin herramientas que instalar aparte. Se valida
  con el lector oficial, que es el que usará el navegador.
- **Estilo de mapa propio** en vez de uno de terceros: el mapa usa los tokens
  del sistema de diseño, así que cambia con el tema y no parece una isla
  visual dentro del panel.
