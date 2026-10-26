import { Controller, Get, Query } from '@nestjs/common';
import { auditLogQuerySchema, type AuditLogListResponse, type AuditLogQuery } from '@durby/shared';
import { ZodQuery } from '../http';
import { RequirePermission } from '../markers';
import { AuditLogsService } from './audit-logs.service';

/** /api/v1/audit-logs (docs/platform/audit.md). Read-only. */
@Controller('audit-logs')
export class AuditLogsController {
  constructor(private readonly auditLogs: AuditLogsService) {}

  @RequirePermission('platform.audit.read')
  @Get()
  list(
    @Query(new ZodQuery(auditLogQuerySchema)) query: AuditLogQuery,
  ): Promise<AuditLogListResponse> {
    return this.auditLogs.list(query);
  }
}
