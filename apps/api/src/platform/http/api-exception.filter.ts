import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { TenantContextMissingError } from '../tenancy';
import { ApiError, type ApiErrorBody } from './api-error';
import { BUSY_RETRY_AFTER_SECONDS, overloadKind } from './overload';

/** Stable codes for errors raised by Nest itself (unknown route, wrong method, …). */
const STATUS_CODES: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'http.bad_request',
  [HttpStatus.UNAUTHORIZED]: 'auth.unauthenticated',
  [HttpStatus.FORBIDDEN]: 'http.forbidden',
  [HttpStatus.NOT_FOUND]: 'http.not_found',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'http.method_not_allowed',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'platform.payload_too_large',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'http.unsupported_media_type',
  [HttpStatus.TOO_MANY_REQUESTS]: 'http.too_many_requests',
};

/**
 * Every error leaves the api as `{ code, message, details? }`. Unexpected errors become a generic
 * 500 and are logged; their message never reaches the client.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body, headers } = this.toResponse(exception);
    if (res.headersSent) return;
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.status(status).json(body);
  }

  private toResponse(exception: unknown): ErrorResponse {
    const known = knownErrorResponse(exception);
    if (known) {
      // Overload is expected under load, not a bug: a warning with its kind, never the message.
      const kind = overloadKind(exception);
      if (kind) this.logger.warn({ kind }, 'database overload: answered 503 platform.busy');
      return known;
    }
    // Log the type and stack frames only: messages of driver errors can contain query values, and
    // the first line of `stack` repeats the message.
    const error = exception instanceof Error ? exception : new Error('non-Error thrown');
    const frames = (error.stack ?? '').split('\n').slice(1).join('\n');
    this.logger.error({ err: { type: error.name, stack: frames } }, 'unhandled error');
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { code: 'internal.error', message: 'Internal server error.' },
      headers: {},
    };
  }
}

export interface ErrorResponse {
  status: number;
  body: ApiErrorBody;
  headers: Readonly<Record<string, string>>;
}

/**
 * The response for an expected error (ApiError, Nest's HttpException, a missing tenant), exactly as
 * the filter sends it; null for unexpected errors, which become a logged 500. Also used by
 * platform/idempotency to store a rejected request's response.
 */
export function knownErrorResponse(exception: unknown): ErrorResponse | null {
  if (exception instanceof ApiError) {
    return { status: exception.getStatus(), body: exception.body(), headers: exception.headers };
  }
  if (exception instanceof TenantContextMissingError) {
    return {
      status: HttpStatus.FORBIDDEN,
      body: { code: exception.code, message: 'No active organization for this request.' },
      headers: {},
    };
  }
  // Waiting too long for the database (ADR 0021): retryable, with the same key.
  if (overloadKind(exception)) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      body: { code: 'platform.busy', message: 'The service is busy. Retry shortly.' },
      headers: { 'Retry-After': String(BUSY_RETRY_AFTER_SECONDS) },
    };
  }
  // A body over the parser's limit (express body-parser, e.g. a tile image over 300 KB): an
  // http-errors object, not an HttpException. Its message stays out (it is the parser's).
  if (isBodyTooLarge(exception)) {
    return {
      status: HttpStatus.PAYLOAD_TOO_LARGE,
      body: { code: 'platform.payload_too_large', message: 'The request body is too large.' },
      headers: {},
    };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return {
      status,
      body: { code: STATUS_CODES[status] ?? 'http.error', message: exception.message },
      headers: {},
    };
  }
  return null;
}

/** body-parser's error for a body over its `limit` (`type` is set by body-parser, `status` by http-errors). */
function isBodyTooLarge(exception: unknown): boolean {
  if (typeof exception !== 'object' || exception === null) return false;
  const { type, status } = exception as { type?: unknown; status?: unknown };
  return type === 'entity.too.large' && status === HttpStatus.PAYLOAD_TOO_LARGE;
}
