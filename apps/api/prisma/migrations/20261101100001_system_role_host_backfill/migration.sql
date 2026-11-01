-- The Host role for every existing organization (new ones get it from SystemRoles.ensure). Same pattern as
-- system_roles_backfill (ADR 0016): per tenant with app.tenant_id set (local to this transaction), so FORCE RLS stays
-- on. Idempotent; existing memberships are unchanged.
DO $$
DECLARE
  org RECORD;
BEGIN
  FOR org IN SELECT id FROM organizations ORDER BY id LOOP
    PERFORM set_config('app.tenant_id', org.id::text, true);
    INSERT INTO roles (tenant_id, system_key, updated_at)
      VALUES (org.id, 'host'::system_role, now())
      ON CONFLICT (tenant_id, system_key) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
