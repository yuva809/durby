-- Replays of appending staff writes (ADR 0017 §8, amended): a platform table private to platform/staff, outside every
-- tenant (no tenant_id, no RLS).

-- CreateTable
CREATE TABLE "staff_idempotency_keys" (
    "staff_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_idempotency_keys_pkey" PRIMARY KEY ("staff_id","key")
);

-- AddForeignKey
ALTER TABLE "staff_idempotency_keys" ADD CONSTRAINT "staff_idempotency_keys_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_accounts"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Same contract as Idempotency-Key everywhere: 1-255 visible ASCII characters.
ALTER TABLE "staff_idempotency_keys" ADD CONSTRAINT "staff_idempotency_keys_key_check"
  CHECK ("key" ~ '^[!-~]{1,255}$');
