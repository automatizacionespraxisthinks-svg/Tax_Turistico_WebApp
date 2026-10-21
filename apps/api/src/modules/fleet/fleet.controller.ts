import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pointSchema } from '@tax/shared';
import { zodBody } from '../../common/zod.pipe';
import { AppError } from '../../common/problem';
import { DriverGuard } from '../identity/guards';
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
  ) {}

  @Post('shift/open')
  openShift(
    @Req() request: FastifyRequest,
    @Body(zodBody(shiftSchema)) body: z.infer<typeof shiftSchema>,
  ) {
    return this.fleet.openShift(requireDriver(request).id, body.plate);
  }

  @Post('shift/close')
  async closeShift(@Req() request: FastifyRequest) {
    await this.fleet.closeShift(requireDriver(request).id);
    return { ok: true };
  }

  /**
   * Posición del conductor. Es el endpoint más llamado de la API —62 taxis
   * cada 10–30 s—, así que no escribe en Postgres en cada llamada: Redis
   * guarda la última y el muestreo decide cuándo persistir (§6).
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
