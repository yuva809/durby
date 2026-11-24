-- The daily report of one organization and business day (ADR 0083). Expand only: a new table.

-- CreateTable
CREATE TABLE "report_daily_messages" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_daily_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "report_daily_messages_tenant_id_id_key" ON "report_daily_messages"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "report_daily_messages_tenant_id_day_key" ON "report_daily_messages"("tenant_id", "day");

-- AddForeignKey
ALTER TABLE "report_daily_messages" ADD CONSTRAINT "report_daily_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Row-level security (ADR 0005).
ALTER TABLE "report_daily_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "report_daily_messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "report_daily_messages"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
