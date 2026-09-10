# Prototype 02 — Inicio and Cartera

**Status:** interactive discovery prototype ready for review

**Fidelity:** hierarchy, workflow, state, and permission behavior before production implementation

**Primary question:** What is the next correct action, for which RFC and period, by when, why, and who owns it?

**Prototype:** https://contabilidad-os-alta-empresa.juan-barroet-0020.chatgpt.site/inicio-cartera

## Outcome

The authenticated audit changes the earlier dashboard concept into two lenses over one task model:

- **Inicio** is the active-company decision surface.
- **Cartera** is the multi-RFC queue for users with portfolio scope.

They do not calculate competing priorities or statuses. A task opened from either surface carries the company, working period, obligation scope, role, source, and freshness into the destination.

The prototype uses the approved calm dark visual direction, wide desktop layout, Spanish copy, and text-only `ContabilidadOS` wordmark. It contains no emoji and does not alter production routes.

## What this replaces

The initial importing-dashboard slice remains useful as a new-company state, but it is not the complete dashboard contract. This prototype adds what the production walkthrough showed was missing:

- canonical work items instead of independent dashboard cards;
- an explicit August 2026 working period and 17 September deadline;
- source coverage and freshness in the first viewport;
- a multi-RFC portfolio lens;
- role-shaped actions rather than late API rejection;
- safe `no aplica` and `sin datos por confirmar` semantics;
- a contextual Copiloto that does not permanently reserve table width.

## Canonical work-item contract

Every task projection must receive these fields from domain state rather than reconstruct them in the route:

| Field | Purpose |
|---|---|
| Company | Stable company ID, display name, RFC, and despacho scope |
| Working period | Year and month serialized in the deep link |
| Obligation scope | Obligation or workflow step plus its applicability source |
| Status | Shared semantic status, never inferred from color or missing data |
| Deadline | Natural deadline, adjusted deadline, and urgency |
| Blocker | Concrete reason work cannot advance |
| Ownership | Responsible role and current assignee |
| Source | SAT, bank, upload, calculation, or manual evidence |
| Freshness | Last successful refresh and data coverage |
| Next action | One safe, role-authorized action |
| Evidence | Supporting source records and audit history |

The prototype exercises `blocked`, `in_progress`, `ready_for_review`, `verified`, and `not_applicable`. It treats absence without a trusted applicability decision as `sin datos por confirmar`, not success.

## Priority contract

Inicio and Cartera sort the same tasks in this order:

1. overdue or due-soon external obligations;
2. failed or stale sources that block those obligations;
3. work awaiting human review or authorization;
4. material exceptions;
5. ordinary in-progress work;
6. informational improvements.

The default prototype scenario has a successful SAT refresh with complete August coverage, so it prioritizes two unmatched bank payments. A selectable recovery scenario prioritizes the failed SAT refresh because it can change the August IVA and ISR result due on 17 September 2026. It does not promote the visible local calculation to an approvable result while source coverage is stale.

## Role behavior

| Effective role | Inicio | Cartera | Task action |
|---|---|---|---|
| Responsible for despacho | Portfolio risk and assignments, then company detail | Visible for all authorized RFCs | Assign, unblock, review, or authorize within permission |
| Assigned accountant | Personal priority for the active company and period | Visible for assigned RFCs | Perform preparation and review work within permission |
| Read-only client | Plain-language status, evidence, and responsible team | Hidden without multi-RFC scope | View evidence or follow up; no mutation controls |

The role selector exists only to inspect prototype states. Production derives effective role and scope from the authenticated session.

## Inicio contract

The first viewport contains:

- active company and RFC context;
- the shared August 2026 period;
- adjusted urgency for the 17 September deadline;
- one dominant next action with impact, owner, and reason;
- the source coverage and freshness that make the state trustworthy or block it;
- counts derived from the same canonical tasks;
- source freshness and applicability evidence.

Secondary work is ordered below the dominant action. Opening a task reveals its company, period, obligation, owner, source, coverage, priority reason, and safe-action boundary before navigation.

## Cartera contract

Cartera shows one row per RFC with:

- semantic status;
- next action and blocker reason;
- deadline and urgency;
- assignee;
- source freshness;
- period-preserving entry to the task.

The prototype includes search plus status, assignee, and source-freshness filters. The target implementation must also support due date, regime, module, and blocker filters when backed by the canonical task service.

## Shared component contracts exercised

| Contract | First proving surface | Second consumer |
|---|---|---|
| `AppShell` and `PrimaryNav` | Inicio and Cartera | Cierre mensual |
| `WorkingPeriodBar` | Inicio and Cartera | Bancos and Impuestos |
| `NextAction` | Inicio | Cierre mensual |
| `WorkItem` | Inicio | Cierre mensual and Nómina |
| `WorkStatusBadge` | Inicio and Cartera | Every workflow surface |
| `ApplicabilityBadge` | Inicio | Nómina and Cierre mensual |
| `SourceFreshness` | Inicio and Cartera | Bancos, Impuestos, and Cumplimiento |
| `RolePermissionState` | Inicio and Cartera | Empresa and all action surfaces |
| `TaskDetailDrawer` | Inicio and Cartera | Reconciliation exceptions and filing evidence |
| Contextual Copiloto panel | Inicio and Cartera | Dense banking and accounting workbenches |

These are behavior contracts, not permission to add parallel route-local component families. Production implementation must inspect and extend the existing shared UI system first.

## Prototype interactions

- Switch between Inicio and Cartera without changing the selected period.
- Change company while preserving the working period.
- Change the working period with explicit deadline language.
- Inspect owner, accountant, and read-only behavior.
- Switch between a current SAT connection and a failed-connection recovery state without changing company or period.
- Filter the portfolio by company, RFC, state, assignee, and source freshness.
- Open task details from either lens.
- Open global search from the visible `Command/Ctrl + K` control or the keyboard shortcut.
- Open Copiloto on demand with inherited company, period, view, and role context.
- Use the responsive sidebar and reduced desktop hierarchy.

## Acceptance criteria

- A user identifies the next action, RFC, period, deadline, and reason in under ten seconds.
- Inicio and Cartera render the same status for the same canonical task.
- No unknown or absent value is displayed as zero or complete.
- Local calculation, review readiness, presentation, and authority verification remain distinct.
- Source and freshness are visible without opening a specialist module.
- The healthy SAT scenario never invents a blocker, and the failed scenario never presents stale coverage as ready.
- Global search is visually discoverable and operable with `Command/Ctrl + K`.
- Read-only users do not see purchase, edit, submit, reconcile, classify, delete, or authorization actions.
- A queue entry changes company and period atomically before entering its destination.
- Nómina remains a first-class navigation category.
- Copiloto does not reserve permanent width on dense work surfaces.
- Desktop, mobile, keyboard, loading, empty, stale, degraded, and permission states are covered before implementation ships.

## Open product and engineering decisions

1. Which service owns the canonical task projection and priority score?
2. Which roles may assign work, and can ownership differ by obligation?
3. How are urgency ties resolved across external deadlines and data blockers?
4. Which no-data determinations can be derived and which require human confirmation?
5. Which client-facing evidence is visible before internal review is complete?

These decisions should be resolved before the page-scoped implementation PR. The next discovery prototype is **Cierre mensual**, where the same period, task, status, applicability, freshness, and permission contracts must survive a full cross-product workflow.
