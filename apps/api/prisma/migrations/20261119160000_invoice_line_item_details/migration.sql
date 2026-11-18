-- ADR 0055: a vendor invoice line for an existing item may carry the category, brand and pack size to set on that
-- item when the invoice is approved, in the same columns a new item's use. The pack check of 20261119140000 allowed
-- them only on new-item lines: replace it with the same check without that rule. Relaxes a constraint only.
ALTER TABLE "vendor_invoice_lines" DROP CONSTRAINT "vendor_invoice_lines_new_pack_check";

ALTER TABLE "vendor_invoice_lines" ADD CONSTRAINT "vendor_invoice_lines_new_pack_check" CHECK (
  ("new_item_brand" IS NULL OR char_length("new_item_brand") BETWEEN 1 AND 100)
  AND ("new_item_pack_count" IS NULL OR "new_item_pack_count" BETWEEN 1 AND 100000)
  AND (("new_item_pack_size" IS NULL) = ("new_item_pack_unit" IS NULL))
  AND ("new_item_pack_size" IS NULL OR "new_item_pack_size" > 0)
);
