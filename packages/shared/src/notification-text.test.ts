import { describe, expect, it } from 'vitest';
import { defaultPreference, NOTIFICATION_KINDS, notificationPath } from './api/notifications';
import { dayText, moneyText, notificationText, percentText } from './notification-text';

/** Shows the key and the params: the words themselves are tested where the labels are. */
const t = (key: string, params?: Record<string, string>) =>
  `${key.replace('platform.notifications.', '')}${params ? JSON.stringify(params) : ''}`;

describe('notification text', () => {
  const daily = (params: Record<string, string>, locale = 'en') =>
    notificationText(
      t,
      {
        kind: 'daily_sales',
        params: {
          day: '2026-11-23',
          currency: 'EUR',
          gross: '1240.00',
          orders: '52',
          average: '23.85',
          ...params,
        },
      },
      locale,
    );

  it('formats the daily report for the reader', () => {
    expect(daily({ percent: '8.0' })).toEqual({
      title: 'kinds.dailySales{"day":"Mon, Nov 23","amount":"€1,240.00"}',
      body: 'dailySales.orders{"orders":"52","average":"€23.85"} dailySales.comparison{"percent":"+8.0 %","count":"0"}',
    });
    const german = daily({ percent: '-8.0' }, 'de');
    expect(german.title.replace(/\s/g, ' ')).toContain('"Mo., 23. Nov.","amount":"1.240,00 €"');
    expect(german.body).toContain('"-8,0 %"');
  });

  it('leaves out what there is not', () => {
    expect(daily({}).body).toBe('dailySales.orders{"orders":"52","average":"€23.85"}');
    const full = daily({ percent: '0.0', leftOut: '2', bestName: 'Mitte', bestGross: '800.00' });
    expect(full.body).toContain('dailySales.comparisonLeftOut{"percent":"0.0 %","count":"2"}');
    expect(full.body).toContain('dailySales.best{"location":"Mitte","amount":"€800.00"}');
  });

  it('words the other kinds in one line', () => {
    expect(
      notificationText(t, { kind: 'request_submitted', params: { number: 'S1' } }, 'en'),
    ).toEqual({ title: 'kinds.requestSubmitted{"number":"S1"}', body: null });
    expect(
      notificationText(t, { kind: 'feedback_answered', params: { status: 'done' } }, 'en').title,
    ).toBe('kinds.feedbackAnswered{"status":"feedbackStatus.done"}');
  });

  it('survives values it does not know', () => {
    expect(moneyText('en', '1.00', 'nope')).toBe('1.00 nope');
    expect(dayText('en', 'nonsense')).toBe('nonsense');
    expect(percentText('not a locale', '1.0')).toBe('1.0 %');
  });
});

describe('defaults', () => {
  it('only the daily report is pushed without asking for it', () => {
    expect(NOTIFICATION_KINDS.filter((k) => defaultPreference(k).push)).toEqual(['daily_sales']);
    expect(defaultPreference('daily_sales').email).toBe(false);
  });

  it('the daily report leads to the overview', () => {
    const entityId = '0190a000-0000-7000-8000-000000000001';
    expect(notificationPath({ kind: 'daily_sales', entityType: 'daily_report', entityId })).toBe(
      '/',
    );
  });
});
