-- CreateEnum
CREATE TYPE "user_token_purpose" AS ENUM ('email_verification', 'password_reset');

-- CreateEnum
CREATE TYPE "refresh_token_revoke_reason" AS ENUM ('logout', 'reuse_detected', 'password_reset');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "email_verified_at" TIMESTAMPTZ(6),
    "locale" TEXT NOT NULL DEFAULT 'en',
    "last_organization_id" UUID,
    "password_changed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_tokens" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "purpose" "user_token_purpose" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "organization_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "family_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" "refresh_token_revoke_reason",
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_tokens_token_hash_key" ON "user_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "user_tokens_user_id_purpose_idx" ON "user_tokens"("user_id", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_tenant_id_id_key" ON "memberships"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_tenant_id_user_id_key" ON "memberships"("tenant_id", "user_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_last_organization_id_fkey" FOREIGN KEY ("last_organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------
-- Hand-written below: constraints Prisma cannot express, RLS, and the cross-tenant
-- membership lookup (docs/platform/auth.md, ADR 0006).
-- ---------------------------------------------------------------------------

-- Emails are stored normalized, so the unique index is case-insensitive in effect.
ALTER TABLE "users" ADD CONSTRAINT "users_email_normalized_check" CHECK ("email" = lower(btrim("email")));

-- A token is revoked with a reason or not at all; a token never outlives its family.
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_revoked_check"
  CHECK (("revoked_at" IS NULL) = ("revoked_reason" IS NULL));
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_expiry_check"
  CHECK ("expires_at" <= "family_expires_at");

-- Row-level security for memberships (tenant table, ADR 0005).
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "memberships"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- New functions are not executable by PUBLIC; each one grants EXECUTE explicitly.
-- (Global form: PUBLIC's EXECUTE default cannot be revoked per schema.)
ALTER DEFAULT PRIVILEGES FOR ROLE durby_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- The organizations of the user in app.user_id, across tenants. app.user_id is set by platform/auth
-- from the verified token (set_config(..., true), same transaction), so the caller can only list its
-- own memberships; without the setting the result is empty. Owned by durby_rls_definer (NOLOGIN
-- BYPASSRLS, created by infra/postgres/init/02-rls-definer.sql): FORCE RLS also binds the table
-- owner, so a migrator-owned function would see no rows.
CREATE FUNCTION auth_user_organization_ids()
  RETURNS TABLE (organization_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT m.tenant_id
  FROM public.memberships m
  WHERE m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

-- ACL first: after the owner change the migrator (SET, not INHERIT) can no longer grant on it.
-- The owner change carries these entries over to the new owner.
REVOKE ALL ON FUNCTION auth_user_organization_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_user_organization_ids() TO durby_app;

GRANT USAGE ON SCHEMA public TO durby_rls_definer;
GRANT SELECT ("tenant_id", "user_id") ON "memberships" TO durby_rls_definer;
-- A new owner needs CREATE on the function's schema. Granted only for the owner change:
-- durby_rls_definer must never be able to create objects (checked by test/security-definer.int.spec.ts).
GRANT CREATE ON SCHEMA public TO durby_rls_definer;
ALTER FUNCTION auth_user_organization_ids() OWNER TO durby_rls_definer;
REVOKE CREATE ON SCHEMA public FROM durby_rls_definer;
