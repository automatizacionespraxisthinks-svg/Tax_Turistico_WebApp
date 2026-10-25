import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { EXPORTS_QUEUE, ExportsService } from './exports.service';
import { ExportsProcessor } from './exports.processor';
import { ExportsController } from './exports.controller';

/** Reportes: vistas de lectura y exportaciones asíncronas (§4.1). */
@Module({
  imports: [BullModule.registerQueue({ name: EXPORTS_QUEUE })],
  providers: [ReportsService, ExportsService, ExportsProcessor],
  controllers: [ReportsController, ExportsController],
  exports: [ReportsService],
})
export class ReportsModule {}
