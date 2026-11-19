# ADR 0064: Order Confirmation and Delivery Challan for branch requests

- Status: accepted (2026-11-19); the layout follows the distributor's reference PDF once it arrives
- Date: 2026-11-19
- Builds on: ADR 0045 (branch requests), ADR 0056 (branch addresses), ADR 0063 (Order History)

## Context

A branch wants paper for its requests, as it had before: an Order Confirmation (OC) as soon as it orders, and a
Delivery Challan (DC) that travels with the goods. The app has no PDF generation; the browser prints and saves PDFs.

## Decisions

1. **Two documents per request, derived, never stored**: the OC exists from the moment the request is sent (its
   number is the request's, `SRQ-…`): what was asked, for which branch, by whom, and once approved what will come.
   The DC exists once packed (its number is the transfer's, `TRF-…`, dated when packed): what was sent, the driver,
   a column to write in what arrived (or what the branch confirmed) and lines to sign (packed by, driver, received
   by). Quantities only, never prices.
2. **Printable A4 pages**: `/requests/:id/oc` and `/requests/:id/dc`, a route group of their own with the signed-in
   guard and no menu; "Print or save as PDF" uses the browser. These pages print on A4 with margins and show the
   page: the app's print rules are for 80 mm till receipts and stay as they are everywhere else.
3. **Where they are**: Order History's OC / DC column (OC from the start, DC once packed), the request's panel, the
   cart right after sending (the OC is there at once) and the branch's Delivery Tracking (the DC).
4. **Addresses**: a request's detail carries its branch's and source location's address (`locationAddress`,
   `fromLocationAddress`), so the documents print them without the caller reading the locations.

## Consequences

- Nothing is generated or kept: a document always shows the request as it is now. A reprint after receipt shows
  what the branch confirmed.
- The reference layout may move fields around; the data is all there.
