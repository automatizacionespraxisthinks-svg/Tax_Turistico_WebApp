import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { nucleoDe, nuevoLugarSchema } from '@tax/shared';

/**
 * Convierte un GeoJSON de puntos de referencia en un script SQL que carga el
 * catálogo de lugares, para ejecutarlo desde un cliente de PostgreSQL
 * (DBeaver, pgAdmin, psql) sin pasar por la API.
 *
 * Cumple las mismas reglas que el panel al crear un lugar:
 *  - nombre de 3 a 80 caracteres, hasta 20 palabras clave de 3 a 60;
 *  - ningún nombre ni palabra clave en dos lugares a la vez, contando los que
 *    ya están en la base;
 *  - el lugar tiene que caer dentro de una zona activa, y toma de ella el
 *    tipo y la zona. Las zonas las mira el script en la base donde se
 *    ejecuta, no aquí: las de producción no son las de este equipo.
 *
 * Lo que no cumple, no se carga y lo dice al final. Se puede ejecutar otra
 * vez: un lugar con el mismo nombre se actualiza (punto, palabras clave y
 * zona) en vez de duplicarse.
 *
 * Lo único que no hace como el panel es la bitácora: su hash encadenado lo
 * calcula la API y Postgres no puede imitarlo.
 *
 * Del GeoJSON lee de cada punto `nombre` (o `name`), `alias` (o `aliases`)
 * y la geometría. El resto de propiedades se ignora.
 *
 *   node dist/cli/generar-sql-lugares.js puntos.geojson carga-lugares.sql
 */

interface Punto {
  type: 'Feature';
  geometry: { type: string; coordinates: [number, number] };
  properties: Record<string, unknown>;
}

const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

function main(): void {
  const [entrada, salida] = process.argv.slice(2);
  if (!entrada || !salida) {
    console.error('Uso: generar-sql-lugares.js <puntos.geojson> <salida.sql>');
    process.exitCode = 1;
    return;
  }

  const geo = JSON.parse(readFileSync(entrada, 'utf8')) as { features?: Punto[] };
  const errores: string[] = [];
  const lugares: { nombre: string; aliases: string[]; lat: number; lng: number }[] = [];
  const duenas = new Map<string, string>();

  (geo.features ?? []).forEach((f, i) => {
    const p = f.properties ?? {};
    const etiqueta = String(p.id ?? p.nombre ?? `punto ${i + 1}`);
    if (f.geometry?.type !== 'Point') {
      errores.push(`${etiqueta}: no es un punto`);
      return;
    }
    const [lng, lat] = f.geometry.coordinates;
    const valido = nuevoLugarSchema.safeParse({
      name: p.nombre ?? p.name,
      aliases: p.alias ?? p.aliases ?? [],
      point: { lat, lng },
    });
    if (!valido.success) {
      errores.push(`${etiqueta}: ${valido.error.issues.map((x) => x.message).join('; ')}`);
      return;
    }
    const { name, aliases } = valido.data;
    for (const palabra of [name, ...aliases]) {
      const clave = nucleoDe(palabra);
      const otra = duenas.get(clave);
      if (otra && otra !== name) errores.push(`«${palabra}» está en «${otra}» y en «${name}»`);
      duenas.set(clave, name);
    }
    lugares.push({ nombre: name, aliases, lat, lng });
  });

  if (errores.length) {
    console.error(`No se puede generar:\n- ${errores.join('\n- ')}`);
    process.exitCode = 1;
    return;
  }

  const hoy = new Date().toISOString().slice(0, 10);
  const filas = lugares
    .map(
      (l, i) =>
        `  (${i + 1}, ${lit(l.nombre)}, ${lit(JSON.stringify(l.aliases))}::jsonb, ${l.lat}, ${l.lng})`,
    )
    .join(',\n');

  const sql = `-- =============================================================================
-- Catálogo de lugares de Tax Turístico
-- Generado el ${hoy} desde «${basename(entrada).replace(/[\r\n]/g, '')}» · ${lugares.length} lugares
-- =============================================================================
--
-- ANTES DE EJECUTAR
--   1. Ejecútalo ENTERO como script, en la base «tax»:
--      DBeaver: Alt+X · pgAdmin: F5 · psql: \\i ruta/al/archivo.sql
--   2. Al final sale qué pasó con cada lugar. Todo va en una sola transacción.
--      PARA PROBAR SIN GUARDAR NADA: cambia el COMMIT de la última línea por
--      ROLLBACK. Si el resultado cuadra, vuelve a poner COMMIT y ejecútalo.
--
-- Cada lugar entra en la zona donde cae, con el tipo de esa zona. Si no cae en
-- ninguna zona activa, NO se carga: el panel tampoco lo deja, porque allí no se
-- despacha. Crea la zona que falte y vuelve a ejecutar el script.
--
-- Se puede ejecutar otra vez: un lugar con el mismo nombre se actualiza en vez
-- de duplicarse. Si una palabra clave ya es de otro lugar de la base, ese lugar
-- no se carga y el resultado dice cuál choca.
-- =============================================================================

begin;

-- Igual que nucleoDe() de la app: minúsculas, sin tildes ni signos, y sin
-- artículos ni preposiciones («la terminal» y «terminal» son la misma).
create function pg_temp.clave(t text) returns text language sql immutable as $$
  select btrim(regexp_replace(regexp_replace(
    ' ' || regexp_replace(
      translate(lower(t), 'áàäâãåāéèëêēíìïîīóòöôõōúùüûūñç', 'aaaaaaaeeeeeiiiiioooooouuuuunc'),
      '[^a-z0-9]+', ' ', 'g') || ' ',
    ' ((el|la|los|las|lo|al|del|de|a|en|y|un|una|unos|unas) )+', ' ', 'g'),
    ' +', ' ', 'g'))
$$;

-- Si un punto cae dentro del polígono de una zona. Mismo cálculo (rayo) que
-- la app; el polígono es GeoJSON, en [lng, lat]. El CASE anidado no es
-- adorno: garantiza que no se divida por cero en una arista horizontal.
create function pg_temp.en_zona(lat float8, lng float8, poligono jsonb) returns boolean language sql immutable as $$
  select coalesce(sum(case when (y1 > lat) <> (y2 > lat)
                           then case when lng < (x2 - x1) * (lat - y1) / (y2 - y1) + x1 then 1 else 0 end
                           else 0 end) % 2 = 1, false)
    from (
      select (a.p->>0)::float8 x1, (a.p->>1)::float8 y1, (b.p->>0)::float8 x2, (b.p->>1)::float8 y2
        from jsonb_array_elements(poligono->'coordinates'->0) with ordinality a(p, i)
        join jsonb_array_elements(poligono->'coordinates'->0) with ordinality b(p, j) on b.j = a.i + 1
    ) aristas
$$;

create temp table carga_lugares (orden int, nombre text, aliases jsonb, lat float8, lng float8) on commit drop;
insert into carga_lugares values
${filas};

create temp table carga_informe (orden int, lugar text, resultado text, zona text, detalle text) on commit drop;

do $$
declare
  r record;
  zona record;
  existente uuid;
  choque text;
begin
  for r in select * from carga_lugares order by orden loop
    select z.id, z.name, z.kind into zona
      from zones z
     where z.active and pg_temp.en_zona(r.lat, r.lng, z.polygon)
     order by z.created_at
     limit 1;
    if not found then
      insert into carga_informe values (r.orden, r.nombre, 'Fuera de zona', null,
        'No cae en ninguna zona activa: allí no se despacha. No se carga.');
      continue;
    end if;

    select p.id into existente
      from places p
     where pg_temp.clave(p.name) = pg_temp.clave(r.nombre)
     order by p.active desc
     limit 1;

    -- Ninguna palabra (nombre o palabra clave) puede ser de otro lugar activo.
    select p.name into choque
      from places p
      cross join lateral (select p.name as w union all select jsonb_array_elements_text(p.aliases)) suyas
     where p.active
       and (existente is null or p.id <> existente)
       and pg_temp.clave(suyas.w) in (
         select pg_temp.clave(x) from (select r.nombre as x union all select jsonb_array_elements_text(r.aliases)) nuevas
       )
     limit 1;
    if choque is not null then
      insert into carga_informe values (r.orden, r.nombre, 'Choca', zona.name,
        format('Comparte nombre o palabra clave con «%s». No se carga.', choque));
      continue;
    end if;

    if existente is null then
      insert into places (id, name, kind, zone_id, lat, lng, aliases)
      values (gen_random_uuid(), r.nombre, zona.kind, zona.id, r.lat, r.lng, r.aliases);
      insert into carga_informe values (r.orden, r.nombre, 'Nuevo', zona.name, null);
    else
      update places
         set lat = r.lat, lng = r.lng, aliases = r.aliases, zone_id = zona.id, kind = zona.kind, active = true
       where id = existente;
      insert into carga_informe values (r.orden, r.nombre, 'Actualizado', zona.name, null);
    end if;
  end loop;
end $$;

/* ---------------------------------------------------------------- resultados --- */

-- 1. Resumen
select resultado as "Resultado", count(*) as "Lugares" from carga_informe group by resultado order by 1;

-- 2. Lugar por lugar
select orden as "#", lugar as "Lugar", resultado as "Resultado", coalesce(zona, '—') as "Zona",
       coalesce(detalle, '') as "Detalle"
  from carga_informe
 order by case resultado when 'Fuera de zona' then 0 when 'Choca' then 1 else 2 end, orden;

-- 3. El catálogo como queda, por zona
select coalesce(z.name, 'Sin zona') as "Zona", count(*) as "Lugares activos"
  from places p left join zones z on z.id = p.zone_id
 where p.active
 group by z.name
 order by 2 desc;

-- ¿Todo bien? Deja COMMIT. ¿Era una prueba? Cámbialo por ROLLBACK y no se guarda nada.
commit;
`;

  writeFileSync(salida, sql, 'utf8');
  console.log(`Script listo: ${salida}`);
  console.log(`  ${lugares.length} lugares, ${duenas.size} nombres y palabras clave distintos`);
}

main();
