import { describe, expect, it } from 'vitest';
import { handlerProblems } from './handler-registry';
import type { OnEventMetadata } from './on-event.decorator';

const meta = (overrides: Partial<OnEventMetadata> = {}): OnEventMetadata => ({
  type: 'config.settings.changed',
  handler: 'reports.settingsProjection',
  ...overrides,
});

describe('handlerProblems', () => {
  it('accepts a registered type with a stable name', () => {
    expect(handlerProblems([meta(), meta({ handler: 'reports.other', versions: [1] })])).toEqual(
      [],
    );
  });

  it('rejects unknown types, bad names, duplicates and missing or unknown versions', () => {
    expect(
      handlerProblems([
        meta({ type: 'config.settings.removed' as never }),
        meta({ handler: 'SettingsProjection.apply' }),
        meta(),
        meta(),
        meta({ handler: 'reports.v2', versions: [2] }),
      ]),
    ).toEqual([
      'reports.settingsProjection: unknown event type config.settings.removed',
      'SettingsProjection.apply: handler name must be module.camelCaseName',
      'reports.settingsProjection: duplicate handler name',
      'reports.v2: config.settings.changed has no version 2',
      'reports.v2: must read the current version 1 of config.settings.changed',
    ]);
  });
});
