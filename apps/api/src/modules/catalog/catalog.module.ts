import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { CatalogBulkService } from './catalog-bulk.service';
import { CatalogService } from './catalog.service';

/** Product categories and products (docs/modules/catalog.md). */
@Module({
  controllers: [CatalogController],
  providers: [CatalogService, CatalogBulkService],
  exports: [CatalogService],
})
export class CatalogModule {}
