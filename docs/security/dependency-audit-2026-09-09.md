# Production dependency audit — 2026-09-09

## Scope

Root production dependency graph only, measured with:

```bash
npm audit --omit=dev
```

The audit is being remediated in bounded slices. None of these slices take the higher-risk Facturapi, Prisma, or spreadsheet migrations without their own compatibility work.

## Result

| Snapshot | Critical | High | Moderate | Total |
|---|---:|---:|---:|---:|
| `origin/main` before SEC-DEP-001A | 4 | 15 | 3 | 22 |
| SEC-DEP-001A | 0 | 15 | 4 | 19 |
| SEC-DEP-001B | 0 | 8 | 2 | 10 |

The four critical findings were attached to `next`, `next-auth`, `@auth/prisma-adapter`, and the transitive `@auth/core` package.

## SEC-DEP-001A remediation

| Package | Before | After |
|---|---:|---:|
| `next` | 15.5.14 | 15.5.25 |
| `next-auth` | 5.0.0-beta.30 | 5.0.0-beta.32 |
| `@auth/prisma-adapter` | 2.11.1 | 2.11.3 |
| `@auth/core` | 0.41.1 | 0.41.3 |

`next-auth` and `@auth/prisma-adapter` now share one `@auth/core@0.41.3` installation.

## SEC-DEP-001B remediation

The following resolutions stay within the version ranges already permitted by their direct parents:

| Package | Before | After |
|---|---:|---:|
| `@xmldom/xmldom` | 0.9.9 | 0.9.12 |
| `baseline-browser-mapping` | 2.10.13 | 2.11.21 |
| `browserslist` | 4.28.2 | 4.28.9 |
| `defu` | 6.1.4 | 6.1.7 |
| `fast-uri` | 3.1.5 | 3.1.7 |
| `follow-redirects` | 1.15.11 | 1.16.0 |
| `form-data` | 3.0.4 | 3.0.5 |
| `nanoid` | 3.3.12 | 3.3.18 |
| `postcss` (root graph) | 8.5.15 | 8.5.28 |
| `sharp` | 0.34.5 | 0.35.4 |

This removes seven high and two moderate findings without changing direct dependency ranges. Next.js still pins a separate affected PostCSS version; resolving that advisory requires the Next.js 16 major line.

## Verification

- `npm ls next next-auth @auth/prisma-adapter @auth/core --depth=2`
- `npm audit --omit=dev`: 0 critical, 15 high, 4 moderate
- `npm test`: 332 test files, 3,674 tests passed
- `npm run build`: production compilation, type validation, and 374 static pages passed

SEC-DEP-001B verification:

- `npm ci`: passed from the updated lockfile
- `npm ls @xmldom/xmldom baseline-browser-mapping browserslist defu fast-uri follow-redirects form-data nanoid sharp postcss --all`: expected patched resolutions only
- `npm audit --omit=dev`: 0 critical, 8 high, 2 moderate
- `npm test`: 334 test files, 3,681 tests passed
- `npm run build`: production compilation, type validation, and 374 static pages passed

## Remaining SEC-DEP-001 work

The Phase 0 release gate remains open because eight high advisories remain:

- Facturapi and Axios require a major SDK upgrade; isolate it behind contract tests.
- Prisma, `@prisma/config`, `deepmerge-ts`, and `effect` require a separate controlled major upgrade.
- `xlsx` has no registry-provided fix; replace it, remove the affected path, or document a reviewed exception with exposure controls.
- Next.js pins the remaining affected PostCSS release; npm reports a Next.js 16 major as the available remediation.

Moderate findings, including the Anthropic SDK and Next.js/PostCSS chain, remain tracked but do not replace the zero-critical/high Phase 0 requirement.
