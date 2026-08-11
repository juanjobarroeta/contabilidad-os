import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pdfEstaProtegido, desencriptarPdf } from "./pdf-crypt";

// ── PDF mínimo válido (con xref real) y una copia cifrada hecha con el propio
//    qpdf, para probar el round-trip completo contra el WASM de verdad. ────────

function pdfMinimo(): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += String(off).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const req = createRequire(path.join(process.cwd(), "package.json"));

async function cifrar(pdf: Buffer, password: string): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createModule: any = req("@jspawn/qpdf-wasm/qpdf.js");
  const wasm = readFileSync(req.resolve("@jspawn/qpdf-wasm/qpdf.wasm"));
  const mod = await createModule({
    noInitialRun: true,
    print: () => {},
    printErr: () => {},
    instantiateWasm: (imports: WebAssembly.Imports, done: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) => {
      WebAssembly.instantiate(wasm, imports).then((r) => done(r.instance, r.module));
      return {};
    },
  });
  mod.FS.writeFile("in.pdf", pdf);
  const code = mod.callMain(["--encrypt", password, password, "256", "--", "in.pdf", "enc.pdf"]);
  expect(code).toBe(0);
  return Buffer.from(mod.FS.readFile("enc.pdf"));
}

describe("pdfEstaProtegido", () => {
  it("no marca un PDF sin cifrar", () => {
    expect(pdfEstaProtegido(pdfMinimo())).toBe(false);
  });

  it("detecta un PDF cifrado", async () => {
    const enc = await cifrar(pdfMinimo(), "secreto123");
    expect(pdfEstaProtegido(enc)).toBe(true);
  });
});

describe("desencriptarPdf", () => {
  it("desencripta con la contraseña correcta y la salida abre sin contraseña", async () => {
    const enc = await cifrar(pdfMinimo(), "secreto123");
    const res = await desencriptarPdf(enc, "secreto123");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.pdf.subarray(0, 5).toString()).toBe("%PDF-");
      expect(pdfEstaProtegido(res.pdf)).toBe(false);
    }
  });

  it("con contraseña incorrecta reporta passwordIncorrecta", async () => {
    const enc = await cifrar(pdfMinimo(), "secreto123");
    const res = await desencriptarPdf(enc, "nope");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.passwordIncorrecta).toBe(true);
  });

  it("sin contraseña también falla como passwordIncorrecta (el flujo la pedirá)", async () => {
    const enc = await cifrar(pdfMinimo(), "secreto123");
    const res = await desencriptarPdf(enc, "");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.passwordIncorrecta).toBe(true);
  });

  it("un PDF sin cifrar pasa limpio (caso /Encrypt falso-positivo)", async () => {
    const res = await desencriptarPdf(pdfMinimo(), "");
    expect(res.ok).toBe(true);
  });
});
