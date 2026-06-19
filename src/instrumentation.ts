// Next.js instrumentation: runs once at server startup.
//
// Node < 20 doesn't expose `File` as a global, but undici's `Request.formData()`
// constructs `File` instances for multipart file parts — without the global it
// throws "File is not defined", breaking every PDF/CSV upload route. Node 18
// ships `File` in `node:buffer` (since 18.13) but not as a global, so we lift it
// onto globalThis here. On Node ≥20 (where `File` is already global) this is a
// no-op. Belt-and-suspenders alongside the engines>=20 pin.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const g = globalThis as { File?: unknown; Blob?: unknown };
  if (typeof g.File === "undefined") {
    const buffer = await import("node:buffer");
    if (buffer.File) g.File = buffer.File;
    if (typeof g.Blob === "undefined" && buffer.Blob) g.Blob = buffer.Blob;
  }
}
