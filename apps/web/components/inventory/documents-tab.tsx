'use client';

import { STOCK_DOCUMENT_KINDS, type StockDocumentKind } from '@durby/shared';
import { ArrowLeft } from 'lucide-react';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { loadDocument, loadDocuments } from '../../lib/inventory/api';
import { shortQuantity } from '../../lib/inventory/format';
import { useResource } from '../../lib/use-resource';
import { useMoney } from '../pos/money';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { Loaded } from '../users/common';
import { type InventoryData, warehouseLabel } from './inventory-page';

/** Booked documents, newest first, by kind; one opens with its lines. */
export function DocumentsTab({ data }: { data: InventoryData }) {
  const t = useT();
  const id = useId();
  const money = useMoney();
  const { store } = useAuth();
  const [kind, setKind] = useState<StockDocumentKind | ''>('');
  const [open, setOpen] = useState<string | null>(null);
  const [documents, reload] = useResource(`documents:${kind}`, () =>
    loadDocuments(store, kind ? { kind } : {}),
  );
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });
  const names = new Map(data.warehouses.map((w) => [w.id, warehouseLabel(data, w)]));

  if (open) {
    return <DocumentDetail id={open} names={names} onBack={() => setOpen(null)} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid max-w-56 gap-1.5">
        <Label htmlFor={`${id}-kind`}>{t('inventory.fields.kind')}</Label>
        <Select
          id={`${id}-kind`}
          value={kind}
          onChange={(e) => setKind(e.target.value as StockDocumentKind | '')}
          data-testid="documents-kind"
        >
          <option value="">{t('inventory.page.allKinds')}</option>
          {STOCK_DOCUMENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`inventory.kinds.${k}`)}
            </option>
          ))}
        </Select>
      </div>
      <Loaded resource={documents} reload={reload}>
        {(list) =>
          list.length === 0 ? (
            <p className="text-muted-foreground">{t('inventory.page.emptyDocuments')}</p>
          ) : (
            <Card className="divide-y p-0">
              {list.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-muted"
                  onClick={() => setOpen(d.id)}
                  data-testid="document-row"
                  data-number={d.number}
                >
                  <span className="flex flex-col">
                    <span className="font-medium">
                      {d.number} · {t(`inventory.kinds.${d.kind}`)}
                      {d.reason && ` · ${t(`inventory.reasons.${d.reason}`)}`}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {names.get(d.warehouseId) ?? d.warehouseName}
                      {d.toWarehouseId && ` → ${names.get(d.toWarehouseId) ?? d.toWarehouseName}`}
                      {d.supplier && ` · ${d.supplier}`}
                    </span>
                  </span>
                  <span className="flex flex-col items-end">
                    {d.value !== null && (
                      <span className="font-medium tabular-nums">{money(d.value)}</span>
                    )}
                    <span className="text-sm text-muted-foreground">
                      {date.format(new Date(d.createdAt))}
                    </span>
                  </span>
                </button>
              ))}
            </Card>
          )
        }
      </Loaded>
    </div>
  );
}

function DocumentDetail({
  id,
  names,
  onBack,
}: {
  id: string;
  names: Map<string, string>;
  onBack: () => void;
}) {
  const t = useT();
  const money = useMoney();
  const { store } = useAuth();
  const [document, reload] = useResource(id, () => loadDocument(store, id));
  return (
    <div className="flex flex-col gap-4">
      <Button variant="ghost" className="gap-2 self-start" onClick={onBack}>
        <ArrowLeft aria-hidden />
        {t('inventory.page.backToDocuments')}
      </Button>
      <Loaded resource={document} reload={reload}>
        {(d) => (
          <Card className="flex flex-col gap-3 p-4" data-testid="document-detail">
            <h2 className="text-lg font-semibold">
              {t('inventory.page.documentTitle', {
                kind: t(`inventory.kinds.${d.kind}`),
                number: d.number,
              })}
            </h2>
            {d.note && <p className="text-sm text-muted-foreground">{d.note}</p>}
            <ul className="divide-y">
              {d.lines.map((l) => (
                <li
                  key={l.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                  data-testid="document-line"
                >
                  <span>
                    <span className="font-medium">{l.itemName}</span>
                    <span className="text-muted-foreground"> · {names.get(l.warehouseId)}</span>
                  </span>
                  <span className="tabular-nums">
                    {`${shortQuantity(l.quantity)} ${t(`inventory.units.${l.unit}`)}`}
                    {l.unitCost !== null &&
                      l.value !== null &&
                      ` × ${money(l.unitCost)} = ${money(l.value)}`}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </Loaded>
    </div>
  );
}
