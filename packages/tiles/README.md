# @tax/tiles — el mapa de Paipa

Genera `apps/admin/public/tiles/paipa.pmtiles`: un archivo estático con el
mapa de Paipa y sus veredas, hecho a partir de OpenStreetMap.

```bash
pnpm build:tiles
```

Tarda unos minutos —casi todo esperando a Overpass— y produce unos 3 MB.
Luego:

```bash
pnpm --filter @tax/tiles verify
```

## Por qué un archivo y no un servidor de teselas

Es el ADR-08. Un servidor de rutas costaría cerca de un gigabyte de RAM en un
VPS compartido donde el presupuesto entero del proyecto es uno; un proveedor
de mapas cobraría por consulta. Un archivo estático lo sirve el mismo
contenedor de la API, el navegador lo cachea y pide por rangos solo los
pedazos que necesita: cero CPU por mapa dibujado y cero coste variable.

Se regenera a mano, cuando interese refrescar los datos. No es parte del
despliegue: cambia unas pocas veces al año.

## Cómo está hecho

1. **Overpass** da los datos de OSM del recuadro de Paipa, una consulta por
   capa. Es un servicio gratuito y compartido que se satura a diario, así que
   hay reintentos con espera creciente sobre varias instancias y una caché en
   disco (`.cache/`) para no volver a pedir lo que ya llegó.
2. **geojson-vt** corta cada capa en azulejos de los niveles 9 a 15.
3. **vt-pbf** los serializa a MVT.
4. **`src/pmtiles.ts`** los empaqueta en un archivo PMTiles v3.

### El escritor es propio

El paquete `pmtiles` de npm solo lee; el escritor oficial es un binario de Go.
Como el formato está especificado y el archivo es pequeño, se implementó aquí:
el pipeline entero corre con `pnpm`, sin instalar herramientas aparte en cada
máquina ni en CI.

`verify` lo comprueba con el lector oficial —el mismo que usará el navegador—,
porque un archivo mal escrito no da error: da un mapa en blanco.

## Capas

| Capa | Contiene |
| --- | --- |
| `roads` | Vías, menos peatonales y escaleras; con `name` y `ref` |
| `water` | Lago Sochagota, ríos y quebradas |
| `landuse` | Residencial, cultivos, bosque, parques |
| `buildings` | Huellas de edificio, visibles desde z15 |
| `places` | Veredas, barrios y puntos de referencia (hospital, colegios, terminal) |

El estilo que las pinta está en `apps/admin/src/map/style.ts` y usa los
tokens del sistema de diseño, no una paleta de terceros: terreno y agua llevan
los colores de mapa de la marca, como el resto del panel.

## Atribución

Los datos son de OpenStreetMap, bajo ODbL. **La atribución
«© OpenStreetMap» es obligatoria** allí donde se muestre el mapa (§9.4); va en
los metadatos del archivo y la pinta MapLibre en la esquina.

## Trampas que ya costaron tiempo

- **No todas las instancias de Overpass sirven el mundo entero.**
  `overpass.osm.ch` solo indexa Suiza y responde 200 con cero elementos: un
  vacío que parece un éxito. Por eso una respuesta vacía se trata como fallo
  y solo se cachea lo que trajo datos.
- **MapLibre no entiende `oklch()`.** Los tokens del diseño están en ese
  espacio y hay que convertirlos a sRGB antes de montarlos en el estilo; leer
  `fillStyle` después de asignarlo no convierte nada, hay que rasterizar un
  píxel y leerlo.
- **Vite y el worker de MapLibre.** Pre-empaquetar `maplibre-gl` rompe la URL
  de su worker; va en `optimizeDeps.exclude`.
