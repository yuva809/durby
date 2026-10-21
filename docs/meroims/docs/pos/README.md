# Durby POS — Blueprint Package (from MeroIMS evidence)

Read in order:
| # | Document | What it answers |
|---|---|---|
| 00 | [00-pos-test-plan.md](00-pos-test-plan.md) | Option B test protocol, retail-till API contract, scenario queue + status |
| 01 | [01-pos-feature-inventory.md](01-pos-feature-inventory.md) | Every MeroIMS POS feature + route, tagged OBS/TEST/BND/UNK |
| 02 | [02-pos-workflows-and-lifecycles.md](02-pos-workflows-and-lifecycles.md) | Sequence diagrams (shift, sale, hold, refund, cash, close) + state machines |
| 03 | [03-pos-api-catalog.md](03-pos-api-catalog.md) | POS endpoints with actual request/response bodies |
| 04 | [04-pos-domain-model.md](04-pos-domain-model.md) | Observed entities + **proposed Durby Prisma schema** |
| 05 | [05-pos-architecture.md](05-pos-architecture.md) | Observed MeroIMS POS architecture + dependency matrix |
| 06 | [06-pos-tests-results-and-unknowns.md](06-pos-tests-results-and-unknowns.md) | S1–S7 results, side effects, records left, prioritised unknowns |
| 07 | [07-durby-pos-blueprint.md](07-durby-pos-blueprint.md) | **Recommended Durby architecture** (NestJS modular monolith, Prisma, PG) |
| 08 | [08-german-compliance-workstream.md](08-german-compliance-workstream.md) | KassenSichV/TSE, receipts, DSFinV-K, GoBD (gating, verify with Steuerberater) |
| 09 | [09-durby-pos-roadmap.md](09-durby-pos-roadmap.md) | Phased roadmap with dependencies + acceptance criteria |
| — | [tests/](tests/) | One record per approved write test (S1–S7) |

Evidence: `../../evidence/tests/`, `../../evidence/captures/shapes-S*.txt`, `../../evidence/pos-retail-api-client.txt`, `../../evidence/bundle/js-lazy/`.
