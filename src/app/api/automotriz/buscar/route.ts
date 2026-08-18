/**
 * GET /api/automotriz/buscar?companyId=…&q=…
 *
 * Búsqueda transversal para la paleta de comandos del satélite (⌘K): una sola
 * petición que barre unidades, directorio, refacciones y órdenes de servicio.
 *
 * POR QUÉ EN EL HUB Y NO EN EL CLIENTE. El satélite ya sabe pedir cada una de
 * esas listas por separado, así que la paleta podría armarse con cuatro
 * llamadas y filtrar en el navegador. No se hizo así por dos razones:
 *
 *   1. Volumen. Esas rutas devuelven la tabla COMPLETA (vehiculos no pagina;
 *      ordenes toma 200). Buscar «un VIN entre todo el padrón» bajando el
 *      padrón entero a cada tecleo es exactamente lo que no se debe hacer, y
 *      además sólo encontraría lo que quepa en el `take`.
 *   2. Corrección. El filtrado en el cliente sólo ve lo que se bajó; aquí el
 *      `contains` lo resuelve Postgres sobre la tabla entera.
 *
 * COTAS. Cada grupo trae a lo más POR_GRUPO resultados: una paleta se lee de
 * un vistazo, no se pagina. `q` exige MIN_CONSULTA caracteres — con uno solo
 * el `contains` recorre la tabla completa para devolver ruido.
 *
 * TENANT. `requireMembership` + `requireModule` y `companyId` en el `where` de
 * las cuatro consultas (la invariante que verifica api-guardias.test.ts).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

/** Cuántos resultados por grupo. La paleta muestra, no pagina. */
const POR_GRUPO = 6;

/** Mínimo de caracteres para consultar. Con menos, no vale el barrido. */
const MIN_CONSULTA = 2;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const q = searchParams.get("q")?.trim() ?? "";
  if (q.length < MIN_CONSULTA) {
    // Consulta demasiado corta: se contesta vacío, no un error. La paleta
    // teclea letra por letra y un 400 a media palabra sería ruido en Sentry.
    return NextResponse.json({ vehiculos: [], contactos: [], refacciones: [], ordenes: [] });
  }

  const como = { contains: q, mode: "insensitive" as const };
  // Un folio es un entero: sólo se busca por folio si lo que se tecleó lo es.
  const folio = Number.isInteger(Number(q)) && Number(q) > 0 ? Number(q) : null;

  const [vehiculos, contactos, refacciones, ordenes] = await Promise.all([
    prisma.vehiculo.findMany({
      where: {
        companyId,
        OR: [
          { vin: como },
          { marca: como },
          { modelo: como },
          { version: como },
          { color: como },
          { numeroMotor: como },
          { numeroEconomico: como },
        ],
      },
      select: {
        id: true, vin: true, marca: true, modelo: true, version: true,
        anio: true, color: true, estado: true,
      },
      // Lo que sigue en el piso pesa más que lo ya entregado: quien busca un
      // VIN casi siempre busca la unidad viva, no el histórico.
      orderBy: [{ fechaVenta: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }],
      take: POR_GRUPO,
    }),

    prisma.customer.findMany({
      where: { companyId, OR: [{ razonSocial: como }, { rfc: como }] },
      select: { id: true, razonSocial: true, rfc: true },
      orderBy: { razonSocial: "asc" },
      take: POR_GRUPO,
    }),

    prisma.refaccion.findMany({
      where: { companyId, OR: [{ numeroParte: como }, { descripcion: como }] },
      select: { id: true, numeroParte: true, descripcion: true },
      orderBy: { numeroParte: "asc" },
      take: POR_GRUPO,
    }),

    prisma.ordenServicio.findMany({
      where: {
        companyId,
        OR: [
          ...(folio ? [{ folio }] : []),
          { vin: como },
          { placas: como },
          { descripcionUnidad: como },
          { cliente: { razonSocial: como } },
        ],
      },
      select: {
        id: true, folio: true, estado: true, vin: true, descripcionUnidad: true,
        cliente: { select: { id: true, razonSocial: true } },
      },
      orderBy: { recibidaAt: "desc" },
      take: POR_GRUPO,
    }),
  ]);

  return NextResponse.json({ vehiculos, contactos, refacciones, ordenes });
});
