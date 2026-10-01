# ContaBot objectives and accounting tools

## Assigning and managing work

The **Trabajo de ContaBot** panel in Dashboard and Cierre assigns a completed
calendar month, either the full close or one existing checklist step. The
assigning accountant remains responsible. Owners/admins can configure a recurring
monthly responsibility, its accountable member, starting month and company-wide
daily run limit (default three). Changing responsibility pauses existing recurring
objectives; resume them individually to authorize work under the new member.

Each objective has a persistent conversation, next action, current checklist
evidence, document requests and immutable execution receipts. Pause blocks future
callbacks; an in-flight provider turn must settle before the objective can resume.
Deleting its conversation pauses the assignment. Explicit resume creates a fresh
conversation if needed; deletion never silently starts another agent.

The scheduler checks deterministic evidence every five minutes, with bounded
dispatch through `/api/cron/contabot-objectives`. Paid work starts only for a new
assignment, changed evidence or explicit resume, subject to company concurrency,
daily limits and the existing monthly AI budget. It waits for documents and
confirmation cards rather than repeatedly asking the model to check them.

Completion comes from the existing close engine and its required human decisions.
An agent saying “done”, a completed provider turn, missing data, or an unsubmitted
SAT filing does not establish a completed fiscal close. Verified objectives reopen
when the underlying evidence changes. No SAT submission, payment or stamping is
automated by this feature.

## Accounting tools available in chat

- `query_saldos_cuentas`: selected accounts with requested-period imported CE,
  the latest previous company CE period, and the local ledger, separately labeled.
  Missing evidence is null, never an invented zero. Local entries do not prove full
  coverage; a missing SAT filing does not remove access to local records.
- `query_auxiliar_cuenta`: company-scoped local entries for one account/month,
  with an explicit truncation flag.
- `proponer_crear_subcuenta` and `proponer_renombrar_cuenta`: confirmation cards
  that preserve account numbers and existing history. Creating a child inherits
  the parent's type/nature/official grouping and does not create an opening balance.
- `proponer_registro_prestamo`: one documented MXN principal movement against an
  explicit debtor/creditor auxiliary and a mapped bank account. Confirmation
  rechecks evidence, company, existing applications and period locks before posting
  a balanced pair. The selected counteraccount persists through monthly regeneration.
  Undoing the category removes its bank entries atomically and respects closed periods.

Loan postings are bounded to debtor group 107 and creditor groups 205/251. They do
not handle interest, foreign-exchange conversion, duplicate deletion or unsupported
account families. An ambiguous counterparty needs evidence and a human decision.

Only one unexpired proposal may be pending per conversation. A new question does
not hide it, another proposal cannot replace it, cancellation clears it server-side,
and concurrent confirmations consume the token once. Stale data requires a new card.

## Deployment and operating boundary

Apply `20261001_contabot_objectives` before starting the updated application.
Accounting read/proposal tools also work in the existing in-app chat. Managed
objectives remain behind `CONTABOT_MANAGED_ENABLED` and the explicit
`CONTABOT_MANAGED_COMPANY_IDS` allowlist; deploying this code does not expand it.
The delegated close scope is Pro, persona moral, regime 601 only. Membership,
accounting-module access and delegation are revalidated during execution.

The cron accepts the existing `x-cron-secret` or bearer secret. Existing provider
sessions receive the new tool catalogue on their next idle turn: their local
conversation remains, retired provider bindings ignore late callbacks, and history
deletion removes every binding. Provider uncertainty retains the work lock until
there is a verified outcome and usage receipt.

Validation uses disposable Postgres data and a synthetic provider for scheduling,
permissions, restart recovery, document waiting, pauses, quotas, reassignment,
provider upgrades and concurrent confirmations. Loan regeneration tests exercise
the real posting engine with the separately tested close-readiness gate stubbed.
These checks establish application behavior, not professional approval of a real
company's accounting or tax treatment.
