import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pointSchema, haversineKm } from '@tax/shared';
import { zodBody } from '../../common/zod.pipe';
import { AppError } from '../../common/problem';
import { loadEnv } from '../../config/env';
import { DriverGuard } from '../identity/guards';
import { RidesService, type Actor } from './rides.service';
import { DispatchService } from '../dispatch/dispatch.service';
import { FleetService } from '../fleet/fleet.service';

const atSchema = z.object({ at: pointSchema.optional() });

/**
 * Comandos del conductor sobre su carrera.
 *
 * Un conductor solo ve y toca las carreras ofrecidas o asignadas a él; la
 * comprobación es por objeto, no solo por rol (§8.1).
 */
@Controller('v1/driver/rides')
@UseGuards(DriverGuard)
export class DriverRidesController {
  private readonly env = loadEnv();

  constructor(
    private readonly rides: RidesService,
    private readonly dispatch: DispatchService,
    private readonly fleet: FleetService,
  ) {}

  /**
   * Lo que la PWA necesita al abrir: quién es, si tiene carrera en curso y si
   * hay una oferta esperando. Es la primera llamada de la aplicación.
   */
  @Get('me')
  async me(@Req() request: FastifyRequest) {
    const driver = requireDriver(request);

    const [session, shift, totals] = await Promise.all([
      this.rides.driverSession(driver.id),
      this.fleet.currentShift(driver.id),
      this.fleet.todayTotals(driver.id),
    ]);

    return {
      driver: { id: driver.id, code: driver.code, name: driver.name },
      shift,
      totals,
      ...session,
    };
  }

  @Post(':rideId/accept')
  accept(@Req() request: FastifyRequest, @Param('rideId', ParseUUIDPipe) rideId: string) {
    const driver = requireDriver(request);
    return this.dispatch.accept(rideId, driver.id, actorFrom(request));
  }

  @Post(':rideId/reject')
  async reject(@Req() request: FastifyRequest, @Param('rideId', ParseUUIDPipe) rideId: string) {
    await this.dispatch.reject(rideId, requireDriver(request).id);
    return { ok: true };
  }

  /**
   * «Llegué». A menos de 150 m del punto es normal; más lejos se acepta
   * igual, pero queda registrada la excepción (§5.3). El conductor no se
   * queda bloqueado por un GPS impreciso en una vereda.
   */
  @Post(':rideId/arrived')
  async arrived(
    @Req() request: FastifyRequest,
    @Param('rideId', ParseUUIDPipe) rideId: string,
    @Body(zodBody(atSchema)) body: z.infer<typeof atSchema>,
  ) {
    const driver = requireDriver(request);
    const ride = await this.ownRide(rideId, driver.id);

    let note: string | undefined;
    if (body.at && ride.pickupLat && ride.pickupLng) {
      const meters =
        haversineKm(body.at, { lat: ride.pickupLat, lng: ride.pickupLng }) * 1000;
      if (meters > this.env.ARRIVAL_RADIUS_METERS) {
        note = `Excepción: marcó llegada a ${Math.round(meters)} m del punto`;
      }
    }

    return this.rides.transition(rideId, 'DRIVER_ARRIVED', actorFrom(request), {
      note,
      at: body.at,
      patch: { arrivedAt: new Date() },
      event: { type: 'ride.driver_arrived' },
    });
  }

  @Post(':rideId/board')
  async board(
    @Req() request: FastifyRequest,
    @Param('rideId', ParseUUIDPipe) rideId: string,
    @Body(zodBody(atSchema)) body: z.infer<typeof atSchema>,
  ) {
    const driver = requireDriver(request);
    await this.ownRide(rideId, driver.id);

    return this.rides.transition(rideId, 'IN_PROGRESS', actorFrom(request), {
      note: 'Pasajero a bordo',
      at: body.at,
      patch: { startedAt: new Date() },
      event: { type: 'ride.started' },
    });
  }

  @Post(':rideId/finish')
  async finish(
    @Req() request: FastifyRequest,
    @Param('rideId', ParseUUIDPipe) rideId: string,
    @Body(zodBody(atSchema)) body: z.infer<typeof atSchema>,
  ) {
    const driver = requireDriver(request);
    const ride = await this.ownRide(rideId, driver.id);

    /*
     * Aqui es donde la carrera consigue su destino. Casi nadie lo dice por
     * WhatsApp —lo dice ya montado en el carro—, asi que hasta este momento
     * la mayoria de carreras solo tienen punto de partida. La posicion del
     * conductor al cerrar es el destino, y con el salen la distancia y la
     * tarifa real.
     */
    const cierre = await this.rides.cierreDeCarrera(ride, body.at);

    const updated = await this.rides.transition(rideId, 'COMPLETED', actorFrom(request), {
      at: body.at,
      note: cierre.note,
      patch: { finishedAt: new Date(), ...cierre.patch },
      event: {
        type: 'ride.completed',
        payload: { distanceKm: cierre.patch.distanceKm, fareFinal: cierre.patch.fareFinal },
      },
    });

    // El conductor vuelve a Disponible, condición de la transición (§5.3).
    await this.dispatch.releaseDriver(driver.id);
    return updated;
  }

  /** Comprueba que la carrera es de este conductor antes de dejar tocarla. */
  private async ownRide(rideId: string, driverId: string) {
    const ride = await this.rides.byId(rideId);
    if (ride.driverId !== driverId) {
      throw new AppError('FORBIDDEN', 'Esa carrera no está asignada a este conductor');
    }
    return ride;
  }
}

function requireDriver(request: FastifyRequest) {
  if (!request.driver) throw new AppError('UNAUTHORIZED', 'Sin conductor en la petición');
  return request.driver;
}

function actorFrom(request: FastifyRequest): Actor {
  const driver = requireDriver(request);
  return { kind: 'driver', name: driver.name, id: driver.id, role: 'conductor', ip: request.ip };
}
