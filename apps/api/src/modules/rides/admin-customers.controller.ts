import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { zodBody } from '../../common/zod.pipe';
import { RequierePermiso, SessionGuard } from '../identity/guards';
import { RidesService, type Actor } from './rides.service';
import { TitularesService } from './titulares.service';

const cambiosSchema = z.object({ esPrueba: z.boolean() });

/** Un teléfono como lo escribe la oficina: «310 123 4567», «+57 310…». */
const buscarSchema = z.object({
  telefono: z
    .string()
    .trim()
    .transform((v) => v.replace(/[^\d+]/g, ''))
    .transform((v) => (v.startsWith('+') ? v : v.length === 10 ? `+57${v}` : `+${v}`))
    .refine((v) => /^\+\d{8,15}$/.test(v), 'Escribe el número completo, por ejemplo 310 123 4567'),
});

const supresionSchema = z.object({
  motivo: z.string().trim().min(5, 'Escribe el motivo o el número de la solicitud').max(200),
});

/**
 * Clientes vistos desde el panel. Por ahora solo una cosa: marcar un teléfono
 * del equipo de pruebas, para que Reportes pueda dejar fuera sus carreras.
 * Lo puede hacer cualquiera de la oficina: no cambia el despacho, solo cómo
 * se cuenta.
 */
@Controller('v1/admin/customers')
@UseGuards(SessionGuard)
export class AdminCustomersController {
  constructor(
    private readonly rides: RidesService,
    private readonly titulares: TitularesService,
  ) {}

  /* ------------------------------------- derechos del titular (Ley 1581) */

  @Get('titular')
  @RequierePermiso('clientes.datos')
  buscarTitular(@Query(zodBody(buscarSchema)) query: z.infer<typeof buscarSchema>) {
    return this.titulares.buscar(query.telefono);
  }

  @Get(':customerId/datos')
  @RequierePermiso('clientes.datos')
  consultar(@Req() request: FastifyRequest, @Param('customerId', ParseUUIDPipe) customerId: string) {
    return this.titulares.consultar(customerId, actorDe(request));
  }

  @Post(':customerId/suprimir')
  @RequierePermiso('clientes.datos')
  suprimir(
    @Req() request: FastifyRequest,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body(zodBody(supresionSchema)) body: z.infer<typeof supresionSchema>,
  ) {
    return this.titulares.suprimir(customerId, body.motivo, actorDe(request));
  }

  @Patch(':customerId')
  @RequierePermiso('clientes.marcar')
  update(
    @Req() request: FastifyRequest,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body(zodBody(cambiosSchema)) body: z.infer<typeof cambiosSchema>,
  ) {
    return this.rides.marcarClienteDePrueba(customerId, body.esPrueba, actorDe(request));
  }
}

function actorDe(request: FastifyRequest): Actor {
  const user = request.user!;
  return { kind: 'operator', id: user.id, name: user.name, role: user.role, ip: request.ip };
}
