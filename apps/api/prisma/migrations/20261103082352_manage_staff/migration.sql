-- CreateEnum
CREATE TYPE "permission_effect" AS ENUM ('grant', 'deny');

-- AlterTable
ALTER TABLE "invitations" ADD COLUMN     "display_name" TEXT,
ADD COLUMN     "phone" TEXT;

-- AlterTable
ALTER TABLE "memberships" ADD COLUMN     "deactivated_at" TIMESTAMPTZ(6),
ADD COLUMN     "display_name" TEXT,
ADD COLUMN     "phone" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "must_change_password" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "vouched_by_organization_id" UUID;

-- CreateTable
CREATE TABLE "membership_permissions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "permission_key" TEXT NOT NULL,
    "effect" "permission_effect" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation_permissions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "invitation_id" UUID NOT NULL,
    "permission_key" TEXT NOT NULL,
    "effect" "permission_effect" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "membership_permissions_tenant_id_id_key" ON "membership_permissions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "membership_permissions_tenant_id_membership_id_permission_k_key" ON "membership_permissions"("tenant_id", "membership_id", "permission_key");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_permissions_tenant_id_id_key" ON "invitation_permissions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_permissions_tenant_id_invitation_id_permission_k_key" ON "invitation_permissions"("tenant_id", "invitation_id", "permission_key");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_vouched_by_organization_id_fkey" FOREIGN KEY ("vouched_by_organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "membership_permissions" ADD CONSTRAINT "membership_permissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "membership_permissions" ADD CONSTRAINT "membership_permissions_tenant_id_membership_id_fkey" FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "memberships"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invitation_permissions" ADD CONSTRAINT "invitation_permissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invitation_permissions" ADD CONSTRAINT "invitation_permissions_tenant_id_invitation_id_fkey" FOREIGN KEY ("tenant_id", "invitation_id") REFERENCES "invitations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------
-- Hand-written below (docs/platform/rbac.md → Manage Staff, ADR 0023): checks Prisma cannot express, RLS for
-- the new tenant tables, and the last-Owner trigger counting active Owners only.
-- ---------------------------------------------------------------------------

-- Key shape only, as for role_permissions: the registry lives in code.
ALTER TABLE "membership_permissions" ADD CONSTRAINT "membership_permissions_key_check"
  CHECK ("permission_key" ~ '^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$');
ALTER TABLE "invitation_permissions" ADD CONSTRAINT "invitation_permissions_key_check"
  CHECK ("permission_key" ~ '^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$');

-- Names and phones are stored trimmed and short (the API validates the same).
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_display_name_check"
  CHECK ("display_name" IS NULL OR ("display_name" = btrim("display_name") AND length("display_name") BETWEEN 1 AND 100));
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_phone_check"
  CHECK ("phone" IS NULL OR ("phone" = btrim("phone") AND length("phone") BETWEEN 1 AND 40));
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_display_name_check"
  CHECK ("display_name" IS NULL OR ("display_name" = btrim("display_name") AND length("display_name") BETWEEN 1 AND 100));
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_phone_check"
  CHECK ("phone" IS NULL OR ("phone" = btrim("phone") AND length("phone") BETWEEN 1 AND 40));

-- Row-level security for the new tenant tables (ADR 0005).
ALTER TABLE "membership_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "membership_permissions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "membership_permissions"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "invitation_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitation_permissions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "invitation_permissions"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- An organization never loses its last *active* Owner (ADR 0007 §6, ADR 0023 §6): demoting, deleting and now
-- deactivating an Owner membership are checked at commit. Same locking as before (the Owner role row).
CREATE OR REPLACE FUNCTION rbac_keep_last_owner()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  owner_role uuid;
BEGIN
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
    SELECT 1 FROM public.memberships m
      WHERE m.tenant_id = OLD.tenant_id AND m.role_id = owner_role AND m.deactivated_at IS NULL
  ) THEN
    RAISE EXCEPTION 'organization % would have no owner', OLD.tenant_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'memberships_keep_last_owner';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER memberships_keep_last_owner ON "memberships";
CREATE CONSTRAINT TRIGGER memberships_keep_last_owner
  AFTER UPDATE OF role_id, deactivated_at OR DELETE ON "memberships"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION rbac_keep_last_owner();
