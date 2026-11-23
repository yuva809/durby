'use client';

import { ShoppingCart } from 'lucide-react';
import { useState } from 'react';
import { useT } from '../../app/labels-provider';
import { Button } from '../ui/button';
import { Sheet, SheetContent, SheetTitle } from '../ui/sheet';
import { RequestStockPage } from './request-stock-page';

/**
 * The request cart opened from Inventory (ADR 0065): the same request page, in a side sheet, so the person stays on
 * Inventory instead of going to Order History.
 */
export function RequestCartSheet() {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="inventory-request-stock">
        <ShoppingCart aria-hidden />
        {t('inventory.overview.requestStock')}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          closeLabel={t('platform.common.close')}
          // Padded like a page (the category chips bleed into it), with room for the close button; no sideways scroll.
          className="w-full overflow-x-hidden overflow-y-auto p-4 pt-14 sm:max-w-4xl sm:p-6 sm:pt-14"
        >
          <SheetTitle className="sr-only">{t('platform.nav.requestStock')}</SheetTitle>
          {open && <RequestStockPage inSheet />}
        </SheetContent>
      </Sheet>
    </>
  );
}
