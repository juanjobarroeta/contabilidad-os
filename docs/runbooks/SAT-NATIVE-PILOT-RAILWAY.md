# Supervised native SAT CE pilot on Railway

Status date: 2026-09-08
Pilot company: `SMP150917L69` — Soluciones de Movilidad Poblana
Environment: Railway `ContabilidadOS` / `production`
Scope: one read-only, metadata-only e.firma authentication POST

## Current state

As of 2026-09-08 15:39 America/Mexico_City:

- the production web service is healthy on commit `60dd85b0`; its finalized
  manifest uses `node scripts/deploy-db.mjs`. That separate release does not
  contain the SAT pilot migration or mandate UI;
- SMP is active and has all three e.firma fields stored with the encrypted
  `enc:v1` envelope;
- production does not yet have `SatNativePilotLease` or `SatNativePilotRun`;
- SMP has no acceptance of `MANDATO_EFIRMA` version `2026-09-08`;
- no SMP credential, signature, or customer data has been sent to SAT;
- the credential-free public SAT flow passed locally at 14:37 and 15:10; an
  intermediate check returned the redacted retryable state
  `PORTAL_UNAVAILABLE`. This is not a login and the Railway preflight must pass
  independently before signed mode.

The signed pilot is prohibited until every gate in this runbook is checked.

## Non-negotiable boundary

- One RFC only: `SMP150917L69`.
- One fresh run UUID and one signed POST only.
- Read-only metadata evidence only. Do not follow the first response redirect.
- Download nothing. File, amend, cancel, confirm, upload, or pay nothing.
- Do not solve, outsource, evade, or bypass a CAPTCHA, OTP, or other challenge.
  Stop as `NEEDS_USER_ACTION`.
- Never put a certificate, private key, e.firma password, cookie, SAT token,
  signed challenge, or response body in a variable, command, queue, log,
  screenshot, HAR, ticket, or source file.
- The worker may receive only database/encryption-key references and fixed
  operational selectors. It resolves the encrypted e.firma from Postgres and
  decrypts it only inside the purpose-scoped broker.
- Keep Syntage enabled. This pilot cannot replace it.

## Fixed Railway identifiers

```text
Project:          9c86ff0b-610d-4825-ade7-058ba119b201
Environment:      production
Web service:      f90843f4-0f56-4910-95eb-86015151f4bf
Postgres service: 2d21c92e-9117-4ca7-97a3-7b9498fb3799
Pilot service:    create later; record its returned ID here
```

Always use the pilot service's returned ID after creation. Do not rely on a
temporarily linked default service.

## Gate 1 — reviewed release and settled production

Required approval: explicit owner approval to merge/push and change production.
Local commit permission alone is not deployment permission.

1. Merge only the reviewed Phase 0 commits. Record the exact merge SHA.
2. Confirm the checkout used for deployment is clean:

   ```bash
   git status --porcelain
   git rev-parse HEAD
   ```

   The first command must print nothing. The SHA must be the reviewed release.

3. Confirm no production deployment is queued, building, initializing, or
   deploying:

   ```bash
   railway deployment list \
     --project 9c86ff0b-610d-4825-ade7-058ba119b201 \
     --environment production \
     --service f90843f4-0f56-4910-95eb-86015151f4bf \
     --limit 10 --json
   ```

4. After the web deployment completes, inspect its deployment manifest. It
   must be `SUCCESS` and its pre-deploy command must be exactly
   `node scripts/deploy-db.mjs`. Stop if it shows `prisma db push`.

## Gate 2 — additive migration

The web deployment, not the pilot worker, must apply
`20260908_sat_native_pilot_lease`. Connect read-only:

```bash
railway connect Postgres \
  --project 9c86ff0b-610d-4825-ade7-058ba119b201 \
  --environment production
```

Run:

```sql
SELECT migration_name, finished_at, rolled_back_at
FROM "_prisma_migrations"
WHERE migration_name = '20260908_sat_native_pilot_lease';

SELECT
  to_regclass('public."SatNativePilotLease"') AS lease_table,
  to_regclass('public."SatNativePilotRun"') AS run_table;
```

Required result: one finished, non-rolled-back migration and both relation
names present. Do not run a signed worker if either table is absent.

## Gate 3 — customer mandate

Required action: a real SMP `OWNER`, `ADMIN`, or `ACCOUNTANT` with unrestricted
or `CONTABILIDAD` access signs into the web app, opens the SMP company settings,
reads `/legal/mandato-efirma`, checks the box, and registers version
`2026-09-08`.

A `VIEWER`, platform-support access, bearer token, or vertical-only account
cannot accept for the customer. Do not fabricate or backfill acceptance in SQL.
The legal text is still a draft and requires Mexican counsel review before a
general rollout.

Verify without selecting credential values:

```sql
SELECT
  c.rfc,
  la.version,
  la.contexto,
  la."createdAt",
  la."userId"
FROM "Company" c
JOIN "LegalAcceptance" la ON la."companyId" = c.id
WHERE c.rfc = 'SMP150917L69'
  AND la.documento = 'MANDATO_EFIRMA'
  AND la.version = '2026-09-08'
ORDER BY la."createdAt" DESC;

SELECT
  c."isActive",
  c."fielCer" LIKE 'enc:v1:%' AS certificate_encrypted,
  c."fielKey" LIKE 'enc:v1:%' AS private_key_encrypted,
  c."fielPassword" LIKE 'enc:v1:%' AS password_encrypted
FROM "Company" c
WHERE c.rfc = 'SMP150917L69';
```

Required result: at least one current mandate, an active company, and three
`true` encryption checks.

## Gate 4 — create the isolated one-shot service

Required approval: explicit owner approval to create/configure a production
Railway service. Do not connect it to GitHub; use a clean local upload of the
reviewed commit so a later push cannot trigger another run.

Railway no longer allows a new service to opt into `railway.json`. The pilot
therefore uses `Dockerfile.sat-native-pilot`, which pins the multi-platform Node
`22.23.2-bookworm` image by digest and performs no mutable OS package install.
Its final runtime installs only the SAT credential parser, Prisma client, and
TypeScript runner; the lockfile-pinned Prisma CLI is confined to a separate
client-generation stage and absent from the runtime image. The production
dependency audit must pass before the image is emitted. The
Dockerfile-specific ignore file is default-deny and exposes only the exact build
inputs. The existing web service's legacy
`railway.json` migration remains separate work under `OPS-004`.

1. Verify the CLI is exactly `railway 5.49.6` and linked to the exact project and
   `production` environment. Any CLI update requires re-review of the trigger
   and disarm semantics.
2. Create an empty service with the exact name `sat-native-pilot` and copy its
   returned ID without shell substitution:

   ```bash
   railway add --service sat-native-pilot --json
   ```

3. Before its first deployment, set only these non-secret variables. Do not add
   a database URL or encryption key; disabled mode and public preflight require
   neither. Replace every `REPLACE_WITH_*` token before executing a command:

   ```bash
   railway variable set \
     RAILWAY_DOCKERFILE_PATH=Dockerfile.sat-native-pilot \
     SAT_NATIVE_PILOT_ACTION=DISABLED \
     SAT_NATIVE_PILOT_ENABLED=false \
     --skip-deploys \
     --project 9c86ff0b-610d-4825-ade7-058ba119b201 \
     --environment production \
     --service REPLACE_WITH_PILOT_SERVICE_ID
   ```

4. In Railway service settings, before deployment:

   - set restart policy to **Never**;
   - set exactly one replica in `us-east4-eqdc4a`, matching the web service;
   - leave Cron Schedule empty;
   - leave public networking/domain disabled;
   - leave healthcheck and pre-deploy command empty;
   - leave GitHub source disconnected.

5. Build a clean upload bundle from the reviewed commit. `git archive` includes
   only files tracked by that commit, so ignored or untracked local e.firma
   files cannot enter the upload. First create an empty directory and copy the
   printed path into the second command:

   ```bash
   mktemp -d

   git archive REPLACE_WITH_REVIEWED_COMMIT_SHA \
     | tar -x -C REPLACE_WITH_EMPTY_BUNDLE_DIRECTORY

   find REPLACE_WITH_EMPTY_BUNDLE_DIRECTORY -type f \
     \( -iname '*.cer' -o -iname '*.key' -o -iname '*.pem' \
        -o -iname '*.der' -o -iname '*.pfx' -o -iname '*.p12' \) \
     -print
   ```

   The `find` command must print nothing. Confirm the bundle contains
   `Dockerfile.sat-native-pilot.dockerignore`.

6. Deploy that bundle once in inert mode:

   ```bash
   railway up REPLACE_WITH_EMPTY_BUNDLE_DIRECTORY \
     --path-as-root --detach --yes \
     --message "SAT native pilot image REPLACE_WITH_REVIEWED_COMMIT_SHA" \
     --project 9c86ff0b-610d-4825-ade7-058ba119b201 \
     --environment production \
     --service REPLACE_WITH_PILOT_SERVICE_ID
   ```

7. Capture the new deployment ID, then inspect that exact manifest and its logs:

   ```bash
   railway deployment list \
     --project 9c86ff0b-610d-4825-ade7-058ba119b201 \
     --environment production \
     --service REPLACE_WITH_PILOT_SERVICE_ID \
     --limit 1 --json

   railway logs REPLACE_WITH_INERT_DEPLOYMENT_ID --lines 100 \
     --project 9c86ff0b-610d-4825-ade7-058ba119b201 \
     --environment production \
     --service REPLACE_WITH_PILOT_SERVICE_ID
   ```

Required manifest: the custom Dockerfile, one replica, restart `NEVER`, no
cron, no pre-deploy command, and no public domain. Required application output:

```json
{"state":"DISABLED","credentialUsed":false,"authenticated":false}
```

Stop if any setting differs.

## Gate 5 — Railway public preflight

This step contacts only public SAT login pages. It sends no RFC, customer data,
certificate, key, password, or signature. The service must still have blank
`DATABASE_URL` and `CREDENTIALS_ENCRYPTION_KEY` values.

```bash
railway variable set \
  SAT_NATIVE_PILOT_ACTION=PUBLIC_PREFLIGHT \
  SAT_NATIVE_PILOT_ENABLED=false \
  --project 9c86ff0b-610d-4825-ade7-058ba119b201 \
  --environment production \
  --service REPLACE_WITH_PILOT_SERVICE_ID
```

The single variable update triggers the preflight deployment. Immediately
restore the inert selector without starting another deployment:

```bash
railway variable set \
  SAT_NATIVE_PILOT_ACTION=DISABLED \
  SAT_NATIVE_PILOT_ENABLED=false \
  --skip-deploys \
  --project 9c86ff0b-610d-4825-ade7-058ba119b201 \
  --environment production \
  --service REPLACE_WITH_PILOT_SERVICE_ID
```

Compare the deployment list with the inert deployment, capture exactly one new
ID, and read bounded logs only for that ID:

```bash
railway logs REPLACE_WITH_PREFLIGHT_DEPLOYMENT_ID --lines 100 \
  --project 9c86ff0b-610d-4825-ade7-058ba119b201 \
  --environment production \
  --service REPLACE_WITH_PILOT_SERVICE_ID
```

Required value:
`state=READY_FOR_AUTHORIZATION`, `credentialUsed=false`, and
`authenticated=false`. A successful preflight is not a successful login. Keep
the exact preflight deployment ID for Gate 7.

## Gate 6 — action-time confirmation

All prior authorizations are necessary but do not replace this final
confirmation. Immediately before configuring signed mode, ask the owner:

> Do you explicitly authorize one supervised read-only e.firma login probe for
> SMP150917L69 that will decrypt SMP's stored .cer/.key/password in memory,
> send exactly one signed authentication POST to the allowlisted SAT e.firma
> origin over SAT's acknowledged 1024-bit-DHE TLS compatibility path, not
> follow its redirect, download nothing, file/change nothing, and destroy
> cookies/transient material afterward? Reply yes.

Proceed only after an unambiguous `yes` in the active task. Record the task and
timestamp. Do not reuse an earlier generic authorization.

Select an existing platform operator; do not create or promote one for this
run. Verify the ID read-only and do not paste the returned email elsewhere:

```sql
SELECT id, email
FROM "User"
WHERE "esOperador" IS TRUE
ORDER BY "createdAt";
```

Generate one fresh lowercase UUID and copy it separately:

```bash
uuidgen | tr '[:upper:]' '[:lower:]'
```

Do not put UUID generation or database lookups inside the deployment command.

## Gate 7 — exactly one signed POST

Recheck Gates 1–6 and confirm the worker's last deployment is terminal. From the
clean reviewed checkout, run the reviewed trigger with the values copied during
Gate 6:

```bash
./scripts/railway-sat-native-first-post.sh \
  REPLACE_WITH_PILOT_SERVICE_ID \
  REPLACE_WITH_SUCCESSFUL_PREFLIGHT_DEPLOYMENT_ID \
  REPLACE_WITH_VERIFIED_OPERATOR_USER_ID \
  REPLACE_WITH_FRESH_LOWERCASE_UUID \
  ONE_SMP_SIGNED_POST_AUTHORIZED
```

The trigger performs one Railway variable-collection update that adds the
database/key references and exact signed selectors and triggers the deployment.
Before any mutation, it requires the supplied ID to resolve uniquely to the
production service named `sat-native-pilot` and explicitly rejects the known
web and Postgres IDs. It also requires the supplied preflight deployment to be
the latest `SUCCESS` and refuses while any recent pilot deployment is active.
Any deployment status outside the reviewed terminal allowlist also refuses.
It then immediately blanks both secret references and every signed selector
with `--skip-deploys`, including when the trigger command reports an error or is
interrupted. It never calls `redeploy` or retries. The Dockerfile declares no
matching `ARG`, so those runtime values are not exposed to Docker build steps.

The trigger compares deployment IDs from before and after the update. Exactly
one new deployment ID must be printed. That ID is the only deployment bound to
this authorization. If zero or multiple IDs are reported, signed mode is still
disarmed: inspect every reported ID and do not retry without a fresh UUID and a
new action-time approval.

Inspect status and bounded logs using only the captured ID:

```bash
railway deployment list \
  --project 9c86ff0b-610d-4825-ade7-058ba119b201 \
  --environment production \
  --service REPLACE_WITH_PILOT_SERVICE_ID \
  --limit 20 --json

railway logs REPLACE_WITH_CAPTURED_SIGNED_DEPLOYMENT_ID --lines 100 \
  --project 9c86ff0b-610d-4825-ade7-058ba119b201 \
  --environment production \
  --service REPLACE_WITH_PILOT_SERVICE_ID
```

Do not call `restart`, `redeploy`, rerun the trigger, or retry a failed command.
Restart policy `NEVER`, immediate configuration disarm, the per-company lease,
and the append-only run UUID are independent replay controls.

The only successful evidence outcome at this stage is:

```text
ok=true
state=FIRST_REDIRECT_OBSERVED
credentialUsed=true
authenticated=false
```

This proves only that SAT returned a bounded first redirect after the signed
POST. It does not prove authentication. The code deliberately does not follow
that redirect.

`NEEDS_USER_ACTION`, `AUTH_REJECTED`, `EFIRMA_EXPIRED`,
`PORTAL_CONTRACT_CHANGED`, `ACCESS_DENIED`, and `NOT_CONFIGURED` are terminal.
Do not retry. `PORTAL_UNAVAILABLE` and `RATE_LIMITED` are technically retryable
errors, but this one-shot pilot still requires a new run UUID and a new explicit
action-time approval before another attempt.

## Gate 8 — disable and verify

The trigger already disarms the service before it returns. After the captured
worker is terminal, apply the same idempotent blank configuration again without
deploying:

```bash
railway variable set \
  SAT_NATIVE_PILOT_ACTION=DISABLED \
  SAT_NATIVE_PILOT_ENABLED=false \
  'SAT_NATIVE_PILOT_RFC=' \
  'SAT_NATIVE_PILOT_OPERATOR_USER_ID=' \
  'SAT_NATIVE_PILOT_RUN_ID=' \
  'SAT_NATIVE_PILOT_ACKNOWLEDGEMENT=' \
  'SAT_NATIVE_PILOT_EXECUTION_SCOPE=' \
  'DATABASE_URL=' \
  'CREDENTIALS_ENCRYPTION_KEY=' \
  --skip-deploys \
  --project 9c86ff0b-610d-4825-ade7-058ba119b201 \
  --environment production \
  --service REPLACE_WITH_PILOT_SERVICE_ID
```

Verify the exact copied run UUID:

```sql
SELECT
  r."runId",
  c.rfc,
  r.status,
  r."outcomeCode",
  r."startedAt",
  r."finishedAt"
FROM "SatNativePilotRun" r
JOIN "Company" c ON c.id = r."companyId"
WHERE r."runId" = 'REPLACE_WITH_FRESH_LOWERCASE_UUID';

SELECT
  l."runId",
  l.status,
  l."outcomeCode",
  l."acquiredAt",
  l."releasedAt",
  l."expiresAt"
FROM "SatNativePilotLease" l
WHERE l."runId" = 'REPLACE_WITH_FRESH_LOWERCASE_UUID';

SELECT accion, "createdAt", detalle->>'runId' AS run_id,
       detalle->>'outcomeCode' AS outcome_code
FROM "AuditLog"
WHERE accion IN (
  'sat-native.fiel-use-started',
  'sat-native.fiel-use-finished',
  'sat-native.fiel-use-expired'
)
  AND detalle->>'runId' = 'REPLACE_WITH_FRESH_LOWERCASE_UUID'
ORDER BY "createdAt";
```

Expected: one terminal run, a released lease, and one start plus one finish
audit. The records must contain operational metadata only.

## Stop and rollback

- If any gate fails, leave the worker disabled and investigate offline.
- Do not drop the additive pilot tables or delete audit/run evidence.
- Do not alter SMP credentials or mandate evidence.
- Leave the web mandate UI in place.
- Leave Syntage active.
- Removing the empty pilot service is optional and needs explicit destructive
  approval. Keeping it with blank database/key references and disabled action
  is inert.
- Following the first redirect, mapping an authenticated RFC marker, listing CE
  records, and downloading any artifact are separate reviewed changes with new
  authorization.

## Railway references

- [Infrastructure as Code and Config-as-Code cutoff](https://docs.railway.com/infrastructure-as-code)
- [Custom Dockerfile path](https://docs.railway.com/builds/dockerfiles)
- [Reference and sealed variables](https://docs.railway.com/variables)
- [Restart policy](https://docs.railway.com/deployments/restart-policy)
- [Deployment actions](https://docs.railway.com/deployments/deployment-actions)
