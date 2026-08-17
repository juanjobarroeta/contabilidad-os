# Rutinas de mantenimiento automático

Los prompts de las dos rutinas que convierten un error de Sentry en un Pull
Request. Están aquí en el repo —y no solo dentro de la configuración de la
rutina— por dos razones: para que se puedan revisar y mejorar como cualquier
otro código, y porque la rutina hay que crearla desde la UI.

## Por qué desde la UI y no por API

Una rutina creada programáticamente **no hereda los conectores MCP** de la
sesión que la creó. Sin conectores, la sesión que despierta cada 4 horas no
tiene las herramientas de Sentry (no puede leer los issues) ni las de GitHub
(no puede abrir el PR), o sea que no puede hacer nada de su trabajo.

La única forma de que una rutina tenga conectores es crearla desde
**claude.ai → Routines**, donde se le adjuntan explícitamente. Ahí hay que
marcar:

- **Sentry** — para leer issues, stack traces y comentar los hallazgos.
- **GitHub** — para abrir los PRs en draft.

Al crearlas, elegir que cada disparo **abra una sesión nueva** (no que continúe
una conversación existente), y activar las notificaciones push/email.

---

## Rutina 1 — `sentry-triage`

**Cadencia sugerida**: cada 4 horas (`0 */4 * * *`).
Rápida para cazar un mal deploy el mismo día, tranquila para no llenarte de PRs.

```text
Autonomous Sentry triage for the `cumplo-id` projects. Work through this end to end, then stop.

## Scope

Sentry org: `cumplo-id` (region `https://us.sentry.io`).

| Sentry project | Repo | PR base branch | What it is |
|---|---|---|---|
| `contabilidad-os` | `juanjobarroeta/contabilidad-os` | `main` | Next.js 15 hub on Railway. Accounting/fiscal SaaS for Mexico (CFDI, SAT, nómina, declaraciones). |
| `automotriz` | `juanjobarroeta/Automotriz` | `claude/car-dealership-erp-hjapfc` | React/Vite SPA satellite. No backend of its own — every call goes to the hub. |

**Read `docs/SENTRY.md` in contabilidad-os before anything else.** It explains how the two are wired, why the trace headers matter, and which failure modes are silent.

## Steps

1. For each project, list new unresolved production issues:
   `search_issues(organizationSlug='cumplo-id', projectSlugOrId=<slug>, query='is:unresolved is:for_review environment:production', period='24h', sort='freq')`

2. **Skip** an issue when any of these is true — do not spend tokens on it:
   - It matches known noise (see `IGNORED_ERRORS` in `src/lib/sentry-shared.ts` / `Automotriz/src/sentry.js`).
   - An open PR already references it (search the repo for the issue short-ID).
   - It already carries a triage comment from a previous run.
   - It affects a single user once and has no clear defect behind it.

3. For each remaining issue: `get_sentry_resource` for details and the stack trace, then find the code. If the root cause isn't obvious from the trace alone, use `analyze_issue_with_seer` — but only then; it is slow and costs quota.

4. Decide **honestly** whether you can fix it with confidence. A wrong fix in this codebase is worse than no fix.

5. If yes → branch `claude/sentry-fix-<issue-short-id>` off the base branch above, make the fix, run the repo's own checks (`npx tsc --noEmit` and `npx vitest run` for the hub, `npm run build` for the SPA), commit, push, and open a **draft** PR. Then comment the PR link on the Sentry issue.

6. If no → leave it alone and say why in your summary. That is a valid outcome, not a failure.

## Hard rules

- **Draft PRs only.** Never merge, never push to `main` or to any base branch.
- **One PR per issue.** Put the Sentry issue link in the PR body.
- **Never touch `prisma/migrations/`.** A migration already applied in production is immutable; fix forward with a new one only if a human asked.
- **Never make a test pass by deleting it, skipping it, or weakening its assertion.** If a test blocks you, the fix is wrong or the test found a real second bug.
- **Do not fix anything that touches billing, Stripe, IVA/ISR/fiscal calculation, timbrado, or nómina amounts.** Escalate it in the summary instead. A mis-"fixed" tax calculation is far more expensive than the original error.
- **Do not widen `IGNORED_ERRORS` to silence an issue.** Suppressing a real error is not triage.
- If the same issue comes back after a previous fix, say so plainly — a repeat means the first diagnosis was wrong.

## Reporting

Finish with a short summary: what you fixed (with PR links), what you skipped and why, and anything you escalated. If there was genuinely nothing to do, say exactly that in one line — do not manufacture work.
```

---

## Rutina 2 — `sentry-checkup`

**Cadencia sugerida**: lunes por la mañana (`0 15 * * 1` en UTC ≈ 9:00 en
CDMX).
Mira lo que el triage de 4 horas **no** ve: lo crónico en vez de lo nuevo.

```text
Weekly maintenance check-up for the `cumplo-id` projects. This is the slow, wide pass — the 4-hourly triage handles new issues, so do NOT duplicate it. Look for what a per-issue view misses.

Repos: `juanjobarroeta/contabilidad-os` (Next.js hub, base `main`), `juanjobarroeta/Automotriz` (React SPA, base `claude/car-dealership-erp-hjapfc`).
Sentry org: `cumplo-id`. Background: `docs/SENTRY.md`.

Cover these five, in order:

1. **Chronic issues.** `search_issues(..., query='is:unresolved', period='30d', sort='freq')`. Anything high-volume that nobody has touched in weeks. These are the ones everyone has learned to ignore — decide whether each is a real defect, and fix the top one or two if you're confident.

2. **Regressions since the last deploy.** Compare error volume by `release`. A rate that jumps on a specific release is the single most actionable signal available — name the release and the suspect commit.

3. **Silent instrumentation failures.** Verify traces are still crossing from `automotriz` into `contabilidad-os` (search for events sharing a trace across both projects). If they stopped, check `Access-Control-Allow-Headers` in `src/middleware.ts` first — dropping `sentry-trace`/`baggage` breaks correlation without breaking anything visible. Also confirm source maps are being uploaded: minified frames in recent production events mean `SENTRY_AUTH_TOKEN` is missing from the build env.

4. **Dependency health.** `npm audit` in both repos. Report real, reachable CVEs — do NOT open a mass-bump PR, and do not run `npm audit fix --force`.

5. **Suppression audit.** Read `IGNORED_ERRORS` in both repos. If a pattern is hiding something that turned out to be a genuine bug, say so. Suppression rules rot.

## Hard rules

Same as the triage routine: draft PRs only, never push to a base branch, never touch `prisma/migrations/`, never weaken a test to make it pass, and escalate rather than fix anything touching billing, Stripe, fiscal calculation, timbrado or nómina.

Report as a short digest. Ranked by what actually matters, not by what was easiest to find. If a week is quiet, a three-line "nothing needs attention, here's why" is the correct output.
```

---

## Notas para cuando se agreguen más satélites

El hub tiene varios satélites más (`purificadora`, `flotagob`, `RestauranteOS`,
`bartiz`, `theclubpadel`, `ZionX`…). Para sumar uno al ciclo:

1. Crear su proyecto en Sentry (`cumplo-id`, equipo `cumplo`).
2. Instrumentarlo igual que `Automotriz` — el patrón completo está en
   `Automotriz/src/sentry.js`; lo único que cambia es la DSN y que
   `tracePropagationTargets` apunte al hub.
3. Verificar que su origen esté en `API_ALLOWED_ORIGINS` del hub, o el
   preflight tirará los headers de traza.
4. Agregar su renglón a la tabla de las dos rutinas de arriba.
