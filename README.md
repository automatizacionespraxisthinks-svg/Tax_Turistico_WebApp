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

## Diseño sobrio, sin marca

La identidad visual está concentrada a propósito. Todo el color vive en
`packages/ui/src/styles/tokens.css`; ningún componente escribe un color a mano.

- **Acento.** Un solo bloque de variables (`--c-accent*`). Cambiar ese bloque
  cambia la marca en las dos apps. Hoy es un azul neutro, deliberadamente
  anónimo: es un marcador de posición, no una propuesta de marca.
- **Superficies y tinta.** Escala neutra con un punto frío. La jerarquía la
  llevan las líneas, no las sombras: las sombras son mínimas y se reservan para
  lo que flota (hojas, avisos, menús).
- **Tonos de estado.** Siete tonos semánticos (`neutral`, `info`, `accent`,
  `progress`, `positive`, `warning`, `critical`), cada uno con tinta, fondo,
  línea y sólido. Los estados de carrera y de conductor se mapean a un tono en
  `packages/shared/src/domain/labels.ts`, así que el color de un estado se
  decide una sola vez.
- **Modo oscuro.** Pasos elegidos para el fondo oscuro, no una inversión
  automática del claro. Sigue al sistema por defecto.
- **Tipografía.** Pila del sistema, sin fuentes de red: cero peticiones y cero
  destello al cargar. Números tabulares en todo dato que se actualiza.
- **Marca de posición.** El glifo de la barra lateral y el icono de la PWA son
  neutros y están pensados para sustituirse por el logo real.
- **Gráficas.** Seis colores de serie en orden fijo, validados para visión
  normal y para daltonismo (deuteranopía y tritanopía) contra la superficie
  clara y la oscura: separación ΔE ≥ 8 entre colores contiguos y contraste
  ≥ 3:1. Nunca se ciclan; una séptima serie se agruparía en «Otras».

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
- **Diez minutos a bordo** (`MIN_DURACION_CARRERA_MIN`): «Finalizar» queda
  bloqueado en la PWA con una cuenta atrás, y la API lo rechaza con
  `RIDE_TOO_SHORT` si alguien se lo salta. La oficina sí puede cerrar antes.
- **Foto del lugar**: el cliente la manda por WhatsApp y n8n la entrega con la
  carrera (`pickupPhotoUrl`) o después (`POST /v1/rides/:id/photo`, el archivo
  o un enlace). El conductor la ve mientras va a recogerlo, la oficina en la
  ficha, y se borra a los 30 días.
- **Al aceptar**, el evento `ride.assigned` lleva `driver: { code, name,
  plate }`, y la carrera guarda el taxi con el que va.
- **Outbox**: estados de entrega, reintentos y cola muerta visibles en
  *Sistema*, con reenvío manual.
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
