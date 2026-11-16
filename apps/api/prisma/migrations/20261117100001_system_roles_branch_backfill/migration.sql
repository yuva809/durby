-- The Branch, Warehouse and Driver roles for every existing organization (new ones get them from SystemRoles.ensure).
-- Same pattern as system_role_host_backfill: per tenant with app.tenant_id set, so FORCE RLS stays on. Idempotent.
-- The roles exist everywhere; the role list shows them only where the organization has the orders module.
DO $$
DECLARE
  org RECORD;
BEGIN
  FOR org IN SELECT id FROM organizations ORDER BY id LOOP
    PERFORM set_config('app.tenant_id', org.id::text, true);
    INSERT INTO roles (tenant_id, system_key, updated_at)
      VALUES (org.id, 'branch'::system_role, now()), (org.id, 'warehouse'::system_role, now()), (org.id, 'driver'::system_role, now())
      ON CONFLICT (tenant_id, system_key) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
