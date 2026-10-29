import { randomInt } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { VehicleType } from '@tax/shared';
import { DB, type Database } from '../../db/db.module';
import { driverDevices, drivers, driverShifts, vehicles } from '../../db/schema';
import { AppError } from '../../common/problem';
import { isUniqueViolation } from '../../common/pg-errors';
import { hashSecret } from '../../common/crypto';
import { AuditService } from '../audit/audit.service';

/**
 * Alta y mantenimiento de la flota desde la oficina (§6, §8.1).
 *
 * Hasta aquí los conductores solo se podían crear por terminal, lo que sirve
 * para arrancar con cinco y no para que la oficina opere sola con sesenta y
 * dos. Esto es lo mismo, pero con la sesión del administrador detrás y, sobre
 * todo, dejando rastro: dar de alta a una persona, cambiarle el PIN o
 * revocarle el celular son operaciones sobre datos de personas y tienen que
 * poder demostrarse después.
 *
 * El PIN nunca viaja de vuelta salvo en el momento de generarlo. No hay
 * «ver PIN»: en la base solo existe su hash Argon2, así que la única opción
 * cuando un conductor lo olvida es generarle otro.
 */

export interface AdminActor {
  /** Ausente cuando la operación viene del servidor y no de una persona. */
  id?: string;
  name: string;
  role: string;
  ip?: string;
}

export interface NuevoConductor {
  code: string;
  name: string;
  phone: string;
  plate: string;
  vehicleType: VehicleType;
}

@Injectable()
export class FleetAdminService {
  private readonly logger = new Logger(FleetAdminService.name);

  /*
   * `AuditService` se inyecta por token explícito, no por tipo. Nest resuelve
   * los tipos leyendo los metadatos que emite el compilador, y `tsx` —con el
   * que se ejecutan los comandos de `cli/` en desarrollo— no los emite: el
   * servicio llegaba `undefined` y el alta fallaba al escribir en la
   * bitácora. Compilado funcionaba; en desarrollo no.
   */
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /* ------------------------------------------------------------- altas */

  /**
   * Da de alta un conductor y, si su placa no existía, también el vehículo.
   *
   * Devuelve el PIN una sola vez. Quien lo cree tiene que hacérselo llegar
   * por un canal distinto del que usa el conductor para su código: el código
   * circula entre compañeros y la placa es pública, así que el PIN es lo
   * único que de verdad autentica.
   */
  async createDriver(
    input: NuevoConductor,
    actor: AdminActor,
  ): Promise<{ id: string; code: string; pin: string }> {
    const code = input.code.trim();
    const plate = input.plate.trim().toUpperCase();

    // Cuatro dígitos: se teclea con guantes a las cinco de la mañana. Lo que
    // lo protege no es la longitud sino el bloqueo a los cinco intentos.
    const pin = String(randomInt(1000, 10000));
    const id = uuidv7();

    try {
      await this.db.transaction(async (tx) => {
        const [vehiculo] = await tx
          .select({ id: vehicles.id })
          .from(vehicles)
          .where(eq(vehicles.plate, plate))
          .limit(1);

        if (!vehiculo) {
          await tx.insert(vehicles).values({
            id: uuidv7(),
            plate,
            type: input.vehicleType,
            capacity: input.vehicleType === 'van' ? 8 : input.vehicleType === 'camioneta' ? 5 : 4,
          });
        }

        await tx.insert(drivers).values({
          id,
          code,
          name: input.name.trim(),
          phone: input.phone.trim(),
          pinHash: await hashSecret(pin),
        });

        await this.audit.record(
          {
            actorId: actor.id,
            actorName: actor.name,
            role: actor.role,
            action: 'Dio de alta un conductor',
            entity: 'drivers',
            entityId: code,
            // Nunca el PIN, ni siquiera su hash: la bitácora se lee.
            after: { code, name: input.name.trim(), plate, vehicleType: input.vehicleType },
            ip: actor.ip,
          },
          tx as unknown as Database,
        );
      });
    } catch (error) {
      if (isUniqueViolation(error, 'drivers_code_key')) {
        throw new AppError('VALIDATION_FAILED', `Ya existe un conductor con el código ${code}`);
      }
      throw error;
    }

    this.logger.log({ code, actor: actor.name }, 'Conductor dado de alta');
    return { id, code, pin };
  }

  /* ------------------------------------------------------------ cambios */

  /** Cambia nombre, teléfono, si sigue trabajando o si es una cuenta de prueba. */
  async updateDriver(
    driverId: string,
    cambios: { name?: string; phone?: string | null; active?: boolean; esPrueba?: boolean },
    actor: AdminActor,
  ): Promise<void> {
    const [antes] = await this.db
      .select({
        code: drivers.code,
        name: drivers.name,
        phone: drivers.phone,
        active: drivers.active,
        esPrueba: drivers.esPrueba,
      })
      .from(drivers)
      .where(eq(drivers.id, driverId))
      .limit(1);

    if (!antes) throw new AppError('NOT_FOUND', 'El conductor no existe');

    const despues = {
      name: cambios.name?.trim() ?? antes.name,
      phone: cambios.phone?.trim() ?? antes.phone,
      active: cambios.active ?? antes.active,
      esPrueba: cambios.esPrueba ?? antes.esPrueba,
    };
    const accion =
      despues.active === false && antes.active
        ? 'Desactivó un conductor'
        : despues.esPrueba !== antes.esPrueba
          ? despues.esPrueba
            ? 'Marcó un conductor como cuenta de prueba'
            : 'Quitó la marca de prueba a un conductor'
          : 'Editó un conductor';

    await this.db.transaction(async (tx) => {
      await tx
        .update(drivers)
        .set({ ...despues, updatedAt: new Date() })
        .where(eq(drivers.id, driverId));

      await this.audit.record(
        {
          actorId: actor.id,
          actorName: actor.name,
          role: actor.role,
          action: accion,
          entity: 'drivers',
          entityId: antes.code,
          before: antes,
          after: despues,
          ip: actor.ip,
        },
        tx as unknown as Database,
      );
    });

    /*
     * Desactivar no interrumpe una carrera en curso, y es deliberado: dejar a
     * un pasajero a mitad de camino sería peor que el motivo por el que se
     * desactiva. Lo que sí hace, de inmediato, es sacarlo de las oleadas,
     * porque `findCandidates` exige `active = true`.
     */
  }

  /**
   * Genera un PIN nuevo. No existe «ver el actual»: solo vive su hash.
   */
  async resetPin(driverId: string, actor: AdminActor): Promise<{ code: string; pin: string }> {
    const [conductor] = await this.db
      .select({ code: drivers.code })
      .from(drivers)
      .where(eq(drivers.id, driverId))
      .limit(1);

    if (!conductor) throw new AppError('NOT_FOUND', 'El conductor no existe');

    const pin = String(randomInt(1000, 10000));

    await this.db.transaction(async (tx) => {
      await tx
        .update(drivers)
        .set({
          pinHash: await hashSecret(pin),
          // Un PIN nuevo levanta el bloqueo: si estaba bloqueado por intentos
          // fallidos, lo más probable es que lo hubiera olvidado.
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(drivers.id, driverId));

      await this.audit.record(
        {
          actorId: actor.id,
          actorName: actor.name,
          role: actor.role,
          action: 'Reinició el PIN de un conductor',
          entity: 'drivers',
          entityId: conductor.code,
          ip: actor.ip,
        },
        tx as unknown as Database,
      );
    });

    return { code: conductor.code, pin };
  }

  /* -------------------------------------------------------- dispositivos */

  /** Celulares registrados de un conductor, el más reciente primero. */
  async listDevices(driverId: string) {
    return this.db
      .select({
        id: driverDevices.id,
        label: driverDevices.label,
        lastSeenAt: driverDevices.lastSeenAt,
        createdAt: driverDevices.createdAt,
        revokedAt: driverDevices.revokedAt,
        pushSubscription: driverDevices.pushSubscription,
      })
      .from(driverDevices)
      .where(eq(driverDevices.driverId, driverId))
      .orderBy(desc(driverDevices.createdAt));
  }

  /**
   * Revoca un celular perdido (§8.1).
   *
   * Es lo primero que la oficina necesita un domingo: el token deja de valer
   * en la siguiente petición y, como la suscripción de push vive en la misma
   * fila, el teléfono también deja de recibir ofertas.
   */
  async revokeDevice(deviceId: string, actor: AdminActor): Promise<void> {
    const [dispositivo] = await this.db
      .select({
        id: driverDevices.id,
        label: driverDevices.label,
        revokedAt: driverDevices.revokedAt,
        code: drivers.code,
      })
      .from(driverDevices)
      .innerJoin(drivers, eq(drivers.id, driverDevices.driverId))
      .where(eq(driverDevices.id, deviceId))
      .limit(1);

    if (!dispositivo) throw new AppError('NOT_FOUND', 'El dispositivo no existe');
    if (dispositivo.revokedAt) return;

    await this.db.transaction(async (tx) => {
      await tx
        .update(driverDevices)
        .set({ revokedAt: new Date(), pushSubscription: null })
        .where(eq(driverDevices.id, deviceId));

      await this.audit.record(
        {
          actorId: actor.id,
          actorName: actor.name,
          role: actor.role,
          action: 'Revocó un dispositivo',
          entity: 'driver_devices',
          entityId: dispositivo.code,
          after: { label: dispositivo.label },
          ip: actor.ip,
        },
        tx as unknown as Database,
      );
    });

    this.logger.log({ code: dispositivo.code, actor: actor.name }, 'Dispositivo revocado');
  }

  /* ----------------------------------------------------------- consultas */

  /** Placas dadas de alta, para elegir sin escribirlas a mano. */
  async listVehicles() {
    return this.db
      .select({
        id: vehicles.id,
        plate: vehicles.plate,
        type: vehicles.type,
        capacity: vehicles.capacity,
        active: vehicles.active,
      })
      .from(vehicles)
      .orderBy(vehicles.plate);
  }

  /** Si tiene turno abierto; la oficina lo necesita antes de desactivarlo. */
  async hasOpenShift(driverId: string): Promise<boolean> {
    const [fila] = await this.db
      .select({ id: driverShifts.id })
      .from(driverShifts)
      .where(and(eq(driverShifts.driverId, driverId), isNull(driverShifts.endedAt)))
      .limit(1);
    return Boolean(fila);
  }
}
