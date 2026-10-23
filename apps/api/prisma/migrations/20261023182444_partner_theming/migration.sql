-- CreateTable
CREATE TABLE "partner_themes" (
    "partner_id" UUID NOT NULL,
    "product_name" TEXT NOT NULL,
    "logo_path" TEXT,
    "color_primary" TEXT NOT NULL,
    "color_ink" TEXT,
    "color_paper" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "partner_themes_pkey" PRIMARY KEY ("partner_id")
);

-- CreateTable
CREATE TABLE "partner_domains" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "partner_id" UUID NOT NULL,
    "hostname" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_domains_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "partner_domains_hostname_key" ON "partner_domains"("hostname");

-- CreateIndex
CREATE INDEX "partner_domains_partner_id_idx" ON "partner_domains"("partner_id");

-- AddForeignKey
ALTER TABLE "partner_themes" ADD CONSTRAINT "partner_themes_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "partner_domains" ADD CONSTRAINT "partner_domains_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Shape checks (docs/platform/web-shell.md → Model). Contrast is checked by the api
-- (deriveThemeTokens), which falls back to the default ink and paper if AA can't be met.
ALTER TABLE "partner_themes" ADD CONSTRAINT "partner_themes_product_name_check"
  CHECK (char_length("product_name") BETWEEN 1 AND 60 AND "product_name" !~ '[[:cntrl:]]');
ALTER TABLE "partner_themes" ADD CONSTRAINT "partner_themes_logo_path_check"
  CHECK ("logo_path" ~ '^/brand/[a-z0-9-]+/[a-z0-9-]+\.(svg|png|webp)$');
ALTER TABLE "partner_themes" ADD CONSTRAINT "partner_themes_colors_check"
  CHECK ("color_primary" ~ '^#[0-9a-f]{6}$'
     AND ("color_ink" IS NULL OR "color_ink" ~ '^#[0-9a-f]{6}$')
     AND ("color_paper" IS NULL OR "color_paper" ~ '^#[0-9a-f]{6}$'));
-- Lowercase DNS name: labels of 1–63 characters, at least one dot, ≤ 253 in total, no port or trailing dot.
ALTER TABLE "partner_domains" ADD CONSTRAINT "partner_domains_hostname_check"
  CHECK (char_length("hostname") <= 253
     AND "hostname" ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$');

-- Read-only for the app, like plans (ADR 0015 §3): themes and domains change only through
-- reviewed migrations.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "partner_themes", "partner_domains" FROM durby_app;

-- Demo partner for the two-domain demo (ADR 0015 §6). REMOVE BEFORE PRODUCTION
-- (docs/plan/PHASE-0-1-PROMPTS.md → Before production). Durby itself needs no rows: unknown
-- hosts and partners without a theme get the default theme from packages/shared (DEFAULT_THEME).
INSERT INTO "partners" ("slug", "name", "updated_at")
VALUES ('demo', 'Demo Partner', now())
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "partner_themes" ("partner_id", "product_name", "logo_path", "color_primary", "color_ink", "color_paper", "updated_at")
SELECT "id", 'Gastro Demo', NULL, '#0f766e', '#0b1f2a', '#f4f8f8', now()
FROM "partners" WHERE "slug" = 'demo';

INSERT INTO "partner_domains" ("partner_id", "hostname")
SELECT p."id", d."hostname"
FROM "partners" p
CROSS JOIN (VALUES ('partner-demo.localhost'), ('partner-demo.durby.tech')) AS d("hostname")
WHERE p."slug" = 'demo';

-- Terminology and product name (api-rendered text) for the demo partner (ADR 0011).
INSERT INTO "partner_label_overrides" ("partner_id", "locale", "key", "value", "updated_at")
SELECT p."id", o."locale", o."key", o."value", now()
FROM "partners" p
CROSS JOIN (VALUES
  ('en', 'inventory.nav.title', 'Stock'),
  ('de', 'inventory.nav.title', 'Bestand'),
  ('en', 'platform.app.name', 'Gastro Demo'),
  ('de', 'platform.app.name', 'Gastro Demo')
) AS o("locale", "key", "value")
WHERE p."slug" = 'demo'
ON CONFLICT ("partner_id", "locale", "key") DO NOTHING;
