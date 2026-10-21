import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Options } from 'pino-http';
import { v7 as uuidv7 } from 'uuid';
import type { AppConfig } from '../config';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Requests the logger never writes an access line for (Docker healthcheck every few seconds). */
export const QUIET_PATHS: readonly string[] = ['/api/v1/health/live'];

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Defense in depth: request/response serializers below already drop headers and bodies,
 * these catch secrets passed to the logger explicitly (`logger.info({ user })`).
 */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["idempotency-key"]',
  'res.headers["set-cookie"]',
  'password',
  'token',
  'secret',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.apiKey',
  '*.authorization',
  '*.cookie',
];

/** Reuses a well-formed incoming request id (e.g. from Caddy), otherwise generates a UUID v7. */
export function resolveRequestId(incoming: string | string[] | undefined): string {
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  return candidate !== undefined && REQUEST_ID_PATTERN.test(candidate) ? candidate : uuidv7();
}

/** Path without the query string: query params can carry tokens (e.g. reset links). */
export function pathOnly(url: string | undefined): string {
  return (url ?? '').split('?', 1)[0] ?? '';
}

export function buildPinoHttpOptions(config: AppConfig): Options {
  return {
    level: config.LOG_LEVEL,
    base: { service: 'api', version: config.APP_VERSION },
    redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
    genReqId: (req: IncomingMessage, res: ServerResponse) => {
      const id = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
      res.setHeader('X-Request-Id', id);
      return id;
    },
    autoLogging: { ignore: (req) => QUIET_PATHS.includes(pathOnly(req.url)) },
    serializers: {
      req: (req: { id: string; method: string; url: string }) => ({
        id: req.id,
        method: req.method,
        path: pathOnly(req.url),
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
    ...(config.NODE_ENV === 'development' && {
      transport: { target: 'pino-pretty', options: { singleLine: true } },
    }),
  };
}
