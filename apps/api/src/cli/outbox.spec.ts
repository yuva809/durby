import { describe, expect, it } from 'vitest';
import { parseOutboxArgs, UsageError } from './outbox';

describe('parseOutboxArgs', () => {
  it('parses each command', () => {
    expect(parseOutboxArgs(['dead-letters'])).toEqual({ command: 'dead-letters' });
    expect(parseOutboxArgs(['dead-letters', '--org', 'o'])).toEqual({
      command: 'dead-letters',
      org: 'o',
    });
    expect(parseOutboxArgs(['retry', '--org', 'o', '--event', 'e'])).toEqual({
      command: 'retry',
      org: 'o',
      event: 'e',
    });
    expect(parseOutboxArgs(['handler-failures'])).toEqual({ command: 'handler-failures' });
    expect(parseOutboxArgs(['retry-handler', '--job', 'e@h.x'])).toEqual({
      command: 'retry-handler',
      job: 'e@h.x',
    });
  });

  it.each([
    [[]],
    [['nope']],
    [['retry', '--org', 'o']],
    [['retry-handler']],
    [['handler-failures', '--org', 'o']],
    [['dead-letters', 'extra']],
    [['--help']],
  ])('rejects %j with the usage', (argv) => {
    expect(() => parseOutboxArgs(argv)).toThrow(UsageError);
  });
});
