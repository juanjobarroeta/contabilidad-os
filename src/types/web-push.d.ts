// Ambient shim so `tsc` passes before `web-push` is installed (it lands at
// build time via package.json). Treated as `any`; the real package provides
// the runtime implementation.
declare module "web-push";
