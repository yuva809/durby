-- Waiter and cashier system roles (ADR 0016 §7, amends ADR 0007's list). Own migration: a value added to an enum
-- can't be used in the transaction that adds it; the next migration creates the roles in existing organizations.
ALTER TYPE "system_role" ADD VALUE 'waiter';
ALTER TYPE "system_role" ADD VALUE 'cashier';
