import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { filtrosDeInformeSchema, type FiltrosDeInforme } from '@tax/shared';
import { zodBody } from '../../common/zod.pipe';
import { SessionGuard } from '../identity/guards';
import { ReportsService } from './reports.service';

/**
 * El tablero de Reportes. Una sola consulta trae todo lo de la pantalla con
 * los mismos filtros: así ninguna tarjeta cuenta un periodo distinto del de
 * la gráfica de al lado.
 */
@Controller('v1/reports')
@UseGuards(SessionGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('dashboard')
  dashboard(@Query(zodBody(filtrosDeInformeSchema)) filtros: FiltrosDeInforme) {
    return this.reports.tablero(filtros);
  }

  /** Lo que se puede elegir en cada filtro: zonas, conductores y líneas. */
  @Get('filters')
  filters() {
    return this.reports.opciones();
  }
}
