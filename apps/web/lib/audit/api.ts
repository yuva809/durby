import { type AuditLogListResponse, auditLogListResponseSchema } from '@durby/shared';
import { type Api, read, type Result } from '../api-call';

/** One page of `GET /audit-logs` for `query` (from apiQuery), after `cursor` if given. */
export function loadAuditPage(
  store: Api,
  query: URLSearchParams,
  cursor: string | null,
): Promise<Result<AuditLogListResponse>> {
  const params = new URLSearchParams(query);
  if (cursor) params.set('cursor', cursor);
  const search = params.toString();
  return read(store, `/api/v1/audit-logs${search ? `?${search}` : ''}`, auditLogListResponseSchema);
}
