-- Branch, Warehouse (Lager) and Driver system roles (ADR 0045, branch stock requests). Own migration: values added to
-- an enum can't be used in the transaction that adds them; the next migration creates the roles.
ALTER TYPE "system_role" ADD VALUE 'branch';
ALTER TYPE "system_role" ADD VALUE 'warehouse';
ALTER TYPE "system_role" ADD VALUE 'driver';
