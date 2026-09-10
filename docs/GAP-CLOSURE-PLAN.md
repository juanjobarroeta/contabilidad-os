# ContabilidadOS gap-closure plan

Status date: 2026-09-09
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
| REL-002 | Unified close state machine | NOT_STARTED | A period cannot be ready, posted, closed, or downloadable while a hard blocker exists; every module reads the same state |
| REL-003 | Correct empty-bank semantics | VERIFY | `0 / 0` is `NO_DATA`, never 100% reconciled; the close gate remains blocked until the period is intentionally marked no-bank or data exists |
| REL-004 | Actionable integration errors | NOT_STARTED | SAT/Syntage/Belvo/PAC errors have a stable code, user explanation, retryability, correlation ID, and operator detail |
| FISC-001 | Regime capability registry | NOT_STARTED | All 19 current codes and the PF/PM split for 626 have explicit capability flags; unknown/unsupported calculations return `NOT_SUPPORTED` instead of a generic formula |
| FISC-002 | Multi-regime composition model | NOT_STARTED | Calculations use all active regimes and CSF obligations, not only `Company.regimenFiscal`; independent income baskets cannot contaminate one another |
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
| REL-003A Fail-closed empty-bank state | VERIFY | Reconciliation, declaration checklist, and workbench now classify zero bank movements as `NO_DATA`; no-data periods cannot become mathematically reconciled or open the normal signing path |
| REL-003B Intentional no-bank workflow | VERIFY | Writer-only confirmation persists timestamp, user, and a required explanation; it is revocable, rejected when movements exist, and automatically stops opening the gate if movements later arrive. UI and downstream gates label it as a human decision and never as 100% reconciliation |
| SEC-DEP-001A Critical runtime advisories | VERIFY | Next.js, NextAuth, and the Auth Prisma adapter received bounded patch/beta updates, deduplicating Auth.js Core at 0.41.3. The production audit moved from 4 critical / 15 high / 3 moderate to 0 critical / 15 high / 4 moderate. All 3,674 tests and the production build pass; CI and deployment smoke remain. Evidence: [`docs/security/dependency-audit-2026-09-09.md`](./security/dependency-audit-2026-09-09.md) |
| SEC-DEP-001B Safe transitive patches | VERIFY | Ten transitive resolutions within existing direct-version ranges reduce the production audit from 15 to 8 high and from 4 to 2 moderate advisories. Clean install, all 3,681 tests, and the production build pass; CI remains. Facturapi, Prisma, Next.js 16, and `xlsx` stay isolated as major or replacement work. Evidence: [`docs/security/dependency-audit-2026-09-09.md`](./security/dependency-audit-2026-09-09.md) |
| SEC-DEP-001C SheetJS advisory remediation | VERIFY | `xlsx` moves from the stale npm-registry 0.18.5 release to SheetJS's official 0.20.3 tarball, clearing both known parser advisories without application-code changes. Clean install, 58 focused spreadsheet tests, all 3,681 tests, type checking, and the production build pass; CI remains. Evidence: [`docs/security/dependency-audit-2026-09-09.md`](./security/dependency-audit-2026-09-09.md) |
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
