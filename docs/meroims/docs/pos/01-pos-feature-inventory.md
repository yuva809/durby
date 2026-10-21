# 01 — MeroIMS POS Feature Inventory & Route Checklist

Scope: POS functionality and the minimum supporting product / stock / document / accounting interfaces.
Evidence: route dossiers (`docs/routes/b3-operations-pos.md`, `b6-restaurant-probe.md`), controlled tests S1–S7 (`docs/pos/tests/`), client code (`evidence/bundle/js*`, `evidence/pos-retail-api-client.txt`).
Tags: **OBS** observed at runtime · **TEST** exercised by an approved write test · **BND** seen only in client code · **INF** inferred · **UNK** unknown · **N/A** not available in this tenant.

## 1. Feature inventory

### 1.1 Configuration (POS Settings `/pos-settings`)
| Feature | Status | Notes / evidence |
|---|---|---|
| Registers (create, turn off, remove, assign branch) | **TEST** (create) / OBS | S1: `POST /api/pos/admin/registers {name, branchId}` → `{id, tenantId, name, branchId, isActive}`. Turn off / Remove buttons OBS, not exercised |
| Selling channels toggles (retail, restaurant, mobile, e-commerce) | OBS (UI) / BND | `GET /api/pos/admin/settings`: `posRetailEnabled, posRestaurantEnabled, posMobileEnabled, posEcommerceEnabled, restaurantKitchenEnabled, restaurantBarEnabled, restaurantIgnoreStock, barCategoryIds` |
| Receipt details (store name*, address, phone, PAN/VAT) | OBS (form) | `Save receipt details`; values feed `receipt.store` |
| Till background logo | OBS (form) | `tillBgLogoUrl` |
| Bank QR payment accounts | OBS | `GET /api/pos/admin/bank-accounts {accountName, accountNumber, bankCode, bankName, isDefault, isActive}`; QR tender requires one |
| Discount codes | OBS (form, none exist) | fields: Code*, Type (percentage off / fixed amount off), Percent (max 100)*, Minimum order total, Starts/Ends (optional), Total uses (blank = unlimited). Order has `discountCode`. Behaviour **UNK** (not tested) |
| VAT rate, currency, loyalty redeem rate, delivery charge | OBS (settings shape) | `vatPercent "13.0000"`, `currency NPR`, `loyaltyRedeemRate`, `deliveryCharge` |
| POS users / cashiers | OBS (empty list) | `GET /api/pos/admin/users` = `[]`; separate POS auth (`/api/pos/auth/refresh`) **UNK** |
| Plan entitlements | OBS | `GET /api/pos/admin/entitlements` |

### 1.2 Retail till (`/till`)
| Feature | Status | Notes |
|---|---|---|
| Register picker + open shift (float presets 0/500/1000/2000/5000, "join open shift") | **TEST** S2 | register choice per browser in `localStorage["ims.till.register"]` |
| Product grid with category tabs (counts), paging, live stock ("n left" / "out") | OBS | `GET /api/pos/products?registerId=`; SSE `core.stock.level_changed` updates `available` |
| Search: barcode / name / SKU (client-side filter; Enter does not add) | **TEST** S3 | lookup endpoint exists (`/api/pos/retail/products/lookup?code=`) but not called for typed SKU |
| Cart lines: − / + / Edit (price/discount override) / Void line | OBS (UI) | overrides sent as `unitPrice` / `discountAmount` only when edited (BND) |
| Attach customer (walk-in default; party search) | OBS (UI) / BND | `customer {partyId?, name, phone, vatNumber}`; `GET /api/core/sales/party-search` |
| Hold (F8) / Resume (F9, tenant-wide list) / Take payment | **TEST** S5 | |
| Tender (F10): Cash · Card · QR (`gateway`) · Credit (needs party) · Split (cash+card) | **TEST** cash (S3), card (S5); others BND | quick cash buttons; change computed; tabs toggled per tenant |
| Receipt (structured object returned with sale) | **TEST** S3 | `RCPT-NNNNNN`; printable 80 mm |
| X-report (mid-shift), Print 80 mm | **TEST** | |
| Cash in/out: paid in · paid out · drop | **TEST** S6 | shift-only, no journals |
| Close shift (blind count) → Z-report snapshot, Print 80 mm | **TEST** S7 | |
| Keyboard shortcuts (F8 / F9 / F10, Enter to complete) | OBS | |
| "Live" indicator (SSE connected) | OBS | |

### 1.3 POS order management (`/orders`)
| Feature | Status | Notes |
|---|---|---|
| Orders list (number, customer, type/channel, total, payment, status) | OBS | `GET /api/pos/orders?page&perPage` |
| Order detail + event history | **TEST** S4 | `events[]{event, fromStatus, toStatus, actorType, actorId, note}` |
| Refund (line qty, restock toggle, reason) | **TEST** S4 | |
| Status transitions / undo / resume held | BND | `POST /api/pos/orders/{id}/transition {toStatus, note?}`, `/resume` |
| Reprint receipt (80 mm) `/print/receipt/{id}` | OBS (button) | |
| Driver assignment (delivery) | BND | `POST …/assign-driver {driverId}` |

### 1.4 Restaurant POS (disabled in this tenant)
| Feature | Status | Notes |
|---|---|---|
| Restaurant till `/restaurant/till` | **N/A** ("Till unavailable") | gated server-side: `GET /api/pos/restaurant/*` → **403** `{code, message}` |
| Tables & QR `/restaurant/tables` | OBS (page renders) / N/A data | areas, tables (`includeInactive`), stations |
| Kitchen display `/restaurant/kitchen`, Bar `/restaurant/bar` | N/A | `restaurantKitchenEnabled`, `restaurantBarEnabled`, `barCategoryIds` |
| Waiter floor `/restaurant/waiter` | N/A | |
| KOT status, modifiers, seats, table orders, reservations | BND | `kotStatus`, `ModifierState`, `Seats`, order `tableOrderId`, `diningTableName`, `reservationId/reservationStatus` |
| Shared till workspace with retail | INF | `TillWorkspace({… ignoreStock …})` used by tills |

### 1.5 Supporting interfaces used by POS (minimum set)
| Interface | Status | Role in POS |
|---|---|---|
| Products, categories, units, VAT option (`vat_13`, `no_vat`, null) | OBS | catalog, pricing (VAT-exclusive for `vat_13`), stock |
| Stock levels / movements / inventory ledger | TEST | −qty on sale, +qty on restocked refund |
| Sales documents (`sales_invoice`, `sales_return`) | TEST | auto-created per POS sale / refund |
| Journals + posting mappings (roles × `eventKey`) | TEST | `core.invoice.issued`, `core.sales_return.recorded` |
| Parties (customers) | OBS | optional customer on sale; `credit` tender |
| Audit log | OBS | selective; register creation not logged |
| SSE event stream | OBS / BND | live stock; POS order events |

## 2. POS route checklist
| Route | Status | Dossier / test |
|---|---|---|
| `/pos-settings` | ✅ inspected; register create tested | b3, S1 |
| `/till` | ✅ inspected; full lifecycle tested | b3, S2–S7 |
| `/orders` | ✅ inspected; refund tested | b3, S4 |
| `/print/receipt/{id}` | ◐ link observed, page not opened | — |
| `/restaurant/till` | ⛔ unavailable (restaurant disabled) | b6 |
| `/restaurant/tables` | ◐ renders; data 403 | b6 |
| `/restaurant/kitchen` | ⛔ unavailable | b6 |
| `/restaurant/bar` | ⛔ unavailable | b6 |
| `/restaurant/waiter` | ⛔ unavailable | b6 |
| `/inventory`, `/inventory/{id}` | ✅ inspected (supporting) | b2 |
| `/sales/invoices`, `/sales/returns` | ✅ inspected (supporting) | b1 |
| `/accounting-workbench` (journals, mappings) | ✅ inspected (supporting) | b4 |

## 3. Explicitly not verified (do not assume)
Discount-code application · VAT rounding on multi-line/discounted carts · split tender · credit tender · QR/gateway tender · partial refund · refund without restock · void/cancel of an order · line void accounting · tips/service charge (no evidence it exists) · modifiers/course firing (code only) · offline operation (UNK: not tested; client-generated `clientOrderId` suggests idempotent retry is intended) · POS user PIN login · receipt printing hardware · customer display · fiscal device of any kind (none observed).
