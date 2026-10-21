import 'dotenv/config';
import { randomInt } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { drivers, vehicles } from '../db/schema';
import { hashSecret } from '../common/crypto';

/**
 * Da de alta un conductor y, si hace falta, su vehículo.
 *
 * Hasta ahora la única forma de crear conductores era el sembrado de
 * desarrollo, que los crea a los cinco con el PIN `4821`. Esto permite
 * darlos de alta uno a uno con un PIN propio, que es lo que pide §8.1: el
 * código circula entre compañeros y la placa es pública, así que el PIN es
 * lo único que de verdad autentica.
 *
 * El PIN se genera aquí y se imprime una sola vez; en la base queda solo el
 * hash Argon2. Hay que dárselo al conductor por un canal que no sea el mismo
 * por el que circula su código.
 *
 * La relación conductor-vehículo es por turno, no fija (§6): el vehículo se
 * crea para que la placa exista, pero el conductor puede abrir turno con
 * cualquier otra que esté dada de alta.
 *
 *   node dist/cli/crear-conductor.js 106 "Pedro Ramírez" +573118889900 WXY123 sedan
 */

const TIPOS = ['sedan', 'camioneta', 'van'] as const;
type Tipo = (typeof TIPOS)[number];

async function main(): Promise<void> {
  const [code, name, phone, plate, tipo = 'sedan'] = process.argv.slice(2);

  if (!code || !name || !phone || !plate) {
    console.error(
      'Uso: crear-conductor.js <código> "<nombre>" <teléfono> <placa> [sedan|camioneta|van]',
    );
    process.exitCode = 1;
    return;
  }
  if (!TIPOS.includes(tipo as Tipo)) {
    console.error(`Tipo inválido: «${tipo}». Usa ${TIPOS.join(', ')}.`);
    process.exitCode = 1;
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL');

  const pool = new Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool);

  try {
    const codigo = code.trim();
    const placa = plate.trim().toUpperCase();

    const [existe] = await db.select({ id: drivers.id }).from(drivers).where(eq(drivers.code, codigo)).limit(1);
    if (existe) {
      console.error(`Ya existe un conductor con el código ${codigo}.`);
      process.exitCode = 1;
      return;
    }

    // Cuatro dígitos: es lo que se teclea con guantes a las cinco de la
    // mañana. Lo que lo protege no es la longitud, es el bloqueo a los cinco
    // intentos fallidos.
    const pin = String(randomInt(1000, 10000));

    await db.transaction(async (tx) => {
      const [vehiculo] = await tx
        .select({ id: vehicles.id })
        .from(vehicles)
        .where(eq(vehicles.plate, placa))
        .limit(1);

      if (!vehiculo) {
        await tx.insert(vehicles).values({
          id: uuidv7(),
          plate: placa,
          type: tipo as Tipo,
          capacity: tipo === 'van' ? 8 : tipo === 'camioneta' ? 5 : 4,
        });
      }

      await tx.insert(drivers).values({
        id: uuidv7(),
        code: codigo,
        name: name.trim(),
        phone: phone.trim(),
        pinHash: await hashSecret(pin),
      });
    });

    console.log(`\nConductor creado: ${name} · código ${codigo} · placa ${placa} (${tipo})`);
    console.log(`PIN (no se vuelve a mostrar):\n\n  ${pin}\n`);
    console.log('Entra en la PWA con código + placa + PIN.');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('Falló la creación:', error);
  process.exitCode = 1;
});
