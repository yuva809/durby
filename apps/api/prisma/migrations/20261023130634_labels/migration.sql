-- CreateTable
CREATE TABLE "partner_label_overrides" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "partner_id" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "partner_label_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "label_overrides" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "label_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "partner_label_overrides_partner_id_locale_key_key" ON "partner_label_overrides"("partner_id", "locale", "key");

-- CreateIndex
CREATE UNIQUE INDEX "label_overrides_tenant_id_id_key" ON "label_overrides"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "label_overrides_tenant_id_locale_key_key" ON "label_overrides"("tenant_id", "locale", "key");

-- AddForeignKey
ALTER TABLE "partner_label_overrides" ADD CONSTRAINT "partner_label_overrides_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "label_overrides" ADD CONSTRAINT "label_overrides_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Shape checks (ADR 0011). Key existence, supported locale, org-overridable keys and placeholders are
-- validated against packages/i18n by the api; SQL checks the shape and each level's value limits
-- (partner: 1–1000 characters, may span lines; organization: 1–200 characters, one line).
ALTER TABLE "partner_label_overrides" ADD CONSTRAINT "partner_label_overrides_key_format_check"
  CHECK ("key" ~ '^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$');
ALTER TABLE "label_overrides" ADD CONSTRAINT "label_overrides_key_format_check"
  CHECK ("key" ~ '^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$');
ALTER TABLE "partner_label_overrides" ADD CONSTRAINT "partner_label_overrides_locale_format_check"
  CHECK ("locale" ~ '^[a-z]{2}(-[A-Z]{2})?$');
ALTER TABLE "label_overrides" ADD CONSTRAINT "label_overrides_locale_format_check"
  CHECK ("locale" ~ '^[a-z]{2}(-[A-Z]{2})?$');
ALTER TABLE "partner_label_overrides" ADD CONSTRAINT "partner_label_overrides_value_check"
  CHECK (char_length("value") BETWEEN 1 AND 1000);
ALTER TABLE "label_overrides" ADD CONSTRAINT "label_overrides_value_check"
  CHECK (char_length("value") BETWEEN 1 AND 200 AND "value" !~ '[\n\r]');

-- Row-level security (ADR 0005).
ALTER TABLE "label_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "label_overrides" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "label_overrides"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Partner overrides are read-only for the app (ADR 0011 §1, as ADR 0010 §2): they change only
-- through reviewed migrations. The default privileges of ADR 0002 grant DML to durby_app; take back
-- everything but SELECT. A catalog test guards this.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "partner_label_overrides" FROM durby_app;
