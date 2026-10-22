-- CreateEnum
CREATE TYPE "system_role" AS ENUM ('owner', 'admin', 'manager', 'staff');

-- AlterTable
ALTER TABLE "memberships" ADD COLUMN     "all_locations" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "role_id" UUID;

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "system_key" "system_role",
    "name" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_locations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role_id" UUID NOT NULL,
    "all_locations" BOOLEAN NOT NULL DEFAULT true,
    "invited_by_user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "accepted_by_user_id" UUID,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation_locations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "invitation_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_locations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenant_id_id_key" ON "roles"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenant_id_system_key_key" ON "roles"("tenant_id", "system_key");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenant_id_name_key" ON "roles"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_tenant_id_id_key" ON "role_permissions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_tenant_id_role_id_permission_key_key" ON "role_permissions"("tenant_id", "role_id", "permission_key");

-- CreateIndex
CREATE INDEX "membership_locations_tenant_id_location_id_idx" ON "membership_locations"("tenant_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "membership_locations_tenant_id_id_key" ON "membership_locations"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "membership_locations_tenant_id_membership_id_location_id_key" ON "membership_locations"("tenant_id", "membership_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_tenant_id_email_idx" ON "invitations"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "invitations_tenant_id_role_id_idx" ON "invitations"("tenant_id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_tenant_id_id_key" ON "invitations"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_locations_tenant_id_id_key" ON "invitation_locations"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_locations_tenant_id_invitation_id_location_id_key" ON "invitation_locations"("tenant_id", "invitation_id", "location_id");

-- CreateIndex
CREATE INDEX "memberships_tenant_id_role_id_idx" ON "memberships"("tenant_id", "role_id");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_role_id_fkey" FOREIGN KEY ("tenant_id", "role_id") REFERENCES "roles"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_tenant_id_role_id_fkey" FOREIGN KEY ("tenant_id", "role_id") REFERENCES "roles"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "membership_locations" ADD CONSTRAINT "membership_locations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "membership_locations" ADD CONSTRAINT "membership_locations_tenant_id_membership_id_fkey" FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "memberships"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "membership_locations" ADD CONSTRAINT "membership_locations_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_role_id_fkey" FOREIGN KEY ("tenant_id", "role_id") REFERENCES "roles"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_user_id_fkey" FOREIGN KEY ("accepted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invitation_locations" ADD CONSTRAINT "invitation_locations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invitation_locations" ADD CONSTRAINT "invitation_locations_tenant_id_invitation_id_fkey" FOREIGN KEY ("tenant_id", "invitation_id") REFERENCES "invitations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invitation_locations" ADD CONSTRAINT "invitation_locations_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------
-- Hand-written below: constraints Prisma cannot express, RLS, the system-role backfill and the
-- last-Owner trigger (docs/platform/rbac.md, ADR 0007).
-- ---------------------------------------------------------------------------

-- A system role has a key and no name; a custom role has a trimmed name and no key.
ALTER TABLE "roles" ADD CONSTRAINT "roles_kind_check" CHECK (("system_key" IS NULL) = ("name" IS NOT NULL));
ALTER TABLE "roles" ADD CONSTRAINT "roles_name_check"
  CHECK ("name" IS NULL OR ("name" = btrim("name") AND length("name") BETWEEN 1 AND 100));

-- Key shape only: the registry lives in code (packages/shared/src/permissions.ts) and the API validates against it.
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_key_check"
  CHECK ("permission_key" ~ '^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$');

-- Emails are stored normalized; an invitation is accepted (by someone) or revoked, never both.
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_email_normalized_check" CHECK ("email" = lower(btrim("email")));
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_state_check" CHECK ("accepted_at" IS NULL OR "revoked_at" IS NULL);
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_check"
  CHECK (("accepted_at" IS NULL) = ("accepted_by_user_id" IS NULL));

-- Row-level security for the new tenant tables (ADR 0005).
ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "roles"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "role_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "role_permissions"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "membership_locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "membership_locations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "membership_locations"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "invitations"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "invitation_locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitation_locations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "invitation_locations"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Backfill: the system roles for every existing organization, and the Owner role for every existing
-- membership (e.g. the staging admin). Runs per tenant with app.tenant_id set (local to this transaction),
-- so FORCE RLS stays on and the policies apply. Runs before the trigger below exists, so these updates
-- never queue a deferred last-Owner check.
DO $$
DECLARE
  org RECORD;
BEGIN
  FOR org IN SELECT id FROM organizations LOOP
    PERFORM set_config('app.tenant_id', org.id::text, true);
    INSERT INTO roles (tenant_id, system_key, updated_at)
      SELECT org.id, k, now() FROM unnest(enum_range(NULL::system_role)) AS k
      ON CONFLICT (tenant_id, system_key) DO NOTHING;
    UPDATE memberships m SET role_id = r.id, updated_at = now()
      FROM roles r
      WHERE m.tenant_id = org.id AND m.role_id IS NULL
        AND r.tenant_id = org.id AND r.system_key = 'owner';
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- An organization never loses its last Owner. Deferred to commit, so a transfer (promote B, then demote A)
-- works inside one transaction. Locks the organization's Owner role row first: concurrent demotions
-- serialize, and the check (a new snapshot under READ COMMITTED) sees the other one's committed change.
-- SECURITY INVOKER: it sees the tenant's rows through RLS like the statement that fired it. Trigger
-- functions need no EXECUTE grant (checked at CREATE TRIGGER, not when fired).
CREATE FUNCTION rbac_keep_last_owner()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  owner_role uuid;
BEGIN
  -- A membership without a role (one inserted by the previous release) was never an Owner.
  IF OLD.role_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT r.id INTO owner_role FROM public.roles r
    WHERE r.tenant_id = OLD.tenant_id AND r.system_key = 'owner'
    FOR UPDATE;
  IF OLD.role_id IS DISTINCT FROM owner_role THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.memberships m WHERE m.tenant_id = OLD.tenant_id AND m.role_id = owner_role
  ) THEN
    RAISE EXCEPTION 'organization % would have no owner', OLD.tenant_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'memberships_keep_last_owner';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER memberships_keep_last_owner
  AFTER UPDATE OF role_id OR DELETE ON "memberships"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION rbac_keep_last_owner();
