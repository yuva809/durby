-- Feature overrides set by Durby staff (admin portal 1d; docs/platform/entitlements.md). Expand only (ADR 0004):
-- three nullable columns, so the previous release keeps reading and writing the table unchanged.
-- `reason`: why staff (or an operator) set it, 1–500 characters. `expires_at`: from then on the override counts as
-- absent and the plan applies again (end of the chosen day in Europe/Berlin). `set_by_staff_id`: the staff member
-- who set it last; null for CLI and migration writes. Staff accounts are deactivated, never deleted (RESTRICT).
ALTER TABLE "tenant_feature_overrides"
  ADD COLUMN "reason" TEXT,
  ADD COLUMN "expires_at" TIMESTAMPTZ(6),
  ADD COLUMN "set_by_staff_id" UUID;

ALTER TABLE "tenant_feature_overrides" ADD CONSTRAINT "tenant_feature_overrides_reason_check"
  CHECK ("reason" IS NULL OR char_length("reason") BETWEEN 1 AND 500);

ALTER TABLE "tenant_feature_overrides" ADD CONSTRAINT "tenant_feature_overrides_set_by_staff_id_fkey"
  FOREIGN KEY ("set_by_staff_id") REFERENCES "staff_accounts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
