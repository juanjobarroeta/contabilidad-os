import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership, requireUser, AuthzError } from "@/lib/authz";
import { rangoDelPeriodo } from "@/lib/nomina/incidencias";
import { descargasPorUuid } from "@/lib/nomina/recibos-descarga";
import { normalizarUuid } from "@/lib/fiscal/uuid";
import type { Incidencia } from "@prisma/client";

type Params = { params: Promise<{ id: string }> };

// GET /api/nomina/run/[id]
// Incluye las incidencias del periodo de la corrida (ORDINARIA): alimentan el
// chip de resumen y la captura por empleado en el detalle antes de timbrar.
// Autz: sesión web O token de servicio (Bearer) — ZionX espeja el detalle.
export async function GET(req: Request, { params }: Params) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { id } = await params;
  const run = await prisma.payrollRun.findUnique({
    where: { id },
    include: {
      items: {
        include: { employee: { select: { nombre: true, apellidoPaterno: true, rfc: true } } },
      },
    },
  });

  if (!run) return NextResponse.json({ error: "Corrida no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(user.id, run.companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  // Incidencias cuya fecha cae dentro del periodo, de los empleados de la corrida.
  let incidencias: Incidencia[] = [];
  const rango = run.tipo === "ORDINARIA" ? rangoDelPeriodo(run.periodo) : null;
  if (rango && run.items.length > 0) {
    incidencias = await prisma.incidencia.findMany({
      where: {
        companyId: run.companyId,
        employeeId: { in: run.items.map((i) => i.employeeId) },
        fecha: { gte: rango.inicio, lte: rango.fin },
      },
      orderBy: { fecha: "asc" },
    });
  }

  // Descarga de recibos timbrados: se resuelve el Invoice de cada item por
  // UUID para que la UI enlace a /api/facturas/[invoiceId]/download.
  const descargas = await descargasPorUuid(run.companyId, run.items.map((i) => i.cfdiUuid));
  const items = run.items.map((i) => {
    const d = i.cfdiUuid ? descargas.get(normalizarUuid(i.cfdiUuid)) : undefined;
    return {
      ...i,
      invoiceId: d?.invoiceId ?? null,
      pdfDisponible: d?.pdfDisponible ?? false,
      xmlDisponible: d?.xmlDisponible ?? false,
    };
  });

  return NextResponse.json({ ...run, items, incidencias });
}

// DELETE /api/nomina/run/[id]
// Only DRAFT or CALCULATED runs can be deleted (not stamped — CFDIs already exist)
export async function DELETE(req: Request, { params }: Params) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { id } = await params;
  const run = await prisma.payrollRun.findUnique({
    where: { id },
    select: { id: true, companyId: true, status: true },
  });

  if (!run) return NextResponse.json({ error: "Corrida no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(user.id, run.companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  if (run.status === "STAMPED" || run.status === "PAID") {
    return NextResponse.json(
      { error: "No se puede eliminar una corrida timbrada. Los CFDIs ya fueron emitidos ante el SAT." },
      { status: 400 }
    );
  }

  // Delete items first (cascade should handle it, but explicit for safety)
  await prisma.payrollItem.deleteMany({ where: { payrollRunId: id } });
  await prisma.payrollRun.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
