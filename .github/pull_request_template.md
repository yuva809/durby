## Summary

<!-- What does this change and why? One feature per PR. -->

- Spec: <!-- docs/modules/<name>.md, or "n/a" -->
- ADR: <!-- docs/adr/NNNN-*.md if this makes a new decision, or "n/a" -->

## Hard rules (CLAUDE.md)

Tick each box, or write "n/a" next to it with a reason.

- [ ] **Tenancy.** Every new business table has `tenant_id` and an RLS policy. Tenant comes from the session, never from body/query. DB access goes through the tenant-scoped Prisma client.
- [ ] **No tenant-specific code.** No `if (tenantId === ...)` or client names; differences are feature keys, settings, labels, custom fields or rules.
- [ ] **No hardcoded UI text.** Every user-facing string (UI, PDF, email, export, user-visible error) uses a label key with defaults in `packages/i18n` (`en`, `de`).
- [ ] **Module boundaries.** Modules import only another module's `index.ts`, never query another module's tables; cross-module side effects go through outbox events.
- [ ] **Platform vs modules.** Cross-cutting code is in `apps/api/src/platform/`; platform does not import modules.
- [ ] **Money and quantities** use `Prisma.Decimal` / `decimal.js`, never `number`; JSON carries decimals as strings.
- [ ] **Append-only history.** No UPDATE/DELETE on ledgers, journals, payments or audit logs; corrections are reversing entries.
- [ ] **Idempotency.** Every client-originated write accepts `Idempotency-Key` and is safe to replay.
- [ ] **Audit.** Every state-changing action writes an audit entry (actor, action, entity, before/after).
- [ ] **Guards.** Every endpoint declares `@RequireFeature(...)` and `@RequirePermission(...)`, or is `@Public()` / `@PlatformOnly()`.

## Tests and data

- [ ] Business logic has tests; tenant-scoped features have a cross-tenant isolation test.
- [ ] New feature, permission, label and event keys are registered in `packages/shared` / `packages/i18n`.
- [ ] Migrations: generated SQL is included below and was only run against local/test DBs.
- [ ] DB roles unchanged: `durby_app` has no BYPASSRLS, ownership or CREATE (ADR 0002).
- [ ] Ran `pnpm lint && pnpm typecheck && pnpm test` locally.

<!-- Migration SQL (if any):

```sql
```
-->
