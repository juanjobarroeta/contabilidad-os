/**
 * GET /api/hospital/catalogos?companyId=&tipo=CIE10|CIE9MC&q=[&limit=20&sexo=F|M&edad=<años>]
 * GET /api/hospital/catalogos?companyId=&tipo=CIE10|CIE9MC&codigo=K80.2
 * GET /api/hospital/catalogos?companyId=&tipo=SERVICIO|AFILIACION|PAIS|ENTIDAD|MUNICIPIO|LOCALIDAD|LENGUA|CLUES
 *       [&padre=21&q=&codigo=&limit=&todos=1]
 *
 * Buscador de los catálogos DGIS. Para CIE-10/CIE-9-MC (NOM-024): `q` empata
 * prefijo de código («K80», «51.2») o todas las palabras del nombre sin
 * importar acentos ni mayúsculas («colecist lapar»); sólo claves activas
 * (codificables); `codigo` resuelve un código exacto aunque esté inactivo;
 * `sexo`/`edad` descartan lo que el catálogo restringe (la edad en años).
 *
 * Para los catálogos SAEH/CDA (GIIS-B002): filas con `padre` y `datos`.
 * `padre` acota la jerarquía (MUNICIPIO → entidad «21», LOCALIDAD → entidad+
 * municipio «21114», CLUES → entidad); `q` empata prefijo de clave o código
 * («PLSMP», «114») o palabras del nombre; `codigo` es búsqueda exacta por
 * clave o código; las CLUES salen sólo EN OPERACIÓN salvo `todos=1`. Sin `q`
 * ni `codigo` devuelve el catálogo (acotado por `padre`) hasta `limit`
 * (default 1000); LOCALIDAD y CLUES exigen `padre` o `q`.
 */

import { NextResponse } from "next/server";
import { Prisma, type HospCatalogoTipo } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error } from "@/lib/hospital/http";
import { buscarCie, claveDeCodigoCie, normalizarCodigoCie, type FilaCie } from "@/lib/hospital/cie";

const MAX_LIMIT = 100;
const MAX_LIMIT_SAEH = 1000;
const MAX_PALABRAS = 6;

const TIPOS_SAEH: readonly HospCatalogoTipo[] = ["SERVICIO", "AFILIACION", "PAIS", "ENTIDAD", "MUNICIPIO", "LOCALIDAD", "LENGUA", "CLUES"];

/** «Colecistectomía Laparoscópica» → «COLECISTECTOMIA LAPAROSCOPICA», igual que translate() en SQL. */
function sinAcentos(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
}

const escaparLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function palabrasDe(q: string): string[] {
  return sinAcentos(q)
    .split(/\s+/)
    .map((p) => p.replace(/[^A-Z0-9]/g, ""))
    .filter(Boolean)
    .slice(0, MAX_PALABRAS);
}

function porNombreSql(palabras: string[]): Prisma.Sql {
  return palabras.length
    ? Prisma.sql`(${Prisma.join(
        palabras.map((p) => Prisma.sql`translate(upper(nombre), 'ÁÉÍÓÚÜÑÀÈÌÒÙÂÊÎÔÛ', 'AEIOUUNAEIOUAEIOU') LIKE ${`%${escaparLike(p)}%`}`),
        " AND "
      )})`
    : Prisma.sql`false`;
}

function serializar(f: FilaCie) {
  return {
    clave: f.clave,
    codigo: f.codigo,
    nombre: f.nombre,
    nivel: f.nivel,
    capitulo: f.capitulo,
    capituloNombre: f.capituloNombre,
    subtipo: f.subtipo,
    sexo: f.sexo,
    edadMin: f.edadMin,
    edadMax: f.edadMax,
    activo: f.activo,
  };
}

type FilaSaeh = { clave: string; codigo: string; nombre: string; padre: string | null; activo: boolean; datos: unknown };

function serializarSaeh(f: FilaSaeh) {
  return { clave: f.clave, codigo: f.codigo, nombre: f.nombre, padre: f.padre, activo: f.activo, datos: f.datos && typeof f.datos === "object" ? f.datos : null };
}

const selectSaeh = { clave: true, codigo: true, nombre: true, padre: true, activo: true, datos: true } as const;

/** Catálogos SAEH/CDA: jerarquía por `padre`, búsqueda por clave/código/nombre, inactivos sólo con todos=1. */
async function catalogoSaeh(tipo: HospCatalogoTipo, searchParams: URLSearchParams) {
  const padre = searchParams.get("padre")?.trim().toUpperCase() || null;
  const todos = searchParams.get("todos") === "1";
  const codigo = searchParams.get("codigo")?.trim().toUpperCase();
  const q = searchParams.get("q")?.trim() ?? "";
  const limitParam = Number(searchParams.get("limit"));
  const limit = Math.min(MAX_LIMIT_SAEH, Math.max(1, Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : q ? 20 : MAX_LIMIT_SAEH));

  if (codigo) {
    const filas = await prisma.hospCatalogo.findMany({
      where: { tipo, OR: [{ clave: codigo }, { codigo }], ...(padre ? { padre } : {}) },
      select: selectSaeh,
      orderBy: [{ activo: "desc" }, { clave: "asc" }],
      take: 5,
    });
    return NextResponse.json(filas.map(serializarSaeh));
  }

  if ((tipo === "LOCALIDAD" || tipo === "CLUES") && !padre && !q) {
    return error(tipo === "LOCALIDAD" ? "LOCALIDAD requiere padre (entidad+municipio, p. ej. 21114) o q" : "CLUES requiere padre (entidad, p. ej. 21), q o codigo");
  }

  const clave = sinAcentos(q).replace(/[^A-Z0-9]/g, "");
  const prefijo = `${escaparLike(clave)}%`;
  const porClave = clave ? Prisma.sql`(clave LIKE ${prefijo} OR codigo LIKE ${prefijo})` : Prisma.sql`false`;
  const porNombre = porNombreSql(palabrasDe(q));
  const filtroQ = q ? Prisma.sql`AND (${porClave} OR ${porNombre})` : Prisma.empty;

  const filas = await prisma.$queryRaw<FilaSaeh[]>`
    SELECT clave, codigo, nombre, padre, activo, datos
    FROM "HospCatalogo"
    WHERE tipo = ${tipo}::"HospCatalogoTipo"
      ${padre ? Prisma.sql`AND padre = ${padre}` : Prisma.empty}
      ${todos ? Prisma.empty : Prisma.sql`AND activo = true`}
      ${filtroQ}
    ORDER BY ${clave ? Prisma.sql`(clave LIKE ${prefijo}) DESC,` : Prisma.empty} clave ASC
    LIMIT ${limit}`;
  return NextResponse.json(filas.map(serializarSaeh));
}

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const tipoParam = (searchParams.get("tipo") ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (TIPOS_SAEH.includes(tipoParam as HospCatalogoTipo)) return catalogoSaeh(tipoParam as HospCatalogoTipo, searchParams);
  if (tipoParam !== "CIE10" && tipoParam !== "CIE9MC") return error(`tipo debe ser CIE10, CIE9MC o uno de ${TIPOS_SAEH.join(", ")}`);
  const tipo = tipoParam as HospCatalogoTipo;

  const codigo = searchParams.get("codigo")?.trim();
  if (codigo) {
    const fila = await buscarCie(prisma, tipo, codigo);
    return NextResponse.json(fila ? [serializar({ ...fila })] : []);
  }

  const q = searchParams.get("q")?.trim() ?? "";
  if (!q) return error("q o codigo requerido");
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(searchParams.get("limit") ?? 20) || 20));

  const sexoParam = (searchParams.get("sexo") ?? "").trim().toUpperCase();
  const sexo = sexoParam.startsWith("F") ? "F" : sexoParam.startsWith("M") ? "M" : null;
  const edadParam = searchParams.get("edad");
  const edadAnios = edadParam == null || edadParam === "" ? null : Number(edadParam);
  if (edadAnios != null && (!Number.isFinite(edadAnios) || edadAnios < 0 || edadAnios > 130)) return error("edad inválida (años)");
  const edadDias = edadAnios == null ? null : Math.round(edadAnios * 365.25);

  // Prefijo de código sólo cuando lo capturado parece código («K80», «51.2»).
  const codigoNorm = normalizarCodigoCie(q);
  const pareceCodigo = tipo === "CIE10" ? /^[A-Z]\d/.test(codigoNorm) : /^\d/.test(codigoNorm);
  const prefijoCodigo = `${escaparLike(codigoNorm)}%`;
  const prefijoClave = `${escaparLike(claveDeCodigoCie(codigoNorm))}%`;

  const porNombre = porNombreSql(palabrasDe(q));
  const porCodigo = pareceCodigo ? Prisma.sql`(codigo LIKE ${prefijoCodigo} OR clave LIKE ${prefijoClave})` : Prisma.sql`false`;

  const filas = await prisma.$queryRaw<FilaCie[]>`
    SELECT tipo, clave, codigo, nombre, nivel, capitulo, "capituloNombre", subtipo, sexo, "edadMin", "edadMax", activo
    FROM "HospCatalogo"
    WHERE tipo = ${tipo}::"HospCatalogoTipo"
      AND activo = true
      AND (${porCodigo} OR ${porNombre})
      ${sexo ? Prisma.sql`AND (sexo IS NULL OR sexo = ${sexo})` : Prisma.empty}
      ${edadDias != null ? Prisma.sql`AND ("edadMin" IS NULL OR "edadMin" <= ${edadDias}) AND ("edadMax" IS NULL OR "edadMax" >= ${edadDias})` : Prisma.empty}
    ORDER BY (codigo LIKE ${prefijoCodigo}) DESC, codigo ASC
    LIMIT ${limit}`;

  return NextResponse.json(filas.map(serializar));
});
