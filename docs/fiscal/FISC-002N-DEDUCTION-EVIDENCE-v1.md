# FISC-002N: expense allocation and deduction review prerequisites

Status: `VERIFY` — engineering acceptance is separate from professional approval.

Fixture version: `2026-09-30.1`

Professional review: **PENDING**

Official sources checked: `2026-09-30`

## Scope and non-goals

`GET /api/impuestos/asignaciones-regimen/deducciones?companyId=…&year=2026&month=8` adds a read-only monthly expense-evidence and eligibility-review contract. It allocates documentary expense bases by regime and identifies missing prerequisites. It is **not** a completed deduction engine, a saved accountant approval, or a deduction amount.

No UI, schema, migration, backfill, automatic tax calculation, declaration or close changes are included. The income endpoint keeps its existing public contract. Both directions now share `regimen-document-bases.ts` and `regimen-document-evidence.ts`; the income and deduction entry points retain distinct types and outputs. Neither invokes an external provider.

| Response field | Meaning | Not a claim of |
|---|---|---|
| `documental.totales` | Separate PUE net bases by emission month and PPD net bases by REP FechaPago | Deductible expense, cash payment proof for PUE, or complete SAT import |
| `documental.porRegimen` | Exact reviewed or single-regime implicit attribution of those same documentary bases | Lawful regime-specific deductibility |
| `renglones[].clasificacion` | Stored nature, source use, manual/automatic provenance and unresolved conflicts | Approved tax treatment |
| `renglones[].elegibilidad` | Per-allocation treatment for review and stable reason codes | Saved eligibility approval |
| `deduccionAutorizadaCentavos` | Always `null`, including documented zero and RESICO PF | A calculated or approved zero |
| `usadaEnCalculoAutomatico` / `pueAcreditaPago` | Always `false` | Calculation or payment authorization |

The top-level state is `PENDIENTE` whenever evidence or blockers exist, even when `documental.estado` is `PROYECTABLE`. Only an empty, unblocked documentary result is `SIN_EVIDENCIA`. These are different dimensions: an exact base can still have completely unapproved tax treatment.

## Documentary integrity

The [FISC-002M numeric contract](./FISC-002M-INCOME-EVIDENCE-v1.md) is reused without changing its formulas: net-of-discount bases, exact decimal-text reads, cumulative millionth-to-cent proration, largest-remainder allocation and residual-cent review. This avoids divergent income/expense implementations.

Only company-local `EGRESO` invoices enter expense bases. The repository's `EGRESO` direction means a received invoice; `tipoSat: E` separately identifies a credit note. Resolved customer collections stay out of expense totals, and resolved supplier payments stay out of income totals. Unknown parents still block the appropriate summary; they cannot be safely classified from missing evidence.

Cancelled and superseded documents cannot contribute. Fiscal REP UUID plus parent UUID identifies duplicates; contradictory imports, unknown dates, installment gaps/duplicates, overpayment, ambiguous UUIDs, unsupported documents, foreign currency and regime transitions produce null documentary aggregates. Received credit notes in the month or linked from another month require reviewed netting; emitted notes do not cross into expense netting. Incomplete scans also have null aggregates, not partial totals.

Every metadata, lifecycle, assignment, UUID/history, credit-note and exact monetary read is in one company-scoped `RepeatableRead` transaction. Each scan has a 5,000-record limit plus one sentinel. API previews are limited to 25 document rows and 25 documentary issues; counts and documentary totals are computed before preview truncation. Counts represent processed evidence, not a complete ledger if the scan limit was exceeded. Database failure propagates as an error, not no-data.

Authentication precedes company membership and database reads. Effective `VIEWER` members may read. All responses use `Cache-Control: no-store`. No review, attribution, classification or tax state is written by this endpoint.

## Eligibility boundary

The checklist version covers **2026** only; other years get `RULE_PERIOD_REVIEW`, not a silently extrapolated rule. Historical documentary math is still available.

- Classification alone is not approval. Automatic, missing, unknown or explicitly unresolved nature requires review. A manual `GASTO` label cannot erase conflicting investment, inventory or S01 source use.
- Investment, inventory, personal-deduction and no-fiscal-effects signals remain separate review treatments. No purchase is automatically expensed or depreciated, and no personal amount is added to monthly business deductions.
- Ordinary expense attribution still needs activity linkage and applicable requirements/limits review. The existing fiscal auditor is not used as an approval oracle.
- PUE requires independent payment evidence. PPD uses REP evidence for the documentary payment base, but `PagoDoctoRelacionado` does not preserve `FormaDePagoP`; the parent's `formaPago` is never substituted.
- Rental and platform allocations need effective-period elections. The current standalone rental engine's blind-deduction behavior is not treated as a taxpayer election or copied into composition.
- Recognized 2026 RESICO PF carries an explicit no-monthly-ISR-deduction review label. RESICO PM gets a separate requirements review and never inherits that PF label. This decides neither IVA nor an approved deduction amount.
- Missing/incompatible taxpayer type, assisted regimes and unreviewed periods remain under review. Documentary allocation never grants calculation support.

The statutory motivations are the [LISR consolidated text](https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf), edition showing latest reform 2024-04-01: Articles 27 and 105 distinguish documentary support from deduction requirements and effective disbursement; Article 115 provides distinct rental deduction paths; Article 113-E does not subtract deductions from RESICO PF monthly income. The [SAT rental guidance](https://wwwmat.sat.gob.mx/consulta/26986/lo-que-debes-conocer-de-tu-regimen-) also describes the optional rental method. This is a conservative product review boundary, not individualized advice or certification of every legal requirement.

## Versioned review matrix

These **30 synthetic scenarios** have literal documentary expectations and explicit review outcomes in `src/test/fiscal/fixtures/deduction-v1.ts`. They do not satisfy the requirement for accountant-approved tax-amount cases. The tests additionally replay the existing 34 income numeric/integrity scenarios in the expense direction without computing an oracle from production output.

| Case | Review question / protected contract | Decision |
|---|---|---|
| DED-001 | Reviewed shares allocate discounted expense evidence, not deductions | PENDING |
| DED-002 | Manual GASTO still needs activity and deduction requirements review | PENDING |
| DED-003 | Automatic classification is not accountant acceptance | PENDING |
| DED-004 | An explicit unresolved classification flag survives manual attribution | PENDING |
| DED-005 | Missing nature is not silently converted to GASTO | PENDING |
| DED-006 | Investment purchases require asset and depreciation treatment | PENDING |
| DED-007 | Inventory cannot be treated as an ordinary current expense | PENDING |
| DED-008 | S01 remains a no-fiscal-effects review, not an approved deduction | PENDING |
| DED-009 | Personal deduction use does not enter monthly business deductions | PENDING |
| DED-010 | A manual GASTO override cannot erase an investment-use conflict | PENDING |
| DED-011 | A G01 source conflicts with a manual current-expense classification | PENDING |
| DED-012 | Known zero documentary expense does not become an approved zero deduction | PENDING |
| DED-013 | PPD cannot borrow the payment method of its parent invoice | PENDING |
| DED-014 | RESICO PF expense evidence does not reduce monthly ISR | PENDING |
| DED-015 | RESICO PM is never routed through the PF deduction treatment | PENDING |
| DED-016 | Unknown taxpayer type prevents regime-specific treatment | PENDING |
| DED-017 | An incompatible regime/person pair remains under review | PENDING |
| DED-018 | Rental attribution cannot invent an effective deduction election | PENDING |
| DED-019 | Platform deduction treatment requires the effective election | PENDING |
| DED-020 | Assisted regimes do not inherit general-business deductions | PENDING |
| DED-021 | The 2026 review checklist is not extrapolated into another year | PENDING |
| DED-022 | Missing mixed-regime attribution blocks documentary aggregates | PENDING |
| DED-023 | Received linked credit notes require reviewed netting | PENDING |
| DED-024 | Cancelled expenses and payment receipts create no evidence | PENDING |
| DED-025 | Superseded stamped expenses and receipts create no evidence | PENDING |
| DED-026 | Foreign currency cannot become an unreviewed MXN deduction | PENDING |
| DED-027 | Undated supplier payments keep aggregate evidence pending | PENDING |
| DED-028 | Duplicate REP import is counted once on the expense side | PENDING |
| DED-029 | No evidence yields unknown, not a zero deduction | PENDING |
| DED-030 | Income invoices and collections cannot enter the expense summary | PENDING |

## Verification

Local verification on 2026-09-30 passed 5,319 unit tests / 480 files, 270 fiscal tests / 9 files independently in UTC and America/Mexico_City, and 62 PostgreSQL tests / 6 files (including eight new deduction-reader checks). TypeScript passed. The production dependency audit reported zero vulnerabilities. These engineering results do not constitute professional approval or authenticated production acceptance.

```sh
TZ=UTC npm run test:fiscal -- --maxWorkers=2
TZ=America/Mexico_City npm run test:fiscal -- --maxWorkers=2
npm test -- --maxWorkers=2
NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit
# TEST_DATABASE_URL must identify a disposable database containing "test".
REQUIRE_DB_TESTS=1 npm run test:db
```

API tests use the actual handler, reader and pure evaluator with mocked IO and prohibit network calls. PostgreSQL tests use synthetic companies only and validate exact decimal boundaries, direction isolation, cross-company UUID isolation, classification conflicts, missing nature, PF/PM differentiation and received-vs-emitted credit notes. The existing income contract/regression tests must continue to pass unchanged. Required CI also performs clean-install build, secret scanning and migration drift checks.

Release evidence and exact verification results are recorded on the PR. An unauthenticated production 401 verifies access protection, not an authenticated customer replay or professional approval.

## Remaining work and rollback

Before any deduction can be consumed by a tax engine, implement versioned reviewer decisions with supporting evidence, concurrency/staleness checks and effective-period taxpayer elections; provide an accountant review surface; verify payment method and effective payment evidence; implement the regime-specific amount/timing/limit rules; and obtain professional tax-amount golden cases. Withholding/credit baskets and lawful annual composition remain separate work.

FISC-002 and QA-001 remain `IN_PROGRESS`. Every case above remains pending professional review. Existing unsupported/mixed-regime calculation guards remain unchanged.

Rollback is code-only. No migration, persisted summary, customer-data transformation or provider action is involved.
