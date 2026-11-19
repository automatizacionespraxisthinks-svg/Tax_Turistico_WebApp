import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { zodBody } from '../../common/zod.pipe';
import { ApiKeyGuard, Scopes } from '../identity/api-key.guard';
import { TitularesService } from './titulares.service';

/** El teléfono tal como lo manda n8n al crear la carrera: «+573001112233». */
const conocidoSchema = z.object({
  telefono: z
    .string()
    .trim()
    .refine((v) => /^\+\d{8,15}$/.test(v), 'Teléfono en formato internacional, por ejemplo +573001112233'),
});

/**
 * Clientes vistos desde las integraciones (n8n). Solo responde si un
 * teléfono ya es cliente; ningún dato personal sale por aquí (19/11/2026).
 */
@Controller('v1/customers')
@UseGuards(ApiKeyGuard)
export class CustomersController {
  constructor(private readonly titulares: TitularesService) {}

  /** `{ conocido: true }` si ese teléfono ya pidió algún taxi. */
  @Get('conocido')
  @Scopes('rides:read')
  async conocido(@Query(zodBody(conocidoSchema)) query: z.infer<typeof conocidoSchema>) {
    return { conocido: await this.titulares.conocido(query.telefono) };
  }
}
