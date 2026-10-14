// ─────────────────────────────────────────────────────────────────────────────
// Búsqueda de proveedores para requisiciones y compras.
//
// Dos fallas que se veían como «escribí el proveedor y no salió»:
//  · `contains` de Postgres no ignora acentos («medica» no encuentra «MÉDICA»)
//    ni el orden de las palabras.
//  · El padrón (Supplier) sólo se sembró una vez desde los CFDIs; quien empezó
//    a facturar después existe como emisor de un CFDI recibido pero no como
//    proveedor. Al buscarlo se da de alta solo, igual que la siembra, con el
//    RFC y nombre del propio CFDI.
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const MAX_PALABRAS = 6;
const GENERICOS = ["XAXX010101000", "XEXX010101000"];

export function sinAcentos(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
}

/**
 * Lo mismo del lado de Postgres: mayúsculas sin acentos y Ñ como N. Incluye
 * las minúsculas acentuadas porque `upper()` no las sube con collation C.
 */
const plano = (expr: string) =>
  Prisma.raw(`translate(upper(${expr}), 'ÁÉÍÓÚÜÀÈÌÒÙÂÊÎÔÛÑáéíóúüàèìòùâêîôûñ', 'AEIOUUAEIOUAEIOUNAEIOUUAEIOUAEIOUN')`);

const escaparLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** «Médica del Sur» → ["MEDICA", "DEL", "SUR"]; cada palabra debe aparecer. */
export function palabrasDe(q: string): string[] {
  return sinAcentos(q)
    .split(/\s+/)
    .map((p) => p.replace(/[^A-Z0-9&]/g, ""))
    .filter(Boolean)
    .slice(0, MAX_PALABRAS);
}

/** Condición SQL: todas las palabras en la razón social (sin acentos) o la búsqueda como RFC. */
function coincide(tabla: string, q: string, nombre = '"razonSocial"', rfcCol = "rfc"): Prisma.Sql {
  const palabras = palabrasDe(q);
  const col = plano(`${tabla}.${nombre}`);
  const porNombre = palabras.length
    ? Prisma.join(palabras.map((p) => Prisma.sql`${col} LIKE ${`%${escaparLike(p)}%`}`), " AND ")
    : Prisma.sql`false`;
  const rfc = sinAcentos(q).replace(/[^A-Z0-9&]/g, "");
  const porRfc = rfc.length >= 3 ? Prisma.sql`${plano(`${tabla}.${rfcCol}`)} LIKE ${`%${escaparLike(rfc)}%`}` : Prisma.sql`false`;
  return Prisma.sql`((${porNombre}) OR ${porRfc})`;
}

/** Ids de Supplier que coinciden con `q`; antes da de alta a los emisores que coinciden y aún no son proveedores. */
export async function idsProveedoresQueCoinciden(companyId: string, q: string, limite = 50): Promise<string[]> {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { rfc: true } });
  const excluir = [...GENERICOS, ...(company?.rfc ? [company.rfc.toUpperCase()] : [])];

  // Emisores de CFDIs recibidos (EGRESO) que coinciden y no están en el padrón.
  // Del propio CFDI (contraparte), que se guarda siempre, haya Customer o no.
  const emisores = await prisma.$queryRaw<Array<{ rfc: string; razonSocial: string }>>`
    SELECT DISTINCT ON (upper(trim(i."contraparteRfc"))) upper(trim(i."contraparteRfc")) AS rfc, i."contraparteNombre" AS "razonSocial"
    FROM "Invoice" i
    WHERE i."companyId" = ${companyId}
      AND i.tipo = 'EGRESO' AND i.status <> 'CANCELLED'
      AND i."contraparteRfc" IS NOT NULL AND i."contraparteNombre" IS NOT NULL
      AND ${coincide("i", q, '"contraparteNombre"', '"contraparteRfc"')}
      AND upper(trim(i."contraparteRfc")) <> ALL(${excluir})
      AND NOT EXISTS (SELECT 1 FROM "Supplier" s WHERE s."companyId" = ${companyId} AND upper(s.rfc) = upper(trim(i."contraparteRfc")))
    ORDER BY upper(trim(i."contraparteRfc")), i.fecha DESC
    LIMIT 20`;
  if (emisores.length) {
    await prisma.supplier.createMany({
      data: emisores.map((e) => ({ companyId, rfc: e.rfc, razonSocial: e.razonSocial.trim() })),
      skipDuplicates: true,
    });
  }

  const filas = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT s.id FROM "Supplier" s
    WHERE s."companyId" = ${companyId} AND ${coincide("s", q)}
    ORDER BY s."razonSocial" ASC
    LIMIT ${limite}`;
  return filas.map((f) => f.id);
}
