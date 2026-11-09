-- Lost refresh responses (ADR 0006, amendment 2026-11-09): each token records the token it was issued from, and
-- siblings issued from the same parent are revoked as 'superseded' when one of them is used.
-- Expand only: the previous release neither reads nor writes either; its tokens keep parent_id NULL.
-- ADD VALUE commits with this file's transaction; nothing here uses the new value.
ALTER TYPE "refresh_token_revoke_reason" ADD VALUE 'superseded';

ALTER TABLE "refresh_tokens" ADD COLUMN "parent_id" UUID;

CREATE INDEX "refresh_tokens_parent_id_idx" ON "refresh_tokens"("parent_id");

ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "refresh_tokens"("id") ON DELETE SET NULL ON UPDATE RESTRICT;
