import { Module } from '@nestjs/common';
import { PosModule } from '../pos';
import { AvailabilityController } from './availability/availability.controller';
import { AvailabilityLoader } from './availability/loader';
import { BookingsController } from './bookings/bookings.controller';
import { BookingsService } from './bookings/bookings.service';
import { PosEventsHandler } from './bookings/pos-events.handler';
import { BookingStatusService } from './bookings/status.service';
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
  // BookingsController last: its GET /reservations/:id must come after the static routes
  // (/reservations/floor, /availability, /tables, /settings, …), which Express matches in
  // registration order.
  controllers: [
    FloorController,
    AvailabilityController,
    SetupController,
    LocationSettingsController,
    BookingsController,
  ],
  providers: [
    FloorService,
    AvailabilityLoader,
    TableRulesService,
    CombinationsService,
    LocationSettingsService,
    BookingsService,
    BookingStatusService,
    PosEventsHandler,
  ],
})
export class ReservationsModule {}
