# OPS-001 — deployment health and readiness

Date: 2026-09-23. Scope: the ContabilidadOS web service; no worker, fiscal formula, provider credential, or database-schema change.

## Contract

| Endpoint | Success | Failure | Dependency |
|---|---|---|---|
| `GET /api/health` | `200 {"status":"ok"}` | Server cannot serve requests | None; liveness does not import Prisma or authentication |
| `GET /api/ready` | `200 {"status":"ready"}` | `503 {"status":"not_ready"}` | Read-only `SELECT 1` through the application's shared Prisma connection pool |

Both routes are public by explicit entries in the API security allowlist, use the Node runtime, are forced dynamic, and send `Cache-Control: no-store`. They expose no tenant data, credentials, connection strings, raw error text, or provider status. Next.js supplies HEAD handling from GET. Other API authentication and CORS boundaries are unchanged.

The database probe has a 2,000 ms deadline, with a monotonic-clock check against late completion. Concurrent requests share only the outstanding probe. Completed success is never cached. A timed-out Prisma query cannot be cancelled by the HTTP deadline, so its single-flight slot remains occupied until the actual query settles; additional requests return unavailable without starting more queries. Late success does not overwrite the failed response. A fresh probe is required for recovery. This is bounded probe concurrency per server process, not a global request-rate limiter.

## Deployment gates

The existing `railway.json` now sets `healthcheckPath: /api/ready` and `healthcheckTimeout: 120` seconds. It preserves `node scripts/deploy-db.mjs` as the mandatory pre-deploy command, the start command, and restart policy. The migration algorithm is extracted unchanged into `scripts/lib/deploy-database.mjs` to test its failure paths. Inspection, disconnect, baseline, or migration failure reaches the CLI's non-zero exit; none can report a successful schema or continue to the next migration step.

Readiness proves database connectivity, not schema completeness or fiscal correctness. Schema acceptance is the separate pre-deploy migration gate. No customer table is read by the readiness endpoint.

Railway documents that an unsuccessful pre-deploy command prevents deployment, and a configured healthcheck must succeed before the new release receives traffic. Its healthcheck is **deployment-time only**, not an ongoing monitor. The Phase 0 requirement for seven consecutive days of readiness evidence remains open; this change does not invent that observation window or configure a recurring monitor. Sources checked September 23: [healthchecks](https://docs.railway.com/deployments/healthchecks), [pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command), and [configuration reference](https://docs.railway.com/config-as-code/reference).

## Verification

- Focused suite: 5 files / 27 passing tests, including the existing API security guard. Contracts cover healthy, unavailable, synchronous-error, concurrent, timeout, delayed-completion, late-rejection, and recovery paths; HTTP responses remain uncached and free of diagnostic details.
- Migration tests cover empty/managed/unmanaged schemas, failure at each gate, and the actual CLI's exit code against an intentionally unreachable loopback database.
- The full local real-Postgres suite passes: 4 files / 31 tests, including a new test calling the production readiness route with the shared Prisma client. It uses the existing fail-closed test-database configuration and runs in CI's Postgres job.
- Local acceptance uses a disposable loopback-only Postgres cluster and synthetic production-server keys. The shared Railway staging service tracks a separate SAT branch and is not overwritten by this work.
- Full local unit suite on main baseline `701064d7`: 436 files / 4,719 passing tests. Production dependency audit remains 0 critical, 0 high, and 1 tracked moderate.
- Local production-server smoke passed: GET/HEAD health and ready return 200/no-store; unsupported POST returns 405; login returns 200; invoices redirect to login; invoice and PPD APIs remain 401 without authentication. Stopping only the disposable fixture database changes readiness to 503 (6 ms) while liveness stays 200; restarting it restores readiness to 200 (17 ms). No customer database or external provider is involved.
- `npx tsc --noEmit` and the refreshed production build pass, including all 391 static pages; both new endpoints are dynamic routes.
- [PR #1172 CI](https://github.com/juanjobarroeta/contabilidad-os/actions/runs/35827431823) passes all five checks on Node 22: test 1m26s, build 3m48s, real-Postgres 1m4s, migration drift 54s, and secrets 7s. CI includes concurrent main-branch changes beyond the local baseline: 436 passing test files plus 2 skipped, 4,740 passing tests plus 14 existing XSD tests skipped because `xmllint` is absent, and all 31 real-Postgres tests passing. Those XSD tests pass locally; no new OPS-001 contract is skipped.
- [PR #1172](https://github.com/juanjobarroeta/contabilidad-os/pull/1172) merged at `2026-09-23T06:39:28Z` as `332caf77b6e2dad9417a55acf36a70544799b614`.

## Production acceptance

- Railway deployment `42c81e50-ae16-4a3e-b800-caf0f1b1d00c` reached `SUCCESS` for exact merge `332caf77b6e2dad9417a55acf36a70544799b614`.
- Its resolved file configuration contains `/api/ready`, a 120-second healthcheck window, and the unchanged mandatory `node scripts/deploy-db.mjs` pre-deploy command. This is verified deployment configuration, not merely a committed JSON file.
- Startup at `2026-09-23T06:44:39Z` found 144 migrations with none pending. The server was ready in 761 ms and production observability reported the exact merge SHA.
- Railway's own log records `Path: /api/ready`, `Retry window: 2m0s`, and a successful healthcheck at `2026-09-23T06:44:59.517Z`.
- Public smoke at `2026-09-23T06:45:35Z`–`06:45:37Z` passed all responses below. Railway HTTP logs attribute every one to this exact deployment.

| Production request | Result |
|---|---|
| GET/HEAD `/api/health` | `200`, `Cache-Control: no-store`; GET body `{"status":"ok"}`, HEAD body empty |
| GET/HEAD `/api/ready` | `200`, `Cache-Control: no-store`; GET body `{"status":"ready"}`, HEAD body empty |
| GET `/login` | `200` |
| GET `/facturas` | `307` to `/login` |
| GET `/api/facturas` | `401` without authentication |
| GET `/api/impuestos/asignaciones-regimen/ppd` | `401` without authentication |
| GET `/_next/static/css/25decd6982fa1035.css` | `200`, CSS content type, 63,398 bytes |

The initial exact-deployment HTTP error check returned no 5xx rows. The CE-worker deployment for the same SHA remains build-only with no HTTP healthcheck; no worker configuration or credential was changed. This closes OPS-001's endpoint/promotion-gate implementation and rollout acceptance. The seven-day Phase 0 observation, continuous monitoring, hosted SAT staging workflows, and fiscal acceptance are not claimed complete. Database outage/recovery was tested only on the disposable local fixture, never by interrupting production.

## Rollback and observation

If the new image never becomes ready within the deployment window, inspect its pre-deploy/startup logs and `/api/ready` response. Do not change readiness to liveness or bypass a database failure just to promote the image. Revert this application/configuration change if necessary; no migration or data reversal is introduced here. A rollback to an older image also removes this new readiness gate.

After promotion, inspect both routes and the exact deployment's HTTP logs. `health=200, ready=503` means the web process is reachable but its database probe cannot currently succeed. A successful ready response does not certify SAT/PAC availability, background workers, authenticated workflows, schema drift, or accounting accuracy. Continuous monitoring and the seven-day release gate need separate evidence.
