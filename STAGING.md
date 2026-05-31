# Staging environment & how to test PRs before production

Production deploys from the `main` branch on Railway. To test a PR **before** it
reaches `main` (and therefore production), use a dedicated **staging** Railway
environment with its **own database**. This is the safe place to exercise
anything that talks to live external services — like the SAT Descarga Masiva
sync, which needs a real FIEL and cannot be meaningfully mocked.

> ⚠️ Never point staging at the production database. Staging gets its own
> Postgres so test syncs, onboarding, and `prisma db push` can't touch real data.

---

## One-time setup (Railway dashboard)

1. **Create the environment.** In the Railway project → environment switcher →
   **New Environment** → duplicate from `production` (copies services + variable
   names). Name it `staging`.

2. **Give it its own Postgres.** In the `staging` environment, add a **new
   Postgres** plugin. Railway injects its connection string as `DATABASE_URL`
   into the app service automatically. Make sure the app service in staging is
   using *that* database, not production's.

3. **Point staging at the branch.** App service → **Settings → Deploy → Source**
   → set the deploy branch to the PR branch (e.g.
   `claude/automate-sat-factura-downloads-a802D`) or to a long-lived `staging`
   branch you merge PRs into for testing.

4. **Auto-apply schema on deploy.** This repo has **no Prisma migrations** — it
   uses `prisma db push`. So new columns won't exist in staging until pushed.
   Set a **Pre-Deploy Command** (App service → Settings → Deploy):
   ```
   npx prisma db push
   ```
   This keeps the staging DB schema in sync on every deploy automatically. (Do
   NOT enable this on production without care — `db push` can be destructive on
   column renames/drops. The current PR is purely additive, so it's safe.)

5. **Set the staging variables** (see checklist below). Use *separate*
   values from production — sandbox keys, a distinct `CRON_SECRET`, etc.

6. **Deploy.** Trigger a deploy of the branch. Build runs `next build` (Prisma
   client auto-generates on `npm install`), the pre-deploy command runs
   `prisma db push`, then the app starts.

### Railway CLI alternative

```bash
railway environment staging          # switch to the staging env
railway variables --set CRON_SECRET=... --set ANTHROPIC_API_KEY=...
railway run npm run db:push          # one-off schema push against staging DB
railway up                           # deploy current branch
```

---

## Environment variable checklist

| Variable | Required | Notes (staging) |
|---|---|---|
| `DATABASE_URL` | ✅ | Auto-injected by the staging Postgres plugin. Must be the **staging** DB. |
| `NEXTAUTH_SECRET` / `AUTH_SECRET` | ✅ | `openssl rand -base64 32`. NextAuth v5 reads `AUTH_SECRET`; older refs read `NEXTAUTH_SECRET` — set both to the same value. |
| `NEXTAUTH_URL` | ✅ | The staging app URL, e.g. `https://contabilidad-os-staging.up.railway.app`. |
| `ANTHROPIC_API_KEY` | ✅ | Needed for CSF/document parsing during onboarding. |
| `FACTURAPI_SECRET_KEY` | ✅ | Use a **sandbox** `sk_test_...` key in staging. |
| `FACTURAPI_MASTER_KEY` | ⬜ | Only if auto-provisioning Facturapi orgs in staging. |
| `CRON_SECRET` | ✅ (for cron) | Distinct from prod. The `/api/cron/sat-sync` endpoint returns 401 until this is set. |
| `API_ALLOWED_ORIGINS` | ⬜ | CORS allowlist for the satellite/bearer API; not needed to test the web app or cron. |
| `BELVO_SECRET_ID` / `BELVO_SECRET_PASSWORD` / `BELVO_ENV` | ⬜ | Open-banking (Module 4); leave unset unless testing it. |
| `UMA_DIARIO` | ⬜ | Payroll/IMSS constant; set if testing nómina. |
| `NEXT_PUBLIC_BARTIZ_URL` | ⬜ | Satellite app link; cosmetic. |

---

## Testing this PR (automatic SAT sync) on staging

After the branch is deployed to staging with `DATABASE_URL`, `CRON_SECRET`, and
the schema pushed:

1. **Onboard a test company with a real FIEL.** Open the staging URL → onboarding
   → upload a Constancia de Situación Fiscal + the `.cer`/`.key` FIEL files and
   password. (Confirm in the DB that `fechaInicioOperaciones` got populated from
   the CSF.)

2. **Verify the refactor didn't change the manual flow.** Go to *Impuestos* and
   click **"Sincronizar CFDIs del SAT"**. It should submit + import exactly as
   before — this proves the extraction into `src/lib/sat-sync.ts` is behavior-
   preserving.

3. **Trigger the cron manually** (controlled scope, current month only):
   ```bash
   curl -X POST "https://<staging-app>.up.railway.app/api/cron/sat-sync?months=1" \
     -H "x-cron-secret: $CRON_SECRET"
   ```
   Inspect the JSON summary:
   ```json
   { "ok": true, "companiesEligible": 1, "companiesProcessed": 1,
     "monthsBack": 1, "submitted": 2, "imported": 12, "errors": [], "elapsedMs": 8423 }
   ```
   - `companiesEligible` counts active companies with `autoSyncEnabled` + a FIEL.
   - SAT is asynchronous: the first call usually `submits` requests; run the curl
     again a few minutes later to see `imported` climb as SAT finishes packages.
   - It only **reads** from SAT and **inserts** invoices (deduped by UUID) — it
     never deletes/overwrites, so it's safe to re-run.

4. **Schedule it** (optional, to test the unattended path): add a **Railway Cron**
   service in the staging env that hits the same URL with the secret header,
   e.g. twice daily. Confirm `lastAutoSyncAt` updates on the company.

---

## When it's verified

Once staging looks good, merge the PR to `main` → production auto-deploys. Then
on production: run `prisma db push` (or set the same pre-deploy command), set the
production `CRON_SECRET`, and add the production Railway Cron trigger.
