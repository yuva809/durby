import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MailDispatcher } from './mail-dispatcher';

describe('MailDispatcher', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports a delivered mail', async () => {
    const send = vi.fn(() => Promise.resolve({ messageId: 'm1' }));
    expect(await new MailDispatcher().dispatch('test.mail_failed', send)).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('swallows a failure and logs the safe fields only', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const failure = Object.assign(
      new Error('connect ETIMEDOUT 1.2.3.4:465 for person@example.test'),
      {
        code: 'ETIMEDOUT',
        command: 'CONN',
      },
    );
    const outcome = await new MailDispatcher().dispatch('test.mail_failed', () =>
      Promise.reject(failure),
    );
    expect(outcome).toBe('failed');
    expect(error).toHaveBeenCalledWith(
      { event: 'test.mail_failed', err: { type: 'Error', code: 'ETIMEDOUT', command: 'CONN' } },
      'mail failed',
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain('person@example.test');
  });

  it('also catches a send that throws synchronously', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const outcome = await new MailDispatcher().dispatch('test.mail_failed', () => {
      throw new TypeError('bad template');
    });
    expect(outcome).toBe('failed');
  });

  it('stops waiting for a slow send and still logs its failure later', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    let fail: (reason: Error) => void = () => undefined;
    const slow = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });
    const started = Date.now();
    const outcome = await new MailDispatcher().dispatch('test.mail_failed', () => slow, 50);
    expect(outcome).toBe('pending');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(error).not.toHaveBeenCalled();

    fail(Object.assign(new Error('late'), { code: 'ETIMEDOUT' }));
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
  });
});
