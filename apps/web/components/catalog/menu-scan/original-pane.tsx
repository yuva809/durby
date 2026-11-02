'use client';

import { useState } from 'react';
import { useT } from '../../../app/labels-provider';
import type { Board } from '../../../lib/catalog/menu-scan/board';
import { cn } from '../../../lib/utils';
import { Button } from '../../ui/button';

export interface PagePreview {
  number: number;
  width: number;
  height: number;
  url: string;
}

/**
 * The scanned pages with each product's source line boxed: selecting a product highlights its line
 * (and turns to its page); clicking a box selects the product. Boxes are placed in percent, so the
 * image can scale with the pane.
 */
export function OriginalPane({
  pages,
  board,
  selectedId,
  onSelect,
}: {
  pages: readonly PagePreview[];
  board: Board;
  selectedId: string | null;
  onSelect: (productId: string) => void;
}) {
  const t = useT();
  const selected = selectedId ? board.products[selectedId] : undefined;
  const [chosenPage, setChosenPage] = useState(1);
  const pageNumber = selected?.source?.page ?? chosenPage;
  const page = pages.find((p) => p.number === pageNumber) ?? pages[0];
  if (!page) {
    return <p className="p-4 text-sm text-muted-foreground">{t('catalog.scan.noOriginal')}</p>;
  }
  const products = Object.values(board.products).filter((p) => p.source?.page === page.number);

  return (
    <div className="flex flex-col gap-2" data-testid="scan-original">
      {pages.length > 1 && (
        <div className="flex flex-wrap gap-1">
          {pages.map((p) => (
            <Button
              key={p.number}
              variant={p.number === page.number ? 'default' : 'outline'}
              onClick={() => setChosenPage(p.number)}
            >
              {t('catalog.scan.page', { page: String(p.number) })}
            </Button>
          ))}
        </div>
      )}
      <div className="relative overflow-hidden rounded-md border bg-muted">
        {/* A data URL made on this device: next/image adds nothing. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={page.url}
          alt={t('catalog.scan.page', { page: String(page.number) })}
          className="block w-full"
        />
        {products.map((p) => {
          const box = p.source!.box;
          const active = p.id === selectedId;
          return (
            <button
              key={p.id}
              type="button"
              aria-label={p.name}
              title={p.name}
              onClick={() => onSelect(p.id)}
              className={cn(
                'absolute rounded-sm border-2 transition-colors',
                active
                  ? 'border-primary bg-primary/20'
                  : 'border-transparent hover:border-ring hover:bg-ring/10',
              )}
              style={{
                left: `${(box.x0 / page.width) * 100}%`,
                top: `${(box.y0 / page.height) * 100}%`,
                width: `${((box.x1 - box.x0) / page.width) * 100}%`,
                height: `${((box.y1 - box.y0) / page.height) * 100}%`,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
