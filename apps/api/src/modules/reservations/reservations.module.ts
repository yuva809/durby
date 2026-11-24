import { Module } from '@nestjs/common';
import { PosModule } from '../pos';
import { AvailabilityController } from './availability/availability.controller';
import { AvailabilityLoader } from './availability/loader';
import { BookingsController } from './bookings/bookings.controller';
import { BookingsService } from './bookings/bookings.service';
import { GuestsController } from './bookings/guests.controller';
import { GuestsService } from './bookings/guests.service';
import { PosEventsHandler } from './bookings/pos-events.handler';
import { ReservationsRealtimeHandler } from './bookings/realtime.handler';
import { BookingStatusService } from './bookings/status.service';
import { FloorController } from './floor.controller';
import { FloorService } from './floor.service';
import { CombinationsService } from './setup/combinations.service';
import { LocationSettingsController } from './setup/location-settings.controller';
import { LocationSettingsService } from './setup/location-settings.service';
import { SetupController } from './setup/setup.controller';
import { ReservationsReader } from './reservations-reader';
import { ReservationsStreamController } from './stream.controller';
import { TableRulesService } from './setup/table-rules.service';

/** Reservations and the host stand (docs/modules/reservations.md). Reads pos only through its index. */
@Module({
  imports: [PosModule],
  // BookingsController last: its GET /reservations/:id must come after the static routes
  // (/reservations/floor, /stream, /availability, /tables, /settings, …), which Express matches in
  // registration order.
  controllers: [
    FloorController,
    ReservationsStreamController,
    AvailabilityController,
    SetupController,
    LocationSettingsController,
    GuestsController,
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
    GuestsService,
    PosEventsHandler,
    ReservationsRealtimeHandler,
    ReservationsReader,
  ],
  exports: [ReservationsReader],
})
export class ReservationsModule {}
