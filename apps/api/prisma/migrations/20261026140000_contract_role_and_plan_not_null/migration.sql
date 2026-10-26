-- Contract step (ADR 0004): memberships.role_id and organizations.plan_id become NOT NULL
-- (docs/reviews/phase-1.md → R3; ADR 0007 §11, ADR 0009 §8). Every deployed release since steps
-- 1.3 and 1.5 writes both columns, so a rollback to any of them keeps working.
--
-- Readable pre-checks first. organizations has no RLS, so a plain query sees every row.
-- memberships has FORCE ROW LEVEL SECURITY, which applies to durby_migrator too: without
-- app.tenant_id it sees no rows, so the check sets the tenant per organization (like the 1.3 and
-- 1.5 backfills). SET NOT NULL below scans every row regardless of RLS and is the real guarantee;
-- the checks only say what is wrong. No backfill: a NULL now would come from an unknown writer.
DO $$
DECLARE
  org record;
  missing bigint;
BEGIN
  SELECT count(*) INTO missing FROM organizations WHERE plan_id IS NULL;
  IF missing > 0 THEN
    RAISE EXCEPTION 'organizations.plan_id: % organization(s) without a plan; assign one with the entitlements CLI first', missing;
  END IF;

  FOR org IN SELECT id FROM organizations ORDER BY id LOOP
    PERFORM set_config('app.tenant_id', org.id::text, true);
    SELECT count(*) INTO missing FROM memberships WHERE role_id IS NULL;
    IF missing > 0 THEN
      RAISE EXCEPTION 'memberships.role_id: % membership(s) without a role in organization %; give them a role first', missing, org.id;
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

ALTER TABLE "organizations" ALTER COLUMN "plan_id" SET NOT NULL;
ALTER TABLE "memberships" ALTER COLUMN "role_id" SET NOT NULL;
