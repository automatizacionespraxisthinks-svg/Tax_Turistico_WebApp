import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { VEHICLE_TYPES, suspensionSchema, type Suspension } from '@tax/shared';
import { zodBody } from '../../common/zod.pipe';
import { RequierePermiso, SessionGuard } from '../identity/guards';
import { FleetService } from './fleet.service';
import { FleetAdminService, type AdminActor } from './fleet-admin.service';

const nuevoConductorSchema = z.object({
  // El código es lo que el conductor teclea cada mañana: corto y numérico.
  code: z.string().trim().min(1).max(10).regex(/^[0-9]+$/, 'El código es numérico'),
  name: z.string().trim().min(3).max(120),
  phone: z.string().trim().regex(/^\+\d{8,15}$/, 'Teléfono en formato E.164, por ejemplo +573001234567'),
  plate: z.string().trim().min(5).max(10),
  vehicleType: z.enum(VEHICLE_TYPES).default('sedan'),
});

const cambiosSchema = z
  .object({
    name: z.string().trim().min(3).max(120).optional(),
    phone: z.string().trim().regex(/^\+\d{8,15}$/).optional(),
    active: z.boolean().optional(),
    /** Cuenta con la que el equipo prueba: no cuenta en Reportes sin pruebas. */
    esPrueba: z.boolean().optional(),
    /** Recibe pagos electrónicos: solo a estos les llegan esas carreras. */
    aceptaPagoElectronico: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'No hay nada que cambiar');

function actorDe(request: FastifyRequest): AdminActor {
  const user = request.user!;
  return { id: user.id, name: user.name, role: user.role, ip: request.ip };
}

/**
 * Flota vista desde el panel: estado y posición en vivo de los 62 taxis, y el
 * mantenimiento de conductores y dispositivos.
 *
 * La lectura la puede hacer cualquier operador —necesita ver la flota para
 * despachar—, pero dar de alta, editar, reiniciar un PIN o revocar un celular
 * son solo de administrador (§8.1). El guardia lo comprueba aquí, del lado del
 * servidor: si estuviera solo en la interfaz, bastaría con saltarse la
 * interfaz.
 */
@Controller('v1/admin/drivers')
@UseGuards(SessionGuard)
export class AdminFleetController {
  constructor(
    private readonly fleet: FleetService,
    private readonly admin: FleetAdminService,
  ) {}

  @Get()
  list() {
    return this.fleet.listWithPositions();
  }

  /**
   * Da de alta un conductor. Devuelve el PIN **una sola vez**: en la base
   * solo queda su hash Argon2, así que si se pierde hay que generar otro.
   */
  @Post()
  @RequierePermiso('conductores.gestionar')
  async create(
    @Req() request: FastifyRequest,
    @Body(zodBody(nuevoConductorSchema)) body: z.infer<typeof nuevoConductorSchema>,
  ) {
    const { id, code, pin } = await this.admin.createDriver(body, actorDe(request));
    return { id, code, pin, aviso: 'Este PIN no se vuelve a mostrar. Entrégaselo al conductor ahora.' };
  }

  @Patch(':driverId')
  @RequierePermiso('conductores.gestionar')
  @HttpCode(204)
  async update(
    @Req() request: FastifyRequest,
    @Param('driverId', ParseUUIDPipe) driverId: string,
    @Body(zodBody(cambiosSchema)) body: z.infer<typeof cambiosSchema>,
  ) {
    await this.admin.updateDriver(driverId, body, actorDe(request));
  }

  /**
   * Suspende por unos días (reglamento interno). Reemplaza la suspensión que
   * hubiera; vuelve sola al cumplirse.
   */
  @Post(':driverId/suspension')
  @RequierePermiso('conductores.suspender')
  async suspender(
    @Req() request: FastifyRequest,
    @Param('driverId', ParseUUIDPipe) driverId: string,
    @Body(zodBody(suspensionSchema)) body: Suspension,
  ) {
    const { hasta } = await this.admin.suspender(driverId, body, actorDe(request));
    return { suspendidoHasta: hasta.toISOString() };
  }

  /** Levanta la suspensión antes de que se cumpla. */
  @Delete(':driverId/suspension')
  @RequierePermiso('conductores.suspender')
  @HttpCode(204)
  async levantarSuspension(@Req() request: FastifyRequest, @Param('driverId', ParseUUIDPipe) driverId: string) {
    await this.admin.levantarSuspension(driverId, actorDe(request));
  }

  /** Genera un PIN nuevo y levanta el bloqueo por intentos fallidos. */
  @Post(':driverId/pin')
  @RequierePermiso('conductores.gestionar')
  async resetPin(@Req() request: FastifyRequest, @Param('driverId', ParseUUIDPipe) driverId: string) {
    const { code, pin } = await this.admin.resetPin(driverId, actorDe(request));
    return { code, pin, aviso: 'Este PIN no se vuelve a mostrar.' };
  }

  /** Si tiene turno abierto: la oficina lo mira antes de desactivarlo. */
  @Get(':driverId/shift')
  async shift(@Param('driverId', ParseUUIDPipe) driverId: string) {
    return { open: await this.admin.hasOpenShift(driverId) };
  }

  @Get(':driverId/devices')
  @RequierePermiso('conductores.gestionar')
  async devices(@Param('driverId', ParseUUIDPipe) driverId: string) {
    const rows = await this.admin.listDevices(driverId);
    // La suscripción de push es un secreto del navegador; afuera solo se dice
    // si existe, que es lo único que la oficina necesita saber.
    return rows.map(({ pushSubscription, ...rest }) => ({
      ...rest,
      recibeAvisos: Boolean(pushSubscription),
    }));
  }

  @Post('devices/:deviceId/revoke')
  @RequierePermiso('conductores.gestionar')
  @HttpCode(204)
  async revoke(@Req() request: FastifyRequest, @Param('deviceId', ParseUUIDPipe) deviceId: string) {
    await this.admin.revokeDevice(deviceId, actorDe(request));
  }
}

/** Placas dadas de alta, para elegir en vez de escribirlas a mano. */
@Controller('v1/admin/vehicles')
@UseGuards(SessionGuard)
export class AdminVehiclesController {
  constructor(private readonly admin: FleetAdminService) {}

  @Get()
  list() {
    return this.admin.listVehicles();
  }
}
