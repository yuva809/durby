import type { NotificationKind } from './api/notifications';

/**
 * The words of a notification (ADR 0047, 0083), one function for the bell, email and push. `params` are plain values
 * (decimals, dates, names): money, percentages and dates are formatted here for the reader's language.
 */

type Params = Readonly<Record<string, string>>;

export interface NotificationText {
  title: string;
  /** A second line: the bell and push show it below the title. */
  body: string | null;
}

/** What `daily_sales` carries (ADR 0083); built by the reports module. */
export interface DailySalesParams {
  /** Business day, `YYYY-MM-DD`. */
  day: string;
  currency: string;
  gross: string;
  orders: string;
  average: string;
  /** Against the normal day, one decimal; left out without a comparison. */
  percent?: string;
  /** Locations without a normal day, when the comparison leaves some out. */
  leftOut?: string;
  /** The location with the most sales, when there are several. */
  bestName?: string;
  bestGross?: string;
}

/** A decimal string as money of the locale, without going through a number. */
export function moneyText(locale: string, amount: string, currency: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(
      amount as `${number}`,
    );
  } catch {
    return `${amount} ${currency}`;
  }
}

/** "-5.0" → "-5.0 %" in the locale; `signed` puts a plus before a rise. */
export function percentText(locale: string, value: string, signed = false): string {
  const options: Intl.NumberFormatOptions = {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    ...(signed ? { signDisplay: 'exceptZero' } : {}),
  };
  try {
    return `${new Intl.NumberFormat(locale, options).format(value as `${number}`)} %`;
  } catch {
    return `${value} %`;
  }
}

/** A local date as weekday and day: "Mon, Nov 23". */
export function dayText(locale: string, day: string): string {
  const at = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return day;
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(at);
}

/** `request_submitted` → `requestSubmitted`: label keys are camelCase. */
const camel = (value: string) => value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

export function notificationText<K extends string>(
  t: (key: K, params?: Record<string, string>) => string,
  n: { kind: string; params: Params },
  locale: string,
): NotificationText {
  const label = (key: string, params?: Params) =>
    t(`platform.notifications.${key}` as K, params && { ...params });
  if (n.kind === ('daily_sales' satisfies NotificationKind))
    return dailySales(label, n.params, locale);
  const params = { ...n.params };
  if (params.status) params.status = label(`feedbackStatus.${params.status}`);
  return { title: label(`kinds.${camel(n.kind)}`, params), body: null };
}

function dailySales(
  label: (key: string, params?: Params) => string,
  params: Params,
  locale: string,
): NotificationText {
  const p = params as Params & Partial<DailySalesParams>;
  const money = (amount: string | undefined) =>
    moneyText(locale, amount ?? '0', p.currency ?? 'EUR');
  const parts = [
    label('dailySales.orders', { orders: p.orders ?? '0', average: money(p.average) }),
    p.percent === undefined
      ? null
      : label(p.leftOut ? 'dailySales.comparisonLeftOut' : 'dailySales.comparison', {
          percent: percentText(locale, p.percent, true),
          count: p.leftOut ?? '0',
        }),
    p.bestName === undefined
      ? null
      : label('dailySales.best', { location: p.bestName, amount: money(p.bestGross) }),
  ];
  return {
    title: label('kinds.dailySales', { day: dayText(locale, p.day ?? ''), amount: money(p.gross) }),
    body: parts.filter((part) => part !== null).join(' '),
  };
}
