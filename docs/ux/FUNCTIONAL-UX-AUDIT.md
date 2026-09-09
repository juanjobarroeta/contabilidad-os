# Functional and UX audit

**Status:** source, roadmap, and authenticated production walkthrough complete
**Date:** 2026-09-09
**Branch:** `codex/ux-redesign`
**Scope:** discovery, information architecture, workflow design, and shared-component contracts only

## Executive decision

The current navigation is closer to the right answer after promoting Nómina, but it is not yet the target architecture.

The redesign should organize the product around six recurring jobs:

1. **Inicio** — decide what needs attention now.
2. **Cartera** — triage work across RFCs; only shown when the user has multi-company scope.
3. **Cierre mensual** — the canonical period workflow and definition of done.
4. **Operación** — invoices, banking, and counterparties.
5. **Nómina** — a first-class workspace with its own operating cycle.
6. **Fiscal y contable** — specialist work, history, reports, and evidence.

`Empresa` and `Configuración` remain utilities at the bottom of the shell. Global search remains the long-tail escape hatch.

The most important structural decision is that `/cierre` becomes the orchestration layer. The accounting close, bank reconciliation, payroll, taxes, DIOT, declarations, and deliverables become linked workspaces inside that monthly journey. They must not each invent a separate period or a competing definition of completion.

This is an information-architecture and prototype decision, not authorization to change production navigation during Phase 0.

## Evidence reviewed

### Product surface

This snapshot contains:

- 60 authenticated pages
- 629 API route handlers
- 72 React component files
- 887 TypeScript files under `src/lib`
- 42 indexed destinations in global search

The review covered the application shell, route map, role and membership model, current onboarding, Stripe checkout and webhook flow, legal acceptance, company setup, dashboard, portfolio cockpit, guided close, accounting close, banking, payroll, taxes, declarations, compliance, opinions, findings, and shared UI primitives.

### Product and engineering roadmap

The target UX is aligned to the gap-closure roadmap rather than creating a competing state model. In particular, it assumes the product will provide:

- one period and due-date contract;
- one monthly close state machine;
- explicit no-data and not-applicable semantics;
- actionable integration errors;
- a regime capability registry;
- source, freshness, and provenance on fiscal results;
- human review before consequential actions.

The product thesis is also clear: the despacho is the customer, the monthly close is the operating spine, and the differentiator is moving the accountant from capture to review.

### Authenticated production walkthrough

A read-only walkthrough was completed on 2026-09-09 with the dedicated demo user. It covered Inicio, Cartera, Cierre, Bancos, Nómina, Impuestos, Contabilidad, Cumplimiento, Opiniones, Hallazgos, Facturas, Directorio, Empresa, billing, notices, global search, and the existing-user add-company path.

The walkthrough used navigation, period controls, tabs, filters, and detail views only. It did not upload, submit, stamp, cancel, reconcile, classify, mark paid, mark presented, change settings, purchase, edit, or delete anything.

## Authenticated production findings

These findings are more important than visual polish because they can change what a user believes is complete, payable, compliant, or permitted.

### P0 — conflicting period context

The same signed-in session showed several active contexts at once:

- Inicio mixed August filing work with September setup and no-data items.
- Cierre was on August while the persistent Copiloto led with a September balance alert.
- Bancos opened on September when reached independently, even though the filing and accounting work was for August.
- Accounting links into Bancos did not visibly carry the working month.
- Nómina correctly described August IMSS as due on 17 September, but the SUA export defaulted to bimestre 5, September–October, instead of the due bimestre 4, July–August.

**Risk:** a user can review or export the wrong period while believing they followed the close workflow.

**Required contract:** company, working period, obligation period, payment period, and evidence period must travel together in navigation. When those periods legitimately differ, the interface must name each one.

### P0 — contradictory domain state

The walkthrough found these concrete contradictions:

| Surface A | Surface B | Conflict |
|---|---|---|
| Inicio: Nómina “al corriente” with zero receipts | Nómina: “Aún no corres la nómina de este mes” | Absence of data is treated as both success and pending |
| Impuestos checklist: no current-period REP pending | Impuestos Presentar: two REP pending for $40,212.36 | The same workflow gives opposite readiness answers |
| Contabilidad: zero REP in period, two from other periods | Impuestos: two REP pending without equally prominent source-period scope | Scope is hidden, so counts appear contradictory |
| Cartera: declaration “Por calcular” and $0 payable | Impuestos: calculated total payable $875.90 | Computed, saved, and portfolio states are not distinguished |
| Cartera: CFDIs “al día” | Impuestos: SAT requests processing for nine hours and failed requests with uncontrolled errors | Freshness and job health are collapsed into a green label |
| Cartera: three bank items pending | August Bancos/Cierre: one item pending | Portfolio and period work do not share a count contract |
| Accounting stepper: Cierre, Divergencia, Ajustes, and Entregables checked | Accounting body: close blocked, divergence blocked, adjustments pending, data incomplete | Step summaries do not reflect their own detailed state |
| Accounting: `POSTEADO`, “Mes cerrado,” XML ready | Same page: unmapped accounts would make SAT reject XML, reconciliation remains pending | Posted, closed, generated, and SAT-valid are incorrectly conflated |
| Annual calculation: months 6, 8, 9, 10, 11, and 12 reported as unposted | Accounting period series: August and September reported `POSTED` | Accounting readiness projections disagree about the same months |
| Annual return: Presented with an acuse | Same page: local calculation is incomplete because six months are unposted, yet “Use in declaration” remains available | Authority evidence and local calculation readiness are mixed |
| Opiniones: “Opinión Positiva” | Displayed validity ended 8 September; walkthrough date was 9 September | Expired evidence remains visually positive |

**Required contract:** every projection must derive from one canonical state and expose its source, scope, calculation time, evidence time, and freshness. A label such as `POSTEADO` cannot stand in for “period fully closed.”

### P0 — viewer permissions are not reflected in the interface

The demo user is a direct company `VIEWER` and does not belong to a despacho. The interface nevertheless exposed:

- plan purchase and trial activation;
- company-field editing;
- CSD and e.firma upload;
- Facturapi resynchronization and disconnection;
- company deletion;
- payroll creation, stamping-related, cancellation, and payment actions;
- bank matching, classification, auto-reconciliation, account deletion, and imports;
- invoice creation and mutable fiscal classification;
- filing, evidence, and “mark presented” actions.

The APIs may reject these actions, but late rejection is not permission-shaped UX.

**Required contract:** the shell and page actions consume effective permissions. Viewers should see results, evidence, and history without disabled or doomed mutation controls. Invited viewers and accountants must not be asked to buy the plan paid by the owner or despacho.

### P0 — unsafe readiness and evidence language

Several states rely on self-assertion or permit consequential action before the evidence is trustworthy:

- IMSS can be marked paid from an amount, optional line, and date without a required receipt or bank match.
- DIOT can be marked presented with an optional acuse URL.
- ISN can be marked presented while the screen says the state rate and due date are not verified against published law.
- audit findings can be marked resolved, postponed, or ignored beside the warning without a visible reason or evidence requirement.
- batch REP issuance, re-posting, annual calculation use, and other consequential controls appear in dense work surfaces without a consistent preview contract.

**Required contract:** distinguish recorded by user, supported by uploaded evidence, matched to payment, and verified by authority. Consequential actions use preview, role check, confirmation, idempotent execution, and auditable result.

### P1 — the permanent Copiloto rail makes expert work too narrow

At a 1280 px desktop viewport, the 240 px sidebar and approximately 288 px Copiloto rail leave roughly 680–740 px for the primary workspace. This causes:

- severe truncation in bank reconciliation;
- card-based transaction layouts that require excessive vertical scrolling;
- accounting and payroll tables competing with persistent duplicated findings;
- two simultaneous assistants: a fixed rail plus the floating “Asistente Contable” panel;
- alerts from a different period than the page being reviewed.

**Decision:** Copiloto becomes contextual and collapsible, remembers the user's preference, and does not reserve width on dense workbenches below an appropriate wide-screen breakpoint. Its context must inherit company and period from the page.

### P1 — onboarding is narrow and still has no real payment gate

The existing-user flow correctly recognized the context as “Agregar nueva empresa” and stated that it would join the despacho. That is a strong foundation.

The current production flow still presents a narrow centered card with large unused desktop space and these steps:

`Asistente IA → Datos → Sincronización → Plan → Credenciales`

It requests document upload before a commercial gate, includes a Plan step without Stripe activation, and does not express the approved no-trial flow. Its first screen also uses the English product term “Onboarding” inside an otherwise Spanish interface.

**Decision:** preserve automatic entry-context detection, but replace the narrow card with the wide login-inspired application canvas described below. Use Spanish labels, show exact commercial scope before leaving for Stripe, verify activation on return, and only then request the e.firma mandate and credential.

### P1 — dense lists lack prioritization and recovery structure

Observed examples:

- Bank movements default to all months and render large transaction cards. The visible filters total 223, 3, and 78 without explaining the remaining status population.
- The August reconciliation queue mixes one unresolved movement with ten already reconciled items awaiting posting instead of foregrounding the exception.
- Candidate matches include other months without explaining the allowed date window.
- Imported payroll runs produce a very long historical list with limited visible filtering.
- The declaration history expands large year groups and mixes acuses, manual captures, IMSS, and electronic-accounting evidence.
- Empresa renders a long declaration-import history below credentials and setup.
- Directorio shows repeated per-row synchronize, edit, and delete actions for 66 records; every visible customer lacked a postal code, but there was no focused remediation queue.
- Hallazgos repeats the same risks in an executive summary, category summary, detailed cards, and Copiloto rail.

**Decision:** desktop expert work uses compact tables, explicit mutually exclusive status facets, saved filters, exception-first queues, pagination or virtualization, and a detail panel. Mobile may use cards. Repeated risk summaries should project one canonical work item rather than duplicate it.

### P1 — notification state is confused with work completion

`/avisos` and `/pendientes` render the same notice history. A user can mark a notice “Hecho” even though the underlying bank or close state may remain unresolved.

**Decision:** notification state is read, unread, snoozed, or archived. Domain work status is resolved only by its source workflow or by an explicit evidence-backed override. The two lifecycles must not share “done.”

### What is already working

The redesign should retain these strengths:

- clear Spanish explanations in many fiscal workpapers;
- visible August 2026 deadline of 17 September 2026;
- explicit bank no-data semantics that keep the close gate blocked;
- source labels such as SAT-received and imported historical payroll;
- a precise, versioned, company-specific e.firma mandate limited to SAT authentication and data download;
- strong global keyboard search for long-tail destinations;
- reusable top tabs for Bancos, Nómina, and Impuestos;
- direct evidence links for many acuses and accounting records;
- transparent notes when a calculation is estimated or legally unverified;
- automatic distinction between first-company and add-company entry contexts.

## Product model

The interface currently serves several materially different users:

| User | Primary job | Default landing need |
|---|---|---|
| Despacho owner or manager | Allocate and unblock work across RFCs | Portfolio queue |
| Accountant | Close assigned RFCs accurately and on time | Assigned work for the active period |
| Payroll specialist | Run, validate, stamp, disperse, and evidence payroll | Payroll queue |
| Company owner or reviewer | Understand status, risk, and required decisions | Plain-language company summary |
| Read-only client | Inspect results and evidence | Reports and filed evidence |
| Platform operator | Diagnose cross-account issues | Separate operator tools |

The shell should adapt to membership, role, company count, enabled modules, fiscal obligations, and workflow applicability. It should not rely only on plan tier or hide the product's operating spine because an assisted feature is unavailable.

## Capability map

| Job | Current functions | Current homes | Target owner |
|---|---|---|---|
| Portfolio triage | Deadlines, blockers, company switching, multi-RFC payroll | `/dashboard`, `/despacho`, `/nomina/cockpit`, `/pendientes`, `/avisos` | Inicio / Cartera |
| Monthly close | Twelve-step guided close and six-step accounting close | `/cierre`, `/contabilidad/cierre` | Cierre mensual |
| Invoice operations | Issued/received CFDIs, drafts, stamping, credit notes, REP | `/facturas`, `/facturas/nueva` | Operación / Facturación |
| Bank operations | Accounts, statement import, matching, categorization, evidence | `/bancos` | Operación / Bancos; reconciliation status feeds Cierre |
| Counterparties | Customers, suppliers, account statements, identifiers | `/clientes`, `/proveedores`, `/verificador` | Operación / Directorio |
| Payroll | Employees, runs, incidents, stamping, dispersion, IMSS, annual ISR | `/nomina`, `/nomina/*` | Nómina |
| Monthly tax work | IVA, ISR, retentions, IEPS, DIOT, state payroll tax, workpapers | `/impuestos`, `/impuestos/papeles` | Cierre for current work; Fiscal y contable for direct access/history |
| Filing evidence | Presentation state, acuses, payment evidence, annual return | `/impuestos`, `/declaraciones/*` | Cierre for current work; Fiscal y contable for history |
| Accounting | Posting, divergence, adjustments, reports, CE deliverables | `/contabilidad/*` | Accounting sub-workspace of Cierre; direct specialist access remains |
| Compliance | Obligation calendar, 32-D, CSF, opinions, findings | `/cumplimiento`, `/opiniones`, `/hallazgos` | Fiscal y contable; blockers feed Inicio and Cierre |
| Company readiness | Fiscal identity, CSF, e.firma, CSD, opening, imports, connections | `/empresa`, `/configuracion/empresas/*` | Empresa |
| Organization administration | Firm, users, roles, billing, notifications, account | `/configuracion/*` | Configuración |

## Current-state findings

### 1. There are two competing definitions of “Cierre”

`/cierre` is a twelve-step, plan-gated orchestration flow:

1. Apertura
2. SAT
3. Nómina
4. IMSS
5. Bancos
6. Complementos
7. Impuestos
8. Contabilidad
9. Revisión
10. DIOT
11. Declaración
12. Entregables

`/contabilidad/cierre` is a second six-step close:

1. Documentos
2. Conciliación
3. Posteo
4. Divergencia
5. Ajustes
6. Entregables

Both are useful, but they operate at different levels. The twelve-step flow is the cross-product close; the six-step flow is the accounting sub-workflow. Presenting them as peer destinations makes the same month appear to have two owners and two finish lines.

**Decision:** keep the twelve-step model as the canonical state machine. Present it progressively in five phases, and embed the six-step accounting flow under its Contabilidad phase.

### 2. The period is shared in concept, not in the application shell

The accounting and guided-close routes use `PeriodProvider`, with a company-specific local-storage key. Banking, taxes, compliance, and dashboard logic still select or derive time independently.

Consequences:

- changing August to July in one workspace does not reliably change the next workspace;
- a dashboard deep link can land in a module showing another period;
- independent due-date calculations can disagree;
- users must repeatedly verify context before acting.

**Decision:** the authenticated shell must own a canonical working period for period work. Calendar and historical pages may use other date ranges, but must label that distinction explicitly.

### 3. “No data” can look like success

Payroll, banking, SAT, or obligation surfaces can appear current when there is simply no data. That is unsafe for fiscal work.

Every obligation-dependent result needs one of these applicability states before it receives a progress status:

- `applies`
- `does_not_apply`
- `configuration_required`
- `unknown`

Only `applies` should proceed through work states such as pending, blocked, ready, presented, and verified. Zero records is an observation, not proof that an obligation does not apply.

### 4. Company setup and company administration overlap

`/empresa` combines company switching and creation with CSF, employer registration, platform activity, Facturapi, CSD, e.firma, fiscal opening, declaration import, and electronic-accounting import. `Configuración > Empresas` separately lists and administers companies.

**Decision:**

- `Empresa` owns active-RFC health and capability setup.
- `Configuración` owns the despacho, users, roles, billing, personal settings, and integrations.
- company creation is an explicit workflow launched from Cartera or Empresa, not a generic settings detour.

### 5. Dashboard work queues overlap

The company pilot, multi-company queue, guided-close pending items, notices, and pending pages all answer a version of “what do I do next?” Without a shared task contract, priority and completion can diverge.

**Decision:** create one task projection from canonical domain states. Inicio and Cartera can render different views of the same tasks; they should not calculate separate task truth.

### 6. Plan capability is shaping navigation too early

The guided close can disappear when `cierreGuiado` is unavailable. That hides the product's core monthly mental model rather than only gating premium assistance.

**Decision:** navigation follows the job and obligation. Plan capability controls specific automation, limits, or assisted actions inside the workspace. Unavailable capability is explained in context; it does not erase the user's work.

### 7. Long route files indicate missing workflow boundaries

Examples include a 1,350-line onboarding route, 1,643-line company page, 1,593-line invoices page, and 2,004-line bank manager. This does not require a frontend rewrite, but it is evidence that route-local state, data orchestration, and reusable interaction patterns are coupled.

**Decision:** split only when a page is redesigned, along shared workflow boundaries. Do not perform a broad component migration during Phase 0.

### 8. Role enforcement exists, but role-shaped UX is incomplete

The data model supports company roles (`OWNER`, `ADMIN`, `ACCOUNTANT`, `VIEWER`), despacho roles, per-company despacho scopes, and module restrictions. Much of the visible shell is still common across roles.

**Decision:** use the same route and data contracts, but change default emphasis and action availability:

- owners see decisions, risk, and outcomes;
- accountants see work queues and full review tools;
- viewers see evidence and history without disabled action noise;
- despacho managers see ownership and workload;
- restricted satellite users remain outside the accounting shell.

### 9. Trial language conflicts with the approved commercial flow

Login, signup, landing, onboarding, subscription state, API error copy, and the current Terms still describe a free trial. The approved target has no trial.

This is not only a copy change. Removing the trial affects:

- signup state creation;
- legal documents and their version numbers;
- enforcement and suspension;
- onboarding routing;
- SAT/Syntage access policy;
- login and marketing claims;
- test fixtures and invitations.

**Decision:** treat “no trial” as a coordinated commercial-state migration after Phase 0, not a visual-only patch.

### 10. Billing does not yet match the stated per-RFC doctrine

Stripe Checkout currently creates one subscription line item with quantity one. Billing state lives on `User`, and the webhook applies the purchased tier to all companies owned by that user or associated with the user's despacho.

Before finalizing the payment prototype, product and engineering must resolve:

1. who is the payer: individual owner or despacho;
2. what is billed: user, despacho, or active RFC;
3. how adding, removing, or transferring an RFC changes quantity and proration;
4. whether company entitlements can differ inside one despacho;
5. how negotiated despacho pricing is represented.

The onboarding prototype can show the intended experience, but implementation cannot claim per-RFC billing until these contracts agree.

### 11. Literal emoji and status glyphs remain

The codebase still contains user-visible emoji and glyph-prefixed status text in company setup, banking, payroll, notifications, and other surfaces.

**Decision:** app copy uses Spanish for Mexico and contains no emoji characters. Meaningful icons come from the shared Lucide system with accessible labels. Later implementation should add a user-visible-string check for emoji/pictographic Unicode and replace string-prefix styling with explicit semantic state.

The current circular check beside the wordmark is also perceived as an emoji, regardless of how it is implemented. The auth and application prototypes should use the `ContabilidadOS` wordmark without that symbol until a distinct brand mark is intentionally designed and approved.

## Target navigation

### Desktop hierarchy

| Level | Spanish label | Behavior | Includes |
|---|---|---|---|
| Primary | Inicio | Direct destination | Next action, blockers, deadlines, decisions |
| Primary, conditional | Cartera | Direct destination for multi-RFC users | Company queue, ownership, workload, filters |
| Primary | Cierre mensual | Direct destination and operating spine | Current period, all close phases, evidence of completion |
| Primary category | Operación | Expandable | Facturación, Bancos, Directorio |
| Primary category | Nómina | Expandable and first-class | Resumen, Corridas, Empleados, IMSS y obligaciones |
| Primary category | Fiscal y contable | Expandable | Impuestos, Contabilidad, Declaraciones y acuses, Cumplimiento, Activo fijo |
| Utility | Empresa | Direct destination | Active RFC health, identity, credentials, connections, coverage |
| Utility | Configuración | Direct destination | Despacho, users, billing, account, notifications, integrations |

### Why these categories

- `Inicio`, `Cartera`, and `Cierre mensual` are decisions or jobs, so they are direct destinations.
- `Operación`, `Nómina`, and `Fiscal y contable` are durable work domains with recognizable accountant vocabulary, so they can hold submenus without inventing abstract labels.
- Nómina stays first-class because it has its own people, run, stamping, payment, social-security, and evidence cycle.
- Current-period fiscal and accounting tasks are linked from Cierre, while their specialist hubs remain reachable directly.
- Rare utilities stay discoverable through global search rather than permanently expanding the sidebar.

### Responsive behavior

Mobile should not reproduce the full desktop tree. It should prioritize:

1. Inicio
2. Cierre
3. contextual primary action
4. search
5. company switcher

The complete hierarchy remains available in the drawer. Batch review, dense reconciliation, and accounting tables may require desktop; mobile must still support status, evidence, approvals, and urgent exceptions.

### Route disposition

| Current route | Target placement |
|---|---|
| `/dashboard` | Inicio |
| `/despacho` | Cartera |
| `/cierre` | Cierre mensual |
| `/cierre/negocio` | Owner lens inside Cierre, not a separate mental model |
| `/facturas`, `/facturas/nueva` | Operación / Facturación |
| `/bancos` | Operación / Bancos, linked from Cierre |
| `/clientes`, `/proveedores`, `/verificador` | Operación / Directorio |
| `/nomina`, `/nomina/*` | Nómina |
| `/impuestos`, `/impuestos/papeles` | Fiscal y contable / Impuestos; current period linked from Cierre |
| `/contabilidad/*` | Fiscal y contable / Contabilidad; accounting phase linked from Cierre |
| `/declaraciones/*` | Fiscal y contable / Declaraciones y acuses |
| `/cumplimiento`, `/opiniones`, `/hallazgos` | Fiscal y contable / Cumplimiento |
| `/activos` | Fiscal y contable / Activo fijo |
| `/empresa`, `/empresa/apertura` | Empresa |
| `/configuracion/*` | Configuración |
| `/avisos`, `/pendientes` | Views of the canonical Inicio task/inbox model |
| `/operador`, `/creditos`, `/rentabilidad` | Separate operator-only section |

## Canonical state contracts

The redesign should not proceed page by page until these contracts are named and shared.

### Company context

Every work surface receives the active company, effective role, despacho scope, enabled modules, plan capabilities, and fiscal profile from one stable shell context. Route changes must not refetch and blank the entire company context by default.

### Working period

One contract provides:

- company ID;
- year and month;
- human label;
- natural due date and adjusted due date;
- period lifecycle;
- deep-link serialization;
- a distinction between working period and historical/calendar range.

For the audit date, the natural monthly working period is **August 2026**, due **17 September 2026**. The latest annual filing year is **2025**. Expected latest INPC publication is **July 2026**; older coverage must be marked stale rather than silently accepted.

### Obligation applicability

No status is complete without knowing whether the obligation applies. The source of that decision should be visible: CSF, regime registry, employer setup, user confirmation, or unresolved configuration.

### Work status

Use a shared vocabulary across modules:

- `not_started`
- `in_progress`
- `blocked`
- `ready_for_review`
- `approved`
- `presented`
- `verified`
- `not_applicable`

Not every module uses every state. “Verified” must mean evidence from the relevant authority or source, not merely a successful local save.

### Source and freshness

Every fiscal result that can drive a decision identifies:

- source: SAT, bank import, user upload, calculation, or manual entry;
- last successful refresh;
- coverage period;
- confidence or reconciliation status where relevant;
- degraded or stale state;
- link to supporting evidence.

### Human decision

Consequential actions need a reusable staged-action contract:

1. preview what will happen;
2. state what changes and what remains untouched;
3. show supporting evidence and blockers;
4. require a role-authorized confirmation;
5. execute idempotently;
6. record result and actor;
7. provide recovery or next action.

### Commercial readiness

Onboarding needs an explicit server-confirmed payment state. Returning from Stripe is not proof of activation; the UI must wait for or refresh the webhook-owned subscription state before unlocking credential upload and import.

## Target workflows

### A. First company onboarding — no trial

The new-account path should be:

1. **Create account** — name, email, password.
2. **Accept account legal documents** — Terms and Privacy Notice, with links and versioned evidence.
3. **Identify the company** — upload CSF or enter fiscal data manually.
4. **Validate fit** — detect RFC, taxpayer type, regimes, obligations, and unsupported capabilities before charging.
5. **Confirm commercial scope** — selected offer, payer, billable RFCs, interval, taxes, and renewal terms.
6. **Pay with Stripe** — leave and return to the same resumable onboarding state.
7. **Verify activation** — wait for server-confirmed webhook state; never trust the success query parameter alone.
8. **Accept the e.firma mandate** — a separate, company-specific authorization, not bundled into generic Terms.
9. **Upload and validate e.firma** — certificate/key match, password validation, RFC match, safe error recovery.
10. **Choose import coverage** — only now, because the product can explain cost, duration, and available sources accurately.
11. **Start resumable SAT import** — background progress, coverage, last success, partial failure, and safe continuation.
12. **Configure fiscal opening** — imported evidence first; unresolved opening tasks remain visible.
13. **Configure CSD only if invoicing is needed** — explain that CSD enables issuance, while e.firma enables SAT authorization and data access.
14. **Land in Cierre mensual** — show the first real action for the first working period.

There is no trial CTA, trial banner, or trial fallback in this target.

#### Layout and visual direction

Keep the calm dark surfaces, restrained blue accent, typography, spacing, and low-noise tone that worked on the login page. Do not reuse its narrow authentication-card width for onboarding.

On desktop, onboarding should use a wide application canvas, approximately 1040–1160 px maximum width:

- main task column for explanation and form controls;
- persistent side summary for progress, company, price, security, and what happens next;
- one primary action per step;
- full-width progress and clear return/resume behavior;
- no decorative emoji or check-mark brand symbol.

On mobile, the summary collapses below the active task and progress remains visible without consuming the first viewport.

#### Entry variants

The app already knows the entry context and should branch automatically:

| Context | Correct behavior |
|---|---|
| New user with no memberships | First-company commercial onboarding |
| Existing owner adding an RFC | Add-company flow; reuse account legal acceptance and known payer context |
| Despacho member invited to existing portfolio | Accept invitation and land in assigned work; no payment or company creation |
| Client invited to one company | Accept invitation and land in permitted read/review view |
| Restricted satellite user | Stay in the satellite experience; do not enter accounting onboarding |
| Existing user with incomplete setup | Resume the exact incomplete milestone |

#### Legal separation

Maintain separate evidence for:

- Terms of Service acceptance;
- Privacy Notice acceptance;
- e.firma mandate per company;
- CSD/Facturapi manifestation when applicable;
- filing or payment authorization for each consequential action.

Changing the no-trial commercial terms requires a new legal-document version and reacceptance strategy.

### B. Inicio and Cartera

The first viewport should answer: **what is the next action, for which RFC and period, by when, why, and who owns it?**

The canonical work item contains:

- company and period;
- obligation or workflow step;
- deadline and urgency;
- blocker reason;
- owner or assignee;
- source freshness;
- next safe action;
- link that preserves company and period context.

Recommended priority order:

1. overdue or due-soon external obligations;
2. failed or stale data connections that block work;
3. items awaiting human review or authorization;
4. material exceptions;
5. ordinary in-progress work;
6. informational improvements.

Inicio is the active-company lens. Cartera is the multi-RFC lens with filters for owner, assignee, due date, regime, module, blocker, and freshness. Switching from a queue item must atomically change company and period before navigation.

### C. Cierre mensual

The twelve canonical steps should be progressively disclosed in five phases:

1. **Preparar datos** — Apertura, SAT, Nómina, IMSS, Bancos, Complementos.
2. **Calcular y contabilizar** — Impuestos and Contabilidad.
3. **Revisar** — exceptions, divergence, risks, and human decisions.
4. **Presentar y pagar** — DIOT, declaration, acuse, and payment evidence.
5. **Entregar** — immutable monthly package and client-facing summary.

The page shows one recommended next action, but lets experts inspect every step. Each step displays applicability, status, the number that matters, source freshness, blocker, owner, and evidence.

The accounting six-step workflow remains intact as a drill-down:

`Documentos → Conciliación → Posteo → Divergencia → Ajustes → Entregables`

Closing must be a human-authorized transition with a preview of generated data and an explicit statement that manual and opening entries are preserved.

### D. Bank reconciliation

Reframe the current all-in-one surface as four explicit modes:

1. **Conectar o importar** — choose account and source; upload; show file validation and duplicate handling.
2. **Validar el estado** — opening balance, closing balance, date coverage, rejected rows, duplicate rows, and import history.
3. **Revisar sugerencias** — high-confidence matches first, with single and grouped matches and visible reasoning.
4. **Resolver excepciones y firmar** — unmatched transactions, categorization, rules, tax-payment matching, REP implications, and reconciliation evidence.

Expert speed still matters: keyboard movement, bulk actions, saved rules, undo by import batch, and stable table columns should survive the simplification.

Deleting a bank account must use a shared destructive confirmation that names the account, movement count, consequences, and recovery boundary; native browser confirmation is not sufficient.

### E. Nómina

Nómina remains a primary category because it has an independent end-to-end workflow:

1. **Preparar** — employer setup, employees, contracts, salaries, and incidences.
2. **Calcular** — regular or special run, prior-period prefill, validation, and recalculation.
3. **Revisar** — perceptions, deductions, ISR, IMSS, net pay, and anomalies.
4. **Timbrar** — human confirmation, idempotent stamping, and error recovery.
5. **Dispersar** — payment file, payment status, and bank linkage.
6. **Cumplir** — SUA, IDSE, SIPARE, IMSS, state payroll tax, annual ISR adjustment.
7. **Evidenciar** — receipts, XML/PDF, filings, payments, and accounting impact.

The multi-RFC payroll cockpit is a Nómina view and a Cartera filter, not a disconnected product.

### F. Taxes, declarations, and compliance

For each applicable obligation, use one lifecycle:

`Determined → Workpaper ready → Reviewed → Authorized → Presented → Paid → Verified`

The current-period instance appears in Cierre. Fiscal y contable provides direct specialist access and immutable history.

The user must always be able to tell the difference between:

- calculated locally;
- estimated because data is incomplete;
- reviewed by a person;
- recorded as presented by the user;
- proven by an uploaded acuse;
- verified from SAT evidence;
- paid and matched to bank evidence.

### G. Empresa health

Replace the long mixed company page with a readiness overview:

- fiscal identity and regimes;
- obligation applicability;
- legal acceptance status;
- e.firma health and expiration;
- CSD/Facturapi health when invoicing applies;
- SAT connection and import coverage;
- bank connection/import coverage;
- payroll/employer setup;
- accounting opening status;
- team and access summary;
- billing owner and entitlement summary.

Every card answers whether the capability is required, ready, blocked, optional, or not applicable, and links to a focused setup task.

## Shared component and behavior contracts

Every implementation PR must inspect and extend the shared system before introducing route-local equivalents.

### Shell and navigation

- `AppShell`
- role/capability-aware `PrimaryNav`
- stable `CompanySwitcher`
- global `WorkingPeriodBar`
- command palette with company/period-preserving navigation
- mobile task-first navigation

### Workflow

- `WorkflowStepper`
- `WorkItem`
- `BlockerPanel`
- `NextAction`
- `StagedActionPreview`
- `ConfirmDialog`
- `JobProgress` for resumable imports and long-running work

### Trust and evidence

- `ApplicabilityBadge`
- `WorkStatusBadge`
- `SourceFreshness`
- `EvidenceCard`
- `AuditTrail`
- `RolePermissionState`

### Forms and setup

- field label/help/error/success contract
- file and credential upload
- secret reveal with explicit safety language
- versioned legal acceptance
- payment summary and activation state
- setup checklist and resumable milestone state

### Dense work surfaces

- responsive data table
- money, percentage, quantity, and date cells
- row expansion
- sticky filters and actions
- selection and bulk-action bar
- keyboard navigation
- loading, empty, degraded, error, and permission states

Low-level primitives remain in `src/components/ui`. Domain-aware compositions should live in workflow-level shared directories. A route should not create a visually similar replacement when a shared behavior already exists.

## Prototype roadmap

### Foundation: contracts before screens

Deliverables:

- target shell and responsive hierarchy;
- company/period/task state diagrams;
- applicability and status vocabulary;
- source/freshness examples;
- shared component contracts;
- billing-model decision record.

No production-route changes.

### Prototype 01: onboarding and Empresa

Cover the six entry variants, no-trial Stripe gate, separate legal acceptances, e.firma validation, resumable SAT import, CSD deferral, and first landing in Cierre.

Key success test: a user can explain why payment precedes e.firma, what data access is being authorized, and what happens after returning from Stripe.

### Prototype 02: Inicio and Cartera

Use real company, obligation, freshness, and assignment states. Test owner and accountant lenses without building separate products.

Key success test: the first correct action and its reason are found in under ten seconds.

### Prototype 03: Cierre mensual shell

Unify the twelve-step cross-product close with the six-step accounting drill-down. Include no-data, not-applicable, stale, blocked, ready, presented, and verified scenarios.

Key success test: users can identify why August 2026 cannot close, who owns the blocker, and the exact next action.

### Prototype 04: Bancos

Prototype import, statement validation, suggestion review, exception resolution, and signed evidence with desktop keyboard behavior.

Key success test: an accountant can resolve an unmatched payment without losing period or import context.

### Prototype 05: Nómina

Prototype the full run lifecycle plus multi-RFC triage and accounting/fiscal handoffs.

Key success test: the user can distinguish calculated, reviewed, stamped, dispersed, and evidenced states.

### Prototype 06: Fiscal y contable

Prototype obligation lifecycle, workpapers, accounting divergence, presentation evidence, compliance history, and reports.

Key success test: users do not confuse a local calculation with a SAT-verified filing.

### Prototype 07: secondary operations and settings

Complete Facturación, Directorio, reports, user administration, notifications, and operator surfaces using the proven component contracts.

## Implementation PR boundaries after Phase 0

Recommended sequence:

1. shared shell context and semantic status primitives;
2. onboarding and Empresa;
3. Inicio and Cartera;
4. Cierre mensual shell;
5. Bancos;
6. Nómina;
7. taxes, declarations, compliance, and accounting drill-downs;
8. Facturación and Directorio;
9. reports and settings.

Each PR should:

- own one primary route or one shared contract;
- list the existing fiscal/API contracts it consumes;
- avoid changing fiscal calculations unless separately authorized;
- cover loading, empty, no-data, stale, error, permission, and mobile states;
- include evidence for role and plan variants;
- preserve deep links;
- include Spanish copy with no emoji;
- remain independently reversible and testable.

## Research plan

Run task-based sessions before implementation with:

- two external accountants managing multiple RFCs;
- one payroll specialist;
- one in-house accountant or administrator;
- one business owner/reviewer;
- one read-only client if available.

Core tasks:

1. Add a company, pay, authorize e.firma, and start import.
2. Find why August 2026 cannot close.
3. Import a statement and resolve one unmatched payment.
4. Run payroll through review, stamping, and evidence.
5. Determine what is due by 17 September and what proof exists.
6. Find the latest annual filing and its evidence.

Measure first correct click, completion, wrong-area visits, backtracking, time, confidence, vocabulary used aloud, and whether source/freshness was understood.

## Decisions required before high-fidelity implementation

1. Billing owner and billable unit.
2. Entitlement behavior when a despacho has multiple RFCs or mixed plans.
3. Exact boundary between recording a filing and filing directly with SAT.
4. Whether the core close is universal while assisted close actions are plan-gated.
5. Default landing lens for despacho owner, accountant, payroll specialist, and client.
6. Ownership and assignment model for canonical work items.
7. Which obligations are derived from the regime registry and which require explicit human confirmation.

## Discovery exit criteria

Discovery is complete when:

- [x] the authenticated production walkthrough has been recorded;
- [ ] the proposed hierarchy passes first-click testing for onboarding, monthly close, banking, payroll, and filing evidence;
- [ ] billing ownership and unit are decided;
- [ ] the working-period and task contracts are accepted by product and engineering;
- [ ] applicability/status/source/freshness language is approved;
- [ ] the onboarding prototype covers every entry variant with no trial;
- [ ] each implementation PR has a route boundary and measurable acceptance criteria.
