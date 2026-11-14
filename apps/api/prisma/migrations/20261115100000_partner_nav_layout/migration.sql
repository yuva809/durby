-- Sidebar layout per partner theme (ADR 0044). `default` is Durby's menu; `operations` the grouped menu of a
-- distribution business (Business operations, Administration & reports, Tools & utilities). Expand only: the
-- column has a default, so the running api keeps working until the new one is deployed.

ALTER TABLE "partner_themes" ADD COLUMN "nav_layout" TEXT NOT NULL DEFAULT 'default';

ALTER TABLE "partner_themes" ADD CONSTRAINT "partner_themes_nav_layout_check"
  CHECK ("nav_layout" IN ('default', 'operations'));

-- AsiaMight gets the operations menu (data only; idempotent).
UPDATE "partner_themes" SET "nav_layout" = 'operations', "updated_at" = now()
WHERE "partner_id" = (SELECT "id" FROM "partners" WHERE "slug" = 'asiamight')
  AND "nav_layout" <> 'operations';
