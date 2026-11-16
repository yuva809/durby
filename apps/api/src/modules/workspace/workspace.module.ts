import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog';
import { InventoryModule } from '../inventory';
import { OrdersModule } from '../orders';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';

/** The top bar's search and "waiting for me" across modules (ADR 0046). */
@Module({
  imports: [CatalogModule, InventoryModule, OrdersModule],
  controllers: [WorkspaceController],
  providers: [WorkspaceService],
})
export class WorkspaceModule {}
