-- Baseline privileges for the app role. Runs as durby_migrator (schema owner).
-- Kept in a migration (not the local init script) so every environment gets it.

-- The app role may use the schema but never create objects in it.
GRANT USAGE ON SCHEMA public TO durby_app;

-- Every table/sequence durby_migrator creates from now on is usable by durby_app.
-- RLS policies (step 1.1) restrict which rows. Append-only tables revoke UPDATE/DELETE.
ALTER DEFAULT PRIVILEGES FOR ROLE durby_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO durby_app;
ALTER DEFAULT PRIVILEGES FOR ROLE durby_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO durby_app;
