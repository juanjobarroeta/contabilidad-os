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

import { readFileSync } from "node:fs";

// CÓMO SE CARGA EL PAQUETE, Y POR QUÉ ASÍ.
//
// Esto era `createRequire(path.join(process.cwd(), "package.json"))`, y en
// producción reventaba con «TypeError: e is not a function» — `e` es el propio
// `req` minificado: en el bundle del servidor de Next, `createRequire` no
// devuelve una función utilizable, así que la primera llamada `req(...)` moría.
// Nadie lo notó durante meses porque este archivo SÓLO corría con PDFs
// protegidos con contraseña; el día que el corte por páginas lo puso en cada
// subida, salió a la primera.
//
// El `require` pelón, en cambio, está probado en producción: es lo que usa
// `fiscal-kb/pdf.ts` para pdf-parse, y es lo que hizo funcionar la lectura de
// páginas de este mismo flujo mientras qpdf fallaba. Los dos paquetes están en
// `serverExternalPackages`, así que webpack no los empaqueta y el require llega
// intacto a Node.
//
// Va DENTRO de las funciones a propósito: evaluarlo al cargar el módulo mete a
// pdfjs/emscripten en el paso de build de Next.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function requerir(spec: string): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(spec);
}

let wasmBytes: Buffer | null = null;
function getWasm(): Buffer {
  if (!wasmBytes) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    wasmBytes = readFileSync(require.resolve("@jspawn/qpdf-wasm/qpdf.wasm"));
  }
  return wasmBytes;
}

/** Heurística barata: el diccionario /Encrypt aparece en el trailer de todo PDF
 *  cifrado (y prácticamente nunca como texto literal en uno sin cifrar, porque
 *  los streams van comprimidos). Evita gastar un arranque de qpdf ni un viaje
 *  a Claude en el caso común de PDFs sin contraseña. */
export function pdfEstaProtegido(buf: Buffer): boolean {
  return buf.includes("/Encrypt");
}

export type QpdfRun = { code: number; out: Buffer | null; stderr: string };

/** Ejecuta el CLI de qpdf (WASM) sobre un buffer, en un FS virtual efímero.
 *  Cada llamada instancia un módulo nuevo — callMain solo corre una vez. */
export async function runQpdf(args: string[], input: Buffer): Promise<QpdfRun> {
  try {
    return await correrQpdf(args, input);
  } catch (e) {
    // NUNCA lanza: quien llama decide qué hacer sin qpdf. Antes una excepción
    // aquí subía hasta el usuario como un error minificado sin sentido.
    console.error("[qpdf] falló el arranque del módulo WASM:", e);
    return { code: 2, out: null, stderr: e instanceof Error ? e.message : "error desconocido" };
  }
}

async function correrQpdf(args: string[], input: Buffer): Promise<QpdfRun> {
  // Interop: según cómo resuelva el runtime (CJS vs `require` de un ESM en Node
  // 22, que devuelve el namespace), esto llega como función o como objeto con
  // `default`. Llamar al objeto tira «X is not a function» — que es exactamente
  // lo que reventó en producción cuando este camino, antes reservado a los PDFs
  // con contraseña, pasó a correr en CADA subida.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod0: any = requerir("@jspawn/qpdf-wasm/qpdf.js");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createModule: any = typeof mod0 === "function" ? mod0 : mod0?.default;
  if (typeof createModule !== "function") {
    return { code: 2, out: null, stderr: "qpdf-wasm no exportó una función de arranque" };
  }
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
