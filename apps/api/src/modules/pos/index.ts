// Public API of the pos module (docs/modules/pos.md). Other modules import only this file.
export { PosModule } from './pos.module';
export { TablesService } from './tables.service';
export { AreasService } from './areas.service';
export { type FloorTable, type OpenOrderRef, type OrderRef, PosFloorReader } from './floor-reader';
export { type OrderFacts, PosSalesReader, type SoldLine } from './sales-reader';
