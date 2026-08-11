// ─────────────────────────────────────────────────────────────────────────────
// Estados de cuenta PDF protegidos con contraseña.
//
// Los bancos mexicanos (Banamex, Santander, HSBC…) suelen enviar el estado de
// cuenta cifrado — la contraseña típica es el número de tarjeta, el RFC o una
// fecha. La API de Claude rechaza PDFs cifrados, así que aquí se desencriptan
// ANTES de la extracción por visión, con qpdf compilado a WASM (sin binarios
// nativos — corre igual en Railway que en local). El PDF que se persiste como
// evidencia del lote es el desencriptado, para que siempre pueda abrirse.
// ─────────────────────────────────────────────────────────────────────────────

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

// Resolución desde la raíz del proyecto: el paquete va en serverExternalPackages
// (no lo empaqueta webpack), así que node_modules está disponible en runtime.
const req = createRequire(path.join(process.cwd(), "package.json"));

let wasmBytes: Buffer | null = null;
function getWasm(): Buffer {
  if (!wasmBytes) wasmBytes = readFileSync(req.resolve("@jspawn/qpdf-wasm/qpdf.wasm"));
  return wasmBytes;
}

/** Heurística barata: el diccionario /Encrypt aparece en el trailer de todo PDF
 *  cifrado (y prácticamente nunca como texto literal en uno sin cifrar, porque
 *  los streams van comprimidos). Evita gastar un arranque de qpdf ni un viaje
 *  a Claude en el caso común de PDFs sin contraseña. */
export function pdfEstaProtegido(buf: Buffer): boolean {
  return buf.includes("/Encrypt");
}

type QpdfRun = { code: number; out: Buffer | null; stderr: string };

/** Ejecuta el CLI de qpdf (WASM) sobre un buffer, en un FS virtual efímero.
 *  Cada llamada instancia un módulo nuevo — callMain solo corre una vez. */
async function runQpdf(args: string[], input: Buffer): Promise<QpdfRun> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createModule: any = req("@jspawn/qpdf-wasm/qpdf.js");
  let stderr = "";
  const mod = await createModule({
    noInitialRun: true,
    print: () => {},
    printErr: (line: string) => { stderr += line + "\n"; },
    // qpdf escribe sus errores por el fd 2 crudo (no pasa por printErr):
    // se intercepta el stream de stderr del FS virtual carácter por carácter.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    preRun: [(m: any) => {
      m.FS.init(
        null,
        null,
        (c: number | null) => { if (c != null && c >= 0) stderr += String.fromCharCode(c); }
      );
    }],
    // El loader de Emscripten intenta fetch() sobre la ruta del .wasm (falla en
    // Node); instanciamos nosotros desde el archivo del paquete.
    instantiateWasm: (
      imports: WebAssembly.Imports,
      done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
    ) => {
      WebAssembly.instantiate(getWasm() as BufferSource, imports).then((r) => {
        const s = r as WebAssembly.WebAssemblyInstantiatedSource;
        done(s.instance, s.module);
      });
      return {};
    },
  });
  mod.FS.writeFile("in.pdf", input);
  let code: number;
  try {
    code = mod.callMain(args);
  } catch {
    code = 2;
  }
  let out: Buffer | null = null;
  try {
    out = Buffer.from(mod.FS.readFile("out.pdf"));
  } catch {
    out = null;
  }
  return { code, out, stderr };
}

export type ResultadoDesencriptar =
  | { ok: true; pdf: Buffer }
  | { ok: false; passwordIncorrecta: boolean; detalle: string };

/**
 * Desencripta un PDF con la contraseña dada ("" para PDFs con restricciones de
 * solo-dueño, que abren sin contraseña pero igual traen /Encrypt). Con la
 * contraseña equivocada devuelve ok:false + passwordIncorrecta:true para que la
 * UI vuelva a preguntar. qpdf sale con 0 (éxito) o 3 (warnings, salida escrita).
 */
export async function desencriptarPdf(buf: Buffer, password: string): Promise<ResultadoDesencriptar> {
  const { code, out, stderr } = await runQpdf(
    [`--password=${password}`, "--decrypt", "in.pdf", "out.pdf"],
    buf
  );
  if ((code === 0 || code === 3) && out) return { ok: true, pdf: out };
  return {
    ok: false,
    passwordIncorrecta: /invalid password/i.test(stderr),
    detalle: stderr.trim().slice(0, 300),
  };
}
