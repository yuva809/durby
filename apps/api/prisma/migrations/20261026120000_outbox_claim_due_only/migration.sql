-- Outbox claim starvation (docs/reviews/phase-1.md → R1, ADR 0013 §3).
--
-- outbox_due_tenants: only tenants with due events (available now, of a type this release knows)
-- compete for the claim slots, ordered by their oldest due event. Before, every pending event
-- counted and the LIMIT came first, so tenants with only events in backoff or of unknown types
-- (rollback) could fill all slots and starve tenants with due events.
-- Same signature and result columns, so the previous release keeps working against it (ADR 0004);
-- `pending` and `oldest_pending_at` are now reported for the returned tenants only.
--
-- outbox_backlog: the whole backlog for the lag log, as totals (no tenant ids, no payloads).
-- A new SECURITY DEFINER function: allow-listed (ADR 0006), owned by durby_rls_definer, pinned
-- search_path, not executable by PUBLIC; it reads only the scheduling columns already granted.
--
-- Both are created as durby_rls_definer (the migrator may SET that role), so it owns them and
-- grants on them; CREATE on public is granted for this migration only.

GRANT CREATE ON SCHEMA public TO durby_rls_definer;
SET ROLE durby_rls_definer;

CREATE OR REPLACE FUNCTION outbox_due_tenants(p_types text[], p_limit integer)
  RETURNS TABLE (tenant_id uuid, due bigint, pending bigint, oldest_pending_at timestamptz)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT d.tenant_id, d.due, p.pending, p.oldest_pending_at
  FROM (
    SELECT e.tenant_id, count(*) AS due, min(e.occurred_at) AS oldest_due_at
    FROM public.outbox_events e
    WHERE e.published_at IS NULL AND e.dead_lettered_at IS NULL
      AND e.available_at <= now() AND e.type = ANY (p_types)
    GROUP BY e.tenant_id
    ORDER BY min(e.occurred_at), e.tenant_id
    LIMIT least(greatest(p_limit, 1), 500)
  ) d
  CROSS JOIN LATERAL (
    SELECT count(*) AS pending, min(x.occurred_at) AS oldest_pending_at
    FROM public.outbox_events x
    WHERE x.tenant_id = d.tenant_id AND x.published_at IS NULL AND x.dead_lettered_at IS NULL
  ) p
  ORDER BY d.oldest_due_at, d.tenant_id
$$;

CREATE FUNCTION outbox_backlog(p_types text[])
  RETURNS TABLE (due bigint, pending bigint, tenants bigint, oldest_pending_at timestamptz)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT count(*) FILTER (WHERE e.available_at <= now() AND e.type = ANY (p_types)),
         count(*),
         count(DISTINCT e.tenant_id),
         min(e.occurred_at)
  FROM public.outbox_events e
  WHERE e.published_at IS NULL AND e.dead_lettered_at IS NULL
$$;

REVOKE ALL ON FUNCTION outbox_backlog(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbox_backlog(text[]) TO durby_app;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM durby_rls_definer;
