import { isIP } from 'node:net';
import { Injectable } from '@nestjs/common';
import { CLS_REQ, ClsService } from 'nestjs-cls';

/** Same bound as the `audit_logs_request_id_check` constraint and resolveRequestId(). */
const MAX_REQUEST_ID_LENGTH = 64;

interface RequestLike {
  /** Set by pino-http (genReqId): the incoming X-Request-Id or a generated uuid v7. */
  id?: unknown;
  /** Resolved by Express with `trust proxy` = TRUST_PROXY hops. */
  ip?: unknown;
}

/** Request id and client IP of the current HTTP request; both null outside one (CLI, jobs). */
@Injectable()
export class RequestInfo {
  constructor(private readonly cls: ClsService) {}

  current(): { requestId: string | null; ip: string | null } {
    const req = this.cls.isActive() ? this.cls.get<RequestLike | undefined>(CLS_REQ) : undefined;
    const id = req?.id;
    const ip = req?.ip;
    return {
      requestId:
        typeof id === 'string' && id.length > 0 && id.length <= MAX_REQUEST_ID_LENGTH ? id : null,
      ip: typeof ip === 'string' && isIP(ip) !== 0 ? ip : null,
    };
  }
}
