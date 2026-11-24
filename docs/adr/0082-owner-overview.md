# ADR 0082: Owner overview: all locations today, yesterday against a normal day

- Status: accepted
- Date: 2026-11-24
- Spec: [reports](../modules/reports.md) → Overview. Builds on [ADR 0081](0081-reports-read-model.md) (metrics, fact
  tables) and [ADR 0075](0075-start-page-setting.md) (start page).

## Context

The signed-in home page is a placeholder. An owner of several locations wants one screen that says how the group is
doing today, and whether yesterday was good or bad.

## Decisions

1. **The home page** shows the overview to people holding `reports.sales.read` in an organization with `reports` and
   `pos`. Everyone else keeps the page as it was, and the redirects (branch, driver, `startPage`) come first. No new
   permission: someone limited to some locations sees those, and the total is theirs.

2. **A normal day** is the average of a location's sales on the four same weekdays before yesterday (7, 14, 21 and 28
   days earlier), each a whole business day of that location. Days without an order are left out: the place was closed
   or not open yet, and counting them as zero would make an ordinary day look good. The screen says how many days the
   average is from. With none there is no comparison, never 0 %.

3. **The total compares like with like**: normal days are summed over the locations that have one, and compared with
   those same locations' yesterday. The screen says how many locations are left out.

4. **Today** is compared with the same weekday last week up to the same time, by the definition of the sales card.

5. **Active locations only**, without warehouse sites. Reports still cover archived locations, so a period's total there
   can be higher.

6. **One call, one read-only snapshot**, refreshed every minute while the page is visible. Open tables come live from
   `PosFloorReader`, everything else from the fact tables.

## Consequences

- Weekday averages don't know holidays: a closed day yesterday shows as −100 %, and an event day weighs in for four
  weeks.
- Until the facts of earlier orders are rebuilt (ADR 0081), normal days come from fewer days or don't exist; the screen
  says so.
