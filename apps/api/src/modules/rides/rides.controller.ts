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
  UseInterceptors,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RIDE_STATUSES, createRideSchema, pointSchema, type RideStatus } from '@tax/shared';
import { zodBody } from '../../common/zod.pipe';
import { AppError } from '../../common/problem';
import { IdempotencyInterceptor } from '../../common/idempotency.interceptor';
import { ApiKeyGuard, Scopes } from '../identity/api-key.guard';
import { RidesService, type Actor } from './rides.service';
import { DispatchService } from '../dispatch/dispatch.service';

const addressSchema = z.object({
  text: z.string().min(3),
  reference: z.string().optional(),
  point: pointSchema.optional(),
});

const cancelSchema = z.object({
  reason: z.string().min(3, 'El motivo es obligatorio'),
});

const listQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((value) => value?.split(',').filter((s): s is RideStatus => RIDE_STATUSES.includes(s as RideStatus))),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/**
 * Contrato con n8n (§7).
 *
 * Son las herramientas cerradas del agente: crear, consultar, editar
 * dirección y cancelar. No hay acceso a SQL, ni a otros clientes, ni a la API
 * administrativa; los permisos se comprueban aquí, del lado de la API, no en
 * el prompt (§7.2).
 */
@Controller('v1/rides')
@UseGuards(ApiKeyGuard)
export class RidesController {
  constructor(
    private readonly rides: RidesService,
    private readonly dispatch: DispatchService,
  ) {}

  @Post()
  @Scopes('rides:write')
  @UseInterceptors(IdempotencyInterceptor)
  create(
    @Req() request: FastifyRequest,
    @Body(zodBody(createRideSchema)) body: z.infer<typeof createRideSchema>,
  ) {
    return this.rides.create(body, actorFrom(request, 'customer'));
  }

  @Get()
  @Scopes('rides:read')
  list(@Query(zodBody(listQuerySchema)) query: z.infer<typeof listQuerySchema>) {
    return this.rides.list(query.status, query.limit);
  }

  @Get(':rideId')
  @Scopes('rides:read')
  detail(@Param('rideId', ParseUUIDPipe) rideId: string) {
    return this.rides.detail(rideId);
  }

  /** RF-11: el cliente corrige la dirección sin perder la carrera. */
  @Patch(':rideId/address')
  @Scopes('rides:write')
  @UseInterceptors(IdempotencyInterceptor)
  updateAddress(
    @Req() request: FastifyRequest,
    @Param('rideId', ParseUUIDPipe) rideId: string,
    @Body(zodBody(addressSchema)) body: z.infer<typeof addressSchema>,
  ) {
    return this.rides.updateAddress(rideId, body, actorFrom(request, 'customer'));
  }

  @Post(':rideId/cancel')
  @Scopes('rides:write')
  @UseInterceptors(IdempotencyInterceptor)
  cancel(
    @Req() request: FastifyRequest,
    @Param('rideId', ParseUUIDPipe) rideId: string,
    @Body(zodBody(cancelSchema)) body: z.infer<typeof cancelSchema>,
  ) {
    return this.rides.cancel(rideId, body.reason, actorFrom(request, 'customer'));
  }

  /** Relanzar el despacho de una carrera sin asignar (§5.3, operador). */
  @Post(':rideId/redispatch')
  @Scopes('rides:write')
  async redispatch(@Req() request: FastifyRequest, @Param('rideId', ParseUUIDPipe) rideId: string) {
    // Relanzar es un acto de operador (§5.3); por esta via lo hace una
    // integracion en su nombre, y la bitacora dira cual.
    await this.dispatch.redispatch(rideId, actorFrom(request, 'operator'));
    return { ok: true };
  }

  /** Asignación manual (RF-41). */
  @Post(':rideId/assign')
  @Scopes('rides:write')
  assign(
    @Req() request: FastifyRequest,
    @Param('rideId', ParseUUIDPipe) rideId: string,
    @Body(zodBody(z.object({ driverId: z.string().uuid() })))
    body: { driverId: string },
  ) {
    return this.dispatch.assignManually(rideId, body.driverId, actorFrom(request, 'operator'));
  }
}

function actorFrom(request: FastifyRequest, kind: Actor['kind']): Actor {
  const principal = request.principal;
  if (!principal) throw new AppError('UNAUTHORIZED', 'Sin principal en la petición');
  return {
    kind,
    name: principal.name,
    id: principal.id,
    role: 'integración',
    ip: request.ip,
  };
}
