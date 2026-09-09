# Prototype 02 — Dashboard

**Status:** superseded as the complete dashboard contract; retained as the new-company import state

**Fidelity:** workflow and hierarchy before visual implementation

**Primary question:** What requires action now, for which RFC and period, and why?

**Prototype:** `docs/ux/prototypes/dashboard-importing.html`

The authenticated audit expanded this surface into the shared **Inicio and Cartera** model. See [`PROTOTYPE-02-INICIO-CARTERA.md`](./PROTOTYPE-02-INICIO-CARTERA.md) for the current contract. This earlier artifact remains a required state for a recently activated company whose SAT import is still running.

## First slice

The first slice begins exactly where the approved onboarding ends: a paid company is active, e.firma is valid, and the historical SAT import is still running.

It includes:

- Persistent company context without a context questionnaire
- Shared period context centered on August 2026
- One dominant import-readiness action instead of a generic KPI grid
- The 17 September 2026 monthly deadline and its dependency on fiscal coverage
- Safe actions that can proceed while import runs
- Dataset status with source and freshness shown together
- A detailed coverage drawer for the 50 requested periods
- Responsive navigation with Nómina as a primary destination and secondary modules grouped into submenus
- Spanish interface copy with no emoji characters

The mockup intentionally does not invent balances, tax estimates, or compliance scores before the required fiscal coverage exists.

## Entry states inferred by the application

The dashboard does not ask the user to select a persona or explain their context.

1. **Company still importing:** show verified activation, import coverage, safe actions, and the next expected update.
2. **Single-company operator:** lead with the most important actionable fiscal or operational item for the active period.
3. **Multi-company accountant:** lead with portfolio exceptions, then enter a company-level dashboard with context preserved.
4. **Read-only owner or reviewer:** emphasize decisions, cash and tax exposure, deadlines, and evidence rather than preparation controls.

## First viewport contract

The first viewport must show:

- Active company or portfolio scope
- Active fiscal period
- One primary next action with its reason
- Deadline or urgency when applicable
- Source and last successful update
- A truthful state when data is incomplete, stale, estimated, or unavailable

It must not start with a generic KPI grid. Metrics appear only when they help explain the primary action or a material business condition.

## Shared contracts exercised

- `PageContainer` and `PageHeader`
- Company context
- Period context
- Primary next-action pattern
- Status, source, and freshness indicator
- Monetary value and variance treatment
- Import/readiness progress
- Loading, empty, error, permission, and stale-data states

These contracts should be evaluated against existing shared components before implementation. The prototype must name a second consumer for every new shared component.

| Prototype contract | Second consumer |
|---|---|
| Application page shell | Banking and compliance |
| Primary navigation and submenu pattern | Payroll, banking, tax, and company administration |
| Company context | Every company-scoped route |
| Period context | Taxes, accounting, and compliance |
| Primary next action | Compliance and bank reconciliation |
| Status, source, and freshness | Taxes, accounting, banking |
| Readiness progress | SAT import and accounting close |
| Detail drawer | Reconciliation exceptions and filing evidence |
| Responsive status table | Banking imports and compliance history |

## Required prototype states

1. New paid company with import in progress
2. Import partially failed or stalled
3. August 2026 monthly work due 17 September 2026
4. No blocking obligations
5. Unknown or stale SAT status
6. Multi-company portfolio with one urgent RFC
7. Read-only user without preparation permissions
8. Mobile view with only the primary task and essential context

## Acceptance criteria

- A user identifies the next action, RFC, period, and reason in under ten seconds.
- No unknown value is represented as zero.
- Estimated, presented, and SAT-verified states remain visibly distinct.
- Source and freshness are available without opening a secondary page.
- The primary action preserves company and period context on navigation.
- Nómina remains directly accessible on desktop and mobile without opening a submenu.
- The same shared status and period patterns can be used by compliance and declarations.
