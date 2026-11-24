-- Deleting a stock item with its history (ADR 0079): the one exception to the append-only stock ledger
-- (CLAUDE.md rule 7). One SECURITY DEFINER function, owned by durby_rls_definer (ADR 0006), deletes one item of the
-- caller's organization (app.tenant_id) with its movements, its lines on stock requests and vendor invoices,
-- documents left empty, and its stock levels. The append-only triggers let only that function through, while it
-- runs. Expand only: older releases never call it.

-- The append-only guards: unchanged for everyone but the purge function, which sets durby.item_purge for its own
-- transaction and runs as durby_rls_definer (no one can log in as it; durby_app has no DELETE on these tables).
CREATE OR REPLACE FUNCTION inventory_append_only()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'durby_rls_definer'
     AND current_setting('durby.item_purge', true) = 'on' THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE OR REPLACE FUNCTION stock_requests_append_only()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'vendor_invoice_line_corrections'
     AND current_user = 'durby_rls_definer' AND current_setting('durby.item_purge', true) = 'on' THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- Returns what was deleted. Refuses (P0001, message 'item_purge:<reason>') when the item is in a recipe, a bill of
-- materials, a sales order or has variants: those are set up or financial records to change first.
CREATE FUNCTION purge_stock_item(p_item uuid)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  t uuid := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
  docs uuid[];
  n_moves bigint;
  n_docs bigint;
  n_request_lines bigint;
  n_invoice_lines bigint;
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'item_purge:no_tenant';
  END IF;
  -- durby_rls_definer bypasses RLS: every statement below names the tenant.
  IF NOT EXISTS (SELECT 1 FROM public.stock_items WHERE tenant_id = t AND id = p_item) THEN
    RAISE EXCEPTION 'item_purge:not_found';
  END IF;
  IF EXISTS (SELECT 1 FROM public.recipe_lines WHERE tenant_id = t AND item_id = p_item)
     OR EXISTS (SELECT 1 FROM public.boms WHERE tenant_id = t AND item_id = p_item)
     OR EXISTS (SELECT 1 FROM public.bom_lines WHERE tenant_id = t AND item_id = p_item) THEN
    RAISE EXCEPTION 'item_purge:recipe';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_order_lines WHERE tenant_id = t AND item_id = p_item) THEN
    RAISE EXCEPTION 'item_purge:sales_order';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stock_items WHERE tenant_id = t AND parent_item_id = p_item) THEN
    RAISE EXCEPTION 'item_purge:variants';
  END IF;

  PERFORM set_config('durby.item_purge', 'on', true);

  SELECT coalesce(array_agg(DISTINCT document_id), '{}') INTO docs
  FROM public.stock_movements WHERE tenant_id = t AND item_id = p_item;

  DELETE FROM public.vendor_invoice_line_corrections c
  USING public.vendor_invoice_lines l
  WHERE c.tenant_id = t AND l.tenant_id = t AND c.line_id = l.id AND l.item_id = p_item;
  DELETE FROM public.vendor_invoice_lines WHERE tenant_id = t AND item_id = p_item;
  GET DIAGNOSTICS n_invoice_lines = ROW_COUNT;
  DELETE FROM public.stock_request_lines WHERE tenant_id = t AND item_id = p_item;
  GET DIAGNOSTICS n_request_lines = ROW_COUNT;
  DELETE FROM public.stock_movements WHERE tenant_id = t AND item_id = p_item;
  GET DIAGNOSTICS n_moves = ROW_COUNT;
  -- Documents with nothing left, unless an invoice still points at them.
  DELETE FROM public.stock_documents d
  WHERE d.tenant_id = t AND d.id = ANY (docs)
    AND NOT EXISTS (SELECT 1 FROM public.stock_movements m WHERE m.tenant_id = t AND m.document_id = d.id)
    AND NOT EXISTS (SELECT 1 FROM public.vendor_invoices v WHERE v.tenant_id = t AND v.document_id = d.id);
  GET DIAGNOSTICS n_docs = ROW_COUNT;
  DELETE FROM public.stock_levels WHERE tenant_id = t AND item_id = p_item;
  DELETE FROM public.stock_items WHERE tenant_id = t AND id = p_item;

  PERFORM set_config('durby.item_purge', 'off', true);
  RETURN jsonb_build_object(
    'movements', n_moves, 'documents', n_docs,
    'requestLines', n_request_lines, 'invoiceLines', n_invoice_lines);
END
$$;

-- ACL before the owner change (ADR 0006): only the app may call it.
REVOKE ALL ON FUNCTION purge_stock_item(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_stock_item(uuid) TO durby_app;

-- Only what the function reads (the columns of its WHERE clauses) and the tables it deletes from.
GRANT DELETE ON "stock_items", "stock_movements", "stock_documents", "stock_levels", "stock_request_lines",
  "vendor_invoice_lines", "vendor_invoice_line_corrections" TO durby_rls_definer;
GRANT SELECT ("tenant_id", "id", "parent_item_id") ON "stock_items" TO durby_rls_definer;
GRANT SELECT ("tenant_id", "item_id", "document_id") ON "stock_movements" TO durby_rls_definer;
GRANT SELECT ("tenant_id", "id") ON "stock_documents" TO durby_rls_definer;
GRANT SELECT ("tenant_id", "item_id") ON "stock_levels" TO durby_rls_definer;
GRANT SELECT ("tenant_id", "item_id") ON "stock_request_lines" TO durby_rls_definer;
GRANT SELECT ("tenant_id", "id", "item_id") ON "vendor_invoice_lines" TO durby_rls_definer;
GRANT SELECT ("tenant_id", "line_id") ON "vendor_invoice_line_corrections" TO durby_rls_definer;
GRANT SELECT ("tenant_id", "document_id") ON "vendor_invoices" TO durby_rls_definer;
GRANT SELECT ("tenant_id", "item_id") ON "recipe_lines", "boms", "bom_lines", "sales_order_lines"
  TO durby_rls_definer;

-- durby_rls_definer must never be able to create objects (checked by test/security-definer.int.spec.ts).
GRANT CREATE ON SCHEMA public TO durby_rls_definer;
ALTER FUNCTION purge_stock_item(uuid) OWNER TO durby_rls_definer;
REVOKE CREATE ON SCHEMA public FROM durby_rls_definer;
