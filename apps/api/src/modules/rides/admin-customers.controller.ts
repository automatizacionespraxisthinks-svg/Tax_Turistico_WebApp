import { Body, Controller, Param, ParseUUIDPipe, Patch, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { zodBody } from '../../common/zod.pipe';
import { SessionGuard } from '../identity/guards';
import { RidesService, type Actor } from './rides.service';

const cambiosSchema = z.object({ esPrueba: z.boolean() });

/**
 * Clientes vistos desde el panel. Por ahora solo una cosa: marcar un teléfono
 * del equipo de pruebas, para que Reportes pueda dejar fuera sus carreras.
 * Lo puede hacer cualquiera de la oficina: no cambia el despacho, solo cómo
 * se cuenta.
 */
@Controller('v1/admin/customers')
@UseGuards(SessionGuard)
export class AdminCustomersController {
  constructor(private readonly rides: RidesService) {}

  @Patch(':customerId')
  update(
    @Req() request: FastifyRequest,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body(zodBody(cambiosSchema)) body: z.infer<typeof cambiosSchema>,
  ) {
    const user = request.user!;
    const actor: Actor = { kind: 'operator', id: user.id, name: user.name, role: user.role, ip: request.ip };
    return this.rides.marcarClienteDePrueba(customerId, body.esPrueba, actor);
  }
}
