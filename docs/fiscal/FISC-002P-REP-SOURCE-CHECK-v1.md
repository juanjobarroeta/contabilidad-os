# FISC-002P: stored REP payment-source comparison

Status: `VERIFY`. Source-check version: `2026-10-01.1`. Review workflow: `2026-10-01.2`. Professional acceptance: **PENDING**.

## What ships

The monthly Facturas deduction-review panel now shows **Datos de pago cotejados con XML** or **Cotejo de pagos pendiente** for projected PPD expense rows. It compares the company-local stored REP XML with the payment relations used by the existing documentary base. Reviewers can inspect the reported payment date, method, currency, amount, installment, current/history counts, reasons for a pending comparison, and open the REP.

This is **source consistency**, not verified bank settlement, XML authenticity, SAT validity, taxpayer eligibility, or an authorized deductible amount. The stored XML may itself be unverified. No external retrieval or signature check occurs. `comprobacionBancaria` remains `false`, `deduccionAutorizadaCentavos` remains `null`, and automatic tax use stays disabled. Cash, compensation and other recognized payment-method codes are reported as source data, never approved as qualifying payment methods.

PUE still does not prove effective payment. The existing FISC-002M/N income/expense numbers and tax engines are unchanged. Missing/mismatched source evidence does not become zero or an inferred payment method; the accountant can still document the pending criterion without approving a deduction.

## Comparison contract

- Exact, namespace-aware XML structure: CFDI 4.0, `TipoDeComprobante=P`, one direct issuer/receiver/complement, one payments 2.0 complement and one fiscal stamp in that complement. No first-global-attribute or comment matching.
- The fiscal-stamp UUID must match the stored REP UUID. The receiver must match the company RFC and the issuer the parent invoice's stored supplier RFC. Missing supplier identity stays pending. This is not a separate comparison against the parent invoice's XML.
- Exactly one `DoctoRelacionado` for the parent UUID. Multiple payments for the same parent in one REP remain ambiguous because the existing relation table has one row per REP/parent; this release does not repair or collapse them.
- `FechaPago`, `NumParcialidad` and exact six-decimal `ImpPagado` must match the stored relation. CFDI calendar timestamps are compared to canonical UTC storage without interpreting them in the server's timezone. Invalid dates or legacy timezone-shifted records remain pending; no repair runs.
- This version only corroborates MXN payment/document pairs, absent-or-one same-currency equivalence, and absent-or-one MXN exchange rate. Foreign/mixed currency cases remain pending. Amounts are parsed as decimal text with integer arithmetic; local balance arithmetic and the payment-node amount are checked. These limited checks do not implement all SAT XSD/catalog/tax/balance-continuity rules.
- All imported payment history used by a projected parent is checked, including other months. The selected month is still determined by stored `FechaPago`, not REP issuance. Missing/cancelled/invalid records excluded by the existing projector cannot become new rows here; broader import completeness is not asserted.

## Isolation, bounds and freshness

The existing session, company, accounting-module and role guards run before reads. Source reads share the review's repeatable-read transaction and require the company ID even when invoice IDs are known. No API authorization is relaxed; raw XML, account numbers, payment chains and seals are not returned or copied to review records.

The original 5,000-record sentinels remain. Additional budgets are **256 distinct REP documents**, **256 KiB per XML**, and **4 MiB total XML** per review snapshot. Sizes are inspected before loading XML. Exceeding any budget leaves all source comparisons pending, not a successful partial comparison. DTD/entity declarations are rejected before parsing; malformed XML, excessive node counts and ambiguous structures fail closed. The namespace-aware parser is declared as a direct, pinned dependency (`@xmldom/xmldom` 0.9.12), already present in the dependency tree.

Each row previews at most 25 payment relations, while its state/counts and review fingerprint cover every inspected relation. Exact XML SHA-256 fingerprints and source metadata join the existing evidence hash; changing only XML invalidates the saved review and rejects a stale save with 409 while preserving the draft. Over-budget sources remain unavailable and track record metadata; they are not byte-verified. Saved snapshots retain the compared facts and source hashes, not the XML itself; this is not archival/WORM preservation.

The review version bump makes pre-FISC-002P reviews stale so they can be reconsidered under the expanded evidence. Reported-option context keeps its previous version; unchanged rental/platform observations need not be re-recorded merely because payment-source checks were added.

## Sources and verification

Primary technical sources inspected on 2026-10-01: [SAT payment-complement overview](https://wwwmatnp.sat.gob.mx/consultas/92764/comprobante-de-recepcion-de-pagos) and [SAT payments 2.0 technical standard](https://www.sat.gob.mx/cs/Satellite?blobcol=urldata&blobkey=id&blobtable=MungoBlobs&blobwhere=1461175070885&ssbinary=true), especially the payment and related-document attributes. They distinguish payment date/method/currency from related-document amount, currency and installment. They are not evidence that a particular uploaded XML is authentic or a deduction is legally allowed.

Pure synthetic tests cover exact matching, month boundaries in UTC/Mexico City, namespace/quote variations, misleading comments, hostile/ambiguous XML, unknown methods, identity/amount/date mismatches, cancelled sources, currencies and read budgets. PostgreSQL tests cover actual source reads, tenant isolation, retained snapshots, XML-only staleness, other-month history, limits and unchanged documentary numbers. The local browser script exercises the actual UI/API, including an XML-only 409, retained draft and mobile layout. CI, local synthetic acceptance, exact deployment and professional acceptance remain separate evidence; release counts are recorded in the PR.

## Remaining work / rollback

FISC-002 and QA-001 remain `IN_PROGRESS`. Still open: source authenticity/SAT validity where authorized, import/date/ambiguous-relation recovery, independently verified bank/effective-payment evidence (including PUE), legal election continuity/scope, and regime-specific deduction amount/timing/limit rules with professional numeric cases. No calculated deduction is enabled by this slice.

No schema migration, historical backfill, provider/SAT call, payment, filing or accounting-close action. Rollback is code-only; preserve the existing FISC-002O history tables and records.
