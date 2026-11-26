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
import { BookingPagesController } from './online/booking-pages.controller';
import { BookingPagesService } from './online/booking-pages.service';
import { HoldStore } from './online/hold-store';
import { PublicBookingController } from './online/public-booking.controller';
import { PublicBookingService } from './online/public-booking.service';
import { GuestNotifier } from './waitlist/guest-notifier';
import { WaitlistController } from './waitlist/waitlist.controller';
import { WaitlistRetention } from './waitlist/waitlist.retention';
import { WaitlistService } from './waitlist/waitlist.service';

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
    WaitlistController,
    BookingPagesController,
    PublicBookingController,
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
    GuestNotifier,
    WaitlistService,
    WaitlistRetention,
    BookingPagesService,
    PublicBookingService,
    HoldStore,
  ],
  exports: [ReservationsReader],
})
export class ReservationsModule {}
