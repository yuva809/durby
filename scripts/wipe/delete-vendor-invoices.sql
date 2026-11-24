-- DESTRUCTIVE. Deletes approved (or any) vendor invoices of one organization and the stock they booked:
--   * the invoices, their lines and line corrections;
--   * their goods receipts (and correction documents) with all their stock movements;
--   * the stock items those receipts created, when nothing else uses them (no other movement, recipe, bill of
--     materials, sales order, stock request, other invoice or variant);
--   * stock levels: removed for deleted items, recalculated from the remaining movements for the others
--     (quantity, weighted average cost; best-before cleared when nothing is left).
-- The audit log is kept (it is the history of what happened). Item details an approval set on existing items
-- (category, brand, pack size) are not reverted.
--
-- No backup is taken by this script: take one first. Run as the postgres superuser (it switches off the append-only
-- triggers and foreign-key checks for this one transaction, so it checks every reference itself and refuses when
-- something would break).
--
-- Dry run (default, rolls back, prints what WOULD happen):
--   psql -v org_id='<organization id>' -v invoices='VIN-2026-000001,VIN-2026-000002' -v apply_yes=0 \
--        -f scripts/wipe/delete-vendor-invoices.sql
-- Apply (commits):  the same with -v apply_yes=1

\set ON_ERROR_STOP on
BEGIN;
SET LOCAL session_replication_role = replica;
SELECT set_config('del.org', :'org_id', true), set_config('del.invoices', :'invoices', true),
       set_config('del.apply', :'apply_yes', true);

CREATE TEMP TABLE del_invoices ON COMMIT DROP AS
  SELECT id, number, status, invoice_number, document_id, created_at
  FROM vendor_invoices
  WHERE tenant_id = current_setting('del.org')::uuid
    AND number = ANY (string_to_array(replace(current_setting('del.invoices'), ' ', ''), ','));

CREATE TEMP TABLE del_docs ON COMMIT DROP AS
  SELECT document_id AS id FROM del_invoices WHERE document_id IS NOT NULL
  UNION
  SELECT reversal_document_id FROM vendor_invoice_line_corrections
  WHERE invoice_id IN (SELECT id FROM del_invoices)
  UNION
  SELECT receipt_document_id FROM vendor_invoice_line_corrections
  WHERE invoice_id IN (SELECT id FROM del_invoices);

CREATE TEMP TABLE del_moves ON COMMIT DROP AS
  SELECT m.id, m.document_id, m.warehouse_id, m.item_id, m.quantity
  FROM stock_movements m
  WHERE m.tenant_id = current_setting('del.org')::uuid AND m.document_id IN (SELECT id FROM del_docs);

-- Items the receipts created: nothing else uses them, and they were made after the first of these invoices.
CREATE TEMP TABLE del_items ON COMMIT DROP AS
  SELECT i.id, i.name
  FROM stock_items i
  WHERE i.tenant_id = current_setting('del.org')::uuid
    AND i.id IN (SELECT item_id FROM del_moves)
    AND i.created_at >= (SELECT min(created_at) FROM del_invoices)
    AND NOT EXISTS (SELECT 1 FROM stock_movements m
                    WHERE m.item_id = i.id AND m.tenant_id = i.tenant_id
                      AND m.document_id NOT IN (SELECT id FROM del_docs))
    AND NOT EXISTS (SELECT 1 FROM recipe_lines x WHERE x.item_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM boms x WHERE x.item_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM bom_lines x WHERE x.item_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM sales_order_lines x WHERE x.item_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM stock_request_lines x WHERE x.item_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM vendor_invoice_lines x
                    WHERE x.item_id = i.id AND x.invoice_id NOT IN (SELECT id FROM del_invoices))
    AND NOT EXISTS (SELECT 1 FROM stock_items v WHERE v.parent_item_id = i.id);

\echo '== Invoices'
SELECT number, status, invoice_number, document_id IS NOT NULL AS booked FROM del_invoices ORDER BY number;
\echo '== Documents and movements to delete'
SELECT (SELECT count(*) FROM del_docs) AS documents, (SELECT count(*) FROM del_moves) AS movements;
\echo '== Items to delete (created by these invoices, used nowhere else)'
SELECT count(*) AS items_deleted FROM del_items;
\echo '== Items kept (used elsewhere too): their stock is recalculated'
SELECT i.name, w.name AS warehouse, l.quantity AS quantity_now,
       l.quantity - coalesce(sum(d.quantity), 0) AS quantity_after
FROM del_moves d
JOIN stock_items i ON i.id = d.item_id
JOIN warehouses w ON w.id = d.warehouse_id
JOIN stock_levels l ON l.item_id = d.item_id AND l.warehouse_id = d.warehouse_id AND l.tenant_id = i.tenant_id
WHERE d.item_id NOT IN (SELECT id FROM del_items)
GROUP BY i.name, w.name, l.quantity
ORDER BY i.name, w.name;

DO $$
DECLARE
  org uuid := current_setting('del.org')::uuid;
  pair record;
  mv record;
  q numeric;
  avg numeric;
  negatives int := 0;
  n bigint;
BEGIN
  IF (SELECT count(*) FROM del_invoices) = 0 THEN
    RAISE EXCEPTION 'No invoice of this organization has those numbers: nothing to do.';
  END IF;

  DELETE FROM vendor_invoice_line_corrections WHERE invoice_id IN (SELECT id FROM del_invoices);
  DELETE FROM vendor_invoice_lines WHERE invoice_id IN (SELECT id FROM del_invoices);
  DELETE FROM vendor_invoices WHERE id IN (SELECT id FROM del_invoices);
  DELETE FROM stock_movements WHERE id IN (SELECT id FROM del_moves);
  DELETE FROM stock_documents WHERE tenant_id = org AND id IN (SELECT id FROM del_docs);
  DELETE FROM stock_levels WHERE tenant_id = org AND item_id IN (SELECT id FROM del_items);
  DELETE FROM stock_items WHERE tenant_id = org AND id IN (SELECT id FROM del_items);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'stock items deleted: %', n;

  -- The kept items: replay what is left, as the ledger books it (weighted average on the way in).
  FOR pair IN
    SELECT DISTINCT warehouse_id, item_id FROM del_moves WHERE item_id NOT IN (SELECT id FROM del_items)
  LOOP
    q := 0; avg := 0;
    FOR mv IN
      SELECT quantity, unit_cost FROM stock_movements
      WHERE tenant_id = org AND warehouse_id = pair.warehouse_id AND item_id = pair.item_id
      ORDER BY created_at, id
    LOOP
      IF mv.quantity > 0 THEN
        avg := CASE WHEN greatest(q, 0) + mv.quantity > 0
                    THEN round((greatest(q, 0) * avg + mv.quantity * mv.unit_cost) / (greatest(q, 0) + mv.quantity), 4)
                    ELSE mv.unit_cost END;
      END IF;
      q := q + mv.quantity;
    END LOOP;
    IF q < 0 THEN negatives := negatives + 1; END IF;
    UPDATE stock_levels
       SET quantity = q, average_cost = avg,
           expires_on = CASE WHEN q > 0 THEN expires_on END, updated_at = now()
     WHERE tenant_id = org AND warehouse_id = pair.warehouse_id AND item_id = pair.item_id;
  END LOOP;

  IF negatives > 0 THEN
    RAISE WARNING '% stock level(s) would be below zero (goods from these invoices already went out). Review the '
                  '"Items kept" list; fix those with a correction after applying.', negatives;
  END IF;
END $$;

\echo '== Check: nothing points at what was deleted'
SELECT
  (SELECT count(*) FROM stock_movements m WHERE NOT EXISTS (SELECT 1 FROM stock_documents d WHERE d.id = m.document_id)) AS orphan_movements,
  (SELECT count(*) FROM stock_movements m WHERE NOT EXISTS (SELECT 1 FROM stock_items i WHERE i.id = m.item_id)) AS movements_without_item,
  (SELECT count(*) FROM stock_levels l WHERE NOT EXISTS (SELECT 1 FROM stock_items i WHERE i.id = l.item_id)) AS levels_without_item;

\if :apply_yes
COMMIT;
\echo 'COMMITTED: invoices and their stock deleted.'
\else
ROLLBACK;
\echo 'DRY RUN: rolled back, nothing was deleted.'
\endif
