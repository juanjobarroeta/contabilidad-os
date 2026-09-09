# Prototype 01 — Company onboarding

**Status:** approved direction

**Commercial model:** paid activation; no trial

**Production code:** none on this branch

**Interface language:** Spanish for Mexico
**Live prototype:** https://contabilidad-os-alta-empresa.juan-barroet-0020.chatgpt.site

## Fixed decisions

- The application infers whether the account is new, invited, already covered, or adding another company.
- Legal acceptance occurs before uploading a CSF or any fiscal credential.
- Plan selection and payment happen before requesting e.firma.
- Card details are captured only by Stripe-hosted Checkout.
- The application waits for verified Stripe confirmation before enabling e.firma.
- e.firma requires a separate, purpose-specific authorization.
- SAT/Syntage import starts only after payment and e.firma validation.
- CSD and the Facturapi Carta Manifiesto are optional post-onboarding capabilities for CFDI issuance.
- The current product offers no trial. Trial language and trial-only states must not appear.
- No emoji characters appear in the interface.

## Entry routing

The server resolves the route before rendering the first step:

1. **Account without accessible companies:** run the complete first-company flow.
2. **Account adding a billable company:** run the same flow with the existing account and billing context preserved.
3. **Account with an already covered company:** open that company; do not show onboarding or charge again.
4. **Covered invitation:** complete invitation acceptance and skip independent payment.
5. **Invitation requiring a new subscription:** resolve the invitation, company, and billing unit without asking the user to choose a context already known by the server.

## Approved five-step flow

### 1. Agreements

Before fiscal data is collected, the user must explicitly accept:

- Terms and Conditions
- Privacy Notice and the necessary fiscal-data processing authorization

The primary action remains disabled until both items are accepted. The system records the account, document type, immutable version or content hash, timestamp, IP, user agent, locale, and onboarding context.

This is authenticated electronic acceptance. The SAT e.firma is not used to sign ContabilidadOS legal documents.

### 2. Company identity

Primary path: upload the Constancia de Situación Fiscal after privacy acceptance.

Alternative: enter the required fiscal identity manually.

The screen explains the point-of-collection processing and shows the extracted values for confirmation. No e.firma, SAT download, or Syntage provisioning occurs here.

Exit condition: validated RFC, legal name, taxpayer type, primary regime, and postal code saved in a resumable onboarding draft.

### 3. Plan and Stripe payment

The user selects a billable plan and monthly or annual renewal. Prices, IVA, renewal terms, and cancellation language come from the same canonical configuration used by billing.

The screen contains no card fields. Its primary action is **“Continuar a Stripe”**. Stripe-hosted Checkout collects payment details and the final contractual consent configured for Checkout.

The application does not trust the browser return alone. It binds the Checkout Session to the onboarding draft and waits for a signed, idempotently processed payment event before enabling the next step.

Exit condition: the specific company or onboarding draft has a paid and active entitlement.

### 4. e.firma authorization and upload

The screen starts with a visible payment-confirmed state. It asks for:

- e.firma certificate
- Private key
- Password
- Historical range to import
- Confirmation that the user has authority over the RFC
- Authorization for encrypted storage and limited SAT synchronization processing

The disclosure names the current provider used for SAT connectivity, states that ContabilidadOS will not automatically file declarations or issue CFDI with this credential, and provides the revocation/deletion path.

Exit condition: authorization recorded, files validated, RFC matched, credential encrypted, and import requested idempotently.

### 5. Import progress

This is a persistent destination, not a temporary success message. It shows:

- Company and RFC
- Paid plan and payment verification
- Requested, completed, pending, and failed periods
- Current import phase
- Last successful activity
- A safe next action while synchronization continues

The user may leave the page without stopping the job. Completion language is not shown while any requested period remains pending, failed, or outside known coverage.

## Shared component contracts

The onboarding implementation should prove reusable contracts instead of creating route-local UI:

| Contract | Second known consumer |
|---|---|
| Field label, help, error, and success | Company settings |
| Credential and file upload | CSD configuration |
| Versioned consent acceptance | Credential replacement and regulated integrations |
| Resumable step workflow | Accounting close and declarations |
| Plan selector and payment summary | Billing settings and add-company flow |
| Async primary action | Every mutation-heavy workflow |
| Status and progress | Dashboard and SAT synchronization status |
| Error disclosure | Banking imports and fiscal submissions |

Existing primitives in `src/components/ui` must be inspected and extended before introducing new ones. Business-aware compositions belong in a shared workflow layer, not inside the onboarding route.

## Required failure and recovery states

1. CSF extraction incomplete or low confidence
2. Manual company entry
3. Existing RFC already accessible
4. Existing RFC owned by another account
5. Stripe Checkout abandoned
6. Payment rejected
7. Payment completed while the webhook is pending
8. Paid entitlement already recorded after a retry
9. Expired e.firma certificate
10. Certificate, key, or password mismatch
11. RFC mismatch between company and e.firma
12. SAT or Syntage unavailable
13. Import request timeout with safe resumption
14. Partial import with named failed periods
15. Complete import with no CFDI found

## Prototype artifact

The inspectable standalone mockup is stored at `docs/ux/prototypes/onboarding-paid-activation.html`; its editable fragment is stored beside it as `onboarding-paid-activation.fragment.html`. It intentionally simulates the Stripe handoff; it does not collect payment details or call production services. The standalone artifact preserves its sandboxed iframe and Content Security Policy.

## Implementation boundary

This branch contains only discovery, component contracts, and prototypes. Production implementation begins after fiscal stabilization and should be delivered through small route-scoped PRs. The first implementation PR must document the current company creation, consent, Checkout, webhook, entitlement, credential, and import contracts before changing UI behavior.
