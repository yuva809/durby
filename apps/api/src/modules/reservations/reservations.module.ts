import { Module } from '@nestjs/common';
import { PosModule } from '../pos';
import { FloorController } from './floor.controller';
import { FloorService } from './floor.service';

/** Reservations and the host stand (docs/modules/reservations.md). Reads pos only through its index. */
@Module({
  imports: [PosModule],
  controllers: [FloorController],
  providers: [FloorService],
})
export class ReservationsModule {}
