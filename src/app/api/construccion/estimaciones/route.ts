/**
 * GET /api/construccion/estimaciones?proyectoId=...
 *
 * List estimaciones for a proyecto.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const proyectoId = searchParams.get("proyectoId");
  if (!proyectoId) {
    return NextResponse.json({ error: "proyectoId requerido" }, { status: 400 });
  }

  const proyecto = await prisma.proyecto.findUnique({
    where: { id: proyectoId },
    select: { companyId: true },
  });
  if (!proyecto) {
    return NextResponse.json({ error: "Proyecto no encontrado" }, { status: 404 });
  }

  await requireMembership(proyecto.companyId, undefined, req);
  await requireModule(proyecto.companyId, "CONSTRUCCION");

  const btSelect = {
    id: true,
    fecha: true,
    monto: true,
    referencia: true,
    bankAccount: { select: { banco: true, nombre: true } },
  } as const;

  const rows = await prisma.estimacion.findMany({
    where: { proyectoId },
    include: {
      partidas: {
        include: {
          presupuestoPartida: {
            include: {
              concepto: { select: { codigo: true, descripcion: true, unidad: true } },
            },
          },
        },
      },
      // CFDI ligado + su conciliación bancaria: si el cobro ya se identificó
      // en bancos (match directo o porción asignada), la UI lo enseña y
      // ofrece adoptarlo como el cobro de la estimación.
      invoice: {
        select: {
          id: true,
          uuid: true,
          serie: true,
          folio: true,
          fecha: true,
          total: true,
          bankTransactions: { where: { status: "MATCHED" }, select: btSelect },
          conciliacionDetalles: {
            select: { montoAsignado: true, bankTransaction: { select: btSelect } },
          },
        },
      },
      bankTransaction: { select: btSelect },
    },
    orderBy: { numero: "asc" },
  });

  // Cobros conciliados del CFDI (dedup por movimiento): match directo ∪
  // porciones. Es lo que la UI enseña como "cobro identificado en bancos".
  const estimaciones = rows.map((e) => {
    const cobros = new Map<string, { id: string; fecha: Date; monto: number; referencia: string | null; banco: string | null }>();
    for (const bt of e.invoice?.bankTransactions ?? []) {
      cobros.set(bt.id, {
        id: bt.id,
        fecha: bt.fecha,
        monto: Math.abs(Number(bt.monto)),
        referencia: bt.referencia,
        banco: bt.bankAccount ? `${bt.bankAccount.banco} · ${bt.bankAccount.nombre}` : null,
      });
    }
    for (const d of e.invoice?.conciliacionDetalles ?? []) {
      const bt = d.bankTransaction;
      if (!cobros.has(bt.id)) {
        cobros.set(bt.id, {
          id: bt.id,
          fecha: bt.fecha,
          monto: Math.abs(Number(d.montoAsignado)),
          referencia: bt.referencia,
          banco: bt.bankAccount ? `${bt.bankAccount.banco} · ${bt.bankAccount.nombre}` : null,
        });
      }
    }
    return { ...e, cobrosConciliados: [...cobros.values()] };
  });

  return NextResponse.json(estimaciones);
});
