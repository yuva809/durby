-- Host system role (docs/modules/reservations.md → Permissions, ADR 0007 amendment 2026-11-01). Own migration: a value
-- added to an enum can't be used in the transaction that adds it; the next migration creates the role in existing
-- organizations.
ALTER TYPE "system_role" ADD VALUE 'host';
