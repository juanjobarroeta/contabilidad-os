# PUE collections and IVA periods

## Supported behavior

For ordinary outgoing PUE invoices in MXN, the calculation uses reconciled
collection dates or a documented, reviewed full collection. An October CFDI
for a September receipt contributes IVA to September once. The workpaper and
CSV preserve both dates and the source reference. This changes the live IVA
calculation, not the stamped XML, saved returns, or ledger entries. ISR and
financial-accounting recognition remain separate.

The calculator, IVA workpaper, tax API, monthly-close checklist and ContaBot
share `loadPueIncomeCollections`. It reads invoice and bank evidence within a
repeatable-read snapshot, handles detailed split allocations and legacy links,
and checks bank-statement verification and unresolved duplicate decisions.
Equal amounts are not proof of duplication. A repeated evidence ID is counted
once; separate movements remain separate. Allocations conserve cents and never
recognize more than the invoice tax across periods.

Mochi handles missing evidence in the existing conversation. It inspects the
invoice and receipt using `query_iva_cobro`, uses reconciliation tools when a
bank match is missing, and asks only for facts or documents not already
available. `proponer_revision_iva_cobro` stages a documented receipt/treatment
review in the existing Confirm/Cancel card. Confirmed bank evidence already
assigns the month automatically; it does not require another review ritual.
There is no dedicated PUE review screen, form or workpaper action. The workpaper
only displays the calculation and evidence.

Confirmation records actor, time, reason, conversation and invoice fingerprint
atomically. Changed bank evidence or invoice reviews invalidate a staged card.
VIEWER access is read-only. Both the existing chat and the managed agent expose
these capabilities; the capability version rotates old managed sessions so
they receive the new tool definitions without discarding conversation history.

## Unresolved evidence

PUE by itself is not proof of payment. Without evidence, the existing
invoice-month amount remains a visibly preliminary estimate;
`cobrosPue.importeDeterminado` is null and `determinado` is false. Saving that
estimate or marking it filed through the calculation paths is blocked. Complete
figures captured from an actual SAT filing can still be recorded as historical
filing evidence; they do not confirm the live calculation.

Partial/overpaid or contradictory allocations, unverified/changed statements,
unresolved duplicates, unsupported currencies, stale invoice reviews and
receipt-linked canceled/substituted invoices require review. Cash, card and
other payment forms require documentation of the effective receipt date; bank
settlement may be later. A different documentary date conflicting with bank
applications remains pending. Related credit notes also require review of
refunds and restitution; issuing a credit note is not proof of repaying cash.

Interest-related concepts prompt a separate legal-treatment review. The engine
does not infer an exemption, tax the loan principal, or automatically implement
the special Article 18-A accrued-real-interest calculation. The reviewer must
confirm that ordinary cash treatment and the invoice tax breakdown are correct,
including any exemption. Special treatment remains pending. This change does
not extend the separate PPD/REP, expense-accreditation, or journal engines.

Filed/paid returns and closed periods are flagged when collection and invoice
months differ. Reads and reviews never rewrite those records. The calculation
save paths reject replacing a filed/closed period with live figures. Corrections
to historical filings and ledger periods require their own review.

## Generation and certification

An optional CFDI generation timestamp now requires an explicit time, UTC
offset and confirmation that it is the actual generation time for the place
of issuance. Date-only inputs, impossible/future dates and timestamps older
than 72 hours are rejected before calling the PAC. Leaving it blank generates
now. The software no longer invents 23:59 or recommends backdating to force an
IVA period. Acceptance by the PAC does not establish timely issuance.

## Legal basis checked on 2026-10-01

- [LIVA, Articles 1-B, 11, 15-X, 17, 18, 18-A and 22](https://www.diputados.gob.mx/LeyesBiblio/pdf/LIVA.pdf): ordinary collection timing, interest exemptions and special treatment.
- [RMF 2026, rules 2.7.1.29-II-b, 2.7.1.32, 2.7.1.39 and 2.7.2.9-I](https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE/documentos2026/rmf/rmf/RMF_2026-DOF-28122025.pdf): payment form/method, REP, PUE facilities and generation-to-certification tolerance.
- [RCFF, Article 39](https://www.diputados.gob.mx/LeyesBiblio/regley/Reg_CFF.pdf): general operation-to-submission deadline, separate from certification tolerance and subject to applicable special provisions.

These are implementation boundaries and source references, not certification
of a particular taxpayer's treatment. Claude's law-ingestion pipeline is
unchanged.

## Validation and deployment

The migration `20261013_pue_collection_timing` adds only nullable
`Invoice.ivaCausacionRevision`; it does not backfill or move amounts. Generate
Prisma and apply migrations before serving this code. Existing PUE invoices
without adequate receipt evidence become explicitly preliminary.

Unit and PostgreSQL integration tests cover chat inspection/proposal/confirmation,
cancellation, changed evidence, the September/October and
December/January boundaries, cent conservation, real equal payments, duplicate
evidence, splits, changed statements, missing evidence, legal-treatment review,
tenant/role isolation, concurrency and preservation of filed records. The
local-only browser smoke uses synthetic data and never stamps a CFDI or calls
SAT. Run it against a disposable local test database and a local Next server
with `IN_APP_CRON=0` and a dedicated synthetic auth secret:

```sh
TEST_DATABASE_URL=postgresql://localhost/contabilidad_os_test \
AUTH_SECRET=pue-iva-synthetic-local-only \
PUE_SMOKE_ORIGIN=http://127.0.0.1:3219 \
npx tsx scripts/smoke-pue-iva.mjs
```
