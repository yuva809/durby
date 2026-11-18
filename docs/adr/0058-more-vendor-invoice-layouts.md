# ADR 0058: More vendor invoice layouts: packed lines, per-position invoices, free goods and charges

- Status: accepted (2026-11-18)
- Date: 2026-11-18
- Builds on: ADR 0049 (vendor invoice import), ADR 0054 (approval queue), ADR 0055 (pack size, invoice units)

## Context

The distributor's suppliers print layouts the reader didn't know. An Italian wholesaler prints packed lines ("10434
GOLDEN MORN 12x300GR NG CAR 4 12,000 0,000 48,000 2,51 120,48 41%": code, description, origin, pack unit, packs,
pieces per pack, free, pieces, price, total, VAT code), sometimes priced per piece and sometimes per carton, free goods
as a second line of the same product at 0.00, transport and "ORDER CONFIRMED" as lines, the invoice number under a
lone "INVOICE" heading and the net total without a label. A German wholesaler prints "Pos · Art-Nr · Description ·
Qty · Pieces per pack (or Stk) · VAT % · Price · Total". Their 55-line invoice read as nothing. Delivery notes and
outtake orders without prices were among the samples.

## Decisions

1. **Two more layouts in `lib/inventory/invoice-pdf.ts`**, tried before the plain one. Packed lines: the price belongs
   to whichever count times it is the total (pieces or packs). Per position: a whole number of pieces per pack makes
   it a packed line too; "Stk" is single pieces. Both read European decimals only ("48,000" is 48, "1.245,00" is
   1245), unlike the plain layout's guess.
2. **A line in packs** carries `pack: { count, per, unit, pieces, piecePrice }`; `quantity` and `unitPrice` stay as
   invoiced (the packs). Computed prices are rounded to 4 decimals and written as typed ("30.12", "0.2635").
3. **The review counts packed lines "As invoiced" or "By the piece"** (one switch for the invoice, shown when a line
   is in packs; switching re-counts every line from the invoice). Under each such line: "4 CAR × 12 = 48 pcs".
4. **Free goods**: lines of the same code and description become one: quantities and totals added, the price their
   quotient. **Charges** (transport, freight, shipping, "order confirmed") are left out and named in the summary
   ("Skipped, not goods: TRASPORTO, ORDER CONFIRMED").
5. **Number and total**: "Rechnung II Nr. RE22606995", "Fattura n°", or the row under a lone INVOICE heading. Without
   a labelled total equal to the lines' sum, an unlabelled amount below the last line that equals it is the total.
6. **Rounding piece prices**: 101.50 for 400 pieces is 0.25375, kept as 0.2538 (costs have 4 decimals), so a line can
   be cents off. The total check says "matches apart from €0.02 from rounding piece prices" when the difference is
   within half a cent plus half a ten-thousandth per unit on lines priced with more than 2 decimals; anything more
   still shows as different.
7. **Not imported**: documents without prices (delivery notes, outtake orders, CMR). They describe goods an invoice
   books; reading them too would book the goods twice.

## Consequences

- The real 55-line invoice reads as 55 items with every line checked and the printed total matched; the German
  layout was typed from a photo, so its recognition on other photos is untested.
- The api is unchanged: the receipt sent for approval has the quantities and costs as counted.
