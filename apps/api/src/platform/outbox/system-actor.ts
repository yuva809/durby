/**
 * The tenant context's user for outbox work (dispatch, handlers, cleanup): no person acts. Audit
 * rows written by handlers use auditActor.system('job.outbox'), never this id.
 */
export const OUTBOX_SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
