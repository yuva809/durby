-- Feedback to the Durby team (docs/platform/feedback.md, ADR 0044 step 5). Platform data, like the platform audit
-- log: the operator's support inbox, read across customers in the admin portal. No tenant_id and no RLS; the app only
-- inserts an organization's feedback and reads it back filtered by the session's organization. Expand only.

-- CreateEnum
CREATE TYPE "feedback_category" AS ENUM ('bug', 'idea', 'question');

-- CreateEnum
CREATE TYPE "feedback_status" AS ENUM ('new', 'seen', 'done');

-- CreateTable
CREATE TABLE "feedback" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "category" "feedback_category" NOT NULL,
    "message" TEXT NOT NULL,
    "page_path" TEXT,
    "status" "feedback_status" NOT NULL DEFAULT 'new',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feedback_organization_id_id_idx" ON "feedback"("organization_id", "id");

-- CreateIndex
CREATE INDEX "feedback_status_id_idx" ON "feedback"("status", "id");

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------------------------------------------
-- Hand-written below: what the Prisma schema cannot express.
-- ---------------------------------------------------------------------------------------------------------------

ALTER TABLE "feedback" ADD CONSTRAINT "feedback_message_check"
  CHECK (char_length("message") BETWEEN 1 AND 2000);
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_page_path_check"
  CHECK ("page_path" IS NULL OR (char_length("page_path") <= 200 AND "page_path" LIKE '/%'));

-- Kept for the customer's history: never deleted by the app.
REVOKE DELETE, TRUNCATE ON "feedback" FROM durby_app;
