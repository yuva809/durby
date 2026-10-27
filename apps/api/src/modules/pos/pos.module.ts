import { Module } from '@nestjs/common';
import { TablesController } from './tables.controller';
import { TablesService } from './tables.service';

/** Table service (docs/modules/pos.md). Step 1: dining tables. */
@Module({
  controllers: [TablesController],
  providers: [TablesService],
  exports: [TablesService],
})
export class PosModule {}
