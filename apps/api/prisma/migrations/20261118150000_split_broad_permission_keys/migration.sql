-- ADR 0051: split the broad permission keys. Data only, no schema change.
--
-- Copies every stored key onto the keys that replace it, with the same effect (grant or deny):
--   platform.roles.manage  -> platform.roles.create, .edit, .delete
--   platform.users.manage  -> platform.users.edit, .delete
--   orders.orders.edit     -> also orders.orders.delete    (cancel)
--   orders.customers.edit  -> also orders.customers.delete (archive and restore)
-- and gives every custom role platform.org.read (every member sees the organization today).
-- Built-in roles have no stored keys: their split is in SYSTEM_ROLE_GRANTS (packages/shared).
--
-- Expand only (ADR 0004): the old rows stay, so the previous release still reads them after a rollback. Rows are only
-- added (ON CONFLICT DO NOTHING), so running this again changes nothing. The cleanup release deletes the old
-- platform.roles.manage / platform.users.manage rows and their aliases.
--
-- Per tenant with app.tenant_id set, so FORCE ROW LEVEL SECURITY stays on. One audit row per organization that got
-- rows (`platform.permission_keys.split`, actor `migration`), with the count only: no personal data.

-- A plain temp table, dropped at the end: works whether the file runs as one transaction or statement by statement.
DROP TABLE IF EXISTS pg_temp."permission_split";
CREATE TEMP TABLE "permission_split" ("old_key" text NOT NULL, "new_key" text NOT NULL);
INSERT INTO "permission_split" ("old_key", "new_key") VALUES
  ('platform.roles.manage', 'platform.roles.create'),
  ('platform.roles.manage', 'platform.roles.edit'),
  ('platform.roles.manage', 'platform.roles.delete'),
  ('platform.users.manage', 'platform.users.edit'),
  ('platform.users.manage', 'platform.users.delete'),
  ('orders.orders.edit', 'orders.orders.delete'),
  ('orders.customers.edit', 'orders.customers.delete');

DO $$
DECLARE
  org RECORD;
  added INTEGER;
  total INTEGER;
BEGIN
  FOR org IN SELECT "id" FROM "organizations" ORDER BY "id" LOOP
    PERFORM set_config('app.tenant_id', org."id"::text, true);
    total := 0;

    -- Custom roles' stored keys (role_permissions are grants).
    INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
    SELECT rp."tenant_id", rp."role_id", s."new_key"
    FROM "role_permissions" rp
    JOIN "permission_split" s ON s."old_key" = rp."permission_key"
    WHERE rp."tenant_id" = org."id"
    ON CONFLICT ("tenant_id", "role_id", "permission_key") DO NOTHING;
    GET DIAGNOSTICS added = ROW_COUNT;
    total := total + added;

    INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
    SELECT r."tenant_id", r."id", 'platform.org.read'
    FROM "roles" r
    WHERE r."tenant_id" = org."id" AND r."system_key" IS NULL
    ON CONFLICT ("tenant_id", "role_id", "permission_key") DO NOTHING;
    GET DIAGNOSTICS added = ROW_COUNT;
    total := total + added;

    -- Per-member overrides (ADR 0023): a grant or deny on the old key becomes the same on each new key.
    INSERT INTO "membership_permissions" ("tenant_id", "membership_id", "permission_key", "effect")
    SELECT mp."tenant_id", mp."membership_id", s."new_key", mp."effect"
    FROM "membership_permissions" mp
    JOIN "permission_split" s ON s."old_key" = mp."permission_key"
    WHERE mp."tenant_id" = org."id"
    ON CONFLICT ("tenant_id", "membership_id", "permission_key") DO NOTHING;
    GET DIAGNOSTICS added = ROW_COUNT;
    total := total + added;

    -- Open invitations carry the same overrides until they are accepted.
    INSERT INTO "invitation_permissions" ("tenant_id", "invitation_id", "permission_key", "effect")
    SELECT ip."tenant_id", ip."invitation_id", s."new_key", ip."effect"
    FROM "invitation_permissions" ip
    JOIN "permission_split" s ON s."old_key" = ip."permission_key"
    WHERE ip."tenant_id" = org."id"
    ON CONFLICT ("tenant_id", "invitation_id", "permission_key") DO NOTHING;
    GET DIAGNOSTICS added = ROW_COUNT;
    total := total + added;

    CONTINUE WHEN total = 0;
    INSERT INTO "audit_logs"
      ("tenant_id", "actor_type", "actor_system", "action", "entity_type", "entity_id", "before", "after")
    VALUES
      (org."id", 'system', 'migration', 'platform.permission_keys.split', 'organization', org."id",
       NULL, jsonb_build_object('id', org."id", 'rowsAdded', total));
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;

DROP TABLE pg_temp."permission_split";
