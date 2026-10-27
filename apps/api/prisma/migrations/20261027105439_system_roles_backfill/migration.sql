-- The new system roles for every existing organization (new ones get them from SystemRoles.ensure). Same pattern as
-- the rbac backfill: per tenant with app.tenant_id set (local to this transaction), so FORCE RLS stays on.
-- Idempotent; existing memberships are unchanged.
DO $$
DECLARE
  org RECORD;
BEGIN
  FOR org IN SELECT id FROM organizations ORDER BY id LOOP
    PERFORM set_config('app.tenant_id', org.id::text, true);
    INSERT INTO roles (tenant_id, system_key, updated_at)
      SELECT org.id, k::system_role, now() FROM unnest(ARRAY['waiter', 'cashier']) AS k
      ON CONFLICT (tenant_id, system_key) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
