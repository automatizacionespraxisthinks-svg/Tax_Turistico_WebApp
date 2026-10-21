import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { zodBody } from '../../common/zod.pipe';
import { SessionGuard } from '../identity/guards';
import { OutboxService } from './outbox.service';

const listSchema = z.object({
  status: z.enum(['pending', 'delivering', 'delivered', 'dead']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/**
 * Cola de eventos hacia n8n, vista desde el panel.
 *
 * La cola muerta tiene que ser visible (§7.1): un evento enterrado significa
 * que el agente no confirmó esa carrera al cliente, y eso lo arregla una
 * persona, no un reintento automático más.
 */
@Controller('v1/admin/outbox')
@UseGuards(SessionGuard)
export class OutboxController {
  constructor(private readonly outbox: OutboxService) {}

  @Get()
  list(@Query(zodBody(listSchema)) query: z.infer<typeof listSchema>) {
    return this.outbox.list(query.status, query.limit);
  }

  @Post(':eventId/retry')
  async retry(@Param('eventId') eventId: string) {
    await this.outbox.revive(eventId);
    return { ok: true };
  }
}
