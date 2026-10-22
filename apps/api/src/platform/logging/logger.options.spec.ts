import { createServer } from 'node:http';
import { Writable } from 'node:stream';
import type { Logger } from 'pino';
import pinoHttp from 'pino-http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config';
import { buildPinoHttpOptions, pathOnly, resolveRequestId } from './logger.options';

// Only the fields the logger reads.
const config = {
  NODE_ENV: 'production',
  PORT: 4000,
  APP_VERSION: '1.2.3',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgresql://durby_app:secret@localhost:5432/durby',
  REDIS_URL: 'redis://localhost:6379',
} as AppConfig;

/** Runs one request through pino-http with our options and returns the JSON lines it wrote. */
function serverWithCapturedLogs(handler?: (log: Logger) => void) {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      done();
    },
  });
  const logger = pinoHttp(buildPinoHttpOptions(config), stream);
  const server = createServer((req, res) => {
    logger(req, res);
    handler?.(req.log);
    res.end('ok');
  });
  return { server, lines };
}

describe('resolveRequestId', () => {
  it('keeps a well-formed incoming id', () => {
    expect(resolveRequestId('abc-123')).toBe('abc-123');
    expect(resolveRequestId(['first-id', 'second'])).toBe('first-id');
  });

  it.each([undefined, '', 'has spaces', 'x'.repeat(65), 'quote"inject'])(
    'replaces %j with a UUID v7',
    (incoming) => {
      expect(resolveRequestId(incoming)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    },
  );
});

describe('pathOnly', () => {
  it('drops the query string', () => {
    expect(pathOnly('/api/v1/reset?token=abc')).toBe('/api/v1/reset');
    expect(pathOnly(undefined)).toBe('');
  });
});

describe('buildPinoHttpOptions', () => {
  it('echoes the request id and logs it with the access line', async () => {
    const { server, lines } = serverWithCapturedLogs();
    const res = await request(server).get('/api/v1/things').set('X-Request-Id', 'req-42');

    expect(res.headers['x-request-id']).toBe('req-42');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      service: 'api',
      version: '1.2.3',
      req: { id: 'req-42', method: 'GET', path: '/api/v1/things' },
      res: { statusCode: 200 },
    });
  });

  it('never writes headers, cookies or query strings', async () => {
    const { server, lines } = serverWithCapturedLogs();
    await request(server)
      .get('/api/v1/reset?token=query-secret')
      .set('Authorization', 'Bearer header-secret')
      .set('Cookie', 'session=cookie-secret');

    const output = JSON.stringify(lines);
    expect(output).not.toContain('header-secret');
    expect(output).not.toContain('cookie-secret');
    expect(output).not.toContain('query-secret');
  });

  it('redacts secrets passed to the logger explicitly', async () => {
    const { server, lines } = serverWithCapturedLogs((log) =>
      log.info({ user: { email: 'a@b.test', password: 'pw-secret' }, token: 'tok-secret' }),
    );
    await request(server).get('/api/v1/login');

    const output = JSON.stringify(lines);
    expect(output).not.toContain('pw-secret');
    expect(output).not.toContain('tok-secret');
    expect(output).toContain('[REDACTED]');
  });

  it('does not log the liveness probe', async () => {
    const { server, lines } = serverWithCapturedLogs();
    await request(server).get('/api/v1/health/live');
    expect(lines).toHaveLength(0);
  });
});
