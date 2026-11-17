import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pointSchema } from '@tax/shared';
import { zodBody } from '../../common/zod.pipe';
import { AppError } from '../../common/problem';
import { DriverGuard } from '../identity/guards';
import { IdentityService } from '../identity/identity.service';
import { AuditService } from '../audit/audit.service';
import { FleetService } from './fleet.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';

const positionSchema = z.object({
  point: pointSchema,
  accuracyMeters: z.number().int().min(0).max(5000).optional(),
  rideId: z.string().uuid().optional(),
});

const shiftSchema = z.object({ plate: z.string().min(5).max(10) });

/** Endpoints de la PWA del conductor sobre su turno y su posición. */
@Controller('v1/driver')
@UseGuards(DriverGuard)
export class FleetController {
  constructor(
    private readonly fleet: FleetService,
    private readonly realtime: RealtimeGateway,
    private readonly identity: IdentityService,
    private readonly audit: AuditService,
  ) {}

  @Post('shift/open')
  async openShift(
    @Req() request: FastifyRequest,
    @Body(zodBody(shiftSchema)) body: z.infer<typeof shiftSchema>,
  ) {
    const driver = requireDriver(request);
    const turno = await this.fleet.openShift(driver.id, body.plate);
    await this.anotar(request, `Abrió turno en el móvil ${turno.plate}`, { movil: turno.plate });
    await this.anotarFueraDeListado(request, turno);
    return turno;
  }

  /**
   * Cambiar de carro: el mismo conductor pasa a otro móvil sin volver a
   * entrar. Cierra el turno del carro de antes y abre el del nuevo en una
   * sola llamada (17/11/2026).
   */
  @Post('shift/switch')
  async switchVehicle(
    @Req() request: FastifyRequest,
    @Body(zodBody(shiftSchema)) body: z.infer<typeof shiftSchema>,
  ) {
    const driver = requireDriver(request);
    const antes = await this.fleet.placaDelTurno(driver.id);
    const turno = await this.fleet.switchVehicle(driver.id, body.plate);
    await this.anotar(
      request,
      antes ? `Cambió de carro: del móvil ${antes} al ${turno.plate}` : `Cambió de carro: al móvil ${turno.plate}`,
      { antes, movil: turno.plate },
    );
    await this.anotarFueraDeListado(request, turno);
    return turno;
  }

  /**
   * Cambiar de conductor: quien entrega el celular sale de él. Se cierra su
   * turno y su sesión en este teléfono, y el que llega entra con su propio
   * código y PIN (17/11/2026).
   */
  @Post('logout')
  async logout(@Req() request: FastifyRequest) {
    const driver = requireDriver(request);
    const placa = await this.fleet.placaDelTurno(driver.id);
    await this.fleet.salirDelCelular(driver.id);
    await this.identity.revocarDispositivo(driver.deviceId);
    await this.anotar(
      request,
      placa
        ? `Cerró turno en el móvil ${placa} y salió del celular (cambio de conductor)`
        : 'Salió del celular (cambio de conductor)',
      { movil: placa },
    );
    return { ok: true };
  }

  /**
   * La bitácora del conductor (17/11/2026): entrar, abrir y cerrar turno,
   * cambiar de carro y de conductor. La placa va dentro del texto porque la
   * página de Auditoría muestra la acción y el código, nada más.
   */
  private async anotar(request: FastifyRequest, action: string, after?: Record<string, unknown>): Promise<void> {
    const driver = requireDriver(request);
    await this.audit.record({
      actorId: driver.id,
      actorName: driver.name,
      role: 'conductor',
      action,
      entity: 'drivers',
      entityId: driver.code,
      after: after ?? null,
      ip: request.ip,
    });
  }

  /** Un móvil que el listado maestro no le asigna queda en la bitácora. */
  private async anotarFueraDeListado(
    request: FastifyRequest,
    turno: { plate: string; fueraDeListado: boolean },
  ): Promise<void> {
    if (!turno.fueraDeListado) return;
    await this.anotar(request, `Tomó el móvil ${turno.plate}, que el listado no le asigna`, { movil: turno.plate });
  }

  @Post('shift/close')
  async closeShift(@Req() request: FastifyRequest) {
    const driver = requireDriver(request);
    const placa = await this.fleet.placaDelTurno(driver.id);
    await this.fleet.closeShift(driver.id);
    // Cerrar sin turno abierto (un reintento de la cola) no se anota dos veces.
    if (placa) await this.anotar(request, `Cerró turno en el móvil ${placa}`, { movil: placa });
    return { ok: true };
  }

  /**
   * Pausa del turno: el conductor sigue en turno pero deja de recibir
   * ofertas. Es una ruta propia y no un `PATCH` del turno porque el conductor
   * no elige un estado, pulsa un botón; y porque así la cola de la PWA la
   * puede reenviar tal cual cuando vuelve la señal.
   */
  @Post('shift/pause')
  async pauseShift(@Req() request: FastifyRequest) {
    await this.fleet.pauseShift(requireDriver(request).id);
    return { ok: true };
  }

  @Post('shift/resume')
  async resumeShift(@Req() request: FastifyRequest) {
    await this.fleet.resumeShift(requireDriver(request).id);
    return { ok: true };
  }

  /**
   * Posición del conductor. Es con diferencia el endpoint más llamado de la
   * API —62 taxis cada `POSITION_REPORT_*`, que por defecto son dos
   * segundos: unas 31 peticiones por segundo—, así que no escribe en
   * Postgres en cada llamada: Redis guarda la última, el socket la reparte
   * al panel al instante y el muestreo decide cuándo persistir (§6).
   */
  @Post('position')
  async position(
    @Req() request: FastifyRequest,
    @Body(zodBody(positionSchema)) body: z.infer<typeof positionSchema>,
  ) {
    const driver = requireDriver(request);
    await this.fleet.recordPosition(driver.id, body.point, {
      rideId: body.rideId,
      accuracyMeters: body.accuracyMeters,
    });
    this.realtime.driverMoved(driver.id, body.point.lat, body.point.lng);
    return { ok: true };
  }
}

function requireDriver(request: FastifyRequest) {
  if (!request.driver) throw new AppError('UNAUTHORIZED', 'Sin conductor en la petición');
  return request.driver;
}
