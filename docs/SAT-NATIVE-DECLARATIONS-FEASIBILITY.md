# Native SAT retrieval for declarations and electronic accounting

Status date: 2026-09-08
Scope: read-only retrieval. No filing, submission, CAPTCHA bypass, or live-account testing.

## Decision

Build the native SAT reader, but do not cancel Syntage yet.

The viable product is a read-only, e.firma-authenticated retrieval service for declaration history, declaration documents, and CE submission/receipt consultation. It should run behind the provider boundaries already present in ContabilidadOS and shadow Syntage before taking traffic. SAT's official service catalog places CE submission and **Consulta de acuses de envío de contabilidad electrónica** under **Buzón Tributario**; the native driver must enter through that supported Buzón surface and treat any downstream CE application only as part of that flow.

A complete Syntage replacement is not proven until a controlled pilot answers one critical question: does the Buzón CE consultation expose the original submitted CT/B/PL XML and digital-seal XML, or only the receipt and submission metadata? The official SAT material supports consultation of acuses, not a guarantee that it will return the originally submitted payload. An acuse, its status, folio, timestamps, and submission metadata are evidence *about* a submission; they are not the original XML that was submitted. ContabilidadOS currently uses Syntage's original CE XML to create the opening chart, opening balance, and historical `CeBalanzaMes` series. Receipt/metadata-only access is therefore a pilot blocker for replacing that historical CE function.

## What can be replaced

| Source used today                              | Native path                                                                                                                                                                        |      Confidence | Remaining proof                                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------: | ---------------------------------------------------------------------------------------------------- |
| CFDI XML and metadata                          | Official SAT Descarga Masiva web service; already implemented in `src/lib/sat-sync.ts`                                                                                             |            High | None for this project                                                                                |
| Monthly and annual declaration index           | Declaraciones y Pagos portal, which includes searches by return, year, period, operation number, and capture line                                                                  |     Medium-high | Map current PF/PM/regime application variants and pagination                                         |
| Declaration receipt/PDF                        | Declaraciones y Pagos queries and SAT reprint service                                                                                                                              |     Medium-high | Confirm which artifact is returned: full transcript, short receipt, attachments, and complementaries |
| CE submission index and status                 | **Buzón Tributario** → Trámites → Contabilidad electrónica → Consulta de acuses; query criteria include periodicity, year, month range, reason, file type, status, and submission type |            High | Map redirects, requests, and pagination from a real authorized session                               |
| CE receipt and submission metadata             | Buzón CE receipt consultation produces an acuse/status record, not proven original payload                                                                                       |            High | Map receipt download and final accepted/rejected state                                               |
| Original submitted CE XML and digital-seal XML | No official public recovery guarantee found from the Buzón CE consultation                                                                                                       | Unknown/blocker | Prove in the pilot; if absent, retain Syntage for historical CE or require source-system XML/import  |
| SAT opinion 32-D and CSF                       | Official portals; both are separate Syntage dependencies in this repository                                                                                                        |          Medium | Separate native-provider work is required before the Syntage contract can be removed                 |

The production Syntage cadence currently provisions four recurring extractors—`tax_compliance`, `tax_status`, `annual_tax_return`, and `monthly_tax_return`—plus a one-time/retried `electronic_accounting` bootstrap. Replacing only declarations and CE may reduce extraction consumption, but it does not eliminate the contract while opinion/CSF remain dependent on Syntage.

## Buzón Tributario and CAPTCHA finding

The user's recollection about CE is correct. SAT's current official Buzón Tributario catalog lists both **Envío de contabilidad electrónica** and **Consulta de acuses de envío de contabilidad electrónica**. Rule 2.8.1.6 of the 2026 RMF also names Buzón Tributario as an official CE delivery route. SAT publishes a public deep-link page for the receipt query as well. These are two entry points into the same taxpayer service, not evidence of two different CE data stores. The pilot should start at Buzón Tributario and record its authorized redirect chain instead of assuming that an old deep link will remain stable.

The suspected reCAPTCHA v3 is not what the current login pages expose.

Anonymous inspection on 2026-09-07 found:

- Declaraciones y Pagos redirects to the `loginda.siat.sat.gob.mx` WS-Federation realm. Its RFC/password form displays a generated image CAPTCHA. The page did not load `recaptcha` or `grecaptcha` code.
- The public CE deep link currently redirects toward a `login.siat.sat.gob.mx` Liberty/NetIQ authentication realm. Its RFC/password form also displays a generated image CAPTCHA. This downstream realm does not change the fact that SAT catalogs the CE service under Buzón Tributario.
- In both realms, selecting **e.firma** changes the page to `.cer`, `.key`, private-key password, and RFC fields. No CAPTCHA is visible and no reCAPTCHA library was detected in that view.
- The e.firma page signs a client-side challenge and posts realm-specific hidden fields. A CAPTCHA-free screen is not a supported API and can change without notice.

Therefore, the first implementation should use e.firma and must not build a CAPTCHA solver. If the SAT later presents a CAPTCHA or OTP, the job must stop in `NEEDS_USER_ACTION` and hand the session to an authorized user. Do not outsource, bypass, or evade the challenge.

The applications do not share a proven universal session. Authentication and cookies must be isolated per SAT realm. A shared login abstraction can coordinate them, but Buzón/CE and Declaraciones each need their own tested driver. A redirect into another SAT subdomain must remain inside the same ephemeral CE job and must pass a strict domain-and-route allowlist.

## Current repository state

ContabilidadOS is materially ahead of a greenfield implementation:

- `src/lib/sat-fiel.ts` validates and loads each company's e.firma.
- `src/lib/sat-sync.ts` already runs the official, session-free Descarga Masiva workflow with request reuse, polling, retry semantics, and persistent job state.
- `src/lib/fiscal/acuse/parse.ts` and the declaration APIs already parse and retain uploaded/Syntage PDFs.
- `src/lib/contabilidad/ce-import-syntage.ts` and `src/lib/contabilidad/ce-serie.ts` already identify and import CT/B XML content.
- `src/lib/fiscal/cumplimiento/provider.ts` already anticipates an in-house portal provider.
- `scripts/recon-sat-portal.ts` contains an authorized, read-only Playwright reconnaissance flow; repository history records successful e.firma authentication against SAT in August 2026.

The native portal client is not production-ready:

- `src/lib/sat-portal/session.ts` is intentionally disabled with `CAPTURA_LISTA = false` and has no caller.
- `src/lib/sat-portal/auth.ts` is covered by synthetic offline tests, not a current redacted SAT fixture contract.
- The current SAT e.firma page uses a client-side envelope containing a realm token, RFC, certificate serial number, signature, and additional hidden fields. The existing generic `tokenValue` request model is not sufficient evidence of a complete live HTTP login.
- No declaration-list, declaration-download, CE-list, or CE-download native adapters exist.

## Recommended architecture

```text
Scheduler/API
    -> bounded, rate-adaptive queue: Declaraciones | Buzón/CE
        -> SatReadSync lease + idempotency + per-RFC lock
            -> credential vault (purpose-scoped, audited use)
            -> realm driver: Declaraciones | Buzón entry + CE redirects
                -> one ephemeral isolated browser process per active job
                -> allowlisted login/query/download actions only
            -> artifact normalizer
                -> declaration index + original PDF/XLSX when available
                -> CE submission index + receipt + original XML when available
            -> encrypted object storage + SHA-256 + provenance
            -> existing TaxDeclaration / ComplianceSnapshot / CE importers
```

Implementation rules:

1. Define a provider contract before portal code: `listDeclarations`, `downloadDeclarationArtifact`, `listElectronicAccounting`, and `downloadElectronicAccountingArtifact`. Preserve Syntage and native implementations behind the same normalized output. The contract must expose `originalSubmittedXml: UNVERIFIED` until the pilot proves availability.
2. Start with a controlled headless-browser driver because SAT performs e.firma processing in client JavaScript and uses different federation protocols per application. Replace browser steps with a typed HTTP client only after redacted HAR fixtures prove every request, cookie, redirect, and anti-CSRF field.
3. Use one ephemeral browser context per company/job. Never persist cookies, browser profiles, decrypted keys, passwords, screenshots, or raw HAR files in production.
4. Restrict navigation to an explicit SAT domain/route allowlist. Query forms may require POST, but the driver must have no method capable of clicking or calling filing, confirmation, amendment, cancellation, or payment actions.
5. Persist immutable artifact metadata: company, source, SAT folio/operation, return/submission type, period, presented time, status, original filename/MIME type, SHA-256, fetched time, driver version, and source URL category. Deduplicate by SAT identity, not filename.
6. Store original documents in encrypted object storage. Keep only references and extracted fields in Postgres; the current `bytea` declaration storage should not become the long-term archive.
7. Treat portal maintenance, DOM drift, rejected credentials, expired e.firma, missing artifact, and genuine zero results as different states. Never convert an exception into “no declarations.”
8. Maintain redacted fixture tests and an owned-RFC canary. Disable the adapter with a circuit breaker when the page contract changes.
9. Do not use stealth plugins, CAPTCHA farms, rotating proxies, or fingerprint evasion. If a normal authorized session is blocked from Railway infrastructure, use an accountant-controlled local bridge or keep the provider instead of attempting to evade SAT controls.

### Capacity model for approximately 1,000 companies

Use queueing, not one cron invocation that opens 1,000 sessions:

- Create separate bounded queues for Declaraciones and Buzón/CE so a failure or maintenance window in one surface does not consume all capacity. Each queue has a finite depth, a dead-letter limit, and a bounded in-flight count.
- Acquire a lease-backed lock keyed by RFC before a job starts; release it on completion or lease expiry. A company may have more than one local record over time, so company-id locking alone is insufficient. Do not run concurrent e.firma sessions for the same RFC.
- Start with a global concurrency of 4–8 and a hard ceiling of 24 workers, with a smaller independent ceiling per SAT surface. Use a rate-adaptive controller: increase one worker at a time only after sustained successful canary/list/download windows; immediately reduce the affected surface on `RATE_LIMITED`, `PORTAL_UNAVAILABLE`, elevated latency, or contract-change signals. The ceiling is a safety boundary, not a target request rate.
- Apply tenant-fair scheduling, per-RFC cooldowns, and deterministic jitter over the allowed sync window. Reserve a small pool for user-requested refreshes so a backfill cannot starve interactive work.
- Lease jobs with heartbeats and checkpoint after login, listing, and each immutable download. A lost lease may resume only from the last idempotent checkpoint.
- Retry only `PORTAL_UNAVAILABLE` and `RATE_LIMITED`, with exponential backoff, jitter, and a finite attempt/dead-letter limit. `AUTH_REJECTED`, `EFIRMA_EXPIRED`, `NEEDS_USER_ACTION`, `PORTAL_CONTRACT_CHANGED`, and invalid artifacts are terminal until a user or operator intervenes. CAPTCHA, OTP, unexpected confirmation, or any new interactive challenge maps to `NEEDS_USER_ACTION`; no solver, bypass, proxy rotation, or stealth behavior is permitted.
- Add a circuit breaker per portal surface and driver version. A failed owned-RFC canary or a cluster of contract-change failures must pause new jobs before all 1,000 companies are attempted.
- Queue only opaque company and sync-run identifiers. Resolve the e.firma inside the worker; never put RFCs, passwords, `.key`, `.cer`, cookies, or signed challenges in queue payloads.

At a conservative ten minutes per full job, 20 workers can process about 120 jobs/hour before retry and maintenance overhead, so a 1,000-company catch-up is roughly one workday. Normal monthly retrieval should be spread across days; tens of workers are useful for controlled backfills and outage recovery, not for hitting SAT continuously. Measure login duration, page count, download count, peak resident memory, failure class, and queue lag during the pilot before choosing the steady-state fleet.

### Railway deployment boundary

Do not run Chromium inside a Next.js request handler. Create a separate Railway worker service with an asynchronous database/queue contract, pinned browser/runtime versions, bounded concurrency, and enough memory for isolated browser contexts. The existing `railway.json` starts only the Next.js server, and Playwright is currently a development dependency with no browser-install step, so the deployed service is not ready to execute this driver.

The worker must be restart-safe: claim a sync run, write checkpoints after list/download steps, and resume idempotently after a Railway restart. Keep credential values out of the queue. Load them only inside the worker from the vault, preferably into memory-backed file payloads, and destroy the browser context immediately after the job. A browser-as-a-service would send the e.firma to another vendor and would defeat part of the reason for replacing Syntage.

## Security and legal gates

Production use must wait for the credential-vault Phase 0 work already listed in `docs/security/PLAN.md`:

- all e.firma decryption through one purpose-scoped vault;
- an audit event for every credential use;
- per-company/per-field authenticated encryption rather than the current single-key envelope without AAD;
- no legacy plaintext pass-through;
- strict log/Sentry redaction;
- documented revocation and incident response;
- worker isolation and zero credential material in job payloads.

Removing Syntage has one security benefit: the application stops exporting the complete e.firma to that third party. It does not remove ContabilidadOS's own custody risk. SAT's e.firma terms make the holder responsible for the private key and attribute signed actions to it. A read-only driver must still obtain written customer authorization, document scope and retention, and undergo Mexican privacy/security and contractual review. This is not a conclusion that authorized portal automation is unlawful; it is a requirement to validate the operating model because SAT publishes no integration contract or SLA for these portal flows.

## Staged build plan

### Stage A — evidence spike, 3–5 engineering days

- Use exactly one explicitly authorized pilot company, with a fixed fiscal-period window and known declaration/CE history. Keep the RFC in operator-controlled configuration outside source control; never accept the allowlist from a web request.
- Authenticate with that RFC's e.firma in a supervised session. Start CE at the official Buzón Tributario entry, navigate to Trámites → Contabilidad electrónica → Consultas, and capture its SAT-only redirect chain.
- Permit only authentication, list/query, and artifact download routes. Any unexpected host, upload/submission route, CAPTCHA, OTP, confirmation, payment, filing, cancellation, or amendment state stops as `NEEDS_USER_ACTION` or `PORTAL_CONTRACT_CHANGED`; it is never clicked through automatically.
- Redact cookies, tokens, RFCs, certificate material, and document contents before deriving fixtures; never commit the raw HAR.
- Produce an artifact inventory for one monthly return, one annual return, one complementary return, one CE catalog, and one CE balance.
- Decide the CE blocker: original XML available or receipt-only.

Exit gate: documented request/response contract and zero unresolved sensitive data in fixtures.

Current implementation boundary: `src/lib/fiscal/cumplimiento/sat-native/pilot.ts` is disabled by default, requires a separate operator policy naming one authorized RFC, and passes only a read-only metadata request to an injected future Buzón adapter. The policy can be loaded from strict worker environment variables; only the literal value `SAT_NATIVE_PILOT_ENABLED=true` enables it. The selected target is stored in ignored local operator configuration with the switch still disabled, and its RFC is deliberately absent from the native-SAT source and tracked pilot configuration. The boundary cannot carry e.firma material, browser state, cookies, artifacts, URLs, or raw portal responses. It is deliberately not wired to `getFielForCompany` or `abrirSesionSat`.

The remaining blocker before a supervised probe is intentional: `getFielForCompany` directly decrypts the three stored credential fields rather than using the required purpose-scoped/audited vault, while `abrirSesionSat` remains hard-disabled (`CAPTURA_LISTA = false`) and has no redacted Buzón/CE fixture contract. A live adapter must not be added until a vault-backed signer boundary, a SAT-only route allowlist, redacted fixtures, and an explicit operator-run worker launch gate exist.

### Stage B — provider and declarations MVP, 2–3 weeks

- Add native provider contracts, sync-run state, idempotency, and error taxonomy.
- Implement e.firma login independently for the Declaraciones realm.
- Fetch a bounded period, enumerate normal/complementary returns, download every available original artifact, hash it, and feed existing parsers.
- Add offline fixture tests and one manual canary; no unattended customer rollout.

Exit gate: exact declaration count, operation number, period, presentation date, type, and document parity against manual SAT review.

### Stage C — CE reader, 1–2 weeks

- Implement the separate CE realm and criteria query.
- Download receipt/status artifacts and, if SAT exposes them, the original CT/B/PL and seal XML.
- Reuse the existing content-based CE document selection and importers.
- If original XML is unavailable, define the migration boundary explicitly: native covers future receipts/status; source-system export or Syntage covers historical ledger bootstrap.

Exit gate: accepted/rejected status parity and a proven answer on original XML recovery.

### Stage D — hardening and shadow mode, 4 weeks

- Run native and Syntage in parallel for 10–20 authorized RFCs covering PF/PM, multiple regimes, normal/complementary returns, CE/no-CE, and expired/rotated e.firma.
- Add bounded concurrency, backoff, circuit breaking, maintenance windows, metrics, alerting, and an operator replay path.
- Measure intervention rate, artifact parity, latency, memory, and monthly operating cost.

Exit gate: at least 99% artifact parity by SAT folio/operation, 100% complementary-return detection in the sample, no false “empty” results, at least 98% successful scheduled runs excluding confirmed SAT outages/invalid credentials, and less than 2% manual intervention over four weeks.

### Stage E — progressive cutover

- Roll out per firm behind a feature flag.
- Keep Syntage as a fallback/on-demand source for at least one filing cycle.
- Cancel or downgrade only after native opinion/CSF coverage is also complete and the CE payload question is resolved.

Estimated delivery: 6–10 engineering weeks plus the four-week shadow period. The lower end assumes stable pages and original CE XML access; the upper end assumes multiple declaration application variants and additional user-assisted challenge handling.

## Cost and build/buy recommendation

The current Syntage rate card starts at MXN7,500/month for 25 unique entities and 400 extractions: MXN300 per entity at full utilization before any other product costs. That is MXN90,000/year at the minimum tier. Larger listed tiers reduce the per-entity rate but increase the annual fixed commitment.

Native portal compute and storage should be lower than that at modest monthly frequency. The economic risk is engineering and permanent maintenance, not browser CPU. One SAT markup/authentication change can consume days and block every tenant, while Syntage currently absorbs that work. At 1,000 companies, size the business case from observed browser-hours and artifact volume rather than worker count: `monthly infrastructure = browser-hours × measured worker-hour cost + storage + queue/database + observability`. Add an explicit maintenance reserve of at least several engineering days per quarter in the comparison.

Use this payback calculation with measured values after shadow mode:

`payback months = build cost / (avoided Syntage monthly fee - native infrastructure - maintenance reserve)`

At 25 RFCs, do not justify the build only as a MXN90,000/year cost reduction. At roughly 75–100 active RFCs, or when native retrieval is required to make competitive portfolio pricing work, it becomes strategically rational. The implementation also reduces third-party credential exposure and gives ContabilidadOS direct control of provenance, which has product value beyond the fee.

Recommendation:

- **Build** the evidence spike and declarations MVP now as a Phase 0/1 cost-control track.
- **Buy/retain** Syntage during development, shadowing, and as the historical CE fallback.
- **Do not renew blindly** at larger tiers; negotiate a bridge/fallback plan and use native retrieval to reduce paid extraction volume.
- **Do not cancel** until declarations, CE artifacts, opinion 32-D, and CSF all meet cutover gates. Partial replacement that leaves the minimum subscription unchanged produces no cash saving.

## Official sources

- [SAT — Consulta de acuses de Contabilidad Electrónica](https://wwwmatnp.sat.gob.mx/consultas/16203/consulta-tus-acuses-generados-en-la-aplicacion-contabilidad-electronica)
- [SAT — Buzón Tributario service catalog, including CE submission and receipt consultation](https://www.sat.gob.mx/minisitio/bt_serviciosdisponibles/servicios_disponibles.html)
- [SAT — Servicios disponibles del Buzón Tributario](https://wwwmat.sat.gob.mx/consulta/36383/servicios-disponibles-del-buzon-tributario)
- [SAT — Envía tu Contabilidad Electrónica](https://wwwmat.sat.gob.mx/aplicacion/42150/envia-tu-contabilidad-electronica)
- [SAT — Pagos provisionales o definitivos de personas morales](https://wwwmat.sat.gob.mx/declaracion/95291/declaracion-mensual-para-tu-empresa-en-el-servicio-de-declaraciones-y-pagos)
- [SAT — Reimpresión de acuses de declaraciones](https://wwwmat.sat.gob.mx/aplicacion/77792/reimprime-tus-acuses-de-declaraciones-presentadas)
- [SAT — Official Declaraciones y Pagos guide showing declaration queries and receipt downloads](https://www.sat.gob.mx/cs/Satellite?blobcol=urldata&blobkey=id&blobtable=MungoBlobs&blobwhere=1461175253090&ssbinary=true)
- [SAT — Descarga Masiva web-service documentation](https://www.sat.gob.mx/cs/Satellite?blobcol=urldata&blobkey=id&blobtable=MungoBlobs&blobwhere=1461174995026&ssbinary=true)
- [SAT — e.firma overview and legal effect](https://sat.gob.mx/portal/public/tramites/firma-electronica-avanzada-efirma)
- [SAT — 2026 RMF and annex index, including current Anexo 24](https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE/index.html)
- [SAT — RMF 2026, including rule 2.8.1.6](https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE/documentos2026/rmf/rmf/RMF_2026-DOF-28122025.pdf)
- [SAT — Anexo 24 RMF 2026](https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE/documentos2026/rmf/anexos/Anexo_24_RMF2026-13012026.pdf)
- [SAT — 2026 e.firma terms and private-key responsibility, Anexo 1 RMF](https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE/documentos2026/rmf/anexos/Anexo-1-RMF-2026_DOF-28122025.pdf)
- [Cámara de Diputados — Código Fiscal de la Federación](https://www.diputados.gob.mx/LeyesBiblio/pdf/CFF.pdf)

No official public SAT API or web-service documentation was found for retrieving CE/declaration archives. The official public paths above are authenticated portal applications. This is an evidence limit, not proof that no private or specially authorized channel exists.
