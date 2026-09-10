# Production dependency audit — 2026-09-09

## Scope

Root production dependency graph only, measured with:

```bash
npm audit --omit=dev
```

This is the first bounded slice of `SEC-DEP-001`. It removes the critical runtime advisories without taking the higher-risk Facturapi, Prisma, or spreadsheet migrations in the same change.

## Result

| Snapshot | Critical | High | Moderate | Total |
|---|---:|---:|---:|---:|
| `origin/main` before SEC-DEP-001A | 4 | 15 | 3 | 22 |
| SEC-DEP-001A | 0 | 15 | 4 | 19 |

The four critical findings were attached to `next`, `next-auth`, `@auth/prisma-adapter`, and the transitive `@auth/core` package.

## Remediation

| Package | Before | After |
|---|---:|---:|
| `next` | 15.5.14 | 15.5.25 |
| `next-auth` | 5.0.0-beta.30 | 5.0.0-beta.32 |
| `@auth/prisma-adapter` | 2.11.1 | 2.11.3 |
| `@auth/core` | 0.41.1 | 0.41.3 |

`next-auth` and `@auth/prisma-adapter` now share one `@auth/core@0.41.3` installation.

## Verification

- `npm ls next next-auth @auth/prisma-adapter @auth/core --depth=2`
- `npm audit --omit=dev`: 0 critical, 15 high, 4 moderate
- `npm test`: 332 test files, 3,674 tests passed
- `npm run build`: production compilation, type validation, and 374 static pages passed

## Remaining SEC-DEP-001 work

The Phase 0 release gate remains open because 15 high advisories remain:

- Facturapi requires a major SDK upgrade to remove its Axios chain; isolate it behind contract tests.
- Prisma and its generator/configuration chain require a separate controlled upgrade.
- `xlsx` has no registry-provided fix; replace it, remove the affected path, or document a reviewed exception with exposure controls.
- Patchable transitive findings such as `@xmldom/xmldom`, Browserslist, `defu`, `fast-uri`, `form-data`, `nanoid`, and `sharp` should be refreshed separately and audited again.

Moderate findings, including the Anthropic SDK and Next.js/PostCSS chain, remain tracked but do not replace the zero-critical/high Phase 0 requirement.
