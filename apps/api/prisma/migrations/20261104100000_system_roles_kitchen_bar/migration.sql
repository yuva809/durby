-- Kitchen and Bar system roles (docs/modules/pos.md → Kitchen and bar screens, ADR 0026). Own migration: a value added
-- to an enum can't be used in the transaction that adds it; the next migration creates the roles in existing
-- organizations.
ALTER TYPE "system_role" ADD VALUE 'kitchen';
ALTER TYPE "system_role" ADD VALUE 'bar';
