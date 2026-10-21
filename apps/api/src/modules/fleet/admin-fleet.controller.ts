import { Controller, Get, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../identity/guards';
import { FleetService } from './fleet.service';

/** Flota vista desde el panel: estado y posición en vivo de los 62 taxis. */
@Controller('v1/admin/drivers')
@UseGuards(SessionGuard)
export class AdminFleetController {
  constructor(private readonly fleet: FleetService) {}

  @Get()
  list() {
    return this.fleet.listWithPositions();
  }
}
