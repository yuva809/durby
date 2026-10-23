-- CreateEnum
CREATE TYPE "number_series_reset_policy" AS ENUM ('yearly', 'never');

-- CreateTable
CREATE TABLE "number_series" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "reset_policy" "number_series_reset_policy" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "number_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "number_series_counters" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "series_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "next_value" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "number_series_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "number_series_tenant_id_id_key" ON "number_series"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "number_series_tenant_id_key_key" ON "number_series"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "number_series_counters_tenant_id_id_key" ON "number_series_counters"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "number_series_counters_tenant_id_series_id_period_key" ON "number_series_counters"("tenant_id", "series_id", "period");

-- AddForeignKey
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "number_series_counters" ADD CONSTRAINT "number_series_counters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "number_series_counters" ADD CONSTRAINT "number_series_counters_tenant_id_series_id_fkey" FOREIGN KEY ("tenant_id", "series_id") REFERENCES "number_series"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Shape checks (ADR 0012). Tokens, lengths and rendering are validated by the api against
-- packages/shared; SQL backs up the shape and the rules that would let numbers repeat.
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_key_format_check"
  CHECK ("key" ~ '^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$');
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_prefix_check"
  CHECK ("prefix" ~ '^[A-Za-z0-9._/-]{1,16}$');
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_pattern_check"
  CHECK (char_length("pattern") <= 64 AND "pattern" ~ '\{seq:[0-9]{1,2}\}');
-- A yearly reset without a year in the number would issue the same numbers every year.
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_yearly_year_check"
  CHECK ("reset_policy" <> 'yearly' OR "pattern" ~ '\{(YYYY|YY)\}');
ALTER TABLE "number_series_counters" ADD CONSTRAINT "number_series_counters_period_check"
  CHECK ("period" ~ '^(all|[0-9]{4})$');
ALTER TABLE "number_series_counters" ADD CONSTRAINT "number_series_counters_next_value_check"
  CHECK ("next_value" >= 1);

-- Counters only move forward, and a counter never moves to another series or period.
CREATE FUNCTION number_series_counters_forward_only()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.next_value < OLD.next_value THEN
    RAISE EXCEPTION 'number_series_counters.next_value may only increase (% -> %)',
      OLD.next_value, NEW.next_value USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.series_id <> OLD.series_id OR NEW.period <> OLD.period THEN
    RAISE EXCEPTION 'number_series_counters: tenant_id, series_id and period are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER number_series_counters_forward_only
  BEFORE UPDATE ON "number_series_counters"
  FOR EACH ROW EXECUTE FUNCTION number_series_counters_forward_only();

-- A series keeps its tenant and key, and its reset policy once a number was issued (switching
-- never -> yearly would restart at 1 in a year whose numbers were already issued).
CREATE FUNCTION number_series_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.key <> OLD.key THEN
    RAISE EXCEPTION 'number_series: tenant_id and key are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reset_policy <> OLD.reset_policy AND EXISTS (
    SELECT 1 FROM public.number_series_counters c
    WHERE c.tenant_id = OLD.tenant_id AND c.series_id = OLD.id AND c.next_value > 1
  ) THEN
    RAISE EXCEPTION 'number_series: reset_policy is fixed once a number was issued'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER number_series_guard
  BEFORE UPDATE ON "number_series"
  FOR EACH ROW EXECUTE FUNCTION number_series_guard();

-- Row-level security (ADR 0005).
ALTER TABLE "number_series" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "number_series" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "number_series"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "number_series_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "number_series_counters" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "number_series_counters"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Deleting a series or counter would restart its numbers (ADR 0012 §6). The default privileges
-- of ADR 0002 grant DML to durby_app; take back DELETE and TRUNCATE. A catalog test guards this.
REVOKE DELETE, TRUNCATE ON "number_series", "number_series_counters" FROM durby_app;
