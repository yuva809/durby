# Test INV-T2 — Sale of a FIFO product after a second cost layer

| | |
|---|---|
| Approved by user | 2026-10-20 |
| Scenario | Back-office **Cash Sale** invoice: 1 × BEV-WAT-004 (valuationMethod **fifo**; layers after INV-T1: 171 @ 18.00 + 2 @ 20.00) at 30.00, no tax, note `TEST-DURBY-INV-T2` |
| Method | dry run, then one guarded `POST /api/core/sales/invoices` (exact body); REA shapes `evidence/captures/shapes-INV-T2-fifo-sale.txt` |
| Evidence | `evidence/tests/INV-T2-dryrun.json`, `INV-T2-fifo-sale.spec.json`, `INV-T2-result.json` |

## Observed `[OBS]`
| Item | Result |
|---|---|
| Form | rate auto-filled from sales price (30); "Receive total amount — Rs. 30.00" checked by default; Add Tax off; **Save as Draft** available on invoices (not on bills) |
| Response | **201** `INV-2026-000019` `sales_invoice` `settled`, total 30.00, tax 0.00; line **`unitCost 18.0231`** |
| Stock | 173 → **172**, avgCost stays **18.0231** |
| Movement | `sale / sales_invoice` −1 @ **18.0231** |
| Valuation ledger | out 1 @ 18.02 → 172 @ 18.02 = **3099.98** (vs 172 × 18.0231 = 3099.97: rounding drift) |
| Journal | **JV-2026-000061** `core.invoice.issued`: Dr Cash In Hand 30.00 (**operationalAccountId set**) / Cr Sales Goods 30.00 (qty 1) · Dr COGS 18.02 / Cr Inventory Asset 18.02 |
| Operational cash account | −74.00 → **−44.00** (back-office cash invoices settle through it; POS sales do not) |

## Conclusion
**MeroIMS costs FIFO-flagged products at the moving weighted average.** The `valuationMethod: fifo` value is not applied to cost of goods sold (FIFO would have used 18.00). Expected FIFO behaviour is **not implemented**, or not for this path. Durby must choose its costing method deliberately rather than copy the flag.

## Cleanup
Permanent dev records: INV-2026-000019, movement −1, JV-2026-000061.
