# SEC-001 — browser security baseline

Date: 2026-09-28. Scope: the web service's HTTP/browser boundary. No fiscal calculation, customer data, database migration, provider credential, or worker configuration changes.

## Header contract

| Header | Value / behavior |
|---|---|
| `Content-Security-Policy` | `base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'` |
| `X-Frame-Options` | `SAMEORIGIN`, consistent with CSP's frame-ancestor policy |
| `X-Content-Type-Options` | `nosniff`; routes still set their actual HTML/JSON/PDF/XML/asset content types |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |
| `Strict-Transport-Security` | `max-age=31536000`, only in a production build when the TLS proxy supplies `X-Forwarded-Proto: https` |
| `X-Powered-By` | Absent (`poweredByHeader: false`) |

The baseline is defined in `next.config.ts` and survives the Sentry wrapper. HSTS is deliberately host-only: no `includeSubDomains` or preload enrollment. Railway terminates TLS; local plain HTTP does not opt into HSTS. A different hosting/TLS proxy must supply the same protocol indication and pass the smoke test before promotion. HSTS persists in browsers after deployment rollback; removing the header does not clear an existing policy. An intentional HSTS rollback requires serving `max-age=0` over HTTPS.

This is an **enforced navigation/framing baseline, not a strict script/XSS CSP**. It does not restrict `script-src`, `style-src`, `connect-src`, `img-src`, or `frame-src`, and makes no claim to block all script injection or outbound data exfiltration. A full fetch/script policy remains separate work: audit browser resources, introduce per-request nonces for Next hydration and the theme bootstrap, assess dynamic-rendering/cache impact, then observe report-only violations before enforcement. No public report collector or fiscal-URL telemetry is introduced here.

## Compatibility boundary

- In-app acuse and bank-document viewers embed same-origin PDF endpoints. `SAMEORIGIN`, rather than `DENY`, preserves that contract. Signed WhatsApp invoice-file links are attachments, not a promise of cross-origin embedding.
- Satellite applications use bearer API fetches. Framing restrictions do not change their CORS allowlist, authentication, trace headers, or document permissions. No wildcard or credentialed CORS is added. Direct cross-origin framing of hub documents is intentionally denied.
- The hub does not use camera, microphone, or geolocation APIs. Separate satellite documents retain their own capability policies. `web-share` remains enabled for the installed-PWA PDF export flow.
- Hosted Stripe/Facturapi navigation remains navigation; no `default-src`/`connect-src` restriction or new third-party allowlist is introduced. No live checkout, stamp, or provider write is used to test this change.

## Redirect fix

The real Next 15.5.26 server drops previously matched `headers()` when serving a `next.config` redirect. Its configuration-test helper does not reproduce this behavior; the production-mode HTTP smoke caught it. The eight existing workspace redirects therefore move to the existing middleware with **eight exact matcher entries**, retaining status 307, destination, query parameters, and destination-tab precedence. Nested acuse/workpaper routes and NextAuth callbacks stay outside that addition. The original API CORS matchers are unchanged; UI redirects return before CORS handling.

This does not claim control of Railway-generated responses or Next's pre-routing URL normalization responses. Acceptance probes target actual application responses and the explicitly migrated legacy redirects.

## Verification

- Baseline: main `57381c22`. Focused contracts: 2 files / 46 passing tests. The real Sentry-wrapped configuration is tested for headers, HSTS scope, and powered-by removal; routing tests cover all eight redirects, period/query preservation, and unchanged matcher exclusions/API paths.
- Full local unit suite: 443 files / 4,832 passing tests. Real-Postgres suite: 4 files / 31 passing tests. Type checking and the 391-page production build pass. Production dependency audit: 0 critical, 0 high, 1 previously tracked moderate; no dependency changes.
- Real local production server: all 22 public response checks pass, including 204/403 middleware preflights and 307 redirects. Plain HTTP omits HSTS; an explicit simulated HTTPS proxy header enables the host-only policy.
- Full Chromium (not headless-shell): generated fixture credentials log in successfully, theme selection survives reload, the bank workspace opens and visibly renders the synthetic PDF in its native iframe viewer, and a fetch downloads valid PDF bytes. No page errors or unexpected CSP violations occur on that flow.
- A second loopback origin cannot frame the login page; the browser reports `frame-ancestors` blocking. That same allowlisted fixture origin can still fetch the protected API with bearer/trace headers and read its 401 authentication response.
- Production deployment acceptance is pending. No authenticated production workflow, installed iOS PWA, or long-running observation is claimed by these local results.

Repeat the read-only HTTP checks after each candidate deployment:

```sh
node scripts/smoke-browser-security.mjs https://contabilidad-os-production.up.railway.app
```

Set `SECURITY_SMOKE_CORS_ORIGIN` to an **already configured** satellite origin to include allowed preflight and authenticated-boundary checks. Without it, the script explicitly reports that positive CORS was not checked. It never supplies credentials or customer IDs, follows redirects, mutates data, or prints response bodies/session cookies. It verifies HTML, JavaScript/CSS, PWA assets, auth errors, rejected file tokens, unknown paths, health/readiness GET/HEAD, legacy redirects, and rejected preflights. Every HTTPS response checked must carry host-only HSTS and omit `x-powered-by`.

Authenticated/PDF browser checks use a disposable loopback-only PostgreSQL fixture with generated local credentials, synthetic PDF bytes, provider-free company data, disabled cron, and disabled Sentry. The shared Railway SAT staging service is not repurposed. This does not replace a production authenticated/PWA compatibility check or a long-running observation window.

## Rollback

Revert the application change if header enforcement blocks a supported workflow. There is no schema/data reversal. Do not weaken bearer authentication or widen CORS to repair an embedding issue. HSTS rollback has the separate HTTPS `max-age=0` requirement above. Check the exact deployed commit and deployment-attributed smoke requests; an earlier healthy deployment is not evidence for the candidate.

## References checked

- [Next 15 custom headers](https://nextjs.org/docs/15/app/api-reference/config/next-config-js/headers) and [poweredByHeader](https://nextjs.org/docs/15/app/api-reference/config/next-config-js/poweredByHeader).
- [MDN frame-ancestors](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors), [HSTS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Strict-Transport-Security), and [Permissions-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy).
