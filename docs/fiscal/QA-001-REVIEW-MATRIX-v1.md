# QA-001: fiscal regression fixture review

Fixture version: `2026-09-29.1`

Professional review: **PENDING**

Official calendar sources checked: `2026-09-29`

## Scope and acceptance boundary

This first slice contains **42 synthetic contract scenarios**, not 42 accountant-approved tax calculations. It protects period selection, ordinary monthly base deadlines, missing bank evidence, declaration/close provenance, and calculation capability boundaries. It changes no runtime code, tax formula, schema, customer data, or fiscal-provider configuration.

The [versioned catalog](../../src/test/fiscal/fixtures/v1.ts) is the machine-readable oracle. Expected outcomes are literal reviewed-in-code values, never generated snapshots of production output. Stable IDs below link the same facts across independent consumers. All cases still require professional review; a green engineering test is not fiscal certification.

| Layer | Executed code | Deliberate boundary |
|---|---|---|
| Periods | Mexico fiscal date, default/current month, shared monthly contract, declaration checklist, close workflow, owner summary | Ordinary monthly base deadline; no taxpayer-specific extensions |
| Taxes / Close | Real bank coverage, checklist decisions, CE readiness decisions, workflow, canonical close resolver, filing/payment summary, owner summary, definitive-download gate | Inputs are synthetic; DB aggregation, historical-evidence queries, persistence and browser rendering are not exercised |
| Compliance | Real `GET /api/obligaciones`, calendar construction, deadline and filing/onboarding precedence | Auth, obligation seeding and Prisma are mocked; only a manually supplied monthly IVA obligation is exercised |
| Satellite fiscal APIs | Real Automotriz, Hospital and Salameria handlers, default/explicit period selection and returned deadline | IO is mocked from the **requested arguments**, not from expected fixture output; date/checklist decisions remain real |
| Supported regimes | Real lifecycle resolver and monthly/annual capability guards | Engine admission only; no assertion that amounts or the entire regime are fully supported |
| Rejected regimes | Real monthly Taxes engine/handler and annual GET/POST guards, error serialization | Synthetic company rows; fiscal reads, declaration writes and network requests must not occur |

The scenario adapter supplies otherwise-clean PM facts to isolate the changed bank/declaration dimension. IVA `7` and ISR `11` are distinct presentation sentinels, **not tax-amount oracles**. When engines are unavailable, amounts must remain `null`. The external-close boolean is assembled from synthetic historical FILED/PAID evidence; testing the live evidence query remains separate work.

## Sources and product assumptions

- Ordinary monthly IVA/ISR base date: the [SAT monthly declaration service](https://wwwmat.sat.gob.mx/declaracion/53359/simulador-de-declaraciones-de-pagos-mensuales-y-definitivos) describes the following-month deadline. This is not used to certify all regimes or obligations.
- Weekend and named-holiday adjustment: [CFF Article 12, Chamber of Deputies consolidated text](https://www.diputados.gob.mx/LeyesBiblio/pdf/CFF.pdf), edition showing latest reform 2026-04-09. Fixture dates are independently stated calendar examples under these rules. RFC eligibility, exceptional decrees, authority closures and bank-specific Friday payment extensions are excluded, not silently considered resolved.
- Previous completed month in `America/Mexico_City` is the product's operating-period choice, not a claim that the current calendar month changes.
- Filing, payment and local ledger generation are different facts. An imported historical FILED/PAID declaration closes the period **outside ContabilidadOS** without fabricating local entries. An unfiled draft does not. A current local evidence blocker still blocks a local close. These are REL-002/REL-003 product contracts requiring accountant acceptance.
- Pre-onboarding `NOT_APPLICABLE` is the existing calendar suppression rule when no declaration exists. It is **not legal proof that the taxpayer had no obligation** before using the product.
- Regime expectations freeze the [product capability registry](../../src/lib/fiscal/regimen-capabilities.ts), not legal eligibility. In particular, monthly RESICO PM is `ENGINE_NOT_IMPLEMENTED`, not the PF engine; supported/partial admission is not full fiscal coverage. Mixed-regime composition remains fail-closed where required.

## Reviewer matrix

Each row's exact inputs and expected fields live under its ID in the catalog. `PENDING` means no licensed-accountant approval is on record. CI requires one matching row per fixture; it cannot grant approval.

| Case | Review question / protected contract | Decision |
|---|---|---|
| PER-001 | Previous completed month | PENDING |
| PER-002 | UTC September is still August in Mexico | PENDING |
| PER-003 | Mexico midnight changes the operating month | PENDING |
| PER-004 | UTC January is still the previous year in Mexico | PENDING |
| PER-005 | January rollover and Saturday deadline | PENDING |
| PER-006 | Due today is not overdue before Mexico midnight | PENDING |
| PER-007 | Overdue starts at Mexico midnight | PENDING |
| PER-008 | Third Monday of November moves the deadline | PENDING |
| PER-009 | September filing deadline falls on Saturday | PENDING |
| PER-010 | Leap February followed by Sunday and March holiday | PENDING |
| CLOSE-001 | Zero of zero is missing evidence, not reconciliation | PENDING |
| CLOSE-002 | Explicit no-bank confirmation opens the gate without inventing a percentage | PENDING |
| CLOSE-003 | Reconciled evidence is ready but not yet in the ledger | PENDING |
| CLOSE-004 | Partially reconciled bank data blocks the close | PENDING |
| CLOSE-005 | Filed plus a clean local ledger is closed, not necessarily paid | PENDING |
| CLOSE-006 | A local ledger and saved draft do not imply filing | PENDING |
| CLOSE-007 | A late evidence gap overrides a local CLOSED flag without erasing filing | PENDING |
| CLOSE-008 | September onboarding imports a July filed external close without local entries | PENDING |
| CLOSE-009 | An imported paid declaration is both filed and paid, but has no local ledger | PENDING |
| CLOSE-010 | A historical draft is not a filed external close and remains overdue | PENDING |
| CLOSE-011 | A pre-onboarding period without a declaration is not fabricated as filed | PENDING |
| CLOSE-012 | External filing survives unavailable engines; unknown amounts stay unknown | PENDING |
| CLOSE-013 | Unavailable engines cannot make an ordinary period ready | PENDING |
| CLOSE-014 | A no-bank confirmation cannot hide newly arrived unreconciled transactions | PENDING |
| REG-001 | General PM monthly engine enabled | PENDING |
| REG-002 | PFAE monthly engine enabled | PENDING |
| REG-003 | Rentals monthly engine enabled | PENDING |
| REG-004 | Platforms monthly engine enabled | PENDING |
| REG-005 | RESICO PF monthly engine enabled | PENDING |
| REG-006 | General PM annual engine enabled | PENDING |
| REG-007 | PFAE annual engine enabled | PENDING |
| REG-008 | RESICO PM cannot fall through to RESICO PF | PENDING |
| REG-009 | Nonprofit PM remains assisted | PENDING |
| REG-010 | No fiscal obligations is not a calculated zero | PENDING |
| REG-011 | Unknown regime fails closed | PENDING |
| REG-012 | Two monthly engines require explicit composition | PENDING |
| REG-013 | Salary companion does not contaminate the monthly PFAE engine | PENDING |
| REG-014 | Salary companion still requires annual composition | PENDING |
| REG-015 | Historical period uses the old regime, not today's scalar | PENDING |
| REG-016 | Ended regime is excluded at the half-open boundary | PENDING |
| REG-017 | PM-only regime cannot calculate for a PF | PENDING |
| REG-018 | Annual historical calculation cannot use today's supported regime | PENDING |

## Running and changing the suite

```sh
npm run test:fiscal
TZ=UTC npm run test:fiscal
TZ=America/Mexico_City npm run test:fiscal
```

The existing required `test` CI job runs the full unit suite and explicitly repeats these contracts under both server timezones. There is no database, credential, SAT login, provider call, staging write or customer fixture involved. The full suite also discovers these files through the normal Vitest configuration.

Do not update an expected value merely to make a regression pass. Explain the contract change and source, bump the fixture version, retain stable IDs (new IDs for materially different cases), update the matrix, and obtain review of the changed cases. A professional signoff must identify the fixture version and exact Git revision, case IDs, reviewer name/credential, review date, official source edition, expected result, exceptions and durable evidence. Do not mark an entire family approved from one sample.

## Still open before QA-001 completion

The separate [FISC-002M income evidence matrix](./FISC-002M-INCOME-EVIDENCE-v1.md) adds 34 versioned numeric documentary scenarios and a real-PostgreSQL reader suite without altering these original 42 IDs. Its expected amounts are evidence bases, not certified tax calculations; all professional approvals remain pending.

The [FISC-002N deduction prerequisites matrix](./FISC-002N-DEDUCTION-EVIDENCE-v1.md) adds 30 synthetic review scenarios and replays the 34 documentary numeric cases on expenses. It does not authorize deductible amounts or complete the professional tax-amount gate.

Local engineering verification on 2026-09-30: the focused suite passed **110 tests / 5 files** independently under UTC and America/Mexico_City; the full suite passed **5,029 tests / 460 files** with `npm test -- --maxWorkers=2`; `npx tsc --noEmit` passed. The initial unrestricted full-suite run had worker/test timeouts and is not counted as passing evidence. The bounded rerun completed without assertion failures or worker errors. Remote CI/build and deployment evidence are separate from these local results.

- Licensed Mexican tax professional review of this contract matrix.
- At least 20 independently derived, anonymized **tax-amount** golden cases per applicable regime acceptance checklist; these synthetic contracts do not satisfy that requirement.
- Complete due-date applicability/RFC-extension coverage, authoritative CSF obligations, annual/bimonthly calendar cases, and DIOT-specific acceptance.
- Real-database and authenticated browser parity for Taxes, Close and Compliance; staging replay and production/acuse reconciliation with attributable evidence.
- FISC-002 payment/deduction/credit consumption and lawful annual composition, each with independent numeric oracles before enabling calculation.

QA-001 remains `IN_PROGRESS`. No migration or data rollback is needed for this test-only slice; reverting the harness/CI commit removes this regression gate without changing application behavior.
