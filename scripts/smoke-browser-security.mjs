// Read-only SEC-001 acceptance probe. No credentials, customer IDs or writes.
// node scripts/smoke-browser-security.mjs https://your-deployment.example
// Optional: SECURITY_SMOKE_CORS_ORIGIN=https://an-already-allowed-satellite.example
import assert from "node:assert/strict";

const target = new URL(process.argv[2] ?? "http://127.0.0.1:3217");
assert(["https:", "http:"].includes(target.protocol), "Expected an HTTP(S) origin");
assert(!target.username && !target.password && !target.search && !target.hash && target.pathname === "/",
  "Pass only the origin, without credentials, a path or query");
const secure = target.protocol === "https:";
const baseline = {
  "content-security-policy": "base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'",
  "x-frame-options": "SAMEORIGIN",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};
let count = 0;

async function probe(path, status, options = {}) {
  const res = await fetch(new URL(path, target), {
    ...options,
    headers: { "User-Agent": "ContabilidadOS-SEC-001-Smoke", ...options.headers },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(res.status, status, `${options.method ?? "GET"} ${path}: status`);
  for (const [key, value] of Object.entries(baseline)) {
    assert.equal(res.headers.get(key), value, `${path}: ${key}`);
  }
  assert.equal(res.headers.get("x-powered-by"), null, `${path}: x-powered-by must be absent`);
  assert.equal(res.headers.get("strict-transport-security"), secure ? "max-age=31536000" : null,
    `${path}: HSTS must be host-only and HTTPS-only`);
  assert.equal(res.headers.get("access-control-allow-credentials"), null, `${path}: no credentialed CORS`);
  console.log(`PASS ${options.method ?? "GET"} ${path} ${res.status}`);
  count++;
  return res;
}

const login = await probe("/login", 200);
assert.match(login.headers.get("content-type") ?? "", /^text\/html/);
const html = await login.text();
await probe("/login", 200, { method: "HEAD" });
await probe("/legal/terminos", 200);
const protectedPage = await probe("/facturas", 307);
assert.equal(new URL(protectedPage.headers.get("location"), target).pathname, "/login");
const legacy = await probe("/declaraciones?month=9&year=2026", 307);
const destination = new URL(legacy.headers.get("location"), target);
assert.equal(destination.pathname, "/impuestos");
assert.deepEqual(Object.fromEntries(destination.searchParams), { month: "9", year: "2026", tab: "historial" });

for (const path of ["/api/health", "/api/ready"]) {
  for (const method of ["GET", "HEAD"]) {
    const res = await probe(path, 200, { method });
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  }
}
await probe("/api/auth/session", 200);
await probe("/api/facturas", 401);
await probe("/api/declaracion-anual", 401);
await probe("/api/bancos/import-batches/sec001-smoke/pdf", 401);
await probe("/api/facturas/sec001-smoke/file?format=pdf&token=invalid", 403);
await probe("/sec001-page-that-does-not-exist", 404);
await probe("/sw.js", 200);
await probe("/manifest.webmanifest", 200);

// Probe one emitted JS and CSS asset; never follow an arbitrary external URL.
for (const extension of ["js", "css"]) {
  const path = html.match(new RegExp(`(?:src|href)="(/_next/static/[^"?]+\\.${extension})(?:\\?[^\"]*)?"`))?.[1];
  assert(path, `Login must emit a ${extension} asset`);
  const res = await probe(path, 200);
  assert.match(res.headers.get("content-type") ?? "", extension === "js" ? /javascript/ : /^text\/css/);
}

const rejected = await probe("/api/facturas", 403, {
  method: "OPTIONS",
  headers: { Origin: "https://sec001-untrusted.invalid", "Access-Control-Request-Method": "GET" },
});
assert.equal(rejected.headers.get("access-control-allow-origin"), null);

const satellite = process.env.SECURITY_SMOKE_CORS_ORIGIN;
if (satellite) {
  const allowed = await probe("/api/facturas", 204, {
    method: "OPTIONS",
    headers: {
      Origin: satellite, "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization,sentry-trace,baggage",
    },
  });
  assert.equal(allowed.headers.get("access-control-allow-origin"), satellite);
  assert.match(allowed.headers.get("vary") ?? "", /\bOrigin\b/i);
  for (const header of ["authorization", "sentry-trace", "baggage"]) {
    assert((allowed.headers.get("access-control-allow-headers") ?? "").toLowerCase().split(/,\s*/).includes(header));
  }
  const denied = await probe("/api/facturas", 401, { headers: { Origin: satellite } });
  assert.equal(denied.headers.get("access-control-allow-origin"), satellite);
} else {
  console.log("NOT CHECKED: allowlisted satellite CORS (set SECURITY_SMOKE_CORS_ORIGIN)");
}
console.log(`SEC-001: ${count} response checks passed at ${target.origin}`);
