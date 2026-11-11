-- `pos` now depends on `catalog` (admin portal 1d; docs/platform/entitlements.md). No customer may lose POS by
-- it: an organization whose `pos` is on (by an enabling override, or by its plan with no override) while an
-- override disables `catalog` gets catalog back. Every plan includes catalog today, so the override is deleted
-- (back to the plan); on a plan without catalog it would be switched to enabled instead. One audit row per change
-- (`platform.feature_override.deleted` / `.updated`, actor `migration`). Overrides and audit rows sit behind FORCE
-- RLS, which binds the migrator too: each organization is read and written with its app.tenant_id set.
-- Snapshots as EntitlementsAdmin writes them: id, featureKey, enabled, limits (a disabling override has none).
DO $$
DECLARE
  org record;
  catalog_off record;
  pos_on boolean;
  plan_has_catalog boolean;
BEGIN
  FOR org IN SELECT "id", "plan_id" FROM "organizations" ORDER BY "id" LOOP
    PERFORM set_config('app.tenant_id', org."id"::text, true);

    SELECT "id" INTO catalog_off FROM "tenant_feature_overrides"
    WHERE "tenant_id" = org."id" AND "feature_key" = 'catalog' AND NOT "enabled";
    CONTINUE WHEN NOT FOUND;

    SELECT coalesce(
      (SELECT "enabled" FROM "tenant_feature_overrides" WHERE "tenant_id" = org."id" AND "feature_key" = 'pos'),
      EXISTS (SELECT 1 FROM "plan_features" WHERE "plan_id" = org."plan_id" AND "feature_key" = 'pos')
    ) INTO pos_on;
    CONTINUE WHEN NOT pos_on;

    SELECT EXISTS (
      SELECT 1 FROM "plan_features" WHERE "plan_id" = org."plan_id" AND "feature_key" = 'catalog'
    ) INTO plan_has_catalog;

    IF plan_has_catalog THEN
      DELETE FROM "tenant_feature_overrides" WHERE "id" = catalog_off."id";
      INSERT INTO "audit_logs"
        ("tenant_id", "actor_type", "actor_system", "action", "entity_type", "entity_id", "before", "after")
      VALUES
        (org."id", 'system', 'migration', 'platform.feature_override.deleted', 'feature_override', catalog_off."id",
         jsonb_build_object('id', catalog_off."id", 'featureKey', 'catalog', 'enabled', false, 'limits', NULL),
         NULL);
    ELSE
      UPDATE "tenant_feature_overrides" SET "enabled" = true, "updated_at" = now() WHERE "id" = catalog_off."id";
      INSERT INTO "audit_logs"
        ("tenant_id", "actor_type", "actor_system", "action", "entity_type", "entity_id", "before", "after")
      VALUES
        (org."id", 'system', 'migration', 'platform.feature_override.updated', 'feature_override', catalog_off."id",
         jsonb_build_object('id', catalog_off."id", 'featureKey', 'catalog', 'enabled', false, 'limits', NULL),
         jsonb_build_object('id', catalog_off."id", 'featureKey', 'catalog', 'enabled', true, 'limits', NULL));
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
