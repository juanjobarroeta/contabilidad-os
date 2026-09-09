# UX redesign discovery — Phase 0 boundary

**Date:** 2026-09-08
**Status:** Discovery only. No production UI implementation belongs in the current SAT Phase 0 PR.

## Decision

Start the redesign now as research, information architecture, and low-fidelity prototypes. Keep production component, layout, token, and route changes on later page-scoped branches after the SAT/fiscal work is stable.

The first prototype is **onboarding and company setup**. It has the highest leverage: every customer passes through it, it determines data coverage and trust, and the current experience combines eight steps, document parsing, company creation, credential setup, and a legacy plan-choice screen in one 1,276-line client page. The approved target flow records legal acceptance before fiscal-document collection, confirms payment through Stripe before requesting e.firma, and starts import only after a verified payment event. There is no trial in the current commercial model.

## What exists today

This is not a greenfield redesign.

- The application has a coherent token system in `src/app/globals.css` and `tailwind.config.ts`: semantic color tokens, light/dark surfaces, focus treatment, print behavior, shared radii, and tabular-number support.
- Shared primitives exist for buttons, cards, tables, headers, money, status chips, alerts, loading, and empty states in `src/components/ui`.
- Navigation has already moved toward task groups: Inicio, Operación, Nómina, Fiscal, and Configuración. A command palette provides keyboard navigation and cross-company switching.
- Accounting already has a five-step close flow with period context and stateful steps. The design brief in `docs/BRIEF-UX-contabilidad.md` is partly implemented; it should be treated as an existing product constraint, not restarted.
- Compliance is split across three product concepts: monthly/annual tax preparation in **Taxes**, filing status/opinions/findings in **Compliance**, and accounting close/deliverables in **Accounting**.

## Baseline inventory

The counts below are a source-level baseline, not a visual quality score.

| Signal | Current baseline | Meaning |
|---|---:|---|
| Indexed destinations in global search | 39 | The product is broad enough that information architecture matters more than styling. |
| Native `<button>` instances | ~503 | Interaction styling and behavior are mostly page-local. |
| Shared `<Button>` usages | ~14 | The primitive exists but adoption is low. |
| Native `<input>` instances | ~276 | Forms need a shared field/error/help contract. |
| Shared `<Table>` usages | ~2 | Dense financial views still implement table behavior independently. |
| Onboarding page | 1,276 lines | Multiple distinct jobs are coupled in one wizard. |
| Dashboard page | 681 lines | The page has good state-aware content but owns many display patterns locally. |
| Banks page | 1,798 lines | Account setup, import, matching, categorization, history, and bulk actions share one surface. |

Large files are a delivery risk because a visual change, workflow change, and fiscal behavior change can land in the same diff. The redesign should therefore use page shells and workflow boundaries before broad component cleanup.

## Current information architecture audit

### What is working

- Company context is persistent and visible in the shell.
- Global search solves the long-tail navigation problem and supports accountant vocabulary such as CFDI, DIOT, COI, and IMSS.
- Deep links exist for important subviews and old accounting links are preserved.
- The accounting close is modeled as a sequence with status, not merely as tabs.
- Empty, loading, missing-credential, and in-progress SAT states are deliberately represented on the dashboard.

### Friction to validate with users

1. **The sidebar mixes objects, jobs, and oversight.** Clients and suppliers are directories; invoices and banks are operations; taxes and accounting are period workflows; compliance and pending items are oversight. All are peers in the navigation.
2. **Fiscal boundaries are hard to predict.** A user must learn whether a task belongs in Taxes, Compliance, Accounting, Findings, Opinions, or Pending Items.
3. **Payroll occupies five navigation entries.** This makes the sidebar complete but pushes secondary destinations into the primary path.
4. **Mobile inherits the full desktop drawer.** It is responsive mechanically, but it has not yet been reduced to the few jobs a mobile user is likely to perform.
5. **Settings and company setup overlap.** Company credentials live in `Mi Empresa`, company administration lives under Settings, and adding a company returns to the onboarding wizard.

### Information architecture hypothesis

Do not implement this until card-sorting or task testing supports it.

| Primary area | User question | Includes |
|---|---|---|
| Home | What needs my attention? | Dashboard, pending work, multi-RFC portfolio |
| Operate | What happened in the business? | Invoices, banks, payroll |
| Close and file | Can I close and comply for this period? | Monthly taxes, accounting close, deliverables, filings |
| Records | Who and what do I transact with? | Clients, suppliers, fixed assets |
| Company | Is this RFC configured and connected? | Fiscal identity, e.firma, CSD, team, notifications, plan |

Compliance status, SAT opinions, and findings should be tested as views inside **Home** or **Close and file**, rather than assumed to require a permanent top-level destination.

## Critical workflow audit

### 1. Onboarding and company setup

Current source sequence:

1. AI document upload
2. Fiscal data
3. Review
4. SAT synchronization depth
5. Plan choice (legacy source screen; currently not a real payment gate)
6. Contact
7. CSD
8. e.firma/FIEL

Risks:

- The flow promises synchronization before the credential needed to perform it is collected.
- CSD and e.firma are presented as adjacent credential uploads even though they unlock different outcomes: invoicing versus SAT data access.
- The current plan-choice screen says no payment occurs, so it cannot enforce commercial activation before import.
- The UI asks the user to navigate a generic flow even though the application already knows whether the account has zero companies or is adding another RFC.
- Progress is step-count based; it does not tell the user when the company is usable, when historical coverage is complete, or which optional capabilities remain.

Prototype question: **Can a user accept the legal terms, identify the company, understand and pay for the selected plan, authorize e.firma processing, then reach “company connected and importing” while the application infers the correct entry path?**

### 2. Dashboard

Strengths:

- It changes its primary message based on data readiness, overdue obligations, and filing state.
- It communicates when a value is estimated and when the SAT has not returned data.
- It points missing prerequisites toward e.firma, banks, or the relevant tax period.

Risks to test:

- The page competes between readiness, overdue obligations, tax estimates, KPIs, and closing tasks for the primary action.
- A dashboard for a business owner and a dashboard for an external accountant may need different default emphasis.
- Cross-company users may expect portfolio triage before company-level financial KPIs.

Prototype question: **Can the first viewport answer “what is the next action, for which RFC and period, and why?”**

### 3. Bank reconciliation

The current page combines account management, statement import, import history/undo, filters, automatic matching, manual matching, inline transaction review, bulk categorization, and account editing.

Risks:

- Too many operating modes are visible in one workbench.
- Bulk actions and single-transaction actions use separate interaction models.
- Import success, rejected rows, duplicates, and undo are part of the same mental model but are separated from the reconciliation queue.
- Page-local controls make keyboard behavior and confirmation behavior inconsistent.

Prototype question: **Can the workflow become three explicit states—Import, Review suggestions, Resolve exceptions—without losing expert speed?**

### 4. Compliance and declarations

Current conceptual split:

- **Taxes:** monthly workspace, workpapers, review, presentation record, history, and annual return.
- **Compliance:** obligation calendar, SAT opinions, and findings.
- **Accounting:** close readiness, reconciliation gate, divergence, adjustments, and deliverables.

Risks:

- “Prepare,” “present,” and “prove presentation” are close concepts across different areas.
- The same fiscal period can be selected independently in multiple modules.
- A status can be technically correct in one surface and stale in another unless its source and update time are visible.
- The product must distinguish `unknown`, `estimated`, `ready`, `presented`, and `verified by SAT`; reducing these to green/amber/red would weaken fiscal trust.

Fiscal scenario for prototype testing on 2026-09-08:

- Monthly work should foreground **August 2026**, due **17 September 2026**.
- Annual work should treat **2025** as the latest presentable annual return.
- INPC coverage should disclose that **July 2026** is the latest expected publication and identify a stale seed explicitly.

Prototype question: **Can one period workspace show preparation, blockers, filing, and evidence without hiding the source or freshness of each status?**

## Design-system audit

### Preserve

- Semantic `cos-*` color tokens and light/dark pairing.
- Tabular numerals and right-aligned monetary columns.
- The print-specific accounting treatment.
- Global focus fallback and keyboard-first command palette.
- Status vocabulary that carries text and numbers, not color alone.

### Define before visual implementation

1. A field system: label, required/optional marker, help, error, success, prefix/suffix, file input, and credential reveal.
2. A button/action hierarchy: one primary action per region, destructive confirmation, asynchronous state, and icon-only labeling.
3. A period-context component shared across taxes, accounting, compliance, and dashboard links.
4. A source/freshness badge contract for SAT, user-uploaded acuse, calculated estimate, bank evidence, and stale/unknown data.
5. A responsive table/workbench pattern: column priority, row expansion, sticky actions, and bulk selection.
6. A consistent page shell and header scale. `PageContainer` and `PageHeader` exist, but high-traffic pages often use local equivalents.

### Shared-component rule

Every implementation PR must audit the existing shared primitives before adding page-local UI. Reusable behavior belongs in a shared component when it has two or more known consumers. The initial target set is:

- Page shell and header
- Field label, help, error, success, required, and credential-reveal behavior
- File and credential upload
- Versioned consent acceptance
- Step progress and resumable workflow state
- Plan selection and payment summary
- Status, source, and freshness language
- Period context
- Responsive table and bulk-action behavior
- Loading, empty, error, and permission states

Keep low-level primitives in `src/components/ui`. Put business-aware compositions in a workflow-level shared directory rather than embedding them in route files. Page PRs may extend an existing primitive, but must not create a visually similar local replacement.

Product-language constraints:

- All user-visible interface copy is Spanish for Mexico.
- Do not use emoji characters anywhere in the application UI. Use plain text or the existing Lucide icon system when an icon materially improves comprehension.
- Do not ask users for context the application already knows from session, company membership, route, or invitation state.

Known cleanup debt: literal emoji and status glyphs remain in user-visible copy across onboarding, company setup, banking, invoicing, payroll, compliance, notifications, and chat responses. This discovery PR does not change those production surfaces. Each later page PR must replace them with plain text or labeled Lucide icons. Some success styling currently depends on glyph-prefixed strings; those cases require an explicit semantic success/error state before removing the glyph.

## Research plan

Use five 45-minute sessions before committing to the new navigation:

- 2 external accountants managing multiple RFCs
- 1 in-house accountant or administrator
- 1 business owner who reviews but does not prepare filings
- 1 internal operator/support user

Give each participant the same tasks:

1. Add a new company, activate a plan, and start importing five years of CFDIs.
2. Find why August cannot be closed.
3. Import a bank statement and resolve one unmatched payment.
4. Determine what must be filed by 17 September and whether it was presented.
5. Find the latest annual return and its evidence.

Capture time to first correct click, completion rate, wrong-area visits, backtracking, confidence rating, and vocabulary used aloud. Do not coach with current menu labels.

## Delivery sequence and PR boundary

### Current SAT Phase 0 PR

Allowed:

- Discovery documents and research notes
- Low-fidelity prototype artifacts outside production routes
- Test scripts and acceptance criteria that do not alter UI behavior

Not allowed:

- Changes to `src/app`, `src/components`, `globals.css`, or Tailwind tokens for redesign purposes
- Navigation renaming or regrouping
- Component migrations disguised as cleanup
- New visual dependencies

### After fiscal stabilization

1. `codex/ux-redesign` — approved prototypes, component contracts, and user-test findings only
2. Onboarding/company setup implementation
3. Dashboard implementation
4. Bank reconciliation implementation
5. Compliance/declarations implementation
6. Secondary pages and design-system adoption

Each implementation PR must own one primary route, list the fiscal/API contracts it consumes without changing them, include loading/empty/error/permission states, and have desktop plus mobile acceptance evidence.

## Exit criteria for discovery

Discovery is complete when:

- Five task-based sessions are synthesized.
- The top-level information architecture passes a first-click test for the four critical workflows.
- Prototype 01 resolves the mandatory-versus-optional onboarding path.
- Status/source/freshness language is agreed for fiscal data.
- Every proposed implementation PR has a route boundary and measurable acceptance criteria.
