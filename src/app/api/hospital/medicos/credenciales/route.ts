/**
 * GET /api/hospital/medicos/credenciales?companyId=…[&todos=1]
 *
 * Tablero de credencialización: cada médico activo (todos con `todos=1`) con
 * su resumen (requisitos cumplidos, faltantes, por verificar, vencidos, por
 * vencer y el próximo vencimiento) y la lista de sus documentos SIN el
 * archivo. Ver src/lib/hospital/medico-credencial.ts.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error } from "@/lib/hospital/http";
import { resumenCredencial, selectDocumento } from "@/lib/hospital/medico-credencial";

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const hoy = new Date();
  const medicos = await prisma.hospMedico.findMany({
    where: { companyId, ...(searchParams.get("todos") === "1" ? {} : { activo: true }) },
    select: {
      id: true, nombre: true, especialidad: true, cedula: true, cedulaEspecialidad: true, telefono: true, email: true, activo: true,
      porCredencializar: true, credencialVerificadaAt: true, credencialVerificadaPor: true, credencialNotas: true, credencialSeguimiento: true, createdAt: true,
      documentos: { select: selectDocumento, orderBy: { createdAt: "desc" } },
    },
    orderBy: { nombre: "asc" },
  });
  const filas = medicos.map((m) => ({ ...m, resumen: resumenCredencial(m, m.documentos, hoy) }));
  const conteo = (f: (x: (typeof filas)[number]) => boolean) => filas.filter(f).length;
  return NextResponse.json({
    medicos: filas,
    totales: {
      medicos: filas.length,
      porCredencializar: conteo((m) => m.porCredencializar),
      completos: conteo((m) => m.resumen.estado === "COMPLETO"),
      porVencer: conteo((m) => m.resumen.estado === "POR_VENCER"),
      vencidos: conteo((m) => m.resumen.estado === "VENCIDO"),
      incompletos: conteo((m) => m.resumen.estado === "INCOMPLETO"),
      porVerificar: filas.reduce((s, m) => s + m.resumen.porVerificar, 0),
    },
  });
});
