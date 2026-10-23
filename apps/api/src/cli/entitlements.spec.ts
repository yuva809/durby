import { describe, expect, it } from 'vitest';
import { parseEntitlementsArgs } from './entitlements';

const ORG = '01a16364-f7d3-7dc8-8486-0dac56f2493d';

describe('parseEntitlementsArgs', () => {
  it('reads every command', () => {
    expect(parseEntitlementsArgs(['show', '--org', ORG])).toEqual({ command: 'show', org: ORG });
    expect(parseEntitlementsArgs(['set-plan', '--org', ORG, '--plan', 'inventory'])).toEqual({
      command: 'set-plan',
      org: ORG,
      plan: 'inventory',
    });
    expect(
      parseEntitlementsArgs([
        'override',
        '--org',
        ORG,
        '--feature',
        'inventory',
        '--enable',
        '--limits',
        '{"maxLocations":5}',
      ]),
    ).toEqual({
      command: 'override',
      org: ORG,
      feature: 'inventory',
      enabled: true,
      limits: { maxLocations: 5 },
    });
    expect(
      parseEntitlementsArgs(['override', '--org', ORG, '--feature', 'pos', '--disable']),
    ).toEqual({ command: 'override', org: ORG, feature: 'pos', enabled: false, limits: undefined });
    expect(parseEntitlementsArgs(['clear-override', '--org', ORG, '--feature', 'pos'])).toEqual({
      command: 'clear-override',
      org: ORG,
      feature: 'pos',
    });
  });

  it.each([
    [[]],
    [['show']],
    [['plan-feature', '--org', ORG, '--plan', 'full', '--feature', 'pos']],
    [['set-plan', '--org', ORG]],
    [['show', '--org', ORG, '--plan', 'full']],
    [['override', '--org', ORG, '--feature', 'pos']],
    [['override', '--org', ORG, '--feature', 'pos', '--enable', '--disable']],
    [['override', '--org', ORG, '--feature', 'pos', '--disable', '--limits', '{}']],
    [['override', '--org', ORG, '--feature', 'pos', '--enable', '--limits', '{nope']],
    [['clear-override', '--org', ORG]],
    [['show', '--org', ORG, 'extra']],
    [['--help']],
  ])('rejects %j with the usage text', (argv) => {
    expect(() => parseEntitlementsArgs(argv)).toThrow(/Usage:/);
  });
});
