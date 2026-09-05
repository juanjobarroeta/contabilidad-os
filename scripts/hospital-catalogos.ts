/**
 * hospital-catalogos.ts — carga los catálogos maestros de la DGIS en HospCatalogo.
 *
 * Fuente: prisma/catalogos/cie10.csv y cie9mc.csv, derivados de los archivos
 * oficiales (DIAGNOSTICOS_20240416.xlsx y PROCEDIMIENTO_202402.xlsx de
 * gobi.salud.gob.mx). Idempotente: upsert por (tipo, clave); las claves que
 * la DGIS marca como no válidas quedan con activo = false para que los
 * selectores no las ofrezcan pero el histórico las siga resolviendo.
 *
 * Uso: ts-node --compiler-options '{"module":"CommonJS"}' scripts/hospital-catalogos.ts [--solo cie10|cie9mc]
 */
import { PrismaClient, type HospCatalogoTipo } from "@prisma/client";
import * as fs from "node:fs";
import * as path from "node:path";

const prisma = new PrismaClient();
const VERSION = { CIE10: "DGIS 2024-04-16", CIE9MC: "DGIS 2024-02" } as const;

function parseCsv(texto: string): string[][] {
  const filas: string[][] = [];
  let fila: string[] = [];
  let campo = "";
  let enComillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (enComillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; } else enComillas = false;
      } else campo += c;
    } else if (c === '"') enComillas = true;
    else if (c === ",") { fila.push(campo); campo = ""; }
    else if (c === "\n") { fila.push(campo); filas.push(fila); fila = []; campo = ""; }
    else if (c !== "\r") campo += c;
  }
  if (campo.length || fila.length) { fila.push(campo); filas.push(fila); }
  return filas;
}

const num = (v: string) => (v === "" ? null : Number(v));

async function cargar(tipo: HospCatalogoTipo, archivo: string) {
  const [encabezado, ...filas] = parseCsv(fs.readFileSync(path.join(__dirname, "..", "prisma", "catalogos", archivo), "utf8"));
  const col = (fila: string[], nombre: string) => fila[encabezado.indexOf(nombre)] ?? "";
  let nuevos = 0, actualizados = 0;
  const LOTE = 500;
  for (let i = 0; i < filas.length; i += LOTE) {
    const lote = filas.slice(i, i + LOTE).filter((f) => f.length >= 3 && col(f, "clave"));
    await prisma.$transaction(
      lote.map((f) =>
        prisma.hospCatalogo.upsert({
          where: { tipo_clave: { tipo, clave: col(f, "clave") } },
          create: {
            tipo,
            clave: col(f, "clave"),
            codigo: col(f, "codigo"),
            nombre: col(f, "nombre"),
            nivel: Number(col(f, "nivel")),
            capitulo: col(f, "capitulo") || null,
            capituloNombre: col(f, "capituloNombre") || null,
            subtipo: encabezado.includes("subtipo") ? col(f, "subtipo") || null : null,
            sexo: col(f, "sexo") || null,
            edadMin: num(col(f, "edadMin")),
            edadMax: num(col(f, "edadMax")),
            activo: col(f, "activo") === "SI",
            version: VERSION[tipo],
          },
          update: {
            codigo: col(f, "codigo"),
            nombre: col(f, "nombre"),
            nivel: Number(col(f, "nivel")),
            capitulo: col(f, "capitulo") || null,
            capituloNombre: col(f, "capituloNombre") || null,
            subtipo: encabezado.includes("subtipo") ? col(f, "subtipo") || null : null,
            sexo: col(f, "sexo") || null,
            edadMin: num(col(f, "edadMin")),
            edadMax: num(col(f, "edadMax")),
            activo: col(f, "activo") === "SI",
            version: VERSION[tipo],
          },
        })
      )
    );
    nuevos += lote.length; // upsert no distingue; el total es lo que importa
    process.stdout.write(`  ${tipo}: ${Math.min(i + LOTE, filas.length)} / ${filas.length}\r`);
  }
  const total = await prisma.hospCatalogo.count({ where: { tipo } });
  const activos = await prisma.hospCatalogo.count({ where: { tipo, activo: true } });
  console.log(`\n✔ ${tipo}: ${total} claves (${activos} codificables) · ${VERSION[tipo]}`);
  return { nuevos, actualizados };
}

async function main() {
  const solo = process.argv.includes("--solo") ? process.argv[process.argv.indexOf("--solo") + 1] : null;
  if (!solo || solo === "cie10") await cargar("CIE10", "cie10.csv");
  if (!solo || solo === "cie9mc") await cargar("CIE9MC", "cie9mc.csv");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
