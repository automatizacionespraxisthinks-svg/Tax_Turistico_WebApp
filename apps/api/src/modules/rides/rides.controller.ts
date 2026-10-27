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
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { FotosService } from './fotos.service';

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
    private readonly fotos: FotosService,
    private readonly realtime: RealtimeGateway,
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

  /**
   * La foto del lugar, para cuando el cliente la manda después de pedir el
   * taxi. Dos formas, según lo que tenga n8n a mano:
   *
   * - el archivo tal cual, con `content-type: image/jpeg` (o png, webp) y la
   *   imagen como cuerpo: es «n8n Binary File» en el nodo HTTP Request;
   * - `{ "url": "…" }` en JSON, y la API la descarga.
   *
   * Hasta 5 MB. Si ya había una, la reemplaza. El conductor la ve al momento.
   */
  @Post(':rideId/photo')
  @Scopes('rides:write')
  async photo(@Req() request: FastifyRequest, @Param('rideId', ParseUUIDPipe) rideId: string) {
    const actor = actorFrom(request, 'customer');
    const cuerpo: unknown = request.body;

    const ride = Buffer.isBuffer(cuerpo)
      ? await this.fotos.guardar(rideId, cuerpo, 'archivo', actor)
      : await this.fotos.desdeEnlace(rideId, fotoSchema.parse(cuerpo).url, actor);

    this.realtime.rideChanged(ride);
    return { ok: true, code: ride.code, pickupPhotoAt: ride.pickupPhotoAt };
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

const fotoSchema = z.object({ url: z.string().url().max(2000) }, {
  error: 'Manda la imagen como cuerpo (image/jpeg) o un JSON con { "url": "…" }',
});

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
