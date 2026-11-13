-- Partner AsiaMight (ADR 0040): its own product name, colour and domain, on the same api and web as Durby. Partners,
-- themes, domains and partner label overrides change only through reviewed migrations (ADR 0015 §3, ADR 0011).
-- Branding is a placeholder until AsiaMight sends its logo and colours: a later migration updates the theme row.
-- Data only; idempotent.

INSERT INTO "partners" ("slug", "name", "updated_at")
VALUES ('asiamight', 'AsiaMight', now())
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "partner_themes" ("partner_id", "product_name", "logo_path", "color_primary", "color_ink", "color_paper", "updated_at")
SELECT "id", 'AsiaMight', NULL, '#1f7a3d', NULL, NULL, now()
FROM "partners" WHERE "slug" = 'asiamight'
ON CONFLICT ("partner_id") DO NOTHING;

-- app.asiamight.site: their site on production (served when the server's PARTNER_ORIGINS lists it).
-- asiamight.localhost: local development, like partner-demo.localhost.
INSERT INTO "partner_domains" ("partner_id", "hostname")
SELECT p."id", d."hostname"
FROM "partners" p
CROSS JOIN (VALUES ('app.asiamight.site'), ('asiamight.localhost')) AS d("hostname")
WHERE p."slug" = 'asiamight'
ON CONFLICT ("hostname") DO NOTHING;

-- Product name in api-rendered text (emails).
INSERT INTO "partner_label_overrides" ("partner_id", "locale", "key", "value", "updated_at")
SELECT p."id", o."locale", o."key", o."value", now()
FROM "partners" p
CROSS JOIN (VALUES
  ('en', 'platform.app.name', 'AsiaMight'),
  ('de', 'platform.app.name', 'AsiaMight')
) AS o("locale", "key", "value")
WHERE p."slug" = 'asiamight'
ON CONFLICT ("partner_id", "locale", "key") DO NOTHING;
