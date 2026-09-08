# ContabilidadOS pricing strategy — 2026

Status date: 2026-09-08
Primary ICP: independent accountants and small-to-medium Mexican accounting firms
Secondary ICP: owner-operated companies that need one RFC

## Decision

Do not sell the accounting-firm product at MXN800–1,200 per RFC. That is not competitive with category pricing and makes the firm’s portfolio economics worse as it grows.

Price the core software by portfolio tier. Meter only costs that genuinely grow per company: external compliance extraction, bank connections, high-volume payroll/stamping, AI overages, and premium service.

## Current market anchors

Prices exclude VAT where the vendor states it.

| Product | Public monthly anchor | Relevant packaging |
|---|---:|---|
| Contalink Start | MXN590 | 5 RFCs, one accountant, one client user per RFC, unlimited stamping, support/training |
| Contalink Pro | MXN790 | 10 RFCs; additional RFC MXN50; additional user MXN290 |
| Alegra Contabilidad | MXN490 / 990 / 1,990 | 10 / 30 / 75 companies; multi-company workspace and bulk migration |
| Tesio | MXN499 / 799 | Vendor advertises unlimited RFCs and automated filing; treat feature claims as unverified until tested |

Sources: [Contalink](https://www.contalink.com/precios), [Alegra](https://www.alegra.com/mexico/contabilidad/), and [Tesio](https://www.tesio.com.mx/).

## Cost constraint

The current Syntage rate card starts at MXN7,500 per month for 25 unique entities and 400 extractions. At full entity utilization that is MXN300 per entity before PAC stamps, AI, bank data, infrastructure, support, and failed/retried extraction costs. Under-utilizing the minimum tier makes the effective per-RFC cost higher.

Therefore:

1. Continuous Syntage coverage cannot be bundled into a MXN499 plan today.
2. A per-RFC floor is a vendor-contract artifact, not a sound market price.
3. Native SAT functionality should power the core. Syntage must be renegotiated, replaced, pooled at sufficient volume, or sold as a clearly priced premium service.

## Recommended list prices

### Accounting firms — primary offer

| Plan | Monthly price | Included active RFCs | Included users | Intended scope |
|---|---:|---:|---:|---|
| Solo | MXN990 | 10 | 2 | CFDI sync, bookkeeping, tax workpapers for supported regimes, DIOT file, statements, close checklist |
| Despacho | MXN1,990 | 30 | 5 | Solo + banking, payroll, WhatsApp, branded monthly report, client requests/portal |
| Firma | MXN3,990 | 100 | Unlimited internal users | Despacho + portfolio cockpit, API/webhooks, priority support, migration tooling and controls |

Additional active RFCs: MXN59 on Solo, MXN49 on Despacho, MXN35 on Firma. Stored/archive-only RFCs should not count as active.

Annual billing: charge 10 months for 12 only after retention is proven. During the pilot, prefer monthly billing so churn and willingness-to-pay remain visible.

### Direct company — secondary offer

| Plan | Monthly price | Scope |
|---|---:|---|
| Empresa | MXN599 | One RFC, invoicing, native SAT sync, accounting, supported tax workpapers, statements; no continuous third-party monitoring |
| Empresa Pro | MXN1,299 | Empresa + bank, payroll, WhatsApp, higher stamping/AI limits and branded close report |

The current MXN499 entry price can remain only as a limited/self-service acquisition plan without Syntage and high-support features.

## Add-ons and services

- Onboarding/migration: MXN4,900 per firm including 10 RFCs; MXN250 per additional migrated RFC. Waive selectively for an annual commitment, but show the value on the invoice.
- Additional internal user: MXN199/month on Solo or Despacho.
- Additional bank connection: price after measuring Belvo cost; target at least 70% contribution margin.
- Stamps and AI: include a documented allowance; charge overages rather than advertising unlimited use while unit costs are uncertain.
- Premium SLA/implementation support: MXN1,500–3,000/month per firm depending on response time and scope.
- Continuous external compliance extraction: do not publish a price until vendor economics change. If sold now, quote it separately with a contractual minimum and at least 50% contribution margin; never hide it inside the core tier.
- Direct SAT filing: future premium capability. Charge for controlled workflow/value, not per click; include explicit mandate and reviewer seats.

## Pilot pricing

Sell the first ten unrelated firms a 12-month founding offer:

- MXN1,490/month for up to 20 active RFCs.
- White-glove migration included, but invoiced as a discount from the normal setup fee.
- Price locked for 12 months, then converts to the closest list tier.
- No “unlimited” promise.
- Written statement of supported regimes and assisted-only regimes.

This is high enough to test willingness to pay and low enough to sit near Contalink’s portfolio economics while the product earns trust.

## Unit-economics gates

Track contribution margin per firm and per active RFC every month:

`MRR - Syntage - bank data - PAC - AI - messaging - infrastructure allocation - support labor`

Required gates:

- Core software contribution margin: at least 70% at steady state.
- Any third-party-data add-on: at least 50% during pilot and 65% before scale.
- Support after onboarding: below 60 minutes per firm per month.
- No customer-specific development included in subscription; quote it separately only when it generalizes to the ICP.

## Go / no-go recommendation

Push forward, but as a focused 90-day commercial validation—not as a broad launch.

Proceed if, after Phase 0 and the launch-regime guardrails:

1. At least 5 of 10 qualified external firms will pay at least MXN1,490/month.
2. The cohort reaches 100 active RFCs and uses the close workflow monthly.
3. No material unexplained tax variance reaches a filing.
4. Median onboarding reaches useful SAT history in under 30 minutes.
5. Support and third-party costs fit the margin gates above.

Pause or reposition if accountants only want individual tools, refuse portfolio pricing near these anchors, or require unsupported long-tail regimes before they will use the core workflow.

The product is worth pursuing because the integrated close is real. Its defensible position is not “cheaper tax calculation”; it is “the operating system that lets a firm close every client from one queue with evidence.”
