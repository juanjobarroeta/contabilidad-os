# SEC-DEP-001D — remaining high production dependency findings

Date: 2026-09-22. Baseline: `069d832934c9e4083326fa52c4364d8afd21394f`.
Scope: the root application's production dependency graph, including its deployment CLI dependencies. Worker lockfiles are separate graphs and are not covered by this result.

## Result

| Root `npm audit --omit=dev` | Critical | High | Moderate |
|---|---:|---:|---:|
| Baseline, refreshed September 22 | 0 | 7 | 2 |
| SEC-DEP-001D, after clean install | 0 | 0 | 1 |

`npm audit --omit=dev --audit-level=high` exits successfully and is now a required step in the existing CI test job. No advisory was suppressed or accepted as an exception to achieve this result.

## Changes and compatibility boundaries

| Package | Before | After | Evidence |
|---|---|---|---|
| Facturapi | 3.6.0 / Axios 0.24.0 | 5.1.0 / native fetch | [Official SDK changelog](https://github.com/FacturAPI/facturapi-node/blob/main/CHANGELOG.md); installed-SDK HTTP contracts |
| Prisma CLI and client | 6.19.2 | 6.19.3 | [Supported-line security patch](https://github.com/prisma/prisma/releases/tag/6.19.3); Effect resolves to 3.21.0 |
| Prisma config's deepmerge-ts | 7.1.5 | 8.0.2 | [Security fix and breaking-change review](https://github.com/RebeccaStevens/deepmerge-ts/releases/tag/v8.0.0); real Prisma config-loader fixture |
| Next.js / eslint-config-next | 15.5.25 / 15.5.14 | 15.5.26 | [September 22 security release](https://github.com/vercel/next.js/releases/tag/v15.5.26) |
| Next.js's PostCSS | 8.4.31 | 8.5.28 | Same PostCSS major; complete application CSS/production build |

The overrides are scoped to `@prisma/config > deepmerge-ts` and `next > postcss`, with exact patched versions in `package.json` and lockfile integrity hashes. They must remain until the corresponding upstream dependencies select secure versions, at which point removing an override must preserve the audit and compatibility checks. The deepmerge major changes Map-merging and mutation behavior; Prisma uses its `deepmerge` export for plain configuration objects through c12. The fixture exercises that real path with schema and nested migration paths. No application Map merge or database schema behavior is changed.

Facturapi compatibility changes:

- Remove the old ambient declaration so vendor method/type changes are visible to TypeScript.
- Supply decoded CSD bytes directly as supported binary inputs; verify the multipart certificate, key, password, master authentication, and encrypted returned-key persistence with synthetic fixtures.
- Normalize stream and Blob downloads; failed streams reject instead of producing partial PDFs.
- Supply cancellation motive `03` for discarded drafts. Issued-document cancellation retains its caller's motive/substitution and pending-acceptance semantics.
- Preserve native `FacturapiError` diagnostics and correlation ID without forwarding arbitrary response headers. Legacy Axios-shaped errors remain supported.

## Verification

- `npm ci --no-audit --no-fund`: passes from the committed lockfile.
- `npm ls --omit=dev --all`: no missing or invalid production packages; Axios is absent.
- `npx prisma generate`: generates client 6.19.3 without schema changes.
- Focused contracts: 3 test files / 27 passing tests. The installed SDK handles CFDI creation, PPD/payroll JSON, draft lifecycle, cancellation, customer creation, CSD provisioning, binary downloads, stream failures, and HTTP error normalization. Fetch is intercepted and persistence mocked; no real credential, stamp, cancellation, key rotation, or email is sent.
- Full unit suite: 427 files / 4,669 passing tests.
- `npm run build`: compilation, type validation, and all 391 static pages pass.
- [PR #1162 CI](https://github.com/juanjobarroeta/contabilidad-os/actions/runs/35764369672) passed all five checks: test (including the production audit) 1m27s, build 4m26s, real-Postgres authorization 1m8s, migration/schema drift 58s, and secrets 7s. CI runs on Node 22. All new SDK/config tests pass there. Its unit totals are 425 passing files / 4,655 passing tests, plus 14 existing XSD tests skipped because `xmllint` is unavailable; those 14 pass locally. Local checks ran on Node 24.18.0.
- The local production server smoke passed with temporary test keys and an unreachable fixture database: `/login` 200; `/facturas` 307 to login; invoice and PPD APIs 401; both invoice PDF download routes 403 without a valid token; generated CSS 200 (63,367 bytes).
- No migration, backfill, or fiscal-calculation change. Rollback is the previous application image and lockfile; no data reversal is needed.

## Remaining moderate finding

The Anthropic SDK 0.82.0 retains [GHSA-p7fg-763f-g4gf](https://github.com/advisories/GHSA-p7fg-763f-g4gf), concerning its local-filesystem memory tool. The repository does not use that tool in `src` or `scripts`. This remains a tracked moderate finding; the audit is not described as vulnerability-free. A separate SDK compatibility upgrade can remove it.

## Deployment acceptance

- [PR #1162](https://github.com/juanjobarroeta/contabilidad-os/pull/1162) merged at `2026-09-22T18:05:47Z` as `3cc86929e8cbac99bc7397ce508927cb527a761d`, after all five required CI checks passed.
- Railway deployment `8b3947fd-10ce-40a0-9ceb-1b46904f4cdb` reached `SUCCESS`. Startup found 142 migrations with none pending, reported ready in 771 ms, and initialized production observability with that exact merge SHA.
- Public smoke at `2026-09-22T18:17:07Z`–`18:17:08Z` passed. Railway HTTP logs attribute every response below to the exact deployment, including during the old/new instance overlap.

| Request | Result |
|---|---|
| `/login` | `200` |
| `/facturas` | `307`, redirect to `/login` |
| `/api/facturas` | `401`, unauthenticated |
| `/api/impuestos/asignaciones-regimen/ppd` | `401`, unauthenticated |
| `/api/facturas/contract-smoke/file?format=pdf` | `403`, no valid file token |
| `/api/facturas/draft/contract-smoke/pdf` | `403`, no valid file token |
| `/_next/static/css/446400425ed6fe6b.css` | `200`, CSS content type, 63,367 bytes |

The initial deployment-specific HTTP error-log check returned no 5xx rows. This is a bounded rollout observation, not a long-running availability claim. Roll back to the prior application image if dependency-related startup, auth, rendering, or PAC transport regressions appear; no database rollback is needed.

Acceptance closes the root production critical/high dependency gate, including the earlier SEC-DEP-001A–C changes carried by this deployment. Production PAC side effects and authenticated invoice workflows were not exercised; the SDK compatibility evidence uses offline transport contracts and synthetic fixtures, not a live PAC or separate staging integration. The remaining moderate finding, worker dependency graphs, and broader fiscal/product acceptance remain outside this closure.
