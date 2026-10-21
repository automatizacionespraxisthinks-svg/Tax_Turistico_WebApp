import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import * as schema from '../db/schema';
import { constraintName, isUniqueViolation } from '../common/pg-errors';

/**
 * Exclusividad de la carrera (RF-23) con 50 conductores concurrentes.
 *
 * Es la prueba que nombra §10.2 y la única que de verdad valida ADR-09: la
 * garantía no está en el código de la aplicación sino en la sentencia, así
 * que se ejerce la sentencia contra PostgreSQL de verdad, no contra un doble.
 *
 * Necesita la base de desarrollo levantada:
 *   pnpm db:up && pnpm --filter @tax/api db:migrate
 */

const DRIVER_COUNT = 50;

let pool: Pool;
let db: NodePgDatabase<typeof schema>;

/** La misma sentencia atómica que usa DispatchService.accept. */
async function accept(rideId: string, driverId: string): Promise<boolean> {
  const result = await db.execute<{ id: string }>(sql`
    update rides
       set status = 'ASSIGNED',
           driver_id = ${driverId},
           assigned_at = now(),
           version = version + 1
     where id = ${rideId}
       and status = 'NOTIFIED'
       and exists (
         select 1 from ride_offers o
          where o.ride_id = ${rideId}
            and o.driver_id = ${driverId}
            and o.expires_at > now()
            and o.revoked_at is null
            and o.response = 'pending'
       )
    returning id
  `);
  return result.rows.length === 1;
}

describe('exclusividad de la carrera', () => {
  let zoneId: string;
  let customerId: string;
  const driverIds: string[] = [];

  beforeAll(async () => {
    pool = new Pool({
      connectionString:
        process.env.DATABASE_URL ?? 'postgres://tax:tax_dev_password@localhost:55432/tax',
      // Más conexiones que conductores para que la concurrencia sea real y no
      // una cola detrás de un pool de uno.
      max: 20,
    });
    db = drizzle(pool, { schema, casing: 'snake_case' });

    const [zone] = await db
      .insert(schema.zones)
      .values({
        id: uuidv7(),
        name: `Zona de prueba ${Date.now()}`,
        kind: 'urbano',
        polygon: {
          type: 'Polygon',
          coordinates: [
            [
              [-73.13, 5.79],
              [-73.1, 5.79],
              [-73.1, 5.77],
              [-73.13, 5.77],
              [-73.13, 5.79],
            ],
          ],
        },
        tortuosity: 1.25,
        waves: [{ wave: 1, radiusKm: 2, candidates: 3, timeoutSeconds: 45 }],
      })
      .returning();
    zoneId = zone!.id;

    const [customer] = await db
      .insert(schema.customers)
      .values({ id: uuidv7(), phone: `+57300${Date.now().toString().slice(-7)}` })
      .returning();
    customerId = customer!.id;

    for (let i = 0; i < DRIVER_COUNT; i++) {
      const [driver] = await db
        .insert(schema.drivers)
        .values({
          id: uuidv7(),
          code: `T${Date.now().toString().slice(-6)}${i}`,
          name: `Conductor de prueba ${i}`,
          phone: `+5731000000${i}`,
          pinHash: 'no-se-usa-en-esta-prueba',
          status: 'AVAILABLE',
        })
        .returning();
      driverIds.push(driver!.id);
    }
  });

  afterAll(async () => {
    // Las pruebas corren contra la base de desarrollo, así que se llevan lo
    // suyo: dejar 50 conductores y cientos de ofertas sueltas ensucia el
    // panel de quien esté trabajando en la misma máquina.
    await db.execute(sql`delete from ride_offers where ride_id in (
      select id from rides where code like 'R-TEST-%')`);
    await db.execute(sql`delete from ride_status_history where ride_id in (
      select id from rides where code like 'R-TEST-%')`);
    await db.execute(sql`delete from rides where code like 'R-TEST-%'`);
    await db.execute(sql`delete from drivers where name like 'Conductor de prueba %'`);
    await db.execute(sql`delete from customers where id = ${customerId}`);
    await db.execute(sql`delete from zones where id = ${zoneId}`);

    await pool.end();
  });

  async function newRideWithOffers(): Promise<string> {
    const rideId = uuidv7();
    const sequence = await db.execute<{ next: string }>(
      sql`select nextval('ride_code_seq') as next`,
    );

    await db.insert(schema.rides).values({
      id: rideId,
      code: `R-TEST-${sequence.rows[0]!.next}`,
      status: 'NOTIFIED',
      customerId,
      pickupText: 'Punto de prueba',
      pickupLat: 5.78,
      pickupLng: -73.115,
      zoneId,
      fareEstimate: 7000,
      fareRuleVersion: 'prueba',
      // Sin esto, el índice de una sola carrera activa por cliente impediría
      // crear varias carreras de prueba para el mismo teléfono.
      allowsConcurrent: true,
    });

    const expiresAt = new Date(Date.now() + 60_000);
    await db.insert(schema.rideOffers).values(
      driverIds.map((driverId) => ({
        id: uuidv7(),
        rideId,
        driverId,
        wave: 1,
        distanceKm: 1,
        etaMinutes: 3,
        expiresAt,
        response: 'pending' as const,
      })),
    );

    return rideId;
  }

  it(`solo un conductor gana cuando ${DRIVER_COUNT} aceptan a la vez`, async () => {
    const rideId = await newRideWithOffers();

    const results = await Promise.all(driverIds.map((driverId) => accept(rideId, driverId)));

    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);

    const [ride] = await db
      .select()
      .from(schema.rides)
      .where(sql`id = ${rideId}`);

    expect(ride!.status).toBe('ASSIGNED');
    expect(ride!.driverId).not.toBeNull();
    expect(ride!.version).toBe(2);
  }, 30_000);

  it('repetir la aceptación del ganador no vuelve a cambiar la carrera', async () => {
    // Un conductor propio: el de la prueba anterior ya tiene carrera activa y
    // el índice parcial lo rechazaría por otro motivo.
    const driverId = driverIds[10]!;
    const rideId = await newRideWithOffers();

    const first = await accept(rideId, driverId);
    const second = await accept(rideId, driverId);

    expect(first).toBe(true);
    // El estado ya no es NOTIFIED, así que la condición del UPDATE no se
    // cumple: un reintento del cliente no incrementa la versión ni dispara
    // un segundo evento.
    expect(second).toBe(false);
  });

  it('una oferta vencida no permite aceptar', async () => {
    const rideId = await newRideWithOffers();

    await db.execute(
      sql`update ride_offers set expires_at = now() - interval '1 second' where ride_id = ${rideId}`,
    );

    expect(await accept(rideId, driverIds[11]!)).toBe(false);
  });

  it('una oferta revocada no permite aceptar', async () => {
    const rideId = await newRideWithOffers();

    await db.execute(
      sql`update ride_offers set revoked_at = now(), response = 'revoked' where ride_id = ${rideId}`,
    );

    expect(await accept(rideId, driverIds[12]!)).toBe(false);
  });

  it('el índice parcial impide dos carreras activas para el mismo conductor', async () => {
    const driverId = driverIds[13]!;
    const first = await newRideWithOffers();
    const second = await newRideWithOffers();

    expect(await accept(first, driverId)).toBe(true);

    // Respaldo estructural de §5.1: aunque la lógica dejara pasar la segunda
    // asignación, la base la rechaza.
    //
    // Se comprueba con el mismo helper que usa la API, no con el texto del
    // error: Drizzle envuelve el error de pg y el nombre de la restricción
    // queda en `cause`, no en el mensaje. Dar por buena una coincidencia de
    // texto fue justo el fallo que devolvía 500 en vez del código estable.
    let thrown: unknown;
    try {
      await accept(second, driverId);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    expect(isUniqueViolation(thrown)).toBe(true);
    expect(constraintName(thrown)).toBe('one_active_ride_per_driver');
  });
});
