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
- Pending: PR CI, exact production deployment/configuration, and deployment-attributed HTTP smoke.

## Rollback and observation

If the new image never becomes ready within the deployment window, inspect its pre-deploy/startup logs and `/api/ready` response. Do not change readiness to liveness or bypass a database failure just to promote the image. Revert this application/configuration change if necessary; no migration or data reversal is introduced here. A rollback to an older image also removes this new readiness gate.

After promotion, inspect both routes and the exact deployment's HTTP logs. `health=200, ready=503` means the web process is reachable but its database probe cannot currently succeed. A successful ready response does not certify SAT/PAC availability, background workers, authenticated workflows, schema drift, or accounting accuracy. Continuous monitoring and the seven-day release gate need separate evidence.
