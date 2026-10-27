import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { zodBody } from '../../common/zod.pipe';
import { SessionGuard } from '../identity/guards';
import { ReportsService } from './reports.service';

const rangeSchema = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) });

@Controller('v1/reports')
@UseGuards(SessionGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('summary')
  summary(@Query(zodBody(rangeSchema)) query: z.infer<typeof rangeSchema>) {
    return this.reports.summary(query.days);
  }

  @Get('rides-by-hour')
  ridesByHour(@Query(zodBody(rangeSchema)) query: z.infer<typeof rangeSchema>) {
    return this.reports.ridesByHour(query.days);
  }

  @Get('assignment-times')
  assignmentTimes(@Query(zodBody(rangeSchema)) query: z.infer<typeof rangeSchema>) {
    return this.reports.assignmentTimes(query.days);
  }

  @Get('demand-by-zone')
  demandByZone(@Query(zodBody(rangeSchema)) query: z.infer<typeof rangeSchema>) {
    return this.reports.demandByZone(query.days);
  }

  @Get('automation-rate')
  automationRate(@Query(zodBody(rangeSchema)) query: z.infer<typeof rangeSchema>) {
    return this.reports.automationRate(query.days);
  }
}
