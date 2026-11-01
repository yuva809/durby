import { Module } from '@nestjs/common';
import { PosModule } from '../pos';
import { AvailabilityController } from './availability/availability.controller';
import { AvailabilityLoader } from './availability/loader';
import { FloorController } from './floor.controller';
import { FloorService } from './floor.service';

/** Reservations and the host stand (docs/modules/reservations.md). Reads pos only through its index. */
@Module({
  imports: [PosModule],
  controllers: [FloorController, AvailabilityController],
  providers: [FloorService, AvailabilityLoader],
})
export class ReservationsModule {}
