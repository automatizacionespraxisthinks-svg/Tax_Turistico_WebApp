import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RIDE_STATUSES } from '@tax/shared';
import { zodBody } from '../../common/zod.pipe';
import { SessionGuard } from '../identity/guards';
import { ExportsService } from './exports.service';

const solicitudSchema = z.object({
  kind: z.enum(['resumen', 'carreras']),
  format: z.enum(['xlsx', 'pdf']),
  days: z.coerce.number().int().min(1).max(90),
  /** Solo para `carreras`: los filtros de la vista desde la que se pidió. */
  statuses: z.array(z.enum(RIDE_STATUSES)).max(RIDE_STATUSES.length).optional(),
  zoneId: z.string().uuid().optional(),
  query: z.string().trim().max(80).optional(),
  filterLabel: z.string().trim().max(40).optional(),
});

/**
 * Exportaciones a Excel y PDF (§4.1). Las puede pedir cualquiera de la
 * oficina: son los mismos datos que ya ve en *Carreras* y *Reportes*.
 */
@Controller('v1/reports/exports')
@UseGuards(SessionGuard)
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  /** Encola la exportación y devuelve su fila, todavía pendiente. */
  @Post()
  solicitar(
    @Req() request: FastifyRequest,
    @Body(zodBody(solicitudSchema)) body: z.infer<typeof solicitudSchema>,
  ) {
    const { kind, format, ...params } = body;
    const user = request.user!;
    return this.exports.solicitar({ kind, format, params }, { id: user.id, name: user.name });
  }

  @Get()
  lista() {
    return this.exports.lista();
  }

  @Get(':id')
  uno(@Param('id', ParseUUIDPipe) id: string) {
    return this.exports.uno(id);
  }

  /** El archivo, para descargarlo. Solo existe cuando la fila está lista. */
  @Get(':id/file')
  async archivo(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const { content, fileName, contentType } = await this.exports.archivo(id);
    void reply
      .header('content-type', contentType)
      .header('content-disposition', `attachment; filename="${fileName}"`)
      // Lleva teléfonos de clientes: que no se quede en ninguna caché.
      .header('cache-control', 'private, no-store');
    return content;
  }
}
