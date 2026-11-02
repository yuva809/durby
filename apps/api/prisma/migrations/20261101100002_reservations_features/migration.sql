-- Plan contents (ADR 0009; docs/modules/reservations.md → Features, decision Q6): `reservations` and
-- `reservations.online` join the `full` plan only, the one plan with `pos` (reservations reads pos tables). One audit
-- row per organization on it (`platform.plan.features_changed`, actor `migration`), written per tenant with
-- app.tenant_id set so FORCE RLS on audit_logs stays on. Same shape as catalog_and_tables: `features` are sorted keys,
-- `key:<limits json>` where a plan sets limits.
DO $$
DECLARE
  plan_row record;
  org record;
  before_features jsonb;
  after_features jsonb;
BEGIN
  FOR plan_row IN
    SELECT "id", "key" FROM "plans" WHERE "key" = 'full'
  LOOP
    SELECT coalesce(jsonb_agg(f ORDER BY f), '[]'::jsonb) INTO before_features FROM (
      SELECT CASE WHEN "limits" IS NULL THEN "feature_key" ELSE "feature_key" || ':' || "limits"::text END AS f
      FROM "plan_features" WHERE "plan_id" = plan_row."id"
    ) s;

    INSERT INTO "plan_features" ("plan_id", "feature_key", "updated_at")
    VALUES (plan_row."id", 'reservations', now()), (plan_row."id", 'reservations.online', now())
    ON CONFLICT ("plan_id", "feature_key") DO NOTHING;

    SELECT coalesce(jsonb_agg(f ORDER BY f), '[]'::jsonb) INTO after_features FROM (
      SELECT CASE WHEN "limits" IS NULL THEN "feature_key" ELSE "feature_key" || ':' || "limits"::text END AS f
      FROM "plan_features" WHERE "plan_id" = plan_row."id"
    ) s;

    CONTINUE WHEN before_features = after_features;
    FOR org IN SELECT "id" FROM "organizations" WHERE "plan_id" = plan_row."id" ORDER BY "id" LOOP
      PERFORM set_config('app.tenant_id', org.id::text, true);
      INSERT INTO "audit_logs"
        ("tenant_id", "actor_type", "actor_system", "action", "entity_type", "entity_id", "before", "after")
      VALUES
        (org.id, 'system', 'migration', 'platform.plan.features_changed', 'plan', plan_row."id",
         jsonb_build_object('id', plan_row."id", 'key', plan_row."key", 'features', before_features),
         jsonb_build_object('id', plan_row."id", 'key', plan_row."key", 'features', after_features));
    END LOOP;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
