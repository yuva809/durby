import { describe, expect, it } from 'vitest';
import { mailErrorFields } from './mail-error';

describe('mailErrorFields', () => {
  it('keeps only the safe diagnostic fields of a nodemailer error', () => {
    const error = Object.assign(new Error('Invalid login for secret-user@example.test'), {
      code: 'EAUTH',
      responseCode: 535,
      command: 'AUTH PLAIN',
      response: '535 smtps://resend:example-secret-value@smtp.resend.com rejected',
    });
    const fields = mailErrorFields(error);
    expect(fields).toEqual({
      type: 'Error',
      code: 'EAUTH',
      responseCode: 535,
      command: 'AUTH PLAIN',
    });
    expect(JSON.stringify(fields)).not.toMatch(/secret|re_|@/);
  });

  it('drops values that are not plain identifiers', () => {
    const error = Object.assign(new Error('x'), {
      code: 'connect to https://x.test/#token=abc failed',
      command: 'a@b.test',
      responseCode: '535',
    });
    expect(mailErrorFields(error)).toEqual({ type: 'Error' });
  });

  it('copes with values that are not errors', () => {
    expect(mailErrorFields('boom')).toEqual({ type: 'unknown' });
    expect(mailErrorFields(null)).toEqual({ type: 'unknown' });
  });
});
