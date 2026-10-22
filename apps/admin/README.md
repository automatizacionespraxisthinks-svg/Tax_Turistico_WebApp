# @tax/admin — panel de oficina

## El worker de MapLibre

El mapa necesita un archivo que Vite no emite solo. MapLibre v6 resuelve su
worker en tiempo de ejecución, como hermano de su propio módulo:

```js
const n = new URL('./maplibre-gl-worker.mjs', import.meta.url);
```

Esa cadena se construye al vuelo, así que Rollup no puede detectarla y nunca
copia el archivo. **En desarrollo no se nota**, porque
`optimizeDeps.exclude: ['maplibre-gl']` hace que Vite sirva el paquete desde
`node_modules`, donde el hermano existe. Compilado, el paquete vive en
`/assets/` y pide `/assets/maplibre-gl-worker.mjs`, que no está: la petición
cae en el `index.html` del SPA, llega como `text/html` y el navegador la
rechaza por tipo MIME.

El síntoma engaña: **mapa en blanco con los controles y la atribución
intactos**, las teselas descargándose con 206 y un único `Worker failed to
load` en la consola. Parece un problema del servidor y no lo es.

Lo resuelve el plugin `copiarWorkerDeMapLibre` de `vite.config.ts`, que emite
el archivo con su nombre exacto y sin hash. Lleva además una comprobación: si
una versión futura de MapLibre renombra el worker, la compilación falla en vez
de publicar un mapa vacío.

**Y no basta con emitirlo.** El `mime.types` de nginx solo mapea `js`, no
`mjs`, así que el worker salía como `application/octet-stream` y el navegador
lo rechazaba igual: un worker de módulo exige un tipo de JavaScript. Mismo
mapa en blanco, otra causa. `nginx.conf` le pone el tipo a mano con
`types { } default_type text/javascript`, el mismo recurso que la PWA del
conductor usa para su `.webmanifest`.

Esto no se ve con `vite preview`, que sí conoce `.mjs`. Para comprobar un
cambio que toque cómo se sirven los archivos hay que levantar el nginx de
verdad:

```bash
docker run --rm -p 8099:80 -v "$PWD/apps/admin/nginx.conf:/etc/nginx/conf.d/default.conf:ro" -v "$PWD/apps/admin/dist:/usr/share/nginx/html:ro" nginx:1.29-alpine
```

y mirar el `Content-Type` de lo que devuelve, no solo el código 200.

## Las tipografías del mapa

Están en `public/fonts`, servidas por nosotros. El estilo apuntaba a
`fonts.openmaptiles.org`, que hoy responde **200 con una página HTML**:
MapLibre lee ese HTML como protobuf, falla con `Unimplemented type: 4` y
dibuja cada letra con el canvas del navegador. Son 61 avisos por carga, otra
letra en las etiquetas y una dependencia de un tercero caído.

Hay dos rangos, que son los que piden los nombres de Paipa: `0-255` trae el
latino con acentos y eñes, `256-511` el latino extendido. Para añadir otro,
basta con dejar el `.pbf` junto a los demás; el nombre del archivo es el rango.

`nginx.conf` los sirve con `try_files $uri =404` **a propósito**. Si cayeran en
el `try_files` del SPA, un rango que faltara devolvería `index.html` y
tendríamos otra vez HTML donde se espera un protobuf — el mismo fallo
silencioso del worker. Un 404 se ve; un HTML disfrazado, no.
