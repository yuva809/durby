-- AsiaMight (ADR 0040): pieces are called "Stück" in both languages, and passwords set by owners and admins are
-- final by default (ADR 0052): no "choose your own password" step. An organization that saved its own value for
-- the setting keeps it. Data only; idempotent.

INSERT INTO "partner_label_overrides" ("partner_id", "locale", "key", "value", "updated_at")
SELECT p."id", o."locale", o."key", o."value", now()
FROM "partners" p
CROSS JOIN (VALUES
  ('en', 'inventory.units.pc', 'Stück'),
  ('de', 'inventory.units.pc', 'Stück'),
  ('en', 'orders.requestCart.pieces', '= {count} Stück'),
  ('de', 'orders.requestCart.pieces', '= {count} Stück')
) AS o("locale", "key", "value")
WHERE p."slug" = 'asiamight'
ON CONFLICT ("partner_id", "locale", "key") DO NOTHING;

INSERT INTO "partner_setting_values" ("partner_id", "key", "value", "updated_at")
SELECT p."id", 'team.adminsManageSignIn', 'true'::jsonb, now()
FROM "partners" p
WHERE p."slug" = 'asiamight'
ON CONFLICT ("partner_id", "key") DO NOTHING;
