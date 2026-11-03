-- Never-sold products and categories may be deleted (ADR 0024, amends ADR 0016 §5). The catalog migration
-- revoked DELETE; give it back, without TRUNCATE. Sold products stay protected by the ON DELETE RESTRICT foreign
-- key of pos_order_lines; RLS still applies.
GRANT DELETE ON "product_categories", "products" TO durby_app;
