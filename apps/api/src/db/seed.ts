import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';
import { sql } from 'drizzle-orm';
import * as schema from './schema';
import { hashSecret, randomHex, randomToken } from '../common/crypto';

/**
 * Datos mínimos para arrancar en desarrollo: las zonas de Paipa, la tabla de
 * tarifas vigente, unos conductores y una clave de API para n8n.
 *
 * No es un volcado de producción: los conductores reales, sus PIN y las
 * tarifas autorizadas los carga la empresa.
 */

/** Rectángulo alrededor de un punto, en GeoJSON (lng, lat). */
function box(lat: number, lng: number, dLat: number, dLng: number) {
  return {
    type: 'Polygon' as const,
    coordinates: [
      [
        [lng - dLng, lat + dLat],
        [lng + dLng, lat + dLat],
        [lng + dLng, lat - dLat],
        [lng - dLng, lat - dLat],
        [lng - dLng, lat + dLat],
      ] as [number, number][],
    ],
  };
}

const ZONES = [
  { name: 'Centro', kind: 'urbano' as const, lat: 5.7803, lng: -73.1142, dLat: 0.01, dLng: 0.011, tortuosity: 1.25 },
  { name: 'Lago Sochagota', kind: 'urbano' as const, lat: 5.756, lng: -73.13, dLat: 0.009, dLng: 0.01, tortuosity: 1.3 },
  { name: 'Zona termal', kind: 'urbano' as const, lat: 5.735, lng: -73.148, dLat: 0.009, dLng: 0.01, tortuosity: 1.35 },
  { name: 'Vereda El Salitre', kind: 'rural' as const, lat: 5.814, lng: -73.076, dLat: 0.02, dLng: 0.022, tortuosity: 1.75 },
  { name: 'Vereda Canocas', kind: 'rural' as const, lat: 5.73, lng: -73.07, dLat: 0.022, dLng: 0.024, tortuosity: 1.9 },
  { name: 'Vereda Toibita', kind: 'rural' as const, lat: 5.815, lng: -73.17, dLat: 0.022, dLng: 0.024, tortuosity: 1.85 },
  { name: 'Vereda Palermo', kind: 'rural' as const, lat: 5.725, lng: -73.185, dLat: 0.022, dLng: 0.02, tortuosity: 2.0 },
];

const URBAN_WAVES = [
  { wave: 1 as const, radiusKm: 1.5, candidates: 3, timeoutSeconds: 45 },
  { wave: 2 as const, radiusKm: 3.5, candidates: 5, timeoutSeconds: 60 },
  { wave: 3 as const, radiusKm: 12, candidates: 12, timeoutSeconds: 90 },
];

const RURAL_WAVES = [
  { wave: 1 as const, radiusKm: 5, candidates: 3, timeoutSeconds: 70 },
  { wave: 2 as const, radiusKm: 10, candidates: 6, timeoutSeconds: 90 },
  { wave: 3 as const, radiusKm: 20, candidates: 14, timeoutSeconds: 120 },
];

const FARES = [
  { origin: 'urbano', destination: 'urbano', base: 5400, perKm: 1750, min: 7000 },
  { origin: 'urbano', destination: 'rural', base: 7200, perKm: 2400, min: 13000 },
  { origin: 'rural', destination: 'urbano', base: 7200, perKm: 2400, min: 13000 },
  { origin: 'rural', destination: 'rural', base: 8500, perKm: 2600, min: 16000 },
] as const;

const DRIVERS = [
  { code: '101', name: 'Jairo Pérez Sánchez', plate: 'UBP472', type: 'sedan' as const },
  { code: '102', name: 'Luz Marina Cárdenas', plate: 'TQR118', type: 'sedan' as const },
  { code: '103', name: 'Héctor Buitrago Niño', plate: 'SVM903', type: 'sedan' as const },
  { code: '104', name: 'Gloria Rincón Mesa', plate: 'UZK240', type: 'camioneta' as const },
  { code: '105', name: 'Omar Parra Pinzón', plate: 'TJA556', type: 'van' as const },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL');

  const pool = new Pool({ connectionString: url, max: 2 });
  const db = drizzle(pool, { schema, casing: 'snake_case' });

  console.log('Sembrando zonas…');
  for (const zone of ZONES) {
    await db
      .insert(schema.zones)
      .values({
        id: uuidv7(),
        name: zone.name,
        kind: zone.kind,
        polygon: box(zone.lat, zone.lng, zone.dLat, zone.dLng),
        tortuosity: zone.tortuosity,
        waves: zone.kind === 'urbano' ? URBAN_WAVES : RURAL_WAVES,
      })
      .onConflictDoNothing();
  }

  console.log('Sembrando tarifas…');
  for (const fare of FARES) {
    await db
      .insert(schema.fareRules)
      .values({
        id: uuidv7(),
        version: '2026.02',
        originKind: fare.origin,
        destinationKind: fare.destination,
        baseFare: fare.base,
        perKm: fare.perKm,
        minimumFare: fare.min,
        surcharges: [
          { id: 's-noche', label: 'Recargo nocturno', amount: 1500, fromHour: 20, toHour: 5 },
        ],
        legalReference: 'Decreto municipal 041 de 2026',
        effectiveFrom: new Date('2026-02-01T00:00:00Z'),
      })
      .onConflictDoNothing();
  }

  console.log('Sembrando flota…');
  // Un PIN de desarrollo, igual para todos. En producción cada conductor fija
  // el suyo en la vinculación y nunca se almacena en claro.
  const devPinHash = await hashSecret('4821');
  for (const driver of DRIVERS) {
    const vehicleId = uuidv7();
    await db
      .insert(schema.vehicles)
      .values({ id: vehicleId, plate: driver.plate, type: driver.type, capacity: 4 })
      .onConflictDoNothing();

    await db
      .insert(schema.drivers)
      .values({
        id: uuidv7(),
        code: driver.code,
        name: driver.name,
        phone: `+5731${driver.code}0000`,
        pinHash: devPinHash,
      })
      .onConflictDoNothing();
  }

  console.log('Creando usuario de oficina y clave de API…');
  await db
    .insert(schema.users)
    .values({
      id: uuidv7(),
      email: 'operadora@taxturistico.local',
      name: 'Marcela Ruiz',
      passwordHash: await hashSecret('desarrollo-no-usar-en-produccion'),
      role: 'operador',
    })
    .onConflictDoNothing();

  console.log('Sembrando líneas de WhatsApp…');
  for (const line of [
    { id: 'line-1', label: 'Línea 1', phone: '+57 310 842 1190', status: 'working' },
    { id: 'line-2', label: 'Línea 2', phone: '+57 320 455 7731', status: 'working' },
    { id: 'line-3', label: 'Línea 3', phone: '+57 315 668 2204', status: 'scan_qr' },
  ]) {
    await db
      .insert(schema.wahaSessions)
      .values({ ...line, lastCheckAt: new Date(), messagesToday: 0 })
      .onConflictDoNothing();
  }

  const prefix = randomHex(4);
  const secret = randomToken(32);
  await db
    .insert(schema.apiKeys)
    .values({
      id: uuidv7(),
      name: 'n8n',
      prefix,
      keyHash: await hashSecret(secret),
      scopes: ['rides:read', 'rides:write'],
      webhookSecret: randomToken(32),
    })
    .onConflictDoNothing();

  const zoneCount = await db.execute<{ count: number }>(
    sql`select count(*)::int as count from zones`,
  );
  const count = zoneCount.rows[0]?.count ?? 0;

  console.log(`\nListo. Zonas: ${count}.`);
  console.log(`Clave de API para n8n (solo se muestra una vez):\n  tax_${prefix}_${secret}\n`);
  console.log('PIN de los conductores de desarrollo: 4821');

  await pool.end();
}

main().catch((error: unknown) => {
  console.error('Fallo al sembrar:', error);
  process.exitCode = 1;
});
