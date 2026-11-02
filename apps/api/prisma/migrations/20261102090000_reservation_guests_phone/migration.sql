-- Guest matching by phone (docs/modules/reservations.md → GDPR, R1.6): a booking without a matching email links to
-- the most recently seen live guest with the same E.164 phone. Phone is not unique (families share a number), so a
-- plain index, partial like the live email key: anonymised guests have no phone and are never matched.
-- Hand-written: Prisma doesn't model partial indexes (and ignores them in migrate diff).
CREATE INDEX "reservation_guests_live_phone_idx"
  ON "reservation_guests" ("tenant_id", "phone") WHERE "anonymised_at" IS NULL;
