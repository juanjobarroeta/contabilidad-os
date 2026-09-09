# Prototype 02 — Dashboard

**Status:** next redesign

**Fidelity:** workflow and hierarchy before visual implementation

**Primary question:** What requires action now, for which RFC and period, and why?

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
- The same shared status and period patterns can be used by compliance and declarations.
