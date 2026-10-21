import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { desc } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Database } from '../../db/db.module';
import { auditLog } from '../../db/schema';
import { zodBody } from '../../common/zod.pipe';
import { Roles, SessionGuard } from '../identity/guards';
import { AuditService } from './audit.service';

const listSchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });

/** Lectura de la bitácora: solo administradores (§4.1, §8.1). */
@Controller('v1/audit')
@UseGuards(SessionGuard)
@Roles('administrador')
export class AuditController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@Query(zodBody(listSchema)) query: z.infer<typeof listSchema>) {
    return this.db.select().from(auditLog).orderBy(desc(auditLog.seq)).limit(query.limit);
  }

  /**
   * Recorre la cadena y dice si alguien la tocó. Es lo que convierte la
   * bitácora en evidencia: sin esta comprobación, el hash encadenado es
   * decoración.
   */
  @Get('verify')
  verify() {
    return this.audit.verifyChain();
  }
}
