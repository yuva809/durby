import { Global, Module } from '@nestjs/common';
import { AuditLogsController } from './audit-logs.controller';
import { AuditLogsService } from './audit-logs.service';
import { AuditService } from './audit.service';
import { RequestInfo } from './request-info';

/** Audit log (docs/platform/audit.md). Depends only on tenancy, so auth and rbac can use it. */
@Global()
@Module({
  controllers: [AuditLogsController],
  providers: [AuditLogsService, AuditService, RequestInfo],
  exports: [AuditService],
})
export class AuditModule {}
