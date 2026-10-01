# Bank statement verification and ContaBot

Implementation contract for overlapping interim exports, final statements and corrected statements.

- Preserve source files and extracted rows even when no movement is added.
- One canonical movement may have several source observations. Matching is one-to-one within each document. Same amount/day alone never authorizes a merge.
- Strong identifiers link compatible observations. Conflicts and weak matches require a recorded decision. Distinct identifiers/times and repeated rows remain distinct.
- Imports are serialized and file replay is idempotent per account. All imports are provisional until a complete statement is verified.
- Verification requires identity/coverage attestation, both balances, debit/credit totals and available counts, one-to-one coverage and no unresolved discrepancies. Missing checks are explicit.
- Posting revalidates the current evidence under the same company lock as import, review and year closing. New evidence reopens verification.
- Corrections retain an audit snapshot. Posted copies require an explicit balanced reversal; closed periods and dependent operational links remain blocked for review.
- Banks and ContaBot share the same read, proposal and confirmation services. Chat supports document intake, paginated evidence, client questions and bounded CEP lookup.
- Soluciones receives a read-only diagnostic report; no real financial correction is executed as part of validation.

Validation must cover cross-format repeats, legitimate equal payments, changed statements, zero-new-row PDFs, concurrent/retried uploads, stale confirmations, tenant separation, statement coverage, posting guards and browser confirmation flows.

## User workflow

Open **Bancos → Estados y duplicados**, choose account and month, and attach the
interim export or statement. The paperclip in ContaBot uses the same intake.
Originals and source rows remain available even when every row links to an
existing movement. Re-uploading identical bytes returns the existing document.

Review ambiguous overlaps against references, times, bank IDs, and the original.
Each decision has a preview and an explicit confirmation. A posted-copy removal
shows the exact reversing accounts and amounts, retaining original entries,
reversals, source observations and any CEP in the decision snapshot. Applications
to invoices, tax payments or operating modules must be resolved first. Closed
periods cannot be altered through this flow. Importing into a closed period
retains new observations for review without adding canonical movements.

A complete-month verification requires a person to review the original and
confirm its account, currency, dates, balances, separate debit/credit totals and
printed counts (or explicitly state counts are not printed). An equal missing
credit and debit must not pass merely because the net balance agrees. All
canonical movements must be covered once. New evidence invalidates verification;
classifying a movement does not invalidate documentary coverage, but posting
also checks the classification snapshot under the company lock. A known real
bank account needs coverage even for a zero-activity month; cash/satellite bridge
workflows remain separate.

ContaBot can read paginated evidence, request specific missing documents through
its existing client-request tool, and stage a reviewed decision. The final
statement attestation remains in the bank UI. Loan/category approvals on an
unverified statement save drafts; they do not create bank entries. The existing
managed-agent company allowlist is not expanded by this change.

WhatsApp account selection retains the original in a company-scoped inbox for
24 hours; the pending message stores its ID, not file bytes. Expired inbox files
are removed on the next upload for that company. Confirmed originals live with
the import batch. Tlaloc lookup is limited to a stored SPEI with sufficient
identifiers, reuses saved CEPs and reports missing evidence or previous attempts.
It cannot establish that all bank activity has been received.

## Validation

PostgreSQL integration exercises simultaneous replay, cross-format corroboration,
legitimate equal payments, changed amount/date across months, full-month controls,
stale financial previews, balanced posted-copy reversals, closed-period and
linked-invoice blocks, legacy deletion/undo after later evidence, owner/viewer/tenant separation, staged chat confirmation,
draft-to-posted classification, empty-month evidence, original staging, and
mocked CEP retrieval/cache. Existing loan tests now verify a statement before
regeneration. The separate ledger calculation suite isolates the statement gate;
the statement suite exercises the real gate and posting engine together.

Authenticated browser validation uses a disposable local company: upload OFX,
upload overlapping CSV, inspect the ambiguity, preview/confirm a link, review
monthly controls, confirm verification, and inspect ContaBot's paperclip context.
No real fiscal records, credentials or paid providers are used for these checks.
Real-bank parsing quality and professional confirmation remain document-specific.
