import {
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { wahaSessions } from '../../db/schema';
import { RequierePermiso, SessionGuard } from '../identity/guards';
import { AuditService } from '../audit/audit.service';
import { WahaMonitorService } from './waha-monitor.service';

/**
 * Estado de las tres líneas de WhatsApp (§9.1, §10.4).
 *
 * Las tres se publican como alternativas precisamente porque una puede
 * bloquearse: que el panel muestre cuál está caída es parte del plan de
 * contingencia, no un adorno. La tabla la escribe el monitor cada minuto.
 */
@Controller('v1/admin/waha')
@UseGuards(SessionGuard)
export class WahaController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly monitor: WahaMonitorService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list() {
    return this.db.select().from(wahaSessions).orderBy(wahaSessions.label);
  }

  /** El QR para volver a vincular una línea, como imagen en `data:`. */
  @Get(':id/qr')
  async qr(@Param('id') id: string) {
    // Solo líneas que el monitor conoce: no se le pregunta a WAHA por
    // cualquier nombre que llegue en la URL.
    const [linea] = await this.db
      .select({ id: wahaSessions.id })
      .from(wahaSessions)
      .where(eq(wahaSessions.id, id))
      .limit(1);
    if (!linea) throw new NotFoundException('Esa línea no existe');

    const qr = await this.monitor.codigoQr(linea.id);
    if (!qr.ok) throw new ServiceUnavailableException(qr.error);
    return { image: qr.imagen };
  }

  /**
   * Quita una línea que ya no existe en WAHA. Si la borraron a propósito, sin
   * esto seguiría saliendo como caída para siempre. Solo se puede con una
   * línea en `missing`: una viva la volvería a escribir el monitor al minuto.
   */
  @Delete(':id')
  @RequierePermiso('sistema.tecnico')
  async quitar(@Req() request: FastifyRequest, @Param('id') id: string) {
    const user = request.user!;
    await this.db.transaction(async (tx) => {
      const [borrada] = await tx
        .delete(wahaSessions)
        .where(and(eq(wahaSessions.id, id), eq(wahaSessions.status, 'missing')))
        .returning();
      if (!borrada) {
        throw new ConflictException('Solo se quita una línea que ya no existe en WAHA');
      }
      await this.audit.record(
        {
          actorId: user.id,
          actorName: user.name,
          role: user.role,
          action: 'Quitó una línea de WhatsApp',
          entity: 'waha_sessions',
          entityId: borrada.id,
          before: { label: borrada.label, phone: borrada.phone, status: borrada.status },
          ip: request.ip,
        },
        tx as unknown as Database,
      );
    });
    return { ok: true };
  }
}
