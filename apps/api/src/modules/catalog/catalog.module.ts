import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { PricingController } from './pricing.controller';
import { CatalogBulkService } from './catalog-bulk.service';
import { CatalogLookup } from './catalog-lookup.service';
import { CatalogService } from './catalog.service';
import { CategoryImportService } from './category-import.service';
import { PricingService } from './pricing.service';

/** Product categories, products and their price rules (docs/modules/catalog.md). */
@Module({
  controllers: [CatalogController, PricingController],
  providers: [
    CatalogService,
    CatalogBulkService,
    PricingService,
    CategoryImportService,
    CatalogLookup,
  ],
  exports: [CatalogService, PricingService, CatalogLookup],
})
export class CatalogModule {}
