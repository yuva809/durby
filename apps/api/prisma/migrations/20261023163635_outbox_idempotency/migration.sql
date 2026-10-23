-- CreateEnum
CREATE TYPE "idempotency_key_status" AS ENUM ('in_progress', 'completed');

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),
    "dead_lettered_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "handler" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "route" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" "idempotency_key_status" NOT NULL DEFAULT 'in_progress',
    "lock_token" UUID NOT NULL,
    "locked_until" TIMESTAMPTZ(6) NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_tenant_id_id_key" ON "outbox_events"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "processed_events_tenant_id_processed_at_idx" ON "processed_events"("tenant_id", "processed_at");

-- CreateIndex
CREATE UNIQUE INDEX "processed_events_tenant_id_id_key" ON "processed_events"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "processed_events_tenant_id_handler_event_id_key" ON "processed_events"("tenant_id", "handler", "event_id");

-- CreateIndex
CREATE INDEX "idempotency_keys_tenant_id_expires_at_idx" ON "idempotency_keys"("tenant_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_tenant_id_id_key" ON "idempotency_keys"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_tenant_id_user_id_route_key_key" ON "idempotency_keys"("tenant_id", "user_id", "route", "key");

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "processed_events" ADD CONSTRAINT "processed_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Partial indexes (ADR 0013 §12). Prisma can't express them: test/outbox-migration.int.spec.ts fails
-- if one disappears or loses its predicate, and `prisma migrate diff` was checked to keep them.
-- Pending events across tenants, for outbox_due_tenants().
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events"("available_at")
  WHERE "published_at" IS NULL AND "dead_lettered_at" IS NULL;
-- Pending events of one tenant, for the claim.
CREATE INDEX "outbox_events_tenant_pending_idx" ON "outbox_events"("tenant_id", "available_at")
  WHERE "published_at" IS NULL AND "dead_lettered_at" IS NULL;
-- Published events of one tenant, for retention cleanup.
CREATE INDEX "outbox_events_tenant_published_idx" ON "outbox_events"("tenant_id", "published_at")
  WHERE "published_at" IS NOT NULL;

-- Shape checks. Types and payloads are validated by the api against packages/shared/src/events;
-- SQL backs up the shape and the size.
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_type_check"
  CHECK ("type" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$');
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_shape_check" CHECK (
  "version" >= 1 AND "attempts" >= 0
  AND jsonb_typeof("payload") = 'object' AND octet_length("payload"::text) <= 8192
  AND char_length(coalesce("last_error", '')) <= 2000
  AND NOT ("published_at" IS NOT NULL AND "dead_lettered_at" IS NOT NULL)
);
ALTER TABLE "processed_events" ADD CONSTRAINT "processed_events_handler_check"
  CHECK (char_length("handler") <= 100 AND "handler" ~ '^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$');
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_shape_check" CHECK (
  "key" ~ '^[\x21-\x7E]{1,255}$' AND "request_hash" ~ '^[0-9a-f]{64}$'
  AND char_length("route") <= 200 AND "expires_at" > "created_at"
);
-- Completed iff a response is stored; 5xx are never stored (ADR 0014 §5).
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_completion_check" CHECK (
  ("status" = 'completed') = ("response_status" IS NOT NULL AND "completed_at" IS NOT NULL)
  AND ("response_status" IS NULL OR "response_status" BETWEEN 200 AND 499)
);

-- Row-level security (ADR 0005).
ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "outbox_events"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "processed_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "processed_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "processed_events"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "idempotency_keys"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- App privileges (ADR 0013 §11). The default privileges of ADR 0002 grant DML to durby_app:
-- type, version, payload and tenant of an event are immutable; dedupe rows are insert/delete only.
REVOKE UPDATE ON "outbox_events" FROM durby_app;
GRANT UPDATE ("available_at", "published_at", "dead_lettered_at", "attempts", "last_error")
  ON "outbox_events" TO durby_app;
REVOKE UPDATE ON "processed_events" FROM durby_app;

-- Cross-tenant scheduling (ADR 0013 §3, under the ADR 0006 definer rules). Returns per tenant only
-- counts and the oldest pending instant: no payloads, no types, no caller-chosen ids. `due` counts
-- only the types the caller can handle, so a rolled-back worker leaves newer types pending.
CREATE FUNCTION outbox_due_tenants(p_types text[], p_limit integer)
  RETURNS TABLE (tenant_id uuid, due bigint, pending bigint, oldest_pending_at timestamptz)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT e.tenant_id,
         count(*) FILTER (WHERE e.available_at <= now() AND e.type = ANY (p_types)),
         count(*),
         min(e.occurred_at)
  FROM public.outbox_events e
  WHERE e.published_at IS NULL AND e.dead_lettered_at IS NULL
  GROUP BY e.tenant_id
  ORDER BY min(e.occurred_at)
  LIMIT least(greatest(p_limit, 1), 500)
$$;

-- ACL first: after the owner change the migrator (SET, not INHERIT) can no longer grant on it.
REVOKE ALL ON FUNCTION outbox_due_tenants(text[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbox_due_tenants(text[], integer) TO durby_app;

-- Scheduling columns only: never payload, last_error or attempts.
GRANT SELECT ("tenant_id", "type", "occurred_at", "available_at", "published_at", "dead_lettered_at")
  ON "outbox_events" TO durby_rls_definer;
-- A new owner needs CREATE on the function's schema; granted only for the owner change.
GRANT CREATE ON SCHEMA public TO durby_rls_definer;
ALTER FUNCTION outbox_due_tenants(text[], integer) OWNER TO durby_rls_definer;
REVOKE CREATE ON SCHEMA public FROM durby_rls_definer;
