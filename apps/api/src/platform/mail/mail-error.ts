/** What may be logged about a failed send: no message text, address, URL, credential or token. */
export interface MailErrorFields {
  type: string;
  code?: string;
  responseCode?: number;
  command?: string;
}

const IDENTIFIER = /^[A-Za-z0-9_ -]{1,32}$/;

const identifier = (value: unknown): string | undefined =>
  typeof value === 'string' && IDENTIFIER.test(value) ? value : undefined;

/**
 * Nodemailer errors carry `code` (ETIMEDOUT, EAUTH, EENVELOPE, …), `responseCode` (the SMTP reply
 * code) and `command` (the SMTP step). `message` and `response` are left out on purpose: they can
 * echo the recipient or the server's reply. Values that don't look like identifiers are dropped.
 */
export function mailErrorFields(error: unknown): MailErrorFields {
  if (typeof error !== 'object' || error === null) return { type: 'unknown' };
  const { name, code, responseCode, command } = error as Record<string, unknown>;
  const fields: MailErrorFields = { type: identifier(name) ?? 'unknown' };
  const safeCode = identifier(code);
  if (safeCode) fields.code = safeCode;
  if (typeof responseCode === 'number' && Number.isInteger(responseCode)) {
    fields.responseCode = responseCode;
  }
  const safeCommand = identifier(command);
  if (safeCommand) fields.command = safeCommand;
  return fields;
}
