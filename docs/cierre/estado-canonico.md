# Canonical monthly-close state contract

Date: 2026-09-09  
Roadmap: REL-002A

## Purpose

The close workflow previously exposed three independent answers:

- the twelve-step close evaluation;
- `AccountingPeriod.status` (`DRAFT`, `POSTED`, or `CLOSED`);
- evidence that the tax declaration had been submitted.

A submitted declaration could hide later SAT, bank, or accounting blockers, and the monthly ZIP intentionally generated preliminary files. REL-002A establishes one fail-closed operational state without changing monetary calculations or the database schema.

## Precedence

The resolver in `src/lib/cierre/estado-canonico.ts` applies this order:

| Priority | Canonical phase | Condition |
|---:|---|---|
| 1 | `BLOQUEADO` | A step has a hard motor blocker, missing evidence, changed confirmed evidence, or an orphaned dependency wait |
| 2 | `CERRADO` | No hard blocker and the ledger is `CLOSED`, or it is `POSTED` with declaration evidence |
| 3 | `POSTEADO` | No hard blocker and the ledger is `POSTED` |
| 4 | `LISTO` | Current evidence has no hard blocker, but the ledger is not posted |

Warnings (`atencion`) remain visible but are not promoted to hard blockers. Human omission cannot override a current hard blocker because the canonical resolver evaluates the motor evidence independently of the stored decision.

The physical ledger status remains in `estadoContable` for diagnostics. If it says `POSTED` or `CLOSED` while current evidence is blocked, the public phase is still `BLOQUEADO`; `posteado`, `cerrado`, and `descargable` are all false.

## Consumers in REL-002A

- `/api/cierre/estado` returns the canonical state with the existing step detail.
- The accountant close page does not hide blockers merely because a declaration exists.
- The owner summary and AI close context use the same blocker count and phase.
- The daily pass only caches `cerradoAt` after declaration, posting, and zero hard blockers; changed evidence reopens a cached close.
- `/api/contabilidad/paquete` returns `409 CIERRE_NO_DESCARGABLE` for a blocked or unposted period and no longer builds a preliminary ZIP.

## Remaining REL-002 work

- Put the same transition guard in every manual, batch, and automatic monthly-posting entry point. This touches the posting engine and remains a separately reviewed no-go change.
- Inventory and guard individual accounting-electronic download routes so none bypasses the canonical package gate after a new blocker appears.
- Add production smoke evidence and confirm the daily reopen/close behavior against representative periods before marking REL-002 done.

## Verification

- Focused close and package-gate suite: 6 files, 61 tests.
- `npx tsc --noEmit` passes.
- Full suite: 336 files, 3,687 tests passed.
- Production build: compilation, type validation, and 374 static pages passed.
- CI and deployment smoke remain.
