import { randomInt } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { hashSecret } from '../common/crypto';
import { leerListadoMaestro, type PersonaDelListado } from '../modules/fleet/listado-maestro';

/**
 * Convierte el listado maestro en un script SQL para ejecutarlo desde un
 * cliente de PostgreSQL (DBeaver, pgAdmin, psql), sin pasar por la API.
 *
 * Hace lo mismo que `importar-listado-maestro`, con tres diferencias que
 * impone Postgres:
 *  - Los PIN se sortean y se pasan por Argon2 aquí, porque Postgres no tiene
 *    Argon2; el script los trae escritos y los muestra al final. Por eso el
 *    archivo es tan delicado como la lista de PIN.
 *  - La huella de la cédula (HMAC-SHA256 con la ENCRYPTION_KEY) la calcula
 *    Postgres con `sha256()`. La clave la pega quien ejecuta el script; nunca
 *    pasa por este generador.
 *  - La cédula cifrada queda vacía: la app cifra con AES-GCM y Postgres no lo
 *    tiene. Con la huella basta para reconocer a cada persona; si se quiere la
 *    cédula cifrada, una pasada de `importar-listado-maestro --aplicar` la
 *    completa.
 *
 *   node dist/cli/generar-sql-listado-maestro.js "Listado Maestro.xlsx" carga.sql
 */

const lit = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? 'null' : `'${v.replace(/'/g, "''")}'`);
const num = (v: number | null | undefined) => (v === null || v === undefined ? 'null' : String(v));

/**
 * El nombre del archivo va dentro de una cadena SQL, de un `format()` y del
 * JSON de la bitácora: sin comillas, barras, `%` ni caracteres de control,
 * que habría que escapar distinto en cada uno.
 */
const seguroEnJson = (texto: string) => texto.replace(/["'%\\\u0000-\u001f]/g, '');

async function main(): Promise<void> {
  const [entrada, salida] = process.argv.slice(2);
  if (!entrada || !salida) {
    console.error('Uso: generar-sql-listado-maestro.js <archivo.xlsx> <salida.sql>');
    process.exitCode = 1;
    return;
  }

  const listado = await leerListadoMaestro(readFileSync(entrada));
  if (listado.errores.length) {
    console.error(`No se puede generar:\n- ${listado.errores.join('\n- ')}`);
    process.exitCode = 1;
    return;
  }

  /* Las personas en el orden en que recibirán código: por móvil, el conductor primero. */
  const moviles = [...listado.moviles].sort((a, b) => a.interno.localeCompare(b.interno));
  const personas = new Map<string, PersonaDelListado & { orden: number }>();
  const vinculos: { interno: string; cedula: string; rol: 'conductor' | 'relevador' }[] = [];
  for (const m of moviles) {
    const conRol = [
      ...(m.conductor ? [{ p: m.conductor, rol: 'conductor' as const }] : []),
      ...m.relevadores.map((p) => ({ p, rol: 'relevador' as const })),
    ];
    for (const { p, rol } of conRol) {
      const ya = personas.get(p.cedula);
      if (ya) {
        ya.celular ??= p.celular;
        ya.licenciaVence ??= p.licenciaVence;
        ya.restriccion ??= p.restriccion;
      } else {
        personas.set(p.cedula, { ...p, orden: personas.size + 1 });
      }
      vinculos.push({ interno: m.interno, cedula: p.cedula, rol });
    }
  }

  const conPin: { cedula: string; pin: string; hash: string }[] = [];
  for (const cedula of personas.keys()) {
    const pin = String(randomInt(1000, 10000));
    conPin.push({ cedula, pin, hash: await hashSecret(pin) });
  }
  const pinDe = new Map(conPin.map((p) => [p.cedula, p]));
  const archivo = seguroEnJson(basename(entrada));
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());

  const sql = `-- =============================================================================
-- Carga del listado maestro · Tax Turístico
-- Generado el ${hoy} desde «${archivo}»
-- ${moviles.length} móviles · ${personas.size} conductores y relevadores · ${vinculos.length} vínculos
-- =============================================================================
--
-- ANTES DE EJECUTAR
--   1. En la línea marcada con >>>, pega la ENCRYPTION_KEY de tax-api
--      (Dokploy › tax-api › Environment). Sin ella no se ejecuta nada.
--   2. Ejecútalo ENTERO como script, en la base «tax»:
--      DBeaver: Alt+X · pgAdmin: F5 · psql: \\i ruta/al/archivo.sql
--   3. Al final salen el resumen, los PIN de los nuevos y lo que está en la
--      base pero no en el Excel. Todo va en una sola transacción.
--      PARA PROBAR SIN GUARDAR NADA: antes de ejecutar, cambia el COMMIT de la
--      última línea por ROLLBACK. Si el resumen cuadra, vuelve a poner COMMIT
--      y ejecútalo de verdad (los PIN serán los mismos).
--
-- Se puede ejecutar otra vez, o con el listado de otro mes generado igual: lo
-- que ya está se actualiza, nada se duplica, y quien ya existía conserva su
-- código y su PIN. Los códigos nuevos son consecutivos desde 101, saltando los
-- que ya estén usados.
--
-- ESTE ARCHIVO TRAE LOS PIN de los conductores nuevos y datos personales:
-- cuando los entregues, bórralo.
-- =============================================================================

begin;

-- >>> Pega aquí la ENCRYPTION_KEY (64 caracteres hexadecimales, entre las comillas):
select set_config('tax.clave', 'PEGA_AQUI_LA_ENCRYPTION_KEY', true) is not null as "Clave puesta";

do $$
begin
  if current_setting('tax.clave') !~ '^[0-9a-f]{64}$' then
    raise exception 'Falta la ENCRYPTION_KEY de tax-api en la línea marcada con >>> (64 caracteres hexadecimales)';
  end if;
end $$;

-- La huella de la cédula: HMAC-SHA256 con la ENCRYPTION_KEY, el mismo cálculo
-- que hace la API, para que reconozca a estas personas en cargas futuras.
create function pg_temp.huella(cedula text) returns text language plpgsql as $$
declare
  clave bytea := decode(current_setting('tax.clave'), 'hex');
  bloque bytea := clave || decode(repeat('00', 64 - length(clave)), 'hex');
  ipad bytea := bloque;
  opad bytea := bloque;
begin
  for i in 0..63 loop
    ipad := set_byte(ipad, i, get_byte(bloque, i) # 54);
    opad := set_byte(opad, i, get_byte(bloque, i) # 92);
  end loop;
  return encode(sha256(opad || sha256(ipad || convert_to('documento:' || cedula, 'UTF8'))), 'hex');
end $$;

/* ------------------------------------------------------------- los datos --- */

create temp table carga_moviles (
  interno text primary key, placa text not null, activo boolean not null, capacidad int not null,
  marca text, modelo int, combustible text, motor text, chasis text, peso_kg int, matricula date, propietario text
) on commit drop;

insert into carga_moviles values
${moviles
  .map(
    (m) =>
      `  (${lit(m.interno)}, ${lit(m.placa)}, ${m.activo}, ${m.capacidad}, ${lit(m.marca)}, ${num(m.modelo)}, ${lit(m.combustible)}, ${lit(m.motor)}, ${lit(m.chasis)}, ${num(m.pesoKg)}, ${lit(m.matricula)}, ${lit(m.propietario?.nombre)})`,
  )
  .join(',\n')};

create temp table carga_personas (
  cedula text primary key, orden int not null, nombre text not null, celular text, licencia date,
  restriccion text, pin text not null, pin_hash text not null, huella text, nuevo boolean
) on commit drop;

insert into carga_personas (cedula, orden, nombre, celular, licencia, restriccion, pin, pin_hash) values
${[...personas.values()]
  .map((p) => {
    const pin = pinDe.get(p.cedula)!;
    return `  (${lit(p.cedula)}, ${p.orden}, ${lit(p.nombre)}, ${lit(p.celular)}, ${lit(p.licenciaVence)}, ${lit(p.restriccion)}, ${lit(pin.pin)}, ${lit(pin.hash)})`;
  })
  .join(',\n')};

update carga_personas set huella = pg_temp.huella(cedula);

create temp table carga_vinculos (interno text not null, cedula text not null, rol text not null) on commit drop;

insert into carga_vinculos values
${vinculos.map((v) => `  (${lit(v.interno)}, ${lit(v.cedula)}, ${lit(v.rol)})`).join(',\n')};

create temp table carga_informe (orden int, concepto text, cantidad int) on commit drop;

/* ------------------------------------------------------------- los móviles --- */

-- Una placa del Excel que en la base ya es de OTRO móvil no se adivina: se para.
do $$
declare fila record;
begin
  select m.interno, m.placa, v.internal_number as otro into fila
    from carga_moviles m join vehicles v on v.plate = m.placa
   where v.internal_number is not null and v.internal_number <> m.interno
   limit 1;
  if found then
    raise exception 'El móvil % trae la placa %, que en la base es del móvil %. Corrige el Excel o el vehículo antes de cargar.',
      fila.interno, fila.placa, fila.otro;
  end if;
end $$;

-- Un vehículo creado a mano, sin número interno, se reconoce por su placa.
update vehicles v set internal_number = m.interno, updated_at = now()
  from carga_moviles m
 where v.plate = m.placa and v.internal_number is null
   and not exists (select 1 from vehicles x where x.internal_number = m.interno);

with escritos as (
  insert into vehicles as v (id, plate, internal_number, type, capacity, active, brand, model_year, fuel,
                             engine_number, chassis_number, weight_kg, registered_on, owner_name)
  select gen_random_uuid(), placa, interno, 'sedan', capacidad, activo, marca, modelo, combustible,
         motor, chasis, peso_kg, matricula, propietario
    from carga_moviles
  on conflict (internal_number) do update set
    plate = excluded.plate, capacity = excluded.capacity, active = excluded.active, brand = excluded.brand,
    model_year = excluded.model_year, fuel = excluded.fuel, engine_number = excluded.engine_number,
    chassis_number = excluded.chassis_number, weight_kg = excluded.weight_kg,
    registered_on = excluded.registered_on, owner_name = excluded.owner_name, updated_at = now()
  where (v.plate, v.capacity, v.active, v.brand, v.model_year, v.fuel, v.engine_number, v.chassis_number,
         v.weight_kg, v.registered_on, v.owner_name)
        is distinct from
        (excluded.plate, excluded.capacity, excluded.active, excluded.brand, excluded.model_year, excluded.fuel,
         excluded.engine_number, excluded.chassis_number, excluded.weight_kg, excluded.registered_on, excluded.owner_name)
  returning (xmax = 0) as nuevo
)
insert into carga_informe
select 1, 'Móviles nuevos', count(*) filter (where nuevo) from escritos
union all
select 2, 'Móviles actualizados', count(*) filter (where not nuevo) from escritos;

insert into carga_informe
select 3, 'Móviles sin cambios', count(*) - coalesce((select sum(cantidad) from carga_informe where orden in (1, 2)), 0)
  from carga_moviles;
insert into carga_informe select 3, 'Móviles inactivos (no abren turno)', count(*) from carga_moviles where not activo;

/* ------------------------------------------------------ conductores y relevadores --- */

-- Creados a mano en el panel, sin cédula: el celular dice que son ellos.
update drivers d set document_hash = p.huella, updated_at = now()
  from carga_personas p
 where d.document_hash is null and p.celular is not null and d.phone = p.celular
   and not exists (select 1 from drivers x where x.document_hash = p.huella);

update carga_personas p set nuevo = not exists (select 1 from drivers d where d.document_hash = p.huella);

-- Los que ya estaban: nombre, licencia y restricción del Excel; el celular
-- solo si el Excel lo trae, para no borrar uno que ya se conocía.
with escritos as (
  update drivers d set
    name = p.nombre, phone = coalesce(p.celular, d.phone), license_expires_on = p.licencia,
    license_restriction = p.restriccion, updated_at = now()
    from carga_personas p
   where d.document_hash = p.huella and not p.nuevo
     and (d.name, d.phone, d.license_expires_on, d.license_restriction)
         is distinct from (p.nombre, coalesce(p.celular, d.phone), p.licencia, p.restriccion)
  returning 1
)
insert into carga_informe select 5, 'Conductores actualizados', count(*) from escritos;

-- Los nuevos, con el siguiente código libre desde 101.
with nuevos as (
  select p.*, row_number() over (order by p.orden) as n from carga_personas p where p.nuevo
),
libres as (
  select c::text as codigo, row_number() over (order by c) as n
    from generate_series(101, 99999) c
   where not exists (select 1 from drivers d where d.code = c::text)
),
escritos as (
  insert into drivers (id, code, name, phone, document_hash, license_expires_on, license_restriction, pin_hash)
  select gen_random_uuid(), l.codigo, n.nombre, n.celular, n.huella, n.licencia, n.restriccion, n.pin_hash
    from nuevos n join libres l using (n)
  returning 1
)
insert into carga_informe select 4, 'Conductores nuevos', count(*) from escritos;

insert into carga_informe
select 6, 'Conductores sin cambios', count(*) - coalesce((select cantidad from carga_informe where orden = 5), 0)
  from carga_personas where not nuevo;

/* ------------------------------------------------------ quién maneja cada móvil --- */

create temp table carga_deseados on commit drop as
select distinct on (v.id, d.id) v.id as vehicle_id, d.id as driver_id, c.rol
  from carga_vinculos c
  join carga_personas p on p.cedula = c.cedula
  join vehicles v on v.internal_number = c.interno
  join drivers d on d.document_hash = p.huella
 order by v.id, d.id, (c.rol = 'conductor') desc;

with quitados as (
  delete from vehicle_drivers vd
   using vehicles v
   where v.id = vd.vehicle_id and v.internal_number in (select interno from carga_moviles)
     and not exists (select 1 from carga_deseados x where x.vehicle_id = vd.vehicle_id and x.driver_id = vd.driver_id)
  returning 1
)
insert into carga_informe select 9, 'Vínculos quitados', count(*) from quitados;

with cambiados as (
  update vehicle_drivers vd set role = x.rol
    from carga_deseados x
   where x.vehicle_id = vd.vehicle_id and x.driver_id = vd.driver_id and vd.role <> x.rol
  returning 1
)
insert into carga_informe select 8, 'Vínculos con otro rol', count(*) from cambiados;

with nuevos as (
  insert into vehicle_drivers (id, vehicle_id, driver_id, role)
  select gen_random_uuid(), vehicle_id, driver_id, rol from carga_deseados
  on conflict (vehicle_id, driver_id) do nothing
  returning 1
)
insert into carga_informe select 7, 'Vínculos nuevos', count(*) from nuevos;

/* --------------------------------------------------------------- la bitácora --- */

-- Una entrada con lo que hizo la carga: números, ni cédulas ni PIN. La cadena
-- de la bitácora es un hash de cada fila con la anterior; se calcula igual que
-- la API, con las claves en el orden en que las guarda jsonb (por largo).
do $$
declare
  previo text;
  momento timestamptz := date_trunc('milliseconds', clock_timestamp());
  texto text;
begin
  perform pg_advisory_xact_lock(47130001);
  select hash into previo from audit_log order by seq desc limit 1;
  previo := coalesce(previo, repeat('0', 64));
  texto := format(
    '{"prevHash":"%s","actorName":"Carga del listado maestro (SQL)","role":"sistema","action":"Cargó el listado maestro","entity":"drivers","entityId":"${archivo}","before":null,"after":{"moviles":%s,"vinculos":%s,"conductores":%s},"at":"%s"}',
    previo,
    (select count(*) from carga_moviles),
    (select count(*) from carga_deseados),
    (select count(*) from carga_personas),
    to_char(momento at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  insert into audit_log (actor_name, role, action, entity, entity_id, before, after, at, prev_hash, hash)
  values ('Carga del listado maestro (SQL)', 'sistema', 'Cargó el listado maestro', 'drivers', '${archivo}',
          null, (texto::jsonb) -> 'after', momento, previo, encode(sha256(convert_to(texto, 'UTF8')), 'hex'));
end $$;

/* ---------------------------------------------------------------- resultados --- */

-- 1. Resumen
select concepto as "Qué", cantidad as "Cuántos" from carga_informe order by orden;

-- 2. Los PIN de los conductores NUEVOS. No se vuelven a ver: expórtalos ahora.
--    Cada conductor entra a la PWA con su código, la placa de su móvil y su PIN.
select d.code as "Código", d.name as "Nombre",
       string_agg(c.interno || case when c.rol = 'relevador' then ' (relevador)' else '' end || ' · ' || m.placa, ' / '
                  order by c.interno) as "Móvil",
       p.pin as "PIN",
       case when d.phone is null then 'Sin celular' else '' end as "Aviso"
  from carga_personas p
  join drivers d on d.document_hash = p.huella
  join carga_vinculos c on c.cedula = p.cedula
  join carga_moviles m on m.interno = c.interno
 where p.nuevo
 group by d.code, d.name, p.pin, d.phone
 order by d.code::int;

-- 3. En la base pero no en el Excel. Solo se informa: no se toca a nadie.
select 'Conductor' as "Qué", d.code as "Código o móvil", d.name as "Nombre o placa"
  from drivers d
 where d.active and not d.es_prueba
   and (d.document_hash is null or d.document_hash not in (select huella from carga_personas))
union all
select 'Móvil', coalesce(v.internal_number, '—'), v.plate
  from vehicles v
 where v.active and (v.internal_number is null or v.internal_number not in (select interno from carga_moviles))
 order by 1, 2;

-- ¿Todo bien? Deja COMMIT. ¿Era una prueba? Cámbialo por ROLLBACK y no se guarda nada.
commit;
`;

  writeFileSync(salida, sql, { encoding: 'utf8', mode: 0o600 });
  console.log(`Script listo: ${salida}`);
  console.log(`  ${moviles.length} móviles · ${personas.size} personas · ${vinculos.length} vínculos`);
  if (listado.avisos.length) {
    console.log(`\nAvisos del Excel (${listado.avisos.length}):`);
    for (const aviso of listado.avisos) console.log(`  · ${aviso}`);
  }
  console.log('\nEl archivo trae los PIN de los conductores nuevos: trátalo como la lista de PIN.');
}

main().catch((error: unknown) => {
  console.error('No se pudo generar el script:');
  console.error(error);
  process.exitCode = 1;
});
