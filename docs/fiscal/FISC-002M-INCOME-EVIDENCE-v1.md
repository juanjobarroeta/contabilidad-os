# FISC-002M: monthly income evidence by regime

Status: `VERIFY` — engineering acceptance is separate from professional approval.

Fixture version: `2026-09-30.1`

Professional review: **PENDING**

Official sources checked: `2026-09-30`

## Scope

`GET /api/impuestos/asignaciones-regimen/ingresos?companyId=…&year=2026&month=8` provides a read-only, company-authorized documentary summary. It does **not** calculate tax, establish collected/accruable income, change declarations or accounting closes, or unlock mixed-regime engines. There is no new UI or migration in this slice.

| Evidence bucket | Period | Base before regime allocation | Explicit limitation |
|---|---|---|---|
| `PUE_DOCUMENTADO` | CFDI emission month | Subtotal minus discount, rounded to cents | PUE labeling is not verified collection; `pueAcreditaCobro` is always `false` |
| `PPD_REP` | REP `FechaPago` month | Difference between rounded cumulative paid net bases at month-end and month-start | Uses known, eligible REP evidence; does not prove all SAT documents were imported or determine taxable treatment |

The two totals remain separate; there is no combined cash-income or taxable-income total. `usadaEnCalculoAutomatico` is always `false`. Monthly and annual capability guards are unchanged, including `422 NOT_SUPPORTED` for unsafe mixed-regime composition. Deductions, IVA, retentions, credits, annual baskets, CSF-obligation execution and professional acceptance remain future work.

### Source and product assumptions

- [LISR consolidated text, Articles 102 and 114](https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf), edition showing latest reform 2024-04-01, distinguishes effective receipt in the relevant PF income rules. This motivates separating documentary PUE evidence from verified cash receipt; it does not certify regime-specific tax treatment here.
- [SAT deferred/partial-payment rule](https://wwwmatnp.sat.gob.mx/articulo/22029/regla-2.7.1.35) describes the original invoice and subsequent payment complements. The stored `FechaPago`, not REP emission date, assigns payment evidence to a period. An undated REP remains pending even if issued after the selected month.
- [SAT Anexo 20 guidance](https://wwwmat.sat.gob.mx/consultas/35025/formato-de-factura-electronica-%28anexo-20%29) addresses related credit notes and payment evidence. This slice does not infer unreviewed netting or tax-rate allocation; emitted credit notes in the month and linked eligible credit notes from any month block totals.
- UTC half-open database month boundaries reuse the repository's fiscal-storage convention. They are not a new local-time conversion rule. Stored lifecycle dates remain evidence, not asserted exact SAT legal transition dates.

## Numeric contract

The pure implementation is `src/lib/fiscal/regimen-income-summary.ts`; the reader is `src/lib/fiscal/regimen-income-evidence.ts`. All money enters as exact integer millionths, with `BigInt` intermediates and half-up rounding only at the cent boundary. Because the shared Prisma client converts `Decimal` to JavaScript `number`, the reader selects monetary columns as SQL text inside the same transaction. Unsafe or malformed values become missing evidence, never rounded guesses.

For one PPD parent, let `N = subtotal − descuento`, `T = total`, and `P(t)` be the sum of eligible payments strictly before boundary `t`. The cumulative documentary base is `roundToCents(P(t) × N / T)`; the monthly base is its month-end value minus its month-start value. This prevents repeated rounding of tiny payments from losing or inventing lifetime cents.

Reviewed basis points split both cumulative bases with the existing largest-remainder method; ties follow regime-code order. The per-regime monthly amount is the difference between these two splits. Largest remainder is not always monotone for three or more regimes: any negative difference yields `CUMULATIVE_ROUNDING_REVIEW`, not negative income. Summaries use the **current** reviewed assignment/revision; later edits can change a replay. These are not frozen filed workpapers.

Example (independent fixture `INC-001`): a PPD invoice has subtotal MXN 1,000, discount 100, total 1,044, with July/August/September payments 261/522/261. August's net documentary payment base is MXN 450, split 180 to `606` and 270 to `612` at 40%/60%. A separate August PUE invoice contributes MXN 90 of documentary base, split 36/54. These are **two buckets**, not a certified MXN 540 cash/tax base. A net-one-cent invoice paid in three equal parts produces monthly bases `[0, 1, 0]` cents, conserving the single cent.

## Integrity and authorization

- Session authentication precedes membership checks; effective company membership is required, including read-only `VIEWER` membership. Every model query and parameterized raw amount query is company-scoped. No external provider is called.
- A read-only `RepeatableRead` transaction contains regime lifecycle, invoice assignments, current payments, all-period parent history, UUID aliases, linked credit notes and exact monetary reads. A database error is an error, not `SIN_EVIDENCIA`.
- Stamped, non-superseded PUE and REP are eligible. Draft/cancelled/replaced documents cannot contribute. Resolved supplier payments are outside this income contract; unresolved parents remain pending.
- REP identity is normalized fiscal REP UUID plus normalized parent UUID. Identical duplicate imports count once; conflicting date/amount/installment evidence blocks totals. Ambiguous parent or PUE UUID aliases also block, including aliases outside the issue month.
- Known historical payments must have positive safe amounts and known positive installment numbers, no repeated numbers or sequence gaps, and no payment before its parent invoice. Their all-period total cannot exceed the parent total. The current-month set must match the historical snapshot exactly. This detects known contradictions, not completeness of SAT downloads.
- Mixed-regime attribution requires a valid reviewed assignment. A confirmed single-regime parent gets an implicit 100% split without a write. Missing/unknown regimes, stale assignments or regime transitions remain pending.
- Foreign-currency parents wait for stored REP currency/equivalence and reviewed conversion rules. Legacy `tipoSat: null`, unknown methods, invalid discounts/amounts and unsupported documents remain pending.
- Each scan is capped at 5,000 records plus one sentinel. Any overflow produces `EVIDENCE_LIMIT_EXCEEDED` and **null totals**, never partial-looking complete numbers. API previews contain at most 25 rows and 25 issues, with exact whole-result counts. Scan-limit results are not exact full-period evidence counts.
- Every response is `Cache-Control: no-store`. `PROYECTABLE` means only that this documentary contract passed; `PENDIENTE` has null aggregate totals even when some row previews are valid; `SIN_EVIDENCIA` also has null totals. A documented numerical zero is distinct from missing evidence.

The schema stores one related UUID on a credit note and one related document per REP/parent key. This contract does not reconstruct missing XML relationships or prove import completeness. Those storage/import limits and PUE collection evidence require separate work before tax-engine consumption.

## Versioned review matrix

All 34 cases are synthetic, with independently stated expected outcomes in `src/test/fiscal/fixtures/income-v1.ts`. The matrix is checked against stable fixture IDs. They do not satisfy the roadmap requirement for at least 20 anonymized, licensed-accountant-approved **tax-amount** golden cases per regime.

| Case | Review question / protected contract | Decision |
|---|---|---|
| INC-001 | Discounted PUE and partial PPD remain separate exact buckets | PENDING |
| INC-002 | PPD-only month counts payment evidence once | PENDING |
| INC-003 | Identical fiscal REP duplicates count once | PENDING |
| INC-004 | Query/allocation order cannot change totals | PENDING |
| INC-005 | Tiny partial payments conserve the cumulative cent | PENDING |
| INC-006 | Final payment cannot invent another cent | PENDING |
| INC-007 | Half-cent and tied-share rounding is deterministic | PENDING |
| INC-008 | No evidence is null, not verified zero | PENDING |
| INC-009 | Cancelled PUE/REP contribute nothing | PENDING |
| INC-010 | Live REP with cancelled parent requires review | PENDING |
| INC-011 | Same-month PPD emission is not counted twice | PENDING |
| INC-012 | Mixed-regime income requires reviewed shares | PENDING |
| INC-013 | Unresolved parent remains visible and pending | PENDING |
| INC-014 | Ambiguous normalized parent UUID blocks totals | PENDING |
| INC-015 | Current payment must exist in the all-period snapshot | PENDING |
| INC-016 | Cumulative stamped overpayment blocks totals | PENDING |
| INC-017 | Cancelled historical REP cannot cause overpayment | PENDING |
| INC-018 | Missing historical amount is not zero | PENDING |
| INC-019 | Missing payment date leaves the period unknown | PENDING |
| INC-020 | Discount exceeding subtotal is invalid | PENDING |
| INC-021 | Foreign currency remains outside the contract | PENDING |
| INC-022 | Linked credit notes require reviewed netting | PENDING |
| INC-023 | Non-monotone allocation cannot create negative income | PENDING |
| INC-024 | Payment before invoice requires review | PENDING |
| INC-025 | Conflicting REP duplicate blocks totals | PENDING |
| INC-026 | Repeated installment number requires review | PENDING |
| INC-027 | Scan truncation cannot produce aggregate totals | PENDING |
| INC-028 | Regime transition stays blocked | PENDING |
| INC-029 | Single-regime evidence gets implicit full attribution | PENDING |
| INC-030 | Known zero PUE net base differs from no evidence | PENDING |
| INC-031 | Superseded stamped REP is excluded | PENDING |
| INC-032 | Superseded stamped PUE is excluded | PENDING |
| INC-033 | Missing installment number leaves history unverified | PENDING |
| INC-034 | Installment sequence gaps prevent a complete summary | PENDING |

## Verification and remaining gates

Local engineering verification on 2026-09-30: 5,181 unit tests / 472 files passed after syncing the latest main; 182 focused tests / 7 files passed independently in UTC and America/Mexico_City; 41 PostgreSQL tests / 5 files passed, including 10 new reader tests; TypeScript and the production dependency audit passed (zero vulnerabilities). CI and release evidence are recorded with the pull request. Professional approval and authenticated production replay remain separate gates.

```sh
TZ=UTC npm run test:fiscal -- --maxWorkers=2
TZ=America/Mexico_City npm run test:fiscal -- --maxWorkers=2
npm test -- --maxWorkers=2
NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit
# Point TEST_DATABASE_URL only at a disposable test database containing "test".
REQUIRE_DB_TESTS=1 npm run test:db
```

The unit suite exercises the real domain/API/reader with mocked IO and no network. The real PostgreSQL integration suite uses bounded synthetic companies and checks the physical schema, cross-company UUID isolation, superseded/cancelled REP, unknown dates (including late emission), sixth-decimal preservation, unsafe amounts, linked credit notes and cross-month UUID aliases. It removes only its own fixtures. Existing CI runs the focused suite in both timezones and the integration suite against PostgreSQL.

Licensed-accountant review remains pending for every matrix row. No authenticated customer-production replay or reconciliation to an acuse is implied by local/CI tests or a public 401 smoke check. Numeric tax golden cases, UI review, PUE collection evidence, deduction/retention/credit consumption and lawful annual composition remain open. FISC-002 and QA-001 remain `IN_PROGRESS`.

Rollback: revert this read-only endpoint/domain/fixture slice. There is no migration, persisted summary, backfill, provider action or tax-engine state to reverse.
