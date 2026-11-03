'use client';

import { useState } from 'react';
import { useT } from '../../../app/labels-provider';
import type { Board } from '../../../lib/catalog/menu-scan/board';
import { cn } from '../../../lib/utils';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '../../ui/button';
import { Select } from '../../ui/select';

/** Up to this many pages get a button each; more get a page picker. */
const PAGE_BUTTONS = 4;

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
  // Selecting a product turns to its page; the page buttons or picker turn freely after that.
  const [view, setView] = useState({ selectedId, page: selected?.source?.page ?? 1 });
  if (view.selectedId !== selectedId) {
    setView({ selectedId, page: selected?.source?.page ?? view.page });
  }
  const setChosenPage = (page: number) => setView({ selectedId, page });
  const pageNumber = view.page;
  const page = pages.find((p) => p.number === pageNumber) ?? pages[0];
  if (!page) {
    return <p className="p-4 text-sm text-muted-foreground">{t('catalog.scan.noOriginal')}</p>;
  }
  const products = Object.values(board.products).filter((p) => p.source?.page === page.number);
  const index = pages.indexOf(page);

  return (
    <div className="flex flex-col gap-2" data-testid="scan-original">
      {pages.length > 1 && pages.length <= PAGE_BUTTONS && (
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
      {pages.length > PAGE_BUTTONS && (
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            aria-label={t('catalog.scan.previousPage')}
            disabled={index <= 0}
            onClick={() => setChosenPage(pages[index - 1]!.number)}
          >
            <ChevronLeft aria-hidden />
          </Button>
          <Select
            aria-label={t('catalog.scan.original')}
            value={String(page.number)}
            onChange={(e) => setChosenPage(Number(e.target.value))}
            className="flex-1"
            data-testid="scan-page-select"
          >
            {pages.map((p) => (
              <option key={p.number} value={p.number}>
                {t('catalog.scan.pageOf', { page: String(p.number), pages: String(pages.length) })}
              </option>
            ))}
          </Select>
          <Button
            variant="outline"
            size="icon"
            aria-label={t('catalog.scan.nextPage')}
            disabled={index >= pages.length - 1}
            onClick={() => setChosenPage(pages[index + 1]!.number)}
          >
            <ChevronRight aria-hidden />
          </Button>
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
