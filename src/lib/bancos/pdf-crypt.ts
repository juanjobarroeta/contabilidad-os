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

// CÓMO SE CARGA EL PAQUETE, Y POR QUÉ ASÍ.
//
// Tiene que ser OPACO A WEBPACK. Un `require.resolve("…/qpdf.wasm")` con cadena
// literal sí lo analiza el bundler, que entonces intenta empaquetar el .wasm y
// el build muere con «Module parse failed: Unexpected character '\u0000'».
// Por eso va por `createRequire`: el bundler no puede seguirlo.
//
// Y se construye TARDE, dentro de la función. Antes se evaluaba al cargar el
// módulo; si `process.cwd()` no es lo que se espera en ese momento, el fallo
// ocurre al importar la ruta y sale como cualquier otra cosa.
let req: NodeJS.Require | null = null;
function getReq(): NodeJS.Require {
  if (!req) req = createRequire(path.join(process.cwd(), "package.json"));
  return req;
}

let wasmBytes: Buffer | null = null;
function getWasm(): Buffer {
  if (!wasmBytes) wasmBytes = readFileSync(getReq().resolve("@jspawn/qpdf-wasm/qpdf.wasm"));
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
/** Arranca el módulo de emscripten etiquetando el paso: si truena aquí, el
 *  problema es del propio glue WASM y no de cómo lo cargamos. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function arrancar(createModule: any, opciones: any): Promise<any> {
  try {
    return await createModule(opciones);
  } catch (e) {
    throw new Error(`[paso: arranque de emscripten] ${e instanceof Error ? e.message : String(e)}`);
  }
}

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
  // CADA PASO DICE SU NOMBRE. La corrida anterior sólo pudo reportar
  // «TypeError: e is not a function» —un identificador minificado— y con eso no
  // se puede saber si murió al construir el require, al cargar el módulo, al
  // leer el .wasm o dentro del propio arranque de emscripten. Etiquetar los
  // pasos convierte el siguiente fallo en un diagnóstico en vez de una
  // adivinanza.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod0: any;
  try {
    mod0 = getReq()("@jspawn/qpdf-wasm/qpdf.js");
  } catch (e) {
    throw new Error(`[paso: require del módulo] ${e instanceof Error ? e.message : String(e)}`);
  }
  // Interop: según cómo resuelva el runtime (CJS, o `require` de un ESM en Node
  // 22, que devuelve el namespace) esto llega como función o como objeto con
  // `default`. Llamar al objeto tira «X is not a function».
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createModule: any = typeof mod0 === "function" ? mod0 : mod0?.default;
  if (typeof createModule !== "function") {
    return {
      code: 2,
      out: null,
      stderr: `[paso: forma del módulo] qpdf-wasm exportó ${typeof mod0}, no una función de arranque`,
    };
  }
  try {
    getWasm();
  } catch (e) {
    throw new Error(`[paso: lectura del .wasm] ${e instanceof Error ? e.message : String(e)}`);
  }
  let stderr = "";
  const mod = await arrancar(createModule, {
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
