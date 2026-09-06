/**
 * hospital-catalogos.ts — carga los catálogos maestros de la DGIS en HospCatalogo.
 *
 * Fuente: prisma/catalogos/cie10.csv y cie9mc.csv, derivados de los archivos
 * oficiales (DIAGNOSTICOS_20240416.xlsx y PROCEDIMIENTO_202402.xlsx de
 * gobi.salud.gob.mx). Idempotente: upsert por (tipo, clave); las claves que
 * la DGIS marca como no válidas quedan con activo = false para que los
 * selectores no las ofrezcan pero el histórico las siga resolviendo.
 *
 * También los catálogos SAEH/CDA (GIIS-B002, NOM-024 Apéndice A): servicios,
 * afiliación, países, entidades, municipios, localidades, lenguas y CLUES
 * (prisma/catalogos/*.csv[.gz], derivados de gobi.salud.gob.mx y de la base
 * abierta de egresos 2023-2025 de la DGIS).
 *
 * Uso: npx tsx scripts/hospital-catalogos.ts [--solo cie10|cie9mc|servicio|afiliacion|pais|entidad|municipio|localidad|lengua|clues]
 */
import { PrismaClient, type HospCatalogoTipo } from "@prisma/client";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

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

async function cargar(tipo: keyof typeof VERSION, archivo: string) {
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

const SIMPLES: Record<string, { tipo: HospCatalogoTipo; archivo: string; version: string; masivo?: boolean }> = {
  servicio: { tipo: "SERVICIO", archivo: "servicios.csv", version: "DGIS SERVICIOS_ESPECIALIDADES 2022" },
  afiliacion: { tipo: "AFILIACION", archivo: "afiliacion.csv", version: "DGIS AFILIACION 2024 rev. 2024-11-01" },
  pais: { tipo: "PAIS", archivo: "paises.csv", version: "DGIS PAIS 2021 rev. 2024-11-01" },
  entidad: { tipo: "ENTIDAD", archivo: "entidades.csv", version: "DGIS/INEGI ENTIDAD_FEDERATIVA 2016-02" },
  municipio: { tipo: "MUNICIPIO", archivo: "municipios.csv", version: "DGIS/INEGI MUNICIPIOS 2026-06" },
  lengua: { tipo: "LENGUA", archivo: "lenguas.csv", version: "DGIS/INEGI LENGUA_INDIGENA 2018" },
  localidad: { tipo: "LOCALIDAD", archivo: "localidades.csv.gz", version: "DGIS CATLOCALIDADRES egresos 2023-2025", masivo: true },
  clues: { tipo: "CLUES", archivo: "clues.csv.gz", version: "DGIS ESTABLECIMIENTO_SALUD 2026-07", masivo: true },
};

/** Lee un CSV (opcionalmente .gz) de prisma/catalogos. */
function leerCatalogo(archivo: string): string {
  const ruta = path.join(__dirname, "..", "prisma", "catalogos", archivo);
  const bytes = fs.readFileSync(ruta);
  return (archivo.endsWith(".gz") ? zlib.gunzipSync(bytes) : bytes).toString("utf8");
}

/**
 * Catálogos planos: columnas clave, nombre y opcionales codigo, padre, activo
 * y cualquier otra (van a `datos`). Los masivos (localidades, CLUES) entran
 * con createMany + skipDuplicates: rápido y reejecutable; si la DGIS cambia
 * un nombre, se recarga con --recrear.
 */
async function cargarSimple(clave: string) {
  const def = SIMPLES[clave];
  const [encabezado, ...filas] = parseCsv(leerCatalogo(def.archivo));
  const col = (fila: string[], nombre: string) => fila[encabezado.indexOf(nombre)] ?? "";
  const extras = encabezado.filter((c) => !["clave", "codigo", "padre", "nombre", "activo"].includes(c));
  const esCluesActivo = (f: string[]) => (def.tipo === "CLUES" ? col(f, "estatus") === "1" : true);
  const aFila = (f: string[]) => ({
    tipo: def.tipo,
    clave: col(f, "clave"),
    codigo: encabezado.includes("codigo") ? col(f, "codigo") : col(f, "clave"),
    nombre: col(f, "nombre"),
    nivel: 1,
    padre: encabezado.includes("padre") ? col(f, "padre") || null : def.tipo === "CLUES" ? col(f, "entidad") || null : null,
    datos: extras.length ? Object.fromEntries(extras.map((c) => [c, col(f, c)])) : undefined,
    activo: encabezado.includes("activo") ? col(f, "activo") === "SI" : esCluesActivo(f),
    version: def.version,
  });
  const validas = filas.filter((f) => f.length >= 2 && col(f, "clave"));
  if (process.argv.includes("--recrear")) await prisma.hospCatalogo.deleteMany({ where: { tipo: def.tipo } });
  const LOTE = def.masivo ? 2000 : 500;
  for (let i = 0; i < validas.length; i += LOTE) {
    const lote = validas.slice(i, i + LOTE).map(aFila);
    if (def.masivo) {
      await prisma.hospCatalogo.createMany({ data: lote, skipDuplicates: true });
    } else {
      await prisma.$transaction(
        lote.map((d) => prisma.hospCatalogo.upsert({ where: { tipo_clave: { tipo: d.tipo, clave: d.clave } }, create: d, update: { ...d, tipo: undefined, clave: undefined } }))
      );
    }
    process.stdout.write(`  ${def.tipo}: ${Math.min(i + LOTE, validas.length)} / ${validas.length}\r`);
  }
  const total = await prisma.hospCatalogo.count({ where: { tipo: def.tipo } });
  const activos = await prisma.hospCatalogo.count({ where: { tipo: def.tipo, activo: true } });
  console.log(`\n✔ ${def.tipo}: ${total} claves (${activos} activas) · ${def.version}`);
}

async function main() {
  const solo = process.argv.includes("--solo") ? process.argv[process.argv.indexOf("--solo") + 1] : null;
  if (!solo || solo === "cie10") await cargar("CIE10", "cie10.csv");
  if (!solo || solo === "cie9mc") await cargar("CIE9MC", "cie9mc.csv");
  for (const clave of Object.keys(SIMPLES)) if (!solo || solo === clave) await cargarSimple(clave);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
