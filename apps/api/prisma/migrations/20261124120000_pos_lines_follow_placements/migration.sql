-- Merged orders (ADR 0069, amended): a line belongs to the order of its ticket's current placement, so a void, a bill
-- item or a discount of a moved line is on another order than the line was sent on. These composite keys refused that
-- (500 when billing, voiding or discounting after a merge). The line itself is still referenced, in its own tenant; that
-- it is on the order now is checked by the services under the order's lock. No rows change, and older releases keep
-- working: they never depended on the refusal. A ticket's lines stay on the ticket's order.

-- The plain key pos_order_lines_tenant_id_voids_line_id_fkey stays.
ALTER TABLE "pos_order_lines" DROP CONSTRAINT "pos_order_lines_voids_same_order_fkey";

ALTER TABLE "pos_bill_items" DROP CONSTRAINT "pos_bill_items_order_line_fkey";
ALTER TABLE "pos_bill_items" ADD CONSTRAINT "pos_bill_items_tenant_id_order_line_id_fkey" FOREIGN KEY ("tenant_id", "order_line_id") REFERENCES "pos_order_lines"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "pos_order_discount_lines" DROP CONSTRAINT "pos_order_discount_lines_order_line_fkey";
ALTER TABLE "pos_order_discount_lines" ADD CONSTRAINT "pos_order_discount_lines_tenant_id_order_line_id_fkey" FOREIGN KEY ("tenant_id", "order_line_id") REFERENCES "pos_order_lines"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
