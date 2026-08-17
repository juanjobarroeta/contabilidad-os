/**
 * V-1 — El candado de la bóveda: fuera de src/lib/vault.ts, NADIE descifra.
 *
 * Un `import { decryptSecret }` nuevo fuera de la bóveda es exactamente el
 * atajo que V-1 elimina: un descifrado sin propósito declarado y sin
 * bitácora. Este test lo convierte en CI rojo.
 *
 * Exentos: crypto.ts (define las primitivas), vault.ts (el único consumidor
 * autorizado), y los tests. scripts/ vive fuera de src y no se recorre —
 * la rotación de llave (scripts/rotate-encryption-key.ts) sigue operando.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC = path.join(process.cwd(), "src");
const PROHIBIDO = /\bdecrypt(Secret|Nullable|WithKey)\b/;
const EXENTOS = new Set(["src/lib/crypto.ts", "src/lib/vault.ts"]);

function archivosTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...archivosTs(full));
    else if (/\.tsx?$/.test(e.name) && !/\.(test|itest)\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

describe("candado de la bóveda (V-1)", () => {
  it("ningún archivo fuera de la bóveda descifra credenciales", () => {
    const violaciones = archivosTs(SRC)
      .map((abs) => ({
        ruta: path.relative(process.cwd(), abs).split(path.sep).join("/"),
        contenido: fs.readFileSync(abs, "utf8"),
      }))
      .filter((a) => !EXENTOS.has(a.ruta) && PROHIBIDO.test(a.contenido))
      .map((a) => a.ruta);

    expect(
      violaciones,
      `decryptSecret/decryptNullable/decryptWithKey fuera de la bóveda.\n` +
        `Usa abrirCredencial() de src/lib/vault.ts (declara tipo, propósito y ` +
        `actor, y deja bitácora) o descifrarCerParaVigencia() si es sólo el ` +
        `certificado público:\n  ` +
        violaciones.join("\n  ")
    ).toEqual([]);
  });
});
