# ContabilidadOS gap-closure plan

Status date: 2026-09-15
Production baseline: product/engineering
Baseline branch: `codex/gap-closure-roadmap`, based on production commit `97d0adfe`

## Objective

Make ContabilidadOS safe to sell to independent Mexican accounting firms as the system that runs the monthly cycle from SAT data through reconciliation, tax workpapers, accounting, payroll, review, and client delivery.

"Close all gaps" means:

1. No screen may display a tax amount, due date, filing status, reconciliation state, or close state that contradicts another screen.
2. The product must never silently apply a tax formula to an unsupported regime or scenario.
3. Every advertised capability must have a tested acceptance criterion and production evidence.
4. Long-tail regimes may initially be calendar/assisted-only, but that boundary must be explicit in the product.

The regime tracker is in [`docs/fiscal/REGIMEN-COVERAGE.md`](./fiscal/REGIMEN-COVERAGE.md). The pricing decision is in [`docs/PRICING-STRATEGY-2026.md`](./PRICING-STRATEGY-2026.md).

## Status vocabulary

- `NOT_STARTED`: accepted scope, no implementation.
- `IN_PROGRESS`: implementation exists on an active branch.
- `BLOCKED`: dependency or external decision is named.
- `VERIFY`: implemented; automated and human acceptance remain.
- `DONE`: merged, deployed, monitored, and acceptance evidence linked.

An item is not `DONE` because code exists. It is done only after production verification.

## Phase 0 — one source of truth and fail-closed safety

Target: 2–3 weeks. No general-availability sales before this gate passes.

| ID | Work item | Status | Exit criterion |
|---|---|---|---|
| REL-001 | Unified fiscal period and due-date service | IN_PROGRESS | Dashboard, Taxes, Close, Compliance, notifications, and cockpit return the same active period and date; timezone, weekends, CFF holidays, and applicable RFC extensions have golden tests |
| REL-002 | Unified close state machine | VERIFY | REL-002A-D are merged and deployed. Production evidence covers external historical closes, blocker precedence and package rejection, daily-pass telemetry, and the full guard → explicit reopen → exact rebuild → canonical local close path in a dedicated mock-data company. Final acceptance requires only licensed-accountant sign-off |
| REL-003 | Correct empty-bank semantics | VERIFY | `0 / 0` is `NO_DATA`, never 100% reconciled; the close gate remains blocked until the period is intentionally marked no-bank or data exists |
| REL-004 | Actionable integration errors | NOT_STARTED | SAT/Syntage/Belvo/PAC errors have a stable code, user explanation, retryability, correlation ID, and operator detail |
| FISC-001 | Regime capability registry | VERIFY | All 19 current codes and the PF/PM split for 626 have explicit `CAT/CAL/MON/ANN/ACC/FILE/QA` flags. Monthly and annual engines reject unknown, incompatible, assisted-only, and not-applicable tracks before reading fiscal data; APIs return stable `422 NOT_SUPPORTED`, declarations render an assisted/not-applicable state without amounts, and imported SAT history remains available. PR #1130 is merged and is live through production descendant `faa35f48` / Railway deployment `35635dbf`; authenticated Altiplano monthly and 2025 annual reads both returned `200` from that image. Professional review of the registry flags remains. |
| FISC-002 | Multi-regime composition model | IN_PROGRESS | The fail-closed full-set boundary shipped in PR #1137 / `7bbd35c9`; the monthly planner in #1142 / `ddab03b0`; canonical CSF lifecycle in #1143 / `febcdd91`; primary-choice recovery in #1146 / `cd1fb8a7`; effective-period calculation in #1148 / `359bcd89`; historical annual evidence in #1150 / `b03bd684`; and the reviewed invoice-allocation contract in #1151 / `62a20737`. Calculation boundaries resolve lifecycle evidence for the requested month/year instead of blindly applying today's active set. A sole implemented monthly engine runs only when every companion is explicitly `NOT_APPLICABLE`; unsafe monthly sets and every mixed annual fail before fiscal reads with `422 NOT_SUPPORTED`. The allocation contract is evidence only. Exit still requires period-level completeness, payment/deduction/credit consumption, authoritative CSF-obligation execution, and lawful annual composition. |
| OPS-001 | Health/readiness and Railway checks | NOT_STARTED | `/api/health` and `/api/ready` exist; Railway checks readiness; migration and database failures stop promotion |
| SEC-001 | Browser security baseline | NOT_STARTED | HSTS, CSP/frame protection, content-type, referrer, and permissions headers are verified in production; `x-powered-by` removed |
| SEC-DEP-001 | Production dependency remediation | IN_PROGRESS | The refreshed root production audit on 2026-09-09 reported 4 critical, 15 high, and 3 moderate advisories; SEC-DEP-001A/B/C reduce that to 0 critical, 7 high, and 2 moderate. Upgrades or reviewed exceptions must reduce critical/high exposure to zero without fiscal regressions |
| FISC-DATA-001 | Official fiscal-reference provenance | IN_PROGRESS | INPC now covers August 2026 with official INEGI publication evidence and fail-closed missing-period behavior; its full series remains runtime-unverified until the Banxico cotejo confirms the new tip. Every rate, tariff, holiday, and index seed must record official source, publication date, and verification evidence |
| QA-001 | Fiscal golden-case harness | NOT_STARTED | Versioned fixtures cover period rollovers, due dates, no-data states, supported regimes, mixed regimes, and unsupported regimes |

### Phase 0 release gate

- Zero known cross-screen state contradictions.
- Zero silent regime fallback paths.
- Zero tax dates serialized as instants and rendered in a different calendar day.
- Zero unreviewed critical/high production dependency advisories.
- Every fiscal reference used in a calculation is current and officially verified, or the calculation fails closed.
- Production readiness check passing for seven consecutive days.
- A licensed Mexican tax professional signs off the golden cases. Software tests are not a substitute for this review.

### Active Phase 0 sprint

| Slice | Status | Evidence / remaining gate |
|---|---|---|
| REL-001A Default monthly period | VERIFY | Taxes, workpapers, accounting Close, and the home close pilot now default to the prior completed month using Mexico City time; August 2026 and January rollover tests pass |
| REL-001B Central due-date calculation | VERIFY | Dashboard now calls the same `calcularVencimiento` service as Compliance, including bimonthly `YYYY-Bn` keys and shifted annual deadlines |
| REL-001C Calendar-date rendering | VERIFY | Compliance pins fiscal dates to UTC display semantics so `2026-09-17` cannot render as September 16 in Mexico |
| REL-001D CFF/RFC deadline rules | IN_PROGRESS | Weekends, fixed/movable Article 12 days, and sixth-numeric-digit calculations are tested; eligibility exclusions under Decree Article 5.1 still need taxpayer facts and UI provenance before activation |
| REL-001E Consumer parity | VERIFY | Shared monthly contract now drives the firm cockpit, home queue, satellite fiscal defaults, payroll cockpit ranges, and IMSS/IVA notifications. Fiscal APIs emit calendar dates, the DIOT agenda uses the federal deadline, and an API parity test covers the Railway-UTC/Mexico rollover. Automated suite: 330 files / 3,649 tests; staging and production smoke remain. |
| REL-002A Canonical close state and package gate | VERIFY | One pure resolver orders locally managed periods as `BLOQUEADO > CERRADO > CONTABILIZADO > LISTO`; hard blockers, missing evidence, and changed confirmations override a submitted declaration or physical ledger status. The close UI, owner summary, AI context, daily close cache, and monthly ZIP consume it; blocked periods or periods without a finalized ledger return `409 CIERRE_NO_DESCARGABLE`. Focused suite: 6 files / 61 tests; full suite: 336 files / 3,687 tests; type checking and the 374-page production build pass. Production smoke confirms both the blocked-package rejection and the enabled package after an exact rebuild; daily-pass close and notice telemetry was observed from September 11–13. Evidence: [`docs/cierre/estado-canonico.md`](./cierre/estado-canonico.md) |
| REL-002B Historical close provenance and accountant language | VERIFY | Imported monthly declarations marked `FILED`/`PAID` and `isHistorical` become explicit external closes without fabricating an `AccountingPeriod`, pólizas, or a downloadable package. Guided close, owner copy, declaration history, Inicio queue, AI context, and daily audit provenance distinguish the external close. Product copy uses contabilizar/contabilización and generar pólizas instead of postear/posteo; internal `POSTED` storage remains unchanged. Focused suite: 6 files / 50 tests; full suite: 336 files / 3,693 tests; type checking and the 374-page production build pass. Production smoke confirms external-close provenance. Evidence: [`docs/cierre/estado-canonico.md`](./cierre/estado-canonico.md) |
| REL-002C Individual Anexo 24 gates | VERIFY | Catálogo, balanza, pólizas, auxiliar de cuentas, and auxiliar de folios evaluate fresh canonical close evidence and return the same `409 CIERRE_NO_DESCARGABLE` as the monthly ZIP before generating. Month 13 remains on its separate annual-close path. Focused suite: 3 files / 13 tests; full suite: 338 files / 3,703 tests; type checking and the 374-page production build pass. Production now covers both sides of the gate: blocked generation returns `409`, while the exact rebuilt period reports all five XML files ready and exposes enabled package/XML actions. Evidence: [`docs/cierre/estado-canonico.md`](./cierre/estado-canonico.md) |
| REL-002D Canonical accounting-transition guard | VERIFY | `postMonth` evaluates fresh canonical evidence before touching the ledger, so manual, batch, SAT auto-import, and repair callers cannot bypass the same gate. DRAFT periods can be contabilized only when ready; an open clean POSTED period can be regenerated; a period closed by a declaration requires explicit reopening. UNMATCHED and uncategorized IGNORED bank movements are hard blockers in both readiness and the engine. The API returns `409 CIERRE_NO_CONTABILIZABLE` with canonical state. Focused suite: 7 files / 81 tests; full suite: 341 files / 3,712 tests; type checking and all CI checks pass. The controlled production smoke rejected the filed period without mutation, preserved the declaration through explicit reopening, and rebuilt the original 125-entry ledger with an exact semantic-digest match. Evidence: [`docs/cierre/estado-canonico.md`](./cierre/estado-canonico.md) |
| REL-003A Fail-closed empty-bank state | VERIFY | Reconciliation, declaration checklist, and workbench now classify zero bank movements as `NO_DATA`; no-data periods cannot become mathematically reconciled or open the normal signing path |
| REL-003B Intentional no-bank workflow | VERIFY | Writer-only confirmation persists timestamp, user, and a required explanation; it is revocable, rejected when movements exist, and automatically stops opening the gate if movements later arrive. UI and downstream gates label it as a human decision and never as 100% reconciliation |
| FISC-002A Full regime-set calculation boundary | VERIFY | Monthly and annual callers resolve the scalar primary plus the full relation set and fail before fiscal reads when composition is unsafe. PR #1137 / `7bbd35c9` shipped through Railway deployment `e077c18c`; focused suite: 3 files / 51 tests; full suite: 412 files / 4,488 tests; type checking and the 389-page build pass. Production rendered the guarded no-amount state and preserved Altiplano's single-regime paths. |
| FISC-002B Period-aware monthly planner | VERIFY | A sole implemented monthly track may run only when every companion is explicitly monthly `NOT_APPLICABLE`; two runnable tracks and all unsafe/unknown combinations remain blocked. PR #1142 / `ddab03b0` shipped through exact Railway deployment `8ab713e4`; Altiplano monthly and 2025 annual screens remained usable, with exact-release HTTP evidence for `/impuestos` and `/api/declaracion-anual`. Focused suite: 3 files / 51 tests; full suite: 412 files / 4,488 tests; type checking and the 389-page build pass. |
| FISC-002C CSF current-regime lifecycle | VERIFY | CSF parsing uses the canonical 19-code catalog and never infers the primary from the first row. A validated sync plan activates the current set, ends missing rows with provenance, preserves or explicitly requires the primary, and updates the scalar and relation atomically. PR #1143 / `febcdd91` passed all five CI checks and shipped through exact Railway deployment `ba9fa594`; the pre-deploy log confirms the migration applied, `/impuestos` and authenticated `/api/declaracion-anual` returned `200` for Altiplano, and unauthenticated fiscal APIs remained `401`. Focused suite: 6 files / 75 tests; full suite: 414 files / 4,502 tests; type checking and the 389-page production build pass. Current obligation, declaration-coverage, and credit inputs read active rows; calculation history is resolved in FISC-002E. Authoritative removal of obligations absent from a newer CSF is intentionally still FISC-003 scope. |
| FISC-002D CSF primary-choice recovery | VERIFY | Cumplimiento and Mi Empresa share one typed client contract and one accountant-facing selector for `PRIMARY_REQUIRED`. The PDF remains only in browser memory for the explicit retry, every listed regime stays active, changing company clears the pending choice and ignores a late cross-company response, and canceling discards it. PR #1146 / `cd1fb8a7` passed all five CI checks and shipped through exact Railway deployment `e6f7e8d7`; startup completed with 141 migrations and no pending migration, `/login` returned `200`, and both protected CSF pages redirected unauthenticated requests. Focused suite: 4 files / 29 tests; full suite: 416 files / 4,512 tests; type checking and the 389-page production build pass. Authenticated visual smoke remains unverified because the workstation was locked. |
| FISC-002E Effective-period regime resolution | VERIFY | Monthly and annual calculation gates use every lifecycle row overlapping the requested half-open UTC interval; today's scalar is fallback only when no relation evidence exists. Ended historical regimes remain eligible for their earlier periods, future regimes cannot leak backward, and no-overlap evidence fails closed instead of guessing. `endedAt` remains latest-confirmed absence, not an asserted SAT legal end date. One-row-per-code storage cannot retain a reactivation gap: mixed sets remain blocked, while exact interval history is still required to close the single-track gap. PR #1148 / `359bcd89` passed all five CI checks and shipped through exact Railway deployment `4dc8e182`; startup found 141 migrations with none pending and release `359bcd89` ready in 1.5s. Public smoke returned `/login` `200`, `/impuestos` `307` to login, and both fiscal APIs `401` unauthenticated. Focused suite: 3 files / 53 tests; full suite: 417 files / 4,525 tests; type checking and the 389-page production build pass. Authenticated Altiplano smoke remains unverified while the workstation is locked. |
| FISC-002F Period-aware annual evidence coverage | VERIFY | Missing-annual coverage evaluates each closed exercise with the regimes associated with that year, not today's scalar/current-only relation set. A historical 612 year remains requested after a move to RESICO PF, while a RESICO-only year is not invented after a later move to 612; no matching historical relation remains a conservative review request. Current active obligations still gate whether an annual flow exists, pending authoritative obligation history in FISC-003. PR #1150 / `b03bd684` passed all five CI checks and shipped through exact Railway deployment `ed493388`; startup found 141 migrations with none pending and release `b03bd684` ready in 1.3s. Public smoke returned `/login` `200`, `/api/declaraciones/cobertura` `401`, and `/impuestos` `307` to login. Focused suite: 2 files / 55 tests; full suite: 417 files / 4,528 tests; type checking and the 389-page production build pass. Authenticated Altiplano smoke remains unverified while the workstation is locked. |
| FISC-002G Accountant-reviewed invoice allocation contract | VERIFY | Additive assignment/header and per-regime rows represent a complete income/expense CFDI split in exact integer basis points. The API restricts codes to lifecycle evidence for the invoice month, stamps the reviewer, uses optimistic revisions, blocks VIEWER writes, records append-only audit metadata, and reports stale stored evidence for re-review. No backfill or calculation behavior changes: mixed-regime math remains fail-closed, and IVA/annual/payment-level composition are explicitly outside this slice. PR #1151 / `62a20737` passed all five CI checks and shipped through exact Railway deployment `b72b3043`; migration `20260930_fisc002_invoice_regimen_allocation` became number 142, the schema reported current, and the exact release was ready in 652 ms. Public smoke returned `/login` `200`, `/impuestos` `307`, and both the allocation and tax APIs `401` unauthenticated. Focused suite: 2 files / 22 tests; full suite: 419 files / 4,550 tests; type checking, migration drift, and the 389-page production build pass. Authenticated UI smoke remains unverified while the workstation is locked. |
| FISC-002H Invoice allocation review UI | IN_PROGRESS | The invoice detail loads the period-specific contract only for income/expense CFDIs and stays hidden for ordinary single-regime invoices without evidence to review. Multi-regime invoices expose exact two-decimal percentage inputs, a live 100.00% gate, optional review note, saved reviewer evidence, stale-evidence recovery, read-only access, retry/error/conflict states, and an explicit warning that the assignment does not split IVA or alter calculations. Removing evidence returns the invoice to `SIN_ASIGNAR`; the modal now scrolls within small screens. Focused suite: 2 files / 25 tests; full suite: 420 files / 4,565 tests; type checking and the 389-page production build pass. CI, deployment, and authenticated visual smoke remain. |
| SEC-DEP-001A Critical runtime advisories | VERIFY | Next.js, NextAuth, and the Auth Prisma adapter received bounded patch/beta updates, deduplicating Auth.js Core at 0.41.3. The production audit moved from 4 critical / 15 high / 3 moderate to 0 critical / 15 high / 4 moderate. All 3,674 tests and the production build pass; CI and deployment smoke remain. Evidence: [`docs/security/dependency-audit-2026-09-09.md`](./security/dependency-audit-2026-09-09.md) |
| SEC-DEP-001B Safe transitive patches | VERIFY | Ten transitive resolutions within existing direct-version ranges reduce the production audit from 15 to 8 high and from 4 to 2 moderate advisories. Clean install, all 3,681 tests, and the production build pass; CI remains. Facturapi, Prisma, Next.js 16, and `xlsx` stay isolated as major or replacement work. Evidence: [`docs/security/dependency-audit-2026-09-09.md`](./security/dependency-audit-2026-09-09.md) |
| SEC-DEP-001C SheetJS advisory remediation | VERIFY | `xlsx` moves from the stale npm-registry 0.18.5 release to SheetJS's official 0.20.3 tarball, clearing both known parser advisories without application-code changes. Clean install, 58 focused spreadsheet tests, all 3,677 tests, type checking, and the production build pass; CI remains. Evidence: [`docs/security/dependency-audit-2026-09-09.md`](./security/dependency-audit-2026-09-09.md) |
| FISC-DATA-001A Current INPC seed | VERIFY | August 2026 is seeded at 145.462 from INEGI Bulletin 586/26, published 2026-09-09. The generic and depreciation paths share one canonical fail-closed series, and a provenance contract ties the newest value to its official evidence. Post-deploy Banxico SIE cotejo remains. Evidence: [`docs/fiscal/inpc-provenance-2026-09-09.md`](./fiscal/inpc-provenance-2026-09-09.md) |
| SAT-001 Native Buzón CE evidence pilot | IN_PROGRESS | The live credential-free CE preflight passes through the full SSO bootstrap; the session-aware form contract, exact signer envelope, pre-send TLS gate, redacted first-signed-POST probe, route allowlist, bounded transport, non-replayable run identity, durable single-flight lease, awaited credential-use audits, interactive-session-only existing-credential mandate workflow, and inert one-shot Railway worker/runbook are implemented. The mandate blocks platform support, bearer tokens, viewers, and vertical-only staff. No customer credential has been transmitted. Exit requires deployment approval, an authorized customer acceptance, a supervised SMP login, authenticated RFC marker, fixed-period metadata inventory, and proof of whether SAT exposes original CE XML or receipts only |

Current acceptance fixture: on 2026-09-08 in `America/Mexico_City`, the default monthly period is `2026-08` and the base federal deadline is `2026-09-17`.

## Phase 1 — correct engines for the launch regimes

Target: 5–8 weeks after Phase 0. Launch scope: 601, 612, 606, 625, 626-PF, and 626-PM.

| ID | Work item | Status | Exit criterion |
|---|---|---|---|
| REG-601 | PM General monthly and annual engine | NOT_STARTED | Art. 14 provisional flow, PTU, losses, coefficient provenance, annual adjustments, and reconciliations match reviewed cases |
| REG-612 | PF business/professional engine | NOT_STARTED | Cash-basis cumulative ISR, deductions, investments, losses, retentions, IVA, DIOT, and annual composition match reviewed cases |
| REG-606 | PF rental engine | NOT_STARTED | Proven deductions vs 35% option, predial, retentions, applicable monthly/quarterly handling, IVA, and annual composition are covered |
| REG-625 | Technology-platform engine | NOT_STARTED | Activity, threshold, definitive/provisional election, platform/direct collections, retentions, IVA, DIOT relief, and annual behavior are explicit |
| REG-626-PF | RESICO PF engine | NOT_STARTED | Cash-basis income, 1–2.5% rates, 1.25% retention, mixed-income rules, limits, exit risk, annual relief/election, and DIOT/CE relief are versioned |
| REG-626-PM | RESICO PM engine | NOT_STARTED | Separate cumulative cash-basis income-minus-paid-deductions engine; no Art. 14 coefficient fallback; annual and PTU treatment reviewed |
| FISC-003 | Taxpayer-specific obligation service | NOT_STARTED | CSF obligations win; regime rules supply defaults only; employer, IEPS, geography, options, and filing history add scenario-specific obligations |
| DIOT-001 | Complete DIOT supplier identity | NOT_STARTED | Supplier country, foreign tax ID, operation type, non-creditable/exempt/non-object amounts, and 54-field validation are complete |
| FISC-004 | Filing evidence contract | NOT_STARTED | Every filing state is backed by an acuse or explicitly labeled manual/unverified; no calculated draft is presented as filed |

### Phase 1 release gate

- Each launch track has at least 20 reviewed golden cases, including zero, refund, retention, cancellation, credit note, PPD/REP, prior balance, and year rollover.
- A user cannot select a regime/scenario the product cannot calculate without seeing an explicit assisted-only boundary.
- Calculation-to-acuse variance is measured and explained; unexplained material variance blocks the engine.

## Phase 2 — accounting close and decision-grade reporting

Target: 5–8 weeks.

| ID | Work item | Status | Exit criterion |
|---|---|---|---|
| ACC-001 | Formal cash-flow statement | NOT_STARTED | Operating, investing, and financing cash flow ties to bank and ledger movements |
| ACC-002 | Changes in equity and NIF report pack | NOT_STARTED | Statements tie to the trial balance and carry comparative periods |
| ACC-003 | Multi-currency accounting | NOT_STARTED | Transaction, functional, and presentation currencies; period revaluation; realized/unrealized gain/loss entries |
| ACC-004 | Cost centers/projects/segments | NOT_STARTED | Generic dimensions flow through entries, reports, imports, and exports; not limited to a vertical |
| ACC-005 | Core inventory/COGS boundary | NOT_STARTED | Either a tested periodic/perpetual implementation or an explicit unsupported boundary; invoices cannot silently remain purchases when COGS is required |
| RPT-001 | Branded monthly close report | NOT_STARTED | Firm-branded PDF includes executive summary, tax position, five core charts, exceptions, statements, and evidence links |
| RPT-002 | Consolidated aging and trends | NOT_STARTED | Firm and company views expose AR/AP aging, income/expense trends, tax projection, payroll cost, and close progress |

## Phase 3 — firm-scale operation and client delivery

Target: 4–7 weeks.

| ID | Work item | Status | Exit criterion |
|---|---|---|---|
| FIRM-001 | Portfolio cockpit | NOT_STARTED | A firm can filter, assign, and bulk-triage every client by deadline, blocker, owner, regime, and risk without switching companies |
| FIRM-002 | Bulk migration | NOT_STARTED | CSV/template and assisted imports cover companies, opening balances, chart, suppliers/customers, employees, and prior declarations with validation reports |
| FIRM-003 | Client portal | NOT_STARTED | Client uploads documents, answers requests, approves filings, views deliverables, and sees an immutable activity history |
| FIRM-004 | Payroll delivery | NOT_STARTED | Bulk email/portal delivery of PDF/XML receipts with delivery status, retries, consent, and access controls |
| FIRM-005 | Full data portability | NOT_STARTED | Account-level export covers source documents, normalized data, ledger, payroll, audit logs, and configuration |
| API-001 | Productized API/webhooks | NOT_STARTED | Versioned authentication, docs, rate limits, webhook signatures/retries, and tenant-scoped audit evidence |

## Phase 4 — trust, operations, and general availability

Target: 3–6 weeks; security items can run in parallel with Phases 1–3.

| ID | Work item | Status | Exit criterion |
|---|---|---|---|
| SEC-002 | MFA and verified identities | NOT_STARTED | Email verification, TOTP/passkey MFA, recovery controls, session/device management, and privileged-action reauthentication |
| SEC-003 | Credential vault v2 | NOT_STARTED | Centralized encryption service, per-tenant context/AAD, key versions, rotation, access audit, and no plaintext legacy pass-through |
| SEC-004 | Tenant defense in depth | NOT_STARTED | Authorization matrix, negative integration tests, scoped background jobs, and database/RLS decision documented and tested |
| OPS-002 | Backup restore drill | NOT_STARTED | RPO/RTO declared; a restore into an isolated environment is timed and evidenced quarterly |
| OPS-003 | Availability baseline | NOT_STARTED | Multi-replica/queue decision, alerting, SLOs, incident runbook, public status page, and 30-day 99.9% evidence |
| TRUST-001 | Institutional public surface | NOT_STARTED | Custom domain/email, security page, changelog, help center, support policy, migration guide, and named case study |
| TRUST-002 | Independent review | NOT_STARTED | External penetration test and external fiscal review completed; material findings remediated |
| OPS-004 | Railway configuration migration | NOT_STARTED | Deprecated `railway.json` configuration moved before 2026-12-01 and deployment parity verified |

## Phase 5 — long-tail regimes and filing automation

Target: demand-driven after the launch regimes and GA gate.

1. Add full engines in observed-demand order: 621/RIF and 622/AGAPES first if paying firms require them; then 603 and the annual/event-income tracks 605/607/608/611/614/615.
2. Treat 610, 620, 623, and 624 as specialist/partner-assisted until enough paid volume justifies their legal and QA surface.
3. Build direct SAT filing only after mandate/consent, credential-vault, idempotency, staged approval, acuse reconciliation, and incident-recovery controls are complete.
4. Add Carta Porte, Comercio Exterior, generic inventory, and other breadth only from measured ICP demand.

## Fixed execution order

Work is pulled in this order unless a production incident preempts it:

1. REL-001 fiscal period/date consistency.
2. REL-003 empty-bank semantics.
3. SEC-DEP-001 critical/high dependency triage and FISC-DATA-001 provenance.
4. REL-002 close state machine.
5. FISC-001 capability registry and fail-closed guard.
6. FISC-002 multi-regime composition.
7. REG-626-PM, because the current generic PM path is materially different.
8. REG-626-PF cash basis, then REG-601, REG-612, REG-606, REG-625.
9. FISC-003 obligations and DIOT-001.
10. SEC-001/OPS-001, followed by the remainder of the plan.

## Per-item delivery protocol

Each item must produce:

1. Written legal/product assumptions and official source date.
2. Pure domain logic before UI wiring.
3. Unit tests, boundary tests, and regression test for the production finding.
4. Database migration/backfill plan when applicable, including rollback.
5. UI states for loading, empty, unsupported, incomplete, error, and success.
6. Staging verification with anonymized fixtures.
7. Production smoke test, telemetry, and rollback trigger.
8. Link to evidence in this tracker before changing status to `DONE`.

## Commercial validation gate

Continue investing after Phase 1 only if the product reaches:

- 10 unrelated paying firms.
- At least 100 active RFCs.
- Median FIEL-to-useful-history time below 30 minutes.
- At least 80% six-month logo retention in the pilot cohort.
- Measured support below 60 minutes per firm per month after onboarding.
- No unresolved material fiscal variance in a filed period.
