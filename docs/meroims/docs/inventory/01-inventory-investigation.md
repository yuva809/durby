# 01 — MeroIMS Inventory Investigation (for Durby)

**Date:** 2026-10-20 · **Scope:** all inventory functionality reachable with the Admin account. **This phase was read-only**: client code + existing tenant data + earlier evidence. No inventory record was created, modified or deleted.
**Tags:** **V** verified from observed behaviour (runtime data/tests) · **C** documented from MeroIMS client code (request contract is real, server behaviour not exercised) · **I** inferred · **N** not investigated · **B** blocked by tenant data/configuration · **E** external requirement.
**Important:** entities below are **as exposed by the API**. MeroIMS's database schema is not accessible and is not claimed here.

**Evidence used**
| Source | Path |
|---|---|
| Read shapes (earlier rounds) | `evidence/captures/shapes-04-*.txt`, `shapes-b2-inventory.txt`, `shapes-b3-*.txt`, `shapes-b5-*.txt`, `shapes-S3..S5*.txt` |
| Route dossiers (UI) | `docs/routes/b2-inventory.md`, `b3-operations-pos.md`, `b1-commerce.md`, `b4-finance.md`, `b5-reports-admin.md` |
| POS stock tests | `docs/pos/tests/S3, S4, S5` |
| New this round: client code | `evidence/bundle/js-lazy-inventory/` (3 chunks) + existing bundles; route list `evidence/bundle/inventory-route-chunk-urls.txt` |
| New this round: existing-data pull | `evidence/tests/INV-readonly.spec.json`, `INV-readonly.json` (journals, movements, levels, product ledgers, position report, products, warehouses; filtered fields) |

**Tenant data limits (affect what can be observed without writes):** 70 products, all `itemType: product`; **60 FIFO / 10 weighted-average**; **0 perishable (expiry)**; **0 variants**; **0 secondary units**; **1 warehouse** (default, no branch); **0 branches**; 0 purchase bills/returns; 0 transfers/requests; reserved = expired = 0 everywhere; no negative stock.

---

## 1. Products, categories, units, variants, stock settings
| Aspect | Finding | Tag |
|---|---|---|
| Product fields | `id, tenantId, name, sku, barcode, hsCode, description, brand, categoryId, itemType (product/service), unitId, secondaryUnitId, unitsPerSecondaryUnit, packSize, salesPrice, secondarySalesPrice, purchasePrice, taxOption (vat_13/no_vat/null), valuationMethod (fifo/weighted_average), trackExpiry, lowStockThreshold, sales/purchase/return GL account ids, parentProductId, variantAttributes, originBranchId, image, isActive, archivedAt` + `stock{onHand, available, warehouses[]}` | V (shape) |
| Create form `/inventory/new` | Item Name*, Item Code, Barcode, Category, HS Code, Description, Tax, Sales Price, Purchase Price, Reorder Level, **Opening Stock**, **Perishable — track batches and expiry dates**, image. No valuation-method field visible | V (UI) |
| Create request | `POST /api/core/products {…, branchId?, warehouseId?, openingStock?, openingBatchNo?, openingExpiryDate?}`; image `POST/DELETE /api/core/products/{id}/image` (multipart); update `PATCH /api/core/products/{id}`; archive `DELETE`, `POST …/restore` | C |
| Stock edit from item form | changing on-hand in the edit form books an **adjustment delta** (`adjustmentType:"correction"`, reason "Stock corrected from item form") | C, V (7 existing such movements + journals) |
| Quick-create from document editor | `POST /api/core/products {name, itemType:"product", salesPrice, purchasePrice?, sku?}` then optional `POST /api/core/stock/adjustments {…adjustmentType:"opening"}` | C |
| Categories | `GET /api/core/lookups.productCategories {id, name, description, color, imageUrl, parentCategoryId (hierarchy), isActive, archivedAt}`; CRUD `POST/PATCH/DELETE /api/core/lookups/product-categories[/{id}]`, `…/restore` | V (shape), C (writes) |
| Units | `lookups.units {id, name, symbol}`; CRUD `/api/core/lookups/units[/{id}]`, restore | V, C |
| Secondary unit | product `secondaryUnitId + unitsPerSecondaryUnit + secondarySalesPrice`; document lines carry `unitMeta {unit_mode, unit_label, entered_quantity, entered_rate}` while `quantity` is stored in the primary unit | V (shape), C (conversion `toPrimaryPersisted`) |
| Variants | parent product created **inactive** (`isActive:false`) + child products with `parentProductId` + `variantAttributes`; variant attributes CRUD `/api/core/variant-attributes[/{id}]` | C; tenant has 0 variants → behaviour **B** |
| Valuation method | per product `fifo` / `weighted_average` (UI label "FIFO" / "Weighted average"); how it is set (create form shows no selector) **unknown** | V (data), I/N (setting) |
| Reorder level | `lowStockThreshold`; dashboard "Low stock", `/inventory?stock=low_stock` filter | V |

## 2. Stock overview, availability, movement history
| Aspect | Finding | Tag |
|---|---|---|
| Levels | `GET /api/core/stock/levels?warehouseId` → `[{productId, warehouseId, warehouseName, branchId, branchName, onHand, reserved, expired, available, avgCost}]` (46 rows = products with stock) | V |
| Availability formula | `available` reported separately from `onHand`, `reserved`, `expired`; with reserved = expired = 0 everywhere, available = onHand in all rows. Formula `available = onHand − reserved − expired` is **inferred** | V (values) / I (formula) |
| Movements | `GET /api/core/stock/movements?productId&warehouseId&page&perPage` → `{id, productId, warehouseId, movementType, quantity, unitCost, sourceType, sourceId, reason, batches[], createdById, createdAt}` | V |
| Movement types seen in data | `adjustment/adjustment`, `sale/sales_invoice`, `sales_return/sales_return` | V |
| Movement types in UI code | `opening, purchase, purchase_return, sale, transfer, adjustment, correction, loss, expired` | C |
| Source of POS stock movements | **the sales invoice** (`sourceType: sales_invoice`), not the POS order | V (S3/S5 + data) |
| Valuation ledger | `GET /api/core/reports/business/inventory-ledger?from&to&itemIds&warehouseId` → sections per item, rows `{date, type, number, contact, warehouse, inQty, inRate, inAmount, outQty, outRate, outAmount, balanceQty, balanceRate, balanceAmount}`; synthetic opening row dated 1944-01-01 | V |
| Live updates | SSE `core.stock.level_changed {productId, warehouseId, available, tenantAvailable}` | C (payload), V (stream open) |

## 3. Warehouses, branches, allocation
| Aspect | Finding | Tag |
|---|---|---|
| Warehouse | `{id, name, kind ("warehouse"/"branch_store"), branchId, branchName, stockLocationId, sharedBranches[], isDefault, isActive, address, location, phone, email, archivedAt}`; CRUD `POST/PATCH/DELETE /api/core/warehouses`, restore | V (shape), C (writes) |
| Branch | `GET /api/core/branches`, CRUD + `PATCH /branches/{id}/location` + restore; branch stores appear as warehouses of kind `branch_store` (`?includeBranchStores`) | V (endpoint), C, **B** (0 branches) |
| Tenant flags | `branchSharedStock`, `transferApprovalRequired` | V (shape) |
| Allocation | documents/adjustments accept `branchId` or `warehouseId`; register has `storeWarehouseId` (null here → default warehouse used, I) | C / I |

## 4. Opening stock & manual adjustments
| Aspect | Finding | Tag |
|---|---|---|
| UI | `/inventory/adjustment`: table ITEM · ON HAND · RESERVED · AVAILABLE · AVG COST · STOCK VALUE · ACTIONS; history WHEN · ITEM · TYPE · QUANTITY · UNIT COST · REASON; reason placeholder "e.g. Stock count correction" | V |
| Request | `POST /api/core/stock/adjustments {productId, direction:"add"|"reduce", quantity, unitCost?, reason, adjustmentType:"opening"|"add"|"correction"|"loss", branchId?, warehouseId?, batches?:[{batchNo, expiryDate, quantity}]}` | C |
| Opening stock (accounts tab) | `/opening-balance` → tab *Product* uses `GET /api/core/stock/opening {products[], warehouses[]}` | V |
| **Accounting of stock increase (existing data)** | `core.stock.adjusted`: **Dr INV0001 Inventory Asset / Cr OBE0001 Opening Balance Equity**; Dr line carries `productId, quantity, unitCost` (e.g. 790 @ 190.00 = 150,100.00) | **V** |
| Accounting of `loss`/reduce | likely role `stock_adjustment` (posting role exists) | I / N |

## 5. Warehouse transfers & branch stock requests
| Aspect | Finding | Tag |
|---|---|---|
| UI | `/stock-requests` tabs *Branch requests* / *Between warehouses*; filters by status (Draft, Awaiting approval, Approved, Packed, Driver assigned, Verified, In transit, Delivered, Received, Rejected, Cancelled); `/stock-requests/new` tabs *For a branch* / *Between warehouses* (From/To warehouse, note, catalog by category); `/inventory/warehouse-transfer` redirects to `/stock-requests` | V |
| Create transfer | `POST /api/core/stock/transfers {sourceWarehouseId, destinationWarehouseId, lines:[{productId, quantity}], note}` (client caps qty at available; same-warehouse rejected client-side) | C |
| Transfer detail | `GET /api/core/stock/transfers/{id}` → `availableActions[]` (server-driven), lines `{quantity, pickedQuantity, pickNote, packed+by/at, batches, sourceBatches, verifiedQuantity, discrepancyNote, checked+by/at, receivedQuantity, unitCost, added+by/at/qty}`, `history[]`, linked `request` | C |
| Transfer actions | `POST /api/core/stock/transfers/{id}/{action}`: `pack`, `check`, `dispatch`, `assign-driver {driverId, note}`, `deliver`, `receive {lines:[{productId, receivedQuantity}]}`, `cancel`, `approve`, `reject`; `…/schedule {supplyDate}` | C |
| Transfer statuses | `draft, pending_approval, approved, packed, checked, verified, in_transit, delivered, received, rejected, cancelled, closed` | C |
| Branch request | `POST /api/core/stock/requests {branchId, lines, note}`; `POST …/{id}/{approve|reject|archive|restore}`, `…/ship {sourceWarehouseId, note}`, `…/close {note}`, `DELETE`; catalog `GET …/catalog?branchId`; OC/DC confirmations `GET …/confirmations` | C |
| Stock & cost effect of transfers | `unitCost` carried on transfer lines (cost moves with stock, I); timing of decrement/increment (ship vs receive) **N** | I / N, **B** (one warehouse, no branches) |
| Permissions | client checks `denialReason(access, "stock_request", "create")` → resource/action RBAC | C |

## 6. Purchase bills & goods receipt
| Aspect | Finding | Tag |
|---|---|---|
| UI | `/purchases/bills/create`: tabs *Cash Purchase* / *Party Purchase*; lines (product search, qty, rate, discount %, amount), adjustments (discount, tax, charges), paid amount / "Pay total amount", account, TDS, notes, image, signature | V |
| Request | `POST /api/core/purchases/bills` (edit `PATCH /api/core/purchases/bills/{id}`) `{date, documentNumber?, partyId?, lines:[{productId, description, kind, quantity, unitPrice, discountAmount|discountPercent, unitMeta, batchNo?, expiryDate?}], discount…, customFields{tax_option (default "no_vat" unless *Add Tax*), cash_transaction?, chalani_no?}, charges[], settledAmount?, settlementAccountId?, creditTermId?, tds…, notes, attachments[], branchId?|warehouseId?, requestId}` | C |
| Batch capture on receipt | `batchNo + expiryDate` per line only for perishable products | C |
| Stock / cost / journal effect | **not observed** (0 bills in tenant) | **N** (needs write test) |
| Document mutability | bills (and all trade documents) can be **edited (`PATCH`) after save**, voided (`POST /api/core/documents/{id}/void {reason}`), deleted (`DELETE`), restored | C |

## 7. Purchase returns
`POST /api/core/purchases/returns` (same editor body; *Cash Return* / *Party Return*, "Receive the full amount"); expected stock decrease + reversal journal | C (contract) / **N** (effect)

## 8. POS stock deduction, holds, cancellation, refunds, restocking
| Aspect | Finding | Tag |
|---|---|---|
| Sale | stock −qty at completion via the auto-created invoice (movement `sale/sales_invoice`, cost at current layer: 15.00 / 18.00) | **V** (S3, S5) |
| Journal | sale journal includes **Dr COGS / Cr Inventory** at the snapshot unit cost | **V** |
| Hold | held order creates no invoice; stock not re-read between hold and finalize, so reservation is **N**; `reserved` = 0 in all levels after tests | V (no invoice) / N (reservation) |
| Refund with restock | `sales_return` movement +qty **at original cost** (15.00), journal Dr Inventory / Cr COGS | **V** (S4) |
| Refund without restock | not tested | N |
| Order cancellation (`transition → cancelled`) | not tested | N |

## 9. Selling with insufficient/zero stock
| Aspect | Finding | Tag |
|---|---|---|
| Till UI | product tile **disabled when `available ≤ 0`** unless item is `service` or the till runs with `ignoreStock` (restaurant flag `restaurantIgnoreStock`); tile shows "out of stock" | C, V (label) |
| Transfer UI | quantity capped at available | C |
| **Server enforcement** (qty > available on an in-stock item, or API call bypassing UI) | unknown | **N** (write test) |

## 10. Reservations & concurrent sales
`reserved` field exists on levels; no client logic sets it; all values 0. Concurrency across tills (two finalizes, simultaneous sales of last unit) not tested. | V (field) / **N** (behaviour)

## 11. Batch, expiry, serial numbers
| Aspect | Finding | Tag |
|---|---|---|
| Batch/expiry | product `trackExpiry` ("Perishable"); batches on adjustments, documents (`batchNo, expiryDate`), transfers (`batches`, `sourceBatches`), movements (`batches[]`); re-date `PATCH /api/core/stock/batches/{id} {batchNo, expiryDate}`; expiry page `/inventory/expiry` (`GET /api/core/stock/expiry?status&withinDays&warehouseId` → `{data[], today}`; filters location / status / warning window); `expired` qty on levels; movement type `expired` | C / V (shapes), **B** (0 perishable products) |
| Batch consumption order (FEFO?) | unknown | N |
| Serial numbers | no evidence anywhere in client code or API | not found (absence **not** proven) |

## 12. Valuation & costing
| Aspect | Finding | Tag |
|---|---|---|
| Methods | `fifo` and `weighted_average` per product; both in use (60/10) | V |
| Cost on sale | `unitCost` snapshot on invoice line and journal; ledger out-rate = current balance rate | V |
| Cost on refund-restock | original cost | V |
| `avgCost` on levels | present | V (field) |
| Layer behaviour (FIFO consumption order, average recomputation on receipt at a new cost) | **not observable**: each product has one cost layer | **N** (needs a receipt at a different cost) |
| Landed cost (charges on purchase allocated to cost?) | purchase `charges[]` exist; allocation unknown | N |
| Valuation report | `GET /api/core/reports/business/inventory-position?from&to` → `{rows[{item, category, qty, uom, rate, amount}], rowCount, totals{qty, amount}}` (total 1,521,846.00, consistent with dashboard) | V |

## 13. Inventory accounting entries & timing
| Event | Journal | Tag |
|---|---|---|
| Stock increase via item form / opening | Dr Inventory Asset / Cr Opening Balance Equity (`core.stock.adjusted`) | **V** |
| POS sale | … Dr COGS / Cr Inventory (`core.invoice.issued`), ~1.8 s after the sale | **V** |
| POS refund with restock | Dr Inventory / Cr COGS (`core.sales_return.recorded`) | **V** |
| Purchase bill | expected Dr Inventory (+ input VAT) / Cr Cash or AP | I / **N** |
| Purchase return, loss/damage, expiry write-off, transfers | posting roles `stock_adjustment`, `purchase_return`, `inventory` exist | I / **N** |
| Mapping basis | all 22 mappings `eventKey: "global"` (role → account) | V |

## 14. Stock reports, physical counts, reconciliation
Reports observed: inventory position, inventory ledger (per item), product page *Inventory Ledger* + *Item Activity* tabs, dashboard stock value / in-stock / low / out / dated stock. No dedicated **stock-count (stocktake)** workflow found: counts are corrected through adjustments ("Stock count correction"). Reconciliation of GL Inventory vs valuation report: not performed. | V / not found / N

## 15. Recipe / BOM ingredient consumption
BOM and Production Order pages show **"Coming soon"**, no API calls; **no recipe/ingredient code** in the client bundles. Restaurant `restaurantIgnoreStock` suggests restaurant mode may bypass stock instead of consuming ingredients (I). | V (not implemented in UI) / I

---

## Proposed Durby inventory entities (recommendation, not MeroIMS schema)
Product (stock-tracked flag, valuation method, base unit + pack conversions) · StockLocation (per restaurant, optional bar/kitchen sub-locations) · StockMovement (append-only, signed qty, unitCost, sourceType/sourceId, reason code, batch) · CostLayer (FIFO) or running average per product×location · StockLevel (materialised) · Batch (optional, perishables) · Recipe + RecipeLine (dish → ingredients with yield/waste %) · StockCount + StockCountLine (stocktake with variance posting) · Supplier GoodsReceipt / PurchaseBill (later ERP) · Transfer (only if multi-location). Extends `docs/pos/04-pos-domain-model.md`.

---
## Update after controlled test INV-T1 (purchase bill), see `tests/INV-T1-purchase-bill.md`
| Area | Now | Tag |
|---|---|---|
| §6 Goods receipt | cash purchase bill (no tax) → `BILL-2026-000001` settled; stock +qty per line; movement `purchase/purchase_bill` with `unitCost` = unit price; client sends `requestId` (idempotency) and default `warehouseId` | **V** |
| §12 Weighted average | recomputed on receipt: 403@15 + 2@17 → 405 @ **15.0099** | **V** |
| §12 FIFO | stock level and valuation ledger show a **blended average** (173 @ 18.0231) even for FIFO products; FIFO consumption order on sale still unobserved | V (reporting) / **N** (consumption) |
| §13 Purchase journal | `core.purchase.recorded`: Dr Inventory per product line (with qty) / Cr Cash In Hand **with operationalAccountId** → operational cash account −74.00 (negative allowed) | **V** |
| Valuation report | +74.01 for a 74.00 receipt (0.01 rounding drift) | **V** |
| Cash asymmetry explained | purchases settle via an operational account (GL line carries `operationalAccountId`); POS sales don't, so their cash never reaches the money account | **V** |

## Update after INV-T2 (FIFO sale) and INV-T3 (loss), see `tests/`
| Area | Now | Tag |
|---|---|---|
| §12 FIFO | sale of a FIFO-flagged product after a 2nd layer costed at **moving average 18.0231**, not FIFO 18.00 → **`valuationMethod: fifo` is not applied** | **V** |
| §12 Rounding | valuation ledger drifts by 0.01 after receipts/sales (3099.98 vs 3099.97; 6079.00/6063.99 use 2-dp rates) | **V** |
| §4/§13 Loss | `adjustmentType: loss` → movement `adjustment` (type not kept) @ avg cost; journal Dr **ADJ0001 Stock Adjustment Loss** / Cr Inventory | **V** |
| §4 Adjustment reasons | reduce: `loss`, `correction`; add: `correction`, `opening`, `found` (+ unit cost); expiry write-off sends `loss` with batch | V (UI) |
| Cash channels | back-office cash invoices and bills move the operational cash account (settlement account set); POS sales don't | **V** |

## What this means for Durby's inventory module (design input, not MeroIMS facts)
| MeroIMS behaviour (verified) | Durby decision (recommendation) |
|---|---|
| Append-only movements with `sourceType/sourceId`, levels as aggregate, per-line cost snapshot | **Copy** |
| Moving weighted average recomputed on receipt; FIFO flag ignored | **Use moving weighted average** as the single method for the restaurant MVP (simple, matches what MeroIMS actually does); do **not** expose a FIFO option until implemented end-to-end |
| Loss → Stock Adjustment Loss expense; increases → Opening Balance Equity | **Keep loss expense**; book "found"/correction increases to an inventory-gain/variance account, not equity, after go-live |
| Adjustment type not kept on movement | **Store reason code on the movement** (waste, breakage, staff meal, count variance, expiry) for waste reporting |
| Valuation report rounding drift | Store unit cost with ≥4 dp and value = Σ(movement qty × cost) to avoid drift |
| Documents editable after posting | **Immutable after posting**; corrections via reversal documents (GoBD) |
| Overselling: UI-only guard; restaurant mode can ignore stock | **Allow negative stock with alerts** (service must not stop); configurable per product |
| No recipes / BOM | **Design recipes** (dish → ingredients, yield/waste %) and consume on sale; no MeroIMS reference |
| No stocktake workflow | **Design stocktake** (count sheet → variance → adjustment with reason) |
| Purchases settle the operational cash account; POS sales don't | One consistent cash model (see POS blueprint) |
