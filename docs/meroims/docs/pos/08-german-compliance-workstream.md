# 08 — German Restaurant POS Compliance Workstream (essential, gating)

> **Not legal or tax advice.** This lists requirements as commonly understood for German electronic cash registers (Stand: knowledge as of 2026). Every item marked **VERIFY** must be confirmed with a **Steuerberater** and the **certified TSE provider** before go-live. MeroIMS (a Nepal-oriented product) showed **no** fiscal-device integration, so nothing here is derived from it.

## 1. Legal anchors (what applies)
| Area | Source | Core requirement for Durby |
|---|---|---|
| Electronic record-keeping with certified security | **§146a AO**, **KassenSichV** | Every recorded business transaction protected by a **certified technical security device (TSE)**; certification per BSI technical guidelines (TR-03153 family) |
| Individual recording | **§146(1) AO** (Einzelaufzeichnungspflicht) | Record every transaction individually, completely, correctly, timely, orderly |
| Receipt obligation | **§146a(2) AO** (Belegausgabepflicht) | Issue a receipt for every transaction (paper, or electronic with the customer's consent) |
| Receipt content | **§6 KassenSichV** | operator name + address; date + **start and end time** of the transaction; quantity and type of items; **transaction number**; total and VAT amounts per rate (with rate); **serial number** of the system or TSE; **signature counter**; **signature value (Prüfwert)**. QR-code representation is common (DFKA recommendation): VERIFY layout |
| Registration of systems | **§146a(4) AO** (Mitteilungspflicht) | Report each register + TSE to the tax office via **ELSTER**; changes and decommissioning within the legal deadline (VERIFY current deadlines) |
| Audit export | **DSFinV-K** | Standardised export of single records, master data and daily closings (Kassenabschluss) for tax audits; plus TSE export (TAR) |
| Proper bookkeeping | **GoBD** | Immutability (no silent changes), traceability, completeness, retention, procedure documentation (**Verfahrensdokumentation**) |
| Cash inspections | **§146b AO** (Kassen-Nachschau) | Unannounced inspection; must provide DSFinV-K + TSE exports and documentation on demand |
| Retention | AO / HGB (GoBD) | Typically 10 years; certain accounting vouchers 8 years after recent reforms (VERIFY per document type) |
| VAT | UStG | Standard 19 %, reduced 7 %; **restaurant food vs drinks and dine-in vs take-away** treatment: VERIFY current rules and menu-combination splits |
| Business-meal receipts | §4(5) EStG / R 4.10 EStR | Machine-printed "Bewirtungsbeleg" data must come from the TSE-secured system (VERIFY content) |
| Tips | EStG / UStG | Employee tips are not restaurant revenue; record separately (VERIFY treatment of card tips) |
| Card payments | PCI DSS (contractual) | Keep card data out of Durby via terminal integration |
| Personal data | GDPR / BDSG | Staff and customer data minimisation, retention vs deletion conflicts documented |

## 2. Restaurant-specific fiscal behaviour (design must support)
| Situation | Requirement (VERIFY with provider docs) | Durby design hook |
|---|---|---|
| Orders before payment (table service) | order activity must be secured by the TSE as it happens (e.g. "Bestellung" process type), not only at payment | `FiscalTransaction` started/updated on `order.sent` |
| Payment / receipt | finish the TSE transaction with the receipt data ("Kassenbeleg") | fiscal finish inside the payment flow; receipt stores signature fields |
| Cancellation / void (Storno) | recorded and secured, never deleted | `OrderLine.status=VOIDED` + fiscal record + `OrderEvent` |
| Refund | negative transaction, secured, own receipt | `Receipt.kind=REFUND`, negative `Payment` |
| Table transfer / merge / split bill | traceable across transactions | `OrderEvent` + fiscal linkage |
| Training mode | flagged, not mixed with real revenue, still traceable | `ReceiptKind.TRAINING`, separate fiscal process type |
| Daily closing | Kassenabschluss (Z) per register, sequential | `Shift.zNumber`, closeSummary snapshot, DSFinV-K mapping |
| Cash in/out (Einlage/Entnahme/Geldtransit) | recorded as non-sale business transactions | `CashMovement` + fiscal "SonstigerVorgang" (VERIFY) |
| TSE outage | continue operating, document the outage, mark receipts, report persistent failures | fiscal failure state + alerting + retry |

## 3. Key architecture decisions owned by this workstream
1. **TSE type:** cloud TSE (internet required; simpler fleet) vs hardware TSE per register (works offline; device logistics). This **drives the offline design** (07 §8).
2. **TSE provider and SDK/API**, including test environment availability for CI.
3. **DSFinV-K export implementation:** build in-house vs provider tooling; mapping of Durby entities to DSFinV-K tables.
4. **Receipt layout** (paper 80 mm + digital receipt) with all mandatory fields and QR code.
5. **Verfahrensdokumentation** template maintained with the product.
6. **VAT model** for the menu (dine-in/take-away, combos), dated tax-rate table.

## 4. Deliverables & acceptance criteria
| Deliverable | Acceptance criteria |
|---|---|
| Fiscal module with provider adapter | every sale, refund, void, order-before-payment, cash movement and closing creates a finished, signed TSE transaction in the provider's **test** environment; signature data persisted immutably |
| Compliant receipt | contains all §6 KassenSichV fields; reviewed by Steuerberater; QR verifiable by the provider's checker |
| DSFinV-K export | passes the official/provider validation tooling on a test data set covering all transaction types |
| Daily closing (Z) | sequential per register; totals reconcile with payments, cash movements and TSE data |
| Outage handling | simulated TSE outage: service continues, receipts marked, outage logged, recovery verified |
| Immutability | DB-level protection: no UPDATE/DELETE on fiscal, receipt, payment, journal rows; attempted changes logged |
| Registration support | per-register data needed for the ELSTER notification available from back office |
| Verfahrensdokumentation | written, versioned, reviewed |
| Go-live sign-off | Steuerberater sign-off on configuration, receipts, VAT setup and documentation |

## 5. Sequencing
Start in parallel with Phase 1 of the roadmap: choose the TSE provider before building the payment flow, because it shapes the order/payment transaction design. **No production use of Durby POS in Germany before this workstream's acceptance criteria are met.**
