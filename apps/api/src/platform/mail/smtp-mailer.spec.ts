import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config';
import { DEFAULT_SMTP_TIMEOUTS, SmtpMailer } from './smtp-mailer';

const message = { to: 'to@example.test', subject: 'Hello', text: 'Hi' };

describe('SmtpMailer timeouts', () => {
  let server: net.Server;
  let port: number;
  const sockets = new Set<net.Socket>();
  let mailer: SmtpMailer | undefined;

  // Accepts the TCP connection and never sends the SMTP greeting, like a filtered or stuck relay.
  beforeEach(async () => {
    server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
  });

  afterEach(async () => {
    mailer?.onModuleDestroy();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise((resolve) => server.close(resolve));
  });

  const config = () =>
    ({
      SMTP_URL: `smtp://127.0.0.1:${port}`,
      MAIL_FROM: 'Durby <no-reply@durby.test>',
    }) as AppConfig;

  it('gives up on a server that never greets, instead of waiting minutes', async () => {
    mailer = new SmtpMailer(config(), {
      connectionTimeout: 300,
      greetingTimeout: 300,
      socketTimeout: 300,
    });
    const started = Date.now();
    await expect(mailer.send(message)).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('defaults to about ten seconds, far below nodemailer’s 2 and 10 minutes', () => {
    expect(DEFAULT_SMTP_TIMEOUTS).toEqual({
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
  });
});
