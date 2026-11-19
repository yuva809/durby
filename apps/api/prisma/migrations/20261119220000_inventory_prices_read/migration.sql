-- ADR 0060: "See prices and values" (inventory.prices.read). Data only, no schema change.
--
-- Built-in roles get the key from SYSTEM_ROLE_GRANTS (packages/shared): every role but the Branch manager. Custom
-- roles store their keys, so each of them gets it here: until now everyone who read stock saw its values, and this
-- release keeps it so. Owners take it away per role or per person in Manage Staff.
--
-- Expand only (ADR 0004): rows are only added (ON CONFLICT DO NOTHING), so running this again changes nothing, and the
-- previous release ignores the key after a rollback. Per tenant with app.tenant_id set, so FORCE ROW LEVEL SECURITY
-- stays on. One audit row per organization that got rows (`platform.permission_keys.added`, actor `migration`), with
-- the count only: no personal data.

DO $$
DECLARE
  org RECORD;
  added INTEGER;
BEGIN
  FOR org IN SELECT "id" FROM "organizations" ORDER BY "id" LOOP
    PERFORM set_config('app.tenant_id', org."id"::text, true);

    INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
    SELECT r."tenant_id", r."id", 'inventory.prices.read'
    FROM "roles" r
    WHERE r."tenant_id" = org."id" AND r."system_key" IS NULL
    ON CONFLICT ("tenant_id", "role_id", "permission_key") DO NOTHING;
    GET DIAGNOSTICS added = ROW_COUNT;

    CONTINUE WHEN added = 0;
    INSERT INTO "audit_logs"
      ("tenant_id", "actor_type", "actor_system", "action", "entity_type", "entity_id", "before", "after")
    VALUES
      (org."id", 'system', 'migration', 'platform.permission_keys.added', 'organization', org."id",
       NULL, jsonb_build_object('id', org."id", 'rowsAdded', added));
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
