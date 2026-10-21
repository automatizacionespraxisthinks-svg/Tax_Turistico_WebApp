import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RIDE_STATUSES, pointSchema, type RideStatus } from '@tax/shared';
import { zodBody } from '../../common/zod.pipe';
import { AppError } from '../../common/problem';
import { SessionGuard } from '../identity/guards';
import { RidesService, type Actor } from './rides.service';
import { DispatchService } from '../dispatch/dispatch.service';

const listQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((value) =>
      value
        ?.split(',')
        .filter((s): s is RideStatus => RIDE_STATUSES.includes(s as RideStatus)),
    ),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const addressSchema = z.object({
  text: z.string().min(3),
  reference: z.string().optional(),
  point: pointSchema.optional(),
});

const cancelSchema = z.object({ reason: z.string().min(3, 'El motivo es obligatorio') });
const assignSchema = z.object({ driverId: z.string().uuid() });

/**
 * Carreras vistas desde el panel de oficina.
 *
 * Mismos casos de uso que el contrato de n8n, pero autenticados con la sesión
 * de la oficina en vez de la clave de API, y con el actor marcado como
 * `operator`: la máquina de estados permite a un operador cosas que al agente
 * no —reasignar, relanzar— y la bitácora tiene que distinguir quién fue.
 */
@Controller('v1/admin/rides')
@UseGuards(SessionGuard)
export class AdminRidesController {
  constructor(
    private readonly rides: RidesService,
    private readonly dispatch: DispatchService,
  ) {}

  @Get()
  list(@Query(zodBody(listQuerySchema)) query: z.infer<typeof listQuerySchema>) {
    return this.rides.list(query.status, query.limit);
  }

  @Get(':rideId')
  detail(@Param('rideId', ParseUUIDPipe) rideId: string) {
    return this.rides.detail(rideId);
  }

  @Patch(':rideId/address')
  updateAddress(
    @Req() request: FastifyRequest,
    @Param('rideId', ParseUUIDPipe) rideId: string,
    @Body(zodBody(addressSchema)) body: z.infer<typeof addressSchema>,
  ) {
    return this.rides.updateAddress(rideId, body, operator(request));
  }

  @Post(':rideId/cancel')
  cancel(
    @Req() request: FastifyRequest,
    @Param('rideId', ParseUUIDPipe) rideId: string,
    @Body(zodBody(cancelSchema)) body: z.infer<typeof cancelSchema>,
  ) {
    return this.rides.cancel(rideId, body.reason, operator(request));
  }

  /** Relanzar el despacho desde la oleada 1 (§5.3). */
  @Post(':rideId/redispatch')
  async redispatch(@Param('rideId', ParseUUIDPipe) rideId: string) {
    await this.dispatch.startWave(rideId, 1);
    return { ok: true };
  }

  /** Asignación manual a un conductor concreto (RF-41). */
  @Post(':rideId/assign')
  assign(
    @Req() request: FastifyRequest,
    @Param('rideId', ParseUUIDPipe) rideId: string,
    @Body(zodBody(assignSchema)) body: z.infer<typeof assignSchema>,
  ) {
    return this.dispatch.assignManually(rideId, body.driverId, operator(request));
  }
}

function operator(request: FastifyRequest): Actor {
  const user = request.user;
  if (!user) throw new AppError('UNAUTHORIZED', 'Sin usuario en la petición');
  return { kind: 'operator', name: user.name, id: user.id, role: user.role, ip: request.ip };
}
