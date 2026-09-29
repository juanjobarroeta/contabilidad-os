# Hospital safety rollout

The migration is additive and must precede the new API/frontend. Clinical control history is append-only at the database level. Do not roll back by dropping evidence or request-outcome tables.

Existing members receive no new clinical or financial grants automatically. Administrators must assign chart read, documentation, prescribing, administration, discharge and finance separately. A different administrator reviews the actual practitioner's credential and user binding. Updating a practitioner's identity clears that review.

The application endpoint requires a UUID request identity. Deploy the compatible frontend, which reuses it across retries, including reloads. Stock without a verified expiration date or under hold cannot be applied. Release of a stock hold requires administration rights and an evidence reference.

Surgical entry checks consents and preparation. The emergency exception requires independent attestations from two verified accounts within the configured two-hour window and records missing evidence/follow-up. Clinical leadership must review the protocol, consent templates and exception policy before live adoption. These software checks do not certify medical readiness or regulatory conformity.

Patient-rights and facility operations endpoints record evidence and decisions; they do not submit filings or execute clinical decisions. Actual licences, credentials, notices, representation documents, RPBI manifests and professional review remain facility-owned. Retention has no automatic purge; displayed minimum dates are derived from recorded acts and do not replace the production retention/backup policy.

Billing payer shares are hospital-only estimates with proportional VAT allocation; physician fees are separate. Validate actual contract-specific coverage and the invoice/payment/cancellation/bank/ledger cycle with finance before using estimates to issue invoices.

## Verification

The prepared `docs/ci/hospital-safety.yml` runs the real HTTP/PostgreSQL regression against an optimized build and ephemeral synthetic fixtures. `scripts/hospital-safety-regression.ts` refuses non-local databases and any database other than its dedicated test name. Enabling the workflow under `.github/workflows/` is pending a GitHub login with workflow permission. For manual reruns, use a fresh isolated server/database; normal login rate limiting remains enabled.

Before production rollout: backup and restore rehearsal in the target environment, additive migration, coordinated frontend/backend deployment, staff grants and verification, synthetic smoke test, then operator acceptance. Record deployed commits and retain rollback/recovery evidence.
