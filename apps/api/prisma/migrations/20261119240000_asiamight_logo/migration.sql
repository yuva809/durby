-- AsiaMight's logo (ADR 0015 §4, ADR 0040): the file is apps/web/public/brand/asiamight/logo.webp. Data only; only
-- while the theme has none, so a later choice isn't overwritten.
UPDATE "partner_themes"
SET "logo_path" = '/brand/asiamight/logo.webp', "updated_at" = now()
WHERE "partner_id" = (SELECT "id" FROM "partners" WHERE "slug" = 'asiamight') AND "logo_path" IS NULL;
