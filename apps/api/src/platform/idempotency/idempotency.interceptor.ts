import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  RequestMethod,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  idempotencyKeySchema,
} from '@durby/shared';
import type { Request, Response } from 'express';
import { type Observable, of } from 'rxjs';
import { PinoLogger } from 'nestjs-pino';
import { canonicalJson } from '../audit';
import { ApiError, knownErrorResponse } from '../http';
import { TenantContext } from '../tenancy';
import { IDEMPOTENT_KEY, type IdempotentOptions } from './idempotent.decorator';
import { idempotencyErrors } from './idempotency-errors';
import { IdempotencyService, type RequestLease } from './idempotency.service';
import { IdempotencyStore } from './idempotency.store';
import { asJson, findSecretKey, isStoredStatus, requestHash } from './storage-policy';

/**
 * Idempotency-Key for routes marked @Idempotent() (docs/platform/idempotency.md, ADR 0014). Runs
 * after the guards, so the tenant and user are known and refused requests leave no row. Replays
 * the stored result, refuses a reused key (422) or a running one (409), and stores the outcome:
 * 2xx and decided 4xx; 5xx and token-like bodies release the key instead.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantContext: TenantContext,
    private readonly store: IdempotencyStore,
    private readonly idempotency: IdempotencyService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('idempotency');
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const options = this.reflector.get<Required<IdempotentOptions> | undefined>(
      IDEMPOTENT_KEY,
      context.getHandler(),
    );
    if (!options || context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const raw = req.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()];
    if (raw === undefined) throw idempotencyErrors.keyRequired();
    if (typeof raw !== 'string' || !idempotencyKeySchema.safeParse(raw).success) {
      throw idempotencyErrors.keyInvalid();
    }

    const { tenantId, userId } = this.tenantContext.require();
    const routePath = (req.route as { path?: string } | undefined)?.path ?? req.path;
    const route = `${req.method} ${routePath}`;
    const begun = await this.store.begin(
      { tenantId, userId, route, key: raw },
      requestHash(req.method, req.originalUrl, req.body),
    );
    switch (begun.kind) {
      case 'reused':
        throw idempotencyErrors.keyReused();
      case 'in_progress':
        throw idempotencyErrors.requestInProgress();
      case 'replay':
        return of(this.replay(res, begun.status, begun.body, successStatusOf(context, req)));
      case 'started':
        break;
    }

    const current: RequestLease = {
      lease: begun.lease,
      successStatus: successStatusOf(context, req),
      completion: options.completion,
    };
    this.idempotency.begin(current);
    if (begun.lease.takenOver) {
      this.logger.warn({ event: 'idempotency.taken_over', route }, 'idempotency.taken_over');
    }

    let value: unknown;
    try {
      value = await lastValue(next);
    } catch (error) {
      await this.finishError(current, route, error);
      throw error;
    }
    await this.finishSuccess(current, route, value);
    return of(value);
  }

  private async finishSuccess(current: RequestLease, route: string, value: unknown): Promise<void> {
    const body = asJson(value);
    if (current.storedBody !== undefined) {
      if (canonicalJson(current.storedBody) !== canonicalJson(body)) {
        this.logger.error(
          { event: 'idempotency.completion_mismatch', route },
          'idempotency.completion_mismatch',
        );
      }
      return;
    }
    if (current.completion === 'transaction') {
      this.logger.error(
        { event: 'idempotency.completion_missing', route },
        'idempotency.completion_missing',
      );
    }
    await this.save(current, route, current.successStatus, body);
  }

  private async finishError(current: RequestLease, route: string, error: unknown): Promise<void> {
    // Completed in the business transaction and failed afterwards: the stored result stands.
    if (current.storedBody !== undefined) return;
    const known = knownErrorResponse(error);
    if (!known || !isStoredStatus(known.status)) {
      await this.store.release(current.lease);
      return;
    }
    await this.save(current, route, known.status, known.body);
  }

  private async save(current: RequestLease, route: string, status: number, body: unknown) {
    const secret = findSecretKey(body);
    if (secret) {
      this.logger.error(
        { event: 'idempotency.secret_in_response', route, field: secret },
        'idempotency.secret_in_response',
      );
      await this.store.release(current.lease);
      return;
    }
    if (!(await this.store.complete(current.lease, status, body))) {
      this.logger.warn({ event: 'idempotency.lease_lost', route }, 'idempotency.lease_lost');
    }
  }

  private replay(res: Response, status: number, body: unknown, successStatus: number): unknown {
    res.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
    if (status >= 400) {
      const error = body as { code?: string; message?: string; details?: unknown } | null;
      throw new ApiError(
        status,
        error?.code ?? 'http.error',
        error?.message ?? '',
        error?.details,
        { [IDEMPOTENT_REPLAYED_HEADER]: 'true' },
      );
    }
    // Nest sends the route's own success status; a stored one differs only if @HttpCode changed.
    if (status !== successStatus) res.status(status);
    return body ?? undefined;
  }
}

/** The status Nest sends on success: the route's @HttpCode, or 201 for POST and 200 otherwise. */
function successStatusOf(context: ExecutionContext, req: Request): number {
  const code = Reflect.getMetadata(HTTP_CODE_METADATA, context.getHandler()) as number | undefined;
  if (code !== undefined) return code;
  return req.method === RequestMethod[RequestMethod.POST] ? 201 : 200;
}

/** Runs the handler and returns its last emitted value (Nest handlers emit once). */
function lastValue(next: CallHandler): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let value: unknown;
    next.handle().subscribe({
      next: (v: unknown) => (value = v),
      error: reject,
      complete: () => resolve(value),
    });
  });
}
