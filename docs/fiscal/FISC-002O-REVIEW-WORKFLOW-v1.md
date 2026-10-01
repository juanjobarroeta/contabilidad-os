# FISC-002O: documented reviews and reported taxpayer options

Status: `VERIFY`. Workflow version: `2026-10-01.1`. Professional acceptance: **PENDING**.

## What ships

The monthly Facturas workspace has an on-demand **Revisión de deducciones** panel. It displays the FISC-002N documentary bases and review criteria, records an accountant's criterion and references, captures reported rental/platform options with explicit month coverage, and exposes prior revisions. It does not create an approved deduction amount.

`GET /api/impuestos/asignaciones-regimen/deducciones/revision?companyId=…&year=2026&month=9` reads the workspace; `POST` appends a review or option observation. `GET` with `history=1` reads history. The original income/deduction evidence APIs keep their contracts.

| Record | Scope | Meaning |
|---|---|---|
| `FiscalDeductionReview` | Company, month, invoice, PUE/REP source, regime, revision | `DOCUMENTADA`, `NO_PROPONER`, or reopened `PENDIENTE`; none changes tax calculations |
| `FiscalRegimeElection` | Company, exercise, regime, revision | Reported option and effective months; not a SAT election, proof of eligibility, or permission to change an option |

The reviewer supplies a 20–2000-character reason, up to eight distinct source references, and an explicit acknowledgement. Non-pending records require at least one reference. References are plain text locations/folios in the accountant's dossier: **no file upload, external retrieval, verification, or archival of those documents is implemented here**. The invoice UUID/REP IDs and the reviewed surface are separately captured in the review snapshot. Do not enter secrets or credential-bearing links.

`deduccionAutorizadaCentavos` stays `null`; `usadaEnCalculoAutomatico` stays `false`. Existing review reasons remain visible after a record is saved. `VIGENTE` means the documentary snapshot still matches, not that deductibility has been approved. `NO_PROPONER` is also a recorded criterion, not an exclusion applied to any existing engine.

## Integrity and authorization

- Session authentication, effective company membership, enabled accounting module and user module restrictions precede fiscal reads/writes. An independent despacho grant retains its existing authority. VIEWER reads only; writes require OWNER, ADMIN or ACCOUNTANT. A supplied bearer cannot replace the session reviewer.
- All API responses use `no-store`. Browser mutations require JSON and reject cross-site origins; the comparison preserves the original Host authority behind Next/Railway normalization.
- Each record is append-only through this workflow. There is no update/delete endpoint. Reopening adds another revision and keeps prior decisions, author identity, dates, references and review snapshots. These are application-level history guarantees, not tamper-proof/WORM storage. Company deletion still cascades its records.
- A repeatable-read transaction captures the current company/regime lifecycle, exact documentary evidence, options and saved review. The shared reader can join this transaction without nesting another transaction or converting monetary decimals through floating point.
- The server recomputes a SHA-256 fingerprint; stale client evidence is `409 EVIDENCE_CHANGED`. The hash covers the projection inputs and all current option revisions, so a change conservatively invalidates every recorded review in the month. Option freshness uses the company/regime context for the exercise. References outside the system cannot be freshness-verified.
- Expected revision plus a database uniqueness constraint prevents last-writer-wins. Concurrent conflicts return `409 REVISION_CONFLICT`. A request UUID and content/actor hash allow identical retries without duplicate decisions/audits; a reused key with different content/actor is `409 REQUEST_CONFLICT`.
- The record and central audit metadata commit together. Failure does not become a successful empty result. Audit metadata does not copy free-text reasons or references.
- A non-pending criterion requires projectable documentary evidence and an actual company-local allocation. Cancelled/invalid/vanished rows cannot acquire new positive review records; their old history remains visible and no longer counts as current. An existing record may be reopened through the API.
- Existing 5,000-record documentary sentinels remain. Current review keys are capped at 5,000; workspace rows paginate in tens, history in twenties, and issue previews in 25s. Counts are not claims of complete imported SAT data.
- The UI retains a rejected draft on 409 and disables blind resubmission. Reload explicitly asks before discarding a draft. A company/period change remounts the panel so another scope cannot inherit response data or tokens.

## Reported options: deliberate legal boundary

The capture version is limited to 2026. Rental `606` may record `COMPROBADAS`, `OPCIONAL_35` or `PENDIENTE`; platforms `625` may record `PROVISIONAL`, `DEFINITIVO` or `PENDIENTE`. Only PF with that regime in the reviewed month can record an option. Coverage must belong to the selected exercise and include the reviewed month. Outside those months the observation is `FUERA_DE_VIGENCIA`; changes in taxpayer/regime context make it `DESACTUALIZADA`.

This is an observation in an exercise, **not an annual right to switch options**. It does not validate taxpayer eligibility, prior elections, SAT notices, cross-year continuity, property-level exceptions or revocation rules. It does not copy the standalone rental engine's default into a taxpayer election. None of these records is consumed by that engine or by mixed-regime composition.

Primary sources inspected on 2026-10-01: [LISR](https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf), consolidated edition showing latest reform 2024-04-01, Articles 113-B and 115; [SAT rental guidance](https://wwwmat.sat.gob.mx/consulta/26986/lo-que-debes-conocer-de-tu-regimen-). These distinguish rental deduction paths and conditional platform elections, including continuing effects beyond one exercise. This design records the accountant's evidence without deciding those legal requirements.

## Acceptance evidence

Automated contracts cover input/identity forgery, role/module/tenant isolation, invalid periods/options, required references, revision conflicts, idempotent retries, changed evidence, preserved history, effective-month coverage, separate PF/PM treatment, pagination and continued tax-calculation prohibition. Real PostgreSQL tests exercise persistence, concurrent writers and exact evidence reads. The browser probe uses only generated synthetic companies/users against an explicitly local disposable test database.

```sh
TZ=UTC npm run test:fiscal -- --maxWorkers=2
TZ=America/Mexico_City npm run test:fiscal -- --maxWorkers=2
npm test -- --maxWorkers=2
NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit
# TEST_DATABASE_URL must be a disposable database, never a customer database.
REQUIRE_DB_TESTS=1 npm run test:db
# App and script must use the same local test DB and synthetic AUTH_SECRET.
node scripts/smoke-deduction-review.mjs
```

Local checks, CI, exact deployment and authenticated production acceptance are separate evidence. Release counts and deployment attribution are recorded in the PR; neither automated tests nor synthetic browser checks constitute professional approval.

## Remaining work and rollback

FISC-002 and QA-001 remain `IN_PROGRESS`. Next: verified payment-method/effective-payment evidence, legally validated elections (including continuity and scope), and regime-specific deduction amount/timing/limit rules with accountant-approved tax-amount golden cases. Secure document attachment/retention is separate from the source-reference capture here. Withholding/credit baskets and lawful annual composition remain open.

Migration `20261001100000_deduction_review_evidence` only adds two evidence tables, indexes, checks and company foreign keys. It does not backfill or change existing fiscal state. Code rollback can leave those tables intact; preserve recorded history rather than dropping it. No SAT, e.firma, filing, payment or provider action is involved.
