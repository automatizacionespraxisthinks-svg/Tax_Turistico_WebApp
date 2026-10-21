import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { DB, type Database } from '../../db/db.module';
import { wahaSessions } from '../../db/schema';
import { SessionGuard } from '../identity/guards';

/**
 * Estado de las tres líneas de WhatsApp (§9.1, §10.4).
 *
 * Las tres se publican como alternativas precisamente porque una puede
 * bloquearse: que el panel muestre cuál está caída es parte del plan de
 * contingencia, no un adorno.
 */
@Controller('v1/admin/waha')
@UseGuards(SessionGuard)
export class WahaController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get()
  list() {
    return this.db.select().from(wahaSessions).orderBy(wahaSessions.label);
  }
}
