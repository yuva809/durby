# Deferred ERP Investigation Backlog

Out of scope for the Durby **POS** phase (decision 2026-10-20). Read-only evidence already collected stays in `docs/routes/` and `evidence/`. Only the POS-supporting interfaces of these modules are documented now.

| Area | Already observed (read-only) | Deferred work |
|---|---|---|
| Purchasing (bills, returns, payment-out, vendor-invoice import) | routes, forms, list endpoints; no bills exist | write flows, matching, import pipeline |
| Advanced accounting (manual journals, approvals, period locks/close, tax filing, bank reconciliation, cheques, fiscal years) | journal + lines + audits shapes; 20 posting roles; mappings | posting-rule eventKeys (server-side), lock/close semantics, reconciliation |
| Manufacturing (BOM, production order) | **"Coming soon"**: not implemented in MeroIMS | nothing to reverse-engineer |
| Stock requests / picking / delivery / OC-DC | 11-state lifecycle, endpoints | write flows, approval rules |
| Multi-branch & shared warehouses | shapes only (no branches exist) | branch scoping rules |
| Sales documents (quotations, returns, credit) beyond POS-generated invoices | forms + shapes | write flows |
| Web store / storefront / blog / e-commerce channel | routes + endpoints | everything |
| PMS ("service visits") | route + `/api/pms/*` | purpose unknown |
| Imports (AI-assisted party import, legacy import) | capability endpoints | pipelines |
| Staff RBAC (non-POS) | `staff-roles` endpoint; no staff exist | permission matrix |
| Full report suite (GL master/summary/detail, statements) | endpoints + shapes | only POS-relevant reports kept in scope |
