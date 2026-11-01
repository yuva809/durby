import { Module } from '@nestjs/common';
import { PosModule } from '../pos';
import { AvailabilityController } from './availability/availability.controller';
import { AvailabilityLoader } from './availability/loader';
import { FloorController } from './floor.controller';
import { FloorService } from './floor.service';
import { CombinationsService } from './setup/combinations.service';
import { LocationSettingsController } from './setup/location-settings.controller';
import { LocationSettingsService } from './setup/location-settings.service';
import { SetupController } from './setup/setup.controller';
import { TableRulesService } from './setup/table-rules.service';

/** Reservations and the host stand (docs/modules/reservations.md). Reads pos only through its index. */
@Module({
  imports: [PosModule],
  controllers: [
    FloorController,
    AvailabilityController,
    SetupController,
    LocationSettingsController,
  ],
  providers: [
    FloorService,
    AvailabilityLoader,
    TableRulesService,
    CombinationsService,
    LocationSettingsService,
  ],
})
export class ReservationsModule {}
