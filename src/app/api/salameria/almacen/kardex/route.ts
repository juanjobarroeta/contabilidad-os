/**
 * GET /api/salameria/almacen/kardex?companyId=... [&productoId=][&loteId=][&desde=][&hasta=][&tipo=]
 *
 * El rastro de por qué el stock de hoy es el que es. Se lee al revés (lo más
 * reciente primero) porque la pregunta real casi siempre es «¿qué le pasó a
 * esto ayer?», no «¿qué le pasó en 2024?».
 *
 * Sirve además para la alerta sanitaria: filtrando por `loteId` sale a qué
 * pedidos se fue un lote concreto, que es lo que hay que poder contestar en
 * horas cuando el fabricante retira un número de lote.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

const TIPOS = [
  "ENTRADA_IMPORTACION",
  "ENTRADA_COMPRA",
  "ENTRADA_DEVOLUCION",
  "SALIDA_PEDIDO",
  "SALIDA_MERMA",
  "SALIDA_CADUCIDAD",
  "AJUSTE",
] as const;

type Tipo = (typeof TIPOS)[number];

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "SALAMERIA", req);

  const productoId = searchParams.get("productoId");
  const loteId = searchParams.get("loteId");
  const desde = searchParams.get("desde");
  const hasta = searchParams.get("hasta");
  const tipoParam = searchParams.get("tipo");
  const tipo = TIPOS.includes(tipoParam as Tipo) ? (tipoParam as Tipo) : null;

  const movimientos = await prisma.salMovimiento.findMany({
    where: {
      companyId,
      ...(productoId ? { productoId } : {}),
      ...(loteId ? { loteId } : {}),
      ...(tipo ? { tipo } : {}),
      ...(desde || hasta
        ? {
            fecha: {
              ...(desde ? { gte: new Date(desde) } : {}),
              ...(hasta ? { lte: new Date(hasta) } : {}),
            },
          }
        : {}),
    },
    orderBy: [{ fecha: "desc" }, { createdAt: "desc" }],
    include: {
      producto: { select: { id: true, sku: true, nombre: true, unidad: true } },
      lote: { select: { id: true, codigo: true, caducidad: true } },
    },
    take: 500,
  });

  const entradas = movimientos
    .filter((m) => Number(m.cantidad) > 0)
    .reduce((a, m) => a + Number(m.cantidad), 0);
  const salidas = movimientos
    .filter((m) => Number(m.cantidad) < 0)
    .reduce((a, m) => a + Math.abs(Number(m.cantidad)), 0);

  return NextResponse.json({
    resumen: {
      entradas: Math.round(entradas * 1e6) / 1e6,
      salidas: Math.round(salidas * 1e6) / 1e6,
      neto: Math.round((entradas - salidas) * 1e6) / 1e6,
    },
    movimientos,
  });
});
