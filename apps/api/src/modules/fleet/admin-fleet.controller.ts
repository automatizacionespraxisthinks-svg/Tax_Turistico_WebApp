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
  /** Los vehículos que podrá manejar (18/11/2026); es lo que manda el panel. */
  vehicleIds: z.array(z.string().uuid()).max(100).optional(),
  /** La forma de antes: una placa que crea el vehículo si no existe. */
  plate: z.string().trim().min(5).max(10).optional(),
  vehicleType: z.enum(VEHICLE_TYPES).optional(),
}).refine((v) => (v.vehicleIds?.length ?? 0) > 0 || Boolean(v.plate), {
  message: 'Elige al menos un vehículo que pueda manejar',
  path: ['vehicleIds'],
});

const vehiculosPermitidosSchema = z.object({
  vehicleIds: z.array(z.string().uuid()).max(100),
});

const nuevoVehiculoSchema = z.object({
  plate: z.string().trim().min(5, 'La placa tiene al menos 5 caracteres').max(10),
  internalNumber: z.string().trim().max(10).optional(),
  type: z.enum(VEHICLE_TYPES).default('sedan'),
  capacity: z.number().int().min(1).max(20).optional(),
});

const cambiosVehiculoSchema = z
  .object({
    internalNumber: z.string().trim().max(10).nullable().optional(),
    type: z.enum(VEHICLE_TYPES).optional(),
    capacity: z.number().int().min(1).max(20).optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'No hay nada que cambiar');

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

const eliminarSchema = z.object({
  motivo: z.string().trim().min(5, 'Escribe el motivo (al menos 5 letras)').max(300),
  /** El código del conductor, escrito a mano por quien elimina. */
  confirmacion: z.string().trim().min(1, 'Escribe el código del conductor para confirmar').max(10),
});

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

  /**
   * Los vehículos que puede manejar (18/11/2026). Reemplaza la lista: solo
   * podrá abrir turno o cambiar de carro dentro de ella.
   */
  @Post(':driverId/vehicles')
  @RequierePermiso('conductores.gestionar')
  async fijarVehiculos(
    @Req() request: FastifyRequest,
    @Param('driverId', ParseUUIDPipe) driverId: string,
    @Body(zodBody(vehiculosPermitidosSchema)) body: z.infer<typeof vehiculosPermitidosSchema>,
  ) {
    return this.admin.fijarVehiculos(driverId, body.vehicleIds, actorDe(request));
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

  /**
   * Elimina un conductor: baja definitiva y borrado de sus datos personales
   * (ver `FleetAdminService.eliminarDriver`). Pide el motivo y el código del
   * conductor escrito a mano, y queda en la bitácora con quién lo hizo.
   */
  @Post(':driverId/eliminar')
  @RequierePermiso('conductores.eliminar')
  async eliminar(
    @Req() request: FastifyRequest,
    @Param('driverId', ParseUUIDPipe) driverId: string,
    @Body(zodBody(eliminarSchema)) body: z.infer<typeof eliminarSchema>,
  ) {
    return this.admin.eliminarDriver(driverId, body, actorDe(request));
  }

  @Post('devices/:deviceId/revoke')
  @RequierePermiso('conductores.gestionar')
  @HttpCode(204)
  async revoke(@Req() request: FastifyRequest, @Param('deviceId', ParseUUIDPipe) deviceId: string) {
    await this.admin.revokeDevice(deviceId, actorDe(request));
  }
}

/**
 * Vehículos (18/11/2026): los que se eligen como permitidos de cada
 * conductor. Se dan de alta y se editan; no se borran, porque sus turnos y
 * carreras los siguen nombrando: se desactivan.
 */
@Controller('v1/admin/vehicles')
@UseGuards(SessionGuard)
export class AdminVehiclesController {
  constructor(private readonly admin: FleetAdminService) {}

  @Get()
  list() {
    return this.admin.listVehicles();
  }

  @Post()
  @RequierePermiso('conductores.gestionar')
  crear(
    @Req() request: FastifyRequest,
    @Body(zodBody(nuevoVehiculoSchema)) body: z.infer<typeof nuevoVehiculoSchema>,
  ) {
    return this.admin.crearVehiculo(body, actorDe(request));
  }

  @Patch(':vehicleId')
  @RequierePermiso('conductores.gestionar')
  @HttpCode(204)
  async editar(
    @Req() request: FastifyRequest,
    @Param('vehicleId', ParseUUIDPipe) vehicleId: string,
    @Body(zodBody(cambiosVehiculoSchema)) body: z.infer<typeof cambiosVehiculoSchema>,
  ) {
    await this.admin.editarVehiculo(vehicleId, body, actorDe(request));
  }
}
