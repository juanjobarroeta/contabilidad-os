/**
 * GET /api/hospital/catalogos?companyId=&tipo=CIE10|CIE9MC&q=[&limit=20&sexo=F|M&edad=<años>]
 * GET /api/hospital/catalogos?companyId=&tipo=CIE10|CIE9MC&codigo=K80.2
 *
 * Buscador de los catálogos DGIS (CIE-10 diagnósticos, CIE-9-MC
 * procedimientos) para capturar por catálogo (NOM-024). `q` empata prefijo de
 * código («K80», «51.2») o todas las palabras del nombre sin importar acentos
 * ni mayúsculas («colecist lapar»). Sólo claves activas (codificables);
 * `codigo` resuelve un código exacto aunque esté inactivo, para enseñar el
 * nombre de lo que ya quedó guardado. `sexo`/`edad` descartan lo que el
 * catálogo restringe a otro sexo o a otra edad (la edad en años).
 */

import { NextResponse } from "next/server";
import { Prisma, type HospCatalogoTipo } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error } from "@/lib/hospital/http";
import { buscarCie, claveDeCodigoCie, normalizarCodigoCie, type FilaCie } from "@/lib/hospital/cie";

const MAX_LIMIT = 100;
const MAX_PALABRAS = 6;

/** «Colecistectomía Laparoscópica» → «COLECISTECTOMIA LAPAROSCOPICA», igual que translate() en SQL. */
function sinAcentos(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
}

const escaparLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

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

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const tipoParam = (searchParams.get("tipo") ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (tipoParam !== "CIE10" && tipoParam !== "CIE9MC") return error("tipo debe ser CIE10 o CIE9MC");
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

  const palabras = sinAcentos(q)
    .split(/\s+/)
    .map((p) => p.replace(/[^A-Z0-9]/g, ""))
    .filter(Boolean)
    .slice(0, MAX_PALABRAS);

  const porNombre = palabras.length
    ? Prisma.sql`(${Prisma.join(
        palabras.map((p) => Prisma.sql`translate(upper(nombre), 'ÁÉÍÓÚÜÑÀÈÌÒÙÂÊÎÔÛ', 'AEIOUUNAEIOUAEIOU') LIKE ${`%${escaparLike(p)}%`}`),
        " AND "
      )})`
    : Prisma.sql`false`;
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
