import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/platform/config';
import { SmtpMailer } from '../src/platform/mail';

// Same Mailpit image as docker-compose.yml, so local dev and the test agree.
describe('SmtpMailer (Mailpit)', () => {
  let mailpit: StartedTestContainer;
  let mailer: SmtpMailer;
  let apiUrl: string;

  beforeAll(async () => {
    mailpit = await new GenericContainer('axllent/mailpit:v1.31.4')
      .withExposedPorts(1025, 8025)
      .withWaitStrategy(Wait.forHttp('/readyz', 8025))
      .start();
    const host = mailpit.getHost();
    apiUrl = `http://${host}:${mailpit.getMappedPort(8025)}/api/v1`;
    mailer = new SmtpMailer(
      loadConfig({ ...process.env, SMTP_URL: `smtp://${host}:${mailpit.getMappedPort(1025)}` }),
    );
  });

  afterAll(async () => {
    mailer?.onModuleDestroy();
    await mailpit?.stop();
  });

  it('delivers a message with the configured sender', async () => {
    const { messageId } = await mailer.send({
      to: 'alice@example.test',
      subject: 'Hello',
      text: 'Body text',
    });
    expect(messageId).toBeTruthy();

    const res = await fetch(`${apiUrl}/messages`);
    const { messages } = (await res.json()) as {
      messages: { Subject: string; From: { Address: string }; To: { Address: string }[] }[];
    };
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      Subject: 'Hello',
      From: { Address: 'no-reply@durby.test' },
      To: [{ Address: 'alice@example.test' }],
    });
  });
});
