'use client';

import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { loadReservations } from '../../lib/reports/api';
import { useResource } from '../../lib/use-resource';
import { Loaded } from '../users/common';
import { Figure, type ReportContext, ReportFrame, ReportTable } from './report-frame';
import { useDuration } from './tables-report';

/** Covers, no-shows and turn times (docs/modules/reports.md). */
export function ReservationsReport() {
  return (
    <ReportFrame tab="report-reservations">
      {(context) => <Reservations context={context} />}
    </ReportFrame>
  );
}

function Reservations({ context }: { context: ReportContext }) {
  const t = useT();
  const { store } = useAuth();
  const duration = useDuration();
  const { filter, key } = context;
  const [report, reload] = useResource(key, () => loadReservations(store, filter));

  return (
    <Loaded resource={report} reload={reload}>
      {(data) => (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Figure
              metric="reservations.covers"
              value={String(data.covers)}
              note={t('reports.reservations.walkIns', { count: String(data.walkInCovers) })}
            />
            <Figure
              metric="reservations.noShowRate"
              value={data.noShowRate === null ? null : context.percent(data.noShowRate)}
              note={t('reports.reservations.noShows', {
                count: String(data.noShows),
                bookings: String(data.noShows + data.kept),
              })}
            />
            <Figure
              metric="reservations.turnMinutes"
              value={data.turnMinutes === null ? null : duration(data.turnMinutes)}
            />
          </div>
          <ReportTable
            title="reports.reservations.turnTimes"
            fileName="reports.files.turnTimes"
            filter={filter}
            rows={data.turnTimes.filter((b) => b.bookings > 0)}
            rowKey={(b) => String(b.min)}
            columns={[
              {
                label: 'reports.columns.partySize',
                cell: (b) => (b.max === null ? `${b.min}+` : `${b.min}–${b.max}`),
              },
              { label: 'reports.columns.bookings', cell: (b) => String(b.bookings), number: true },
              {
                label: 'reports.columns.averageMinutes',
                cell: (b) => (b.minutes === null ? '' : duration(b.minutes)),
                csv: (b) => (b.minutes === null ? '' : String(b.minutes)),
                number: true,
              },
            ]}
          />
        </>
      )}
    </Loaded>
  );
}
