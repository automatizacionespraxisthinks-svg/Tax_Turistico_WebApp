import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MAX_DIAS_INFORME, RIDE_STATUSES, diasDelRango } from '@tax/shared';
import { zodBody } from '../../common/zod.pipe';
import { SessionGuard } from '../identity/guards';
import { ExportsService } from './exports.service';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const solicitudSchema = z
  .object({
    kind: z.enum(['resumen', 'carreras']),
    format: z.enum(['xlsx', 'pdf']),
    /** Desde *Carreras*: hacia atrás desde ahora. */
    days: z.coerce.number().int().min(1).max(90).optional(),
    /** Desde *Reportes*: los días del tablero, con los dos extremos. */
    desde: fecha.optional(),
    hasta: fecha.optional(),
    /** Solo para `carreras`: los filtros de la vista desde la que se pidió. */
    statuses: z.array(z.enum(RIDE_STATUSES)).max(RIDE_STATUSES.length).optional(),
    zoneId: z.string().uuid().optional(),
    query: z.string().trim().max(80).optional(),
    /** Los filtros del tablero de Reportes. */
    zoneIds: z.array(z.string().uuid()).max(50).optional(),
    zoneKind: z.enum(['urbano', 'rural']).optional(),
    driverId: z.string().uuid().optional(),
    lines: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
    excludeTests: z.boolean().optional(),
    filterLabel: z.string().trim().max(120).optional(),
  })
  .refine((v) => v.days !== undefined || (v.desde && v.hasta), 'Falta el periodo: `days`, o `desde` y `hasta`')
  .refine(
    (v) => !v.desde || !v.hasta || (v.desde <= v.hasta && diasDelRango(v.desde, v.hasta) <= MAX_DIAS_INFORME),
    `El periodo va de \`desde\` a \`hasta\` y tiene hasta ${MAX_DIAS_INFORME} días`,
  );

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
