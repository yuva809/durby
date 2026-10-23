import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { RequestInfo } from './request-info';

/** Audit log (docs/platform/audit.md). Depends only on tenancy, so auth and rbac can use it. */
@Global()
@Module({
  providers: [AuditService, RequestInfo],
  exports: [AuditService],
})
export class AuditModule {}
