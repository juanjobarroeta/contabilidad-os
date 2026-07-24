/**
 * Ingesta del Código de Claves Vehiculares (Anexo 15 RMF, sección C) al
 * catálogo global `ClaveVehicularCatalogo`.
 *
 * Cada Anexo anual publica las claves NUEVAS del ejercicio — correr esto por
 * cada publicación acumula cobertura (upsert por clave: la más reciente gana).
 *
 * Uso:
 *   set -a; . ./.env.local; set +a
 *   npm run automotriz:ingest-claves -- <archivo.pdf|archivo.txt> "Anexo 15 RMF 2026 (DOF 28-dic-2025)"
 *
 * Acepta el PDF del DOF directamente (pdf-parse) o un .txt ya extraído.
 */

import { readFileSync } from "fs";
import { PrismaClient } from "@prisma/client";
import { parseAnexo15Claves } from "../src/lib/automotriz/claves";

const prisma = new PrismaClient();

async function textoDe(archivo: string): Promise<string> {
  if (archivo.toLowerCase().endsWith(".pdf")) {
    // pdf-parse v2 expone una clase; v1 una función. Soportar ambas.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("pdf-parse");
    const buf = readFileSync(archivo);
    const fn = typeof mod === "function" ? mod : (mod.default ?? mod.PDFParse ?? mod.pdf);
    if (typeof fn === "function" && fn.prototype && fn.prototype.getText) {
      const parser = new fn({ data: buf });
      const r = await parser.getText();
      return r.text as string;
    }
    const data = await fn(buf);
    return data.text as string;
  }
  return readFileSync(archivo, "utf8");
}

async function main() {
  const [archivo, fuente] = process.argv.slice(2);
  if (!archivo || !fuente) {
    console.error(
      'Uso: npm run automotriz:ingest-claves -- <archivo.pdf|txt> "<fuente, p.ej. Anexo 15 RMF 2026 (DOF 28-dic-2025)>"'
    );
    process.exit(1);
  }

  const texto = await textoDe(archivo);
  const entries = parseAnexo15Claves(texto);
  if (entries.length === 0) {
    console.error("No se encontraron claves en el documento — ¿es la sección C del Anexo 15?");
    process.exit(1);
  }

  let nuevas = 0;
  let actualizadas = 0;
  for (const e of entries) {
    const prev = await prisma.claveVehicularCatalogo.findUnique({ where: { clave: e.clave } });
    await prisma.claveVehicularCatalogo.upsert({
      where: { clave: e.clave },
      create: { clave: e.clave, empresa: e.empresa, modelo: e.modelo, version: e.version, fuente },
      update: { empresa: e.empresa, modelo: e.modelo, version: e.version, fuente },
    });
    if (prev) actualizadas++;
    else nuevas++;
  }

  const total = await prisma.claveVehicularCatalogo.count();
  console.log(
    `✅ ${entries.length} claves procesadas (${nuevas} nuevas, ${actualizadas} actualizadas). Catálogo total: ${total}.`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
