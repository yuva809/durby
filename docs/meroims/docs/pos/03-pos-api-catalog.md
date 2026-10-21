# 03 — MeroIMS POS API Catalog (observed)

**Base:** `https://api-dev.meroims.com` · JSON · CORS (`OPTIONS` → 204 before each call) · **Auth:** `Authorization` bearer header (SSE: `?access_token=`) · Money = decimal **strings** (2 dp; quantities 4 dp) · IDs = UUID.
Sources: **T** = approved write test (actual body; `evidence/tests/S*-result.json`) · **S** = REA value-free shape (`evidence/captures/shapes-*.txt`) · **B** = client code only (`evidence/bundle/js*`).
Error envelope (observed on gated endpoints): **HTTP 403** `{ "code": string, "message": string }`; known codes (B): `pos.retail_disabled`, `pos.restaurant_disabled`, `pos.store_not_provisioned`.

## 1. Till session & catalog
| Method · Path | Request | Response | Src |
|---|---|---|---|
| GET `/api/pos/retail/context` | — | `{ storeName, currency, vatPercent, tillBgLogoUrl, bankAccounts[{id, accountName, accountNumber, bankCode, bankName, isDefault}], registers[{id, name, branchId, branchName, storeWarehouseId, openShiftId, openShift{id, registerId, status, openingFloat, openedAt, openedById, closedAt, closedById, countedCash, closeSummary}}] }` | S, T |
| GET `/api/pos/products?registerId=` | — | `[{ id, productId, name, sku, barcode, categoryId, categoryName, salesPrice, available, taxOption ("vat_13"\|"no_vat"\|null), itemType, imageUrl, isFeatured, isOrderingEnabled, isVisible, displayOrder, posDescription, coreActive, originBranchId, updatedAt }]` | S, T |
| GET `/api/pos/retail/products/lookup?code=&registerId=` | — | UNK (not called during typed search) | B |
| GET `/api/core/sales/party-search?search=&limit=20` | — | `{ data[{id, name, partyType, phone, email, balance, creditLimit}], hasMore }` | S, B |
| GET `/api/events/stream?access_token=` (SSE) | — | events incl. `core.stock.level_changed {productId, warehouseId, available, tenantAvailable}`, `pos.order.{placed,completed,cancelled,refunded,status_changed}`, `pos.delivery.{assigned,location_updated}`, `pos.account_disabled`, `pos.invalid_refresh` | B (names), OBS (stream open) |

## 2. Shifts
| Method · Path | Request | Response | Src |
|---|---|---|---|
| POST `/api/pos/shifts` | `{ "registerId": uuid, "openingFloat": "0" }` | **201** `{ id, tenantId, registerId, openedById, status:"open", openingFloat:"0.00", openedAt, closedAt:null, closedById:null, countedCash:null, closeSummary:null }` | T (S2) |
| GET `/api/pos/retail/shifts/{id}/x-report` | — | `{ shiftId, registerId, status, openedAt, ordersTotal, ordersCompleted, ordersRefunded, grossSales, capturedTotal, tenderTotals{cash?, card?, …}, openingFloat, paidIn, paidOut, drops, expectedCash }` | T |
| POST `/api/pos/retail/shifts/{id}/cash-movements` | `{ "type": "paid_in"\|"paid_out"\|"drop", "amount": "100.00", "reason": string? }` | **201** `{ id, tenantId, shiftId, registerId, movementType, amount, reason, createdById, createdAt }` | T (S6) |
| POST `/api/pos/shifts/{id}/close` | `{ "countedCash": "40.00" }` | **201** shift `{ …, status:"closed", closedAt, closedById, countedCash, closeSummary{ ordersTotal, ordersCompleted, ordersRefunded, grossSales, capturedTotal, tenderTotals, openingFloat, paidIn, paidOut, drops, expectedCash, countedCash, cashVariance, balanced } }` | T (S7) |

## 3. Sales, holds, receipts
| Method · Path | Request | Response | Src |
|---|---|---|---|
| POST `/api/pos/retail/sales` | `{ clientOrderId: uuid, registerId, customer?{partyId?, name, phone, vatNumber}, lines[{ productId, quantity:"1", unitPrice?, discountAmount? }], tenders[{ type:"cash"\|"card"\|"gateway"\|"credit", amount }], cashierName, note? }` | **201** `{ order, receipt, cashReceived, changeDue }` (shapes below) | T (S3), B |
| POST `/api/pos/retail/holds` | `{ clientOrderId, registerId, customer?, lines[…], cashierName, note? }` | **201** order (status `held`, paymentStatus `pending`, `shiftId:null`, `receiptNumber:null`, `tenders:[]`) | T (S5) |
| GET `/api/pos/retail/holds` | — | `[order…]` held orders **tenant-wide** | S, T |
| POST `/api/pos/retail/holds/{id}/finalize` | `{ registerId, tenders[{type, amount}], cashierName }` | **201** `{ order, receipt, cashReceived, changeDue }` | T (S5) |
| GET `/api/pos/retail/orders/{id}/receipt` | — | receipt object | B, S |

**`order`** (T): `{ id, tenantId, clientOrderId, orderNumber "ORD-YYYY-NNNNNN", channel "retail_pos", status, paymentStatus, partyId, placedByUserId, placedByName, customerName, currency, subTotal, discountTotal, taxTotal, deliveryCharge, grandTotal, tenders[{type, amount, capturedAt}], discountCode, reservationId, reservationStatus, driverId, assignedById, driverAssignedAt, driverAcceptedAt, shiftId, registerId, branchId, receiptNumber "RCPT-NNNNNN", cashReceived, changeDue, notes, tableOrderId, diningTableName, placedAt, completedAt, lines[{ id, orderId, tenantId, lineNo, productId, name, sku, quantity "1.0000", unitPrice, discountAmount, taxAmount, lineTotal (net) }], createdAt, updatedAt }`

**`receipt`** (T): `{ store{name, currency, vatPercent}, register{id, name}, table, tableOrderId, shiftId, receiptNumber, orderNumber, orderId, channel, status, soldAt, operator{id, name}, customer{partyId, name}, lines[{lineNo, productId, name, sku, quantity, unitPrice, discountAmount, taxAmount, lineTotal}], totals{currency, subTotal, discountTotal, taxTotal, deliveryCharge, grandTotal}, tenders[], cashReceived, changeDue }`, no fiscal/signature fields.

## 4. Order management
| Method · Path | Request | Response | Src |
|---|---|---|---|
| GET `/api/pos/orders?page&perPage` | — | `{ data[order…], meta{page, perPage, total, totalPages} }` | S |
| GET `/api/pos/orders/{id}` | — | order + `events[{ id, orderId, tenantId, event, fromStatus, toStatus, actorType, actorId, note, createdAt }]` | T (S4) |
| POST `/api/pos/orders/{id}/refund` | `{ lines[{ productId, quantity:"1.0000" }], restock: true, reason?: string }` | **201** order (`status:"refunded"`, `paymentStatus:"refunded"`) | T (S4) |
| POST `/api/pos/orders/{id}/transition` | `{ toStatus, note? }` | UNK | B |
| POST `/api/pos/orders/{id}/resume` | — | UNK | B |
| POST `/api/pos/orders/{id}/assign-driver` | `{ driverId }` | UNK | B |

## 5. POS administration
| Method · Path | Request | Response | Src |
|---|---|---|---|
| GET `/api/pos/admin/registers` | — | `[{ id, tenantId, name, branchId, branchName, isActive }]` | S, T |
| POST `/api/pos/admin/registers` | `{ "name": "sample 1", "branchId": null }` | **201** `{ id, tenantId, name, branchId, isActive }` | T (S1) |
| GET `/api/pos/admin/settings` | — | `{ tenantId, storeName, storeAddress, storePhone, storePan, currency, vatPercent, deliveryCharge, loyaltyRedeemRate, tillBgLogoUrl, brandName, slug, storeTemplateId, storefrontConfig, barCategoryIds, posRetailEnabled, posRestaurantEnabled, posMobileEnabled, posEcommerceEnabled, restaurantKitchenEnabled, restaurantBarEnabled, restaurantIgnoreStock, entitlements{…}, updatedAt }` | S |
| GET `/api/pos/admin/bank-accounts` | — | `[{ id, tenantId, accountName, accountNumber, bankCode, bankName, isDefault, isActive, createdAt }]` | S |
| GET `/api/pos/admin/discount-codes` | — | `[]` in tenant (shape UNK) | S |
| GET `/api/pos/admin/users` | — | `[]` in tenant (shape UNK) | S |
| GET `/api/pos/admin/entitlements` | — | entitlement flags | S |
| GET `/api/pos/restaurant/{areas,tables,stations}` | `tables?includeInactive` | **403** `{code, message}` (restaurant disabled) | S |
| POST `/api/pos/auth/refresh` | UNK (POS-staff session) | UNK | B |

## 6. Supporting endpoints touched by POS flows
| Method · Path | Why | Src |
|---|---|---|
| GET `/api/core/documents?type&page&perPage`, GET `/api/core/documents/{id}` | POS-generated `sales_invoice` / `sales_return` | T |
| GET `/api/accounting/journals`, `/journals/{id}` | posting result (`sourceEventType`, lines, audits) | T |
| GET `/api/accounting/chart-accounts`, `/mappings`, `/cash-bank-mappings` | which GL accounts POS events hit | T |
| GET `/api/core/stock/levels`, `/stock/movements` | stock effect | S |
| POST `/api/auth/refresh` | `{refreshToken}` → `{accessToken, refreshToken, actorType, tenantId}` (rotation) | S |

## 7. Conventions worth copying / changing in Durby
- Copy: client idempotency key (`clientOrderId`), server-side pricing, decimal strings, separate order vs receipt numbering, append-only order events, frozen Z-report snapshot, event-driven posting with `sourceEventType` back-references.
- Change: refunds must create negative cash tenders in the shift; card must not post to cash; cash movements and variances must journal; every config change must be audited; receipts need fiscal (TSE) data for Germany.
