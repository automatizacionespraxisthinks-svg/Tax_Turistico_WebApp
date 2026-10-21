import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';

/**
 * Auditoría. Es dueño de la bitácora de solo inserción y solo expone lectura
 * a administradores (§4.1). Global porque cualquier módulo que cambia algo
 * debe poder registrarlo, pero nadie escribe en su tabla directamente.
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
