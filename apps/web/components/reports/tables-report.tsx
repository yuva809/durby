'use client';

import { useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { durationLabel, minutesSince } from '../../lib/pos/format';
import { loadTables } from '../../lib/reports/api';
import { useResource } from '../../lib/use-resource';
import { Loaded } from '../users/common';
import { type Column, Figure, type ReportContext, ReportFrame, ReportTable } from './report-frame';

/** Table times and open tables (docs/modules/reports.md). */
export function TablesReport() {
  return <ReportFrame tab="report-tables">{(context) => <Tables context={context} />}</ReportFrame>;
}

/** "1 h 5 min". */
export function useDuration() {
  const t = useT();
  return (minutes: number) => {
    const { key, values } = durationLabel(minutes);
    return t(key, values);
  };
}

function Tables({ context }: { context: ReportContext }) {
  const t = useT();
  const { store } = useAuth();
  const duration = useDuration();
  const { filter, key, manyLocations, locationName } = context;
  const [now] = useState(() => Date.now());
  const [tables, reload] = useResource(key, () => loadTables(store, filter));
  const place = <T extends { locationId: string }>(): Column<T>[] =>
    manyLocations
      ? [{ label: 'reports.columns.location', cell: (row) => locationName(row.locationId) ?? '' }]
      : [];

  return (
    <Loaded resource={tables} reload={reload}>
      {(data) => (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Figure
              metric="tables.averageMinutes"
              value={data.averageMinutes === null ? null : duration(data.averageMinutes)}
              note={t('reports.tables.orders', { count: String(data.orders) })}
            />
            <Figure metric="tables.open" value={String(data.open.length)} />
          </div>
          <ReportTable
            title="reports.tables.openTitle"
            fileName="reports.files.openTables"
            filter={filter}
            rows={data.open}
            rowKey={(o) => o.tableId}
            columns={[
              ...place<(typeof data.open)[number]>(),
              { label: 'reports.columns.table', cell: (o) => o.name },
              {
                label: 'reports.columns.openFor',
                cell: (o) => duration(minutesSince(o.openedAt, now)),
                csv: (o) => String(minutesSince(o.openedAt, now)),
                number: true,
              },
              {
                label: 'reports.columns.guests',
                cell: (o) => (o.covers === null ? '' : String(o.covers)),
                number: true,
              },
            ]}
          />
          <ReportTable
            title="reports.tables.byTable"
            fileName="reports.files.tables"
            note="reports.tables.note"
            filter={filter}
            rows={data.tables}
            rowKey={(row) => row.tableId}
            columns={[
              ...place<(typeof data.tables)[number]>(),
              { label: 'reports.columns.table', cell: (row) => row.name },
              { label: 'reports.columns.orders', cell: (row) => String(row.orders), number: true },
              {
                label: 'reports.columns.averageMinutes',
                cell: (row) => duration(row.averageMinutes),
                csv: (row) => String(row.averageMinutes),
                number: true,
              },
            ]}
          />
        </>
      )}
    </Loaded>
  );
}
