-- Delayed outbox events (R2.0, ADR 0013 amendment): an event may become due later (available_at in the future: a
-- reminder, an expiry). Lag and the dispatch order now go by when an event became due, not when it was written, so
-- a reminder scheduled for tomorrow is never reported as lag and doesn't jump ahead of events due earlier.
--
-- Same signatures and result columns, so the previous release keeps working against them (ADR 0004). Replaced as
-- their owner durby_rls_definer (as in 20261026120000_outbox_claim_due_only); the grants stay with the functions.

GRANT CREATE ON SCHEMA public TO durby_rls_definer;
SET ROLE durby_rls_definer;

CREATE OR REPLACE FUNCTION outbox_due_tenants(p_types text[], p_limit integer)
  RETURNS TABLE (tenant_id uuid, due bigint, pending bigint, oldest_pending_at timestamptz)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT d.tenant_id, d.due, p.pending, d.oldest_due_at
  FROM (
    SELECT e.tenant_id, count(*) AS due, min(e.available_at) AS oldest_due_at
    FROM public.outbox_events e
    WHERE e.published_at IS NULL AND e.dead_lettered_at IS NULL
      AND e.available_at <= now() AND e.type = ANY (p_types)
    GROUP BY e.tenant_id
    ORDER BY min(e.available_at), e.tenant_id
    LIMIT least(greatest(p_limit, 1), 500)
  ) d
  CROSS JOIN LATERAL (
    SELECT count(*) AS pending
    FROM public.outbox_events x
    WHERE x.tenant_id = d.tenant_id AND x.published_at IS NULL AND x.dead_lettered_at IS NULL
  ) p
  ORDER BY d.oldest_due_at, d.tenant_id
$$;

CREATE OR REPLACE FUNCTION outbox_backlog(p_types text[])
  RETURNS TABLE (due bigint, pending bigint, tenants bigint, oldest_pending_at timestamptz)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT count(*) FILTER (WHERE e.available_at <= now() AND e.type = ANY (p_types)),
         count(*),
         count(DISTINCT e.tenant_id),
         min(e.available_at) FILTER (WHERE e.available_at <= now())
  FROM public.outbox_events e
  WHERE e.published_at IS NULL AND e.dead_lettered_at IS NULL
$$;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM durby_rls_definer;
