import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";
import { recalcularPayrollRun } from "@/lib/nomina/payroll-run";
import { rangoDelPeriodo } from "@/lib/nomina/incidencias";
import type { IncidenciaTipo, Incidencia } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// Incidencias — CRUD for absences, overtime, sick leave, bonuses, etc.
//
// GET  /api/nomina/incidencias?companyId=xxx&periodo=2026-04
// POST /api/nomina/incidencias — create one or many, or delete
//
// Reglas de escritura:
// - VIEWER no escribe (403).
// - No se captura ni elimina una incidencia cuya fecha cae en el periodo de
//   una corrida ordinaria ya TIMBRADA para ese empleado (los CFDIs emitidos
//   no cambian) — 409.
// - Si el cliente manda `payrollRunId`, tras la mutación se recalcula ese
//   empleado en la corrida con el motor (calcularNomina) — los importes nunca
//   se editan a mano.
// - Bitácora: nomina.incidencia.agregar / nomina.incidencia.eliminar (sólo
//   metadatos, sin notas de texto libre).
// ─────────────────────────────────────────────────────────────────────────────

const TIPOS_VALIDOS: IncidenciaTipo[] = [
  "FALTA", "FALTA_JUSTIFICADA", "INCAPACIDAD", "PERMISO_CON_GOCE",
  "PERMISO_SIN_GOCE", "HORAS_EXTRA", "VACACIONES", "RETARDO",
  "BONO", "COMISION", "DESCUENTO",
];
const TIPOS_CON_MONTO: IncidenciaTipo[] = ["BONO", "COMISION", "DESCUENTO"];

/** Corrida ordinaria TIMBRADA/PAGADA de la empresa cuyo periodo traslapa
 *  [fecha, fechaFin] y que incluye al empleado — bloquea la mutación. */
async function periodoTimbrado(
  companyId: string,
  employeeId: string,
  fecha: Date,
  fechaFin: Date | null
): Promise<string | null> {
  const runs = await prisma.payrollRun.findMany({
    where: {
      companyId,
      tipo: "ORDINARIA",
      status: { in: ["STAMPED", "PAID"] },
      items: { some: { employeeId } },
    },
    select: { periodo: true },
  });
  const desde = fecha;
  const hasta = fechaFin ?? fecha;
  for (const run of runs) {
    const rango = rangoDelPeriodo(run.periodo);
    if (!rango) continue;
    if (desde <= rango.fin && hasta >= rango.inicio) return run.periodo;
  }
  return null;
}

/** Valida la corrida destino de un recálculo automático. */
async function validarRunParaRecalculo(payrollRunId: string, companyId: string, employeeId: string) {
  const run = await prisma.payrollRun.findUnique({
    where: { id: payrollRunId },
    select: { id: true, companyId: true, status: true, tipo: true, origen: true, periodo: true },
  });
  if (!run || run.companyId !== companyId) {
    return { error: "Corrida no encontrada", status: 404 as const };
  }
  if (run.status === "STAMPED" || run.status === "PAID") {
    return {
      error: "La corrida ya está timbrada — las incidencias del periodo no se pueden modificar.",
      status: 409 as const,
    };
  }
  if (run.origen === "SAT") {
    return { error: "Las corridas importadas del SAT son histórico de sólo lectura.", status: 400 as const };
  }
  if (run.tipo !== "ORDINARIA") {
    return { error: "Las incidencias sólo aplican a corridas ordinarias.", status: 400 as const };
  }
  const item = await prisma.payrollItem.findFirst({
    where: { payrollRunId, employeeId },
    select: { id: true },
  });
  if (!item) return { error: "El empleado no pertenece a esta corrida.", status: 400 as const };
  return { run };
}

/** Metadatos de bitácora de una incidencia (sin notas de texto libre). */
function metadatosIncidencia(inc: Incidencia, payrollRunId?: string | null) {
  return {
    employeeId: inc.employeeId,
    tipo: inc.tipo,
    fecha: inc.fecha.toISOString().slice(0, 10),
    dias: inc.dias,
    horas: inc.horas,
    horasTriples: inc.horasTriples,
    monto: inc.monto,
    periodo: inc.periodo,
    payrollRunId: payrollRunId ?? null,
  };
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const periodo = searchParams.get("periodo"); // e.g. "2026-04"
  const employeeId = searchParams.get("employeeId");

  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const where: Record<string, unknown> = { companyId };
  if (periodo) where.periodo = periodo;
  if (employeeId) where.employeeId = employeeId;

  const incidencias = await prisma.incidencia.findMany({
    where,
    include: {
      employee: {
        select: { nombre: true, apellidoPaterno: true, apellidoMaterno: true, rfc: true, nss: true },
      },
    },
    orderBy: { fecha: "desc" },
  });

  // Summary by type
  const summary: Record<string, { count: number; dias: number }> = {};
  for (const inc of incidencias) {
    if (!summary[inc.tipo]) summary[inc.tipo] = { count: 0, dias: 0 };
    summary[inc.tipo].count++;
    summary[inc.tipo].dias += inc.dias;
  }

  return NextResponse.json({ incidencias, summary, total: incidencias.length });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { companyId, action } = body;

  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  // Single incidencia creation
  if (!action || action === "create") {
    const {
      employeeId, tipo, fecha, fechaFin, dias, horas, horasTriples, monto,
      folioImss, ramoImss, notas, periodo, payrollRunId,
    } = body;

    if (!employeeId || !tipo || !fecha) {
      return NextResponse.json({ error: "employeeId, tipo y fecha requeridos" }, { status: 400 });
    }
    if (!TIPOS_VALIDOS.includes(tipo)) {
      return NextResponse.json({ error: `Tipo de incidencia inválido: ${tipo}` }, { status: 400 });
    }

    // Validación por tipo: las incidencias económicas requieren monto; las de
    // horas extra requieren horas.
    const montoNum = monto !== undefined && monto !== null && monto !== "" ? Number(monto) : null;
    const horasNum = horas !== undefined && horas !== null && horas !== "" ? Number(horas) : null;
    const horasTriplesNum =
      horasTriples !== undefined && horasTriples !== null && horasTriples !== "" ? Number(horasTriples) : null;
    if (TIPOS_CON_MONTO.includes(tipo)) {
      if (!montoNum || !Number.isFinite(montoNum) || montoNum <= 0) {
        return NextResponse.json({ error: "Este tipo de incidencia requiere un monto mayor a cero." }, { status: 400 });
      }
    }
    if (tipo === "HORAS_EXTRA" && !(horasNum && horasNum > 0) && !(horasTriplesNum && horasTriplesNum > 0)) {
      return NextResponse.json({ error: "Captura las horas extra (dobles y/o triples)." }, { status: 400 });
    }

    // Validate employee belongs to company
    const emp = await prisma.employee.findFirst({
      where: { id: employeeId, companyId },
      select: { id: true },
    });
    if (!emp) return NextResponse.json({ error: "Empleado no encontrado" }, { status: 404 });

    // Los periodos ya timbrados no cambian: los CFDIs ya se emitieron.
    const fechaDate = new Date(fecha);
    const fechaFinDate = fechaFin ? new Date(fechaFin) : null;
    const timbrado = await periodoTimbrado(companyId, employeeId, fechaDate, fechaFinDate);
    if (timbrado) {
      return NextResponse.json(
        { error: `El periodo ${timbrado} ya está timbrado para este empleado — la incidencia no se puede capturar.` },
        { status: 409 }
      );
    }

    // Si viene ligada a una corrida, validar la corrida y que la fecha caiga
    // dentro de su periodo (de lo contrario no alimentaría el cálculo).
    if (payrollRunId) {
      const val = await validarRunParaRecalculo(payrollRunId, companyId, employeeId);
      if ("error" in val) return NextResponse.json({ error: val.error }, { status: val.status });
      const rango = rangoDelPeriodo(val.run.periodo);
      if (rango && (fechaDate < rango.inicio || fechaDate > rango.fin)) {
        return NextResponse.json(
          { error: `La fecha debe caer dentro del periodo de la corrida (${val.run.periodo}).` },
          { status: 400 }
        );
      }
    }

    // Auto-calculate dias if fechaFin provided
    let calculatedDias = dias ? Number(dias) : 1;
    if (fechaFin && !dias) {
      const start = new Date(fecha);
      const end = new Date(fechaFin);
      calculatedDias = Math.max(1, Math.floor((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1);
    }

    // Auto-derive periodo from fecha
    const derivedPeriodo = periodo ?? `${fechaDate.getFullYear()}-${String(fechaDate.getMonth() + 1).padStart(2, "0")}`;

    const incidencia = await prisma.incidencia.create({
      data: {
        companyId,
        employeeId,
        tipo,
        fecha: fechaDate,
        fechaFin: fechaFinDate,
        dias: calculatedDias,
        horas: horasNum,
        horasTriples: horasTriplesNum,
        monto: montoNum,
        folioImss: folioImss ?? null,
        ramoImss: ramoImss ?? null,
        notas: notas ?? null,
        periodo: derivedPeriodo,
      },
    });

    registrarBitacora({
      companyId,
      userId: session.user.id,
      actorEmail: session.user.email ?? null,
      accion: "nomina.incidencia.agregar",
      entidad: "Incidencia",
      entidadId: incidencia.id,
      detalle: metadatosIncidencia(incidencia, payrollRunId),
      req,
    });

    // Recalcular al empleado en la corrida — nunca se editan importes a mano.
    let recalculo = null;
    if (payrollRunId) {
      recalculo = await recalcularPayrollRun(payrollRunId, employeeId);
    }

    return NextResponse.json({ ok: true, incidencia, recalculo }, { status: 201 });
  }

  // Bulk creation (from clock-in system import or AI)
  if (action === "bulk-create") {
    const { incidencias } = body as {
      incidencias: {
        employeeId: string;
        tipo: string;
        fecha: string;
        fechaFin?: string;
        dias?: number;
        horas?: number;
        horasTriples?: number;
        monto?: number;
        notas?: string;
      }[];
    };

    if (!incidencias?.length) {
      return NextResponse.json({ error: "incidencias array requerido" }, { status: 400 });
    }

    let created = 0;
    const errors: string[] = [];

    for (const inc of incidencias) {
      try {
        if (!TIPOS_VALIDOS.includes(inc.tipo as IncidenciaTipo)) {
          errors.push(`${inc.employeeId}: tipo inválido ${inc.tipo}`);
          continue;
        }
        const fechaDate = new Date(inc.fecha);
        const periodo = `${fechaDate.getFullYear()}-${String(fechaDate.getMonth() + 1).padStart(2, "0")}`;

        // Mismo candado que la captura individual: sin cambios en periodos timbrados.
        const timbrado = await periodoTimbrado(
          companyId, inc.employeeId, fechaDate, inc.fechaFin ? new Date(inc.fechaFin) : null
        );
        if (timbrado) {
          errors.push(`${inc.employeeId}: el periodo ${timbrado} ya está timbrado`);
          continue;
        }

        let dias = inc.dias ?? 1;
        if (inc.fechaFin && !inc.dias) {
          const end = new Date(inc.fechaFin);
          dias = Math.max(1, Math.floor((end.getTime() - fechaDate.getTime()) / (1000 * 60 * 60 * 24)) + 1);
        }

        await prisma.incidencia.create({
          data: {
            companyId,
            employeeId: inc.employeeId,
            tipo: inc.tipo as IncidenciaTipo,
            fecha: fechaDate,
            fechaFin: inc.fechaFin ? new Date(inc.fechaFin) : null,
            dias,
            horas: inc.horas ?? null,
            horasTriples: inc.horasTriples ?? null,
            monto: inc.monto ?? null,
            notas: inc.notas ?? null,
            periodo,
          },
        });
        created++;
      } catch (e) {
        errors.push(`${inc.employeeId}: ${e instanceof Error ? e.message : "Error"}`);
      }
    }

    if (created > 0) {
      registrarBitacora({
        companyId,
        userId: session.user.id,
        actorEmail: session.user.email ?? null,
        accion: "nomina.incidencia.agregar",
        entidad: "Incidencia",
        detalle: { bulk: true, creadas: created, errores: errors.length },
        req,
      });
    }

    return NextResponse.json({ ok: errors.length === 0, created, errors });
  }

  // Delete
  if (action === "delete") {
    const { incidenciaId, payrollRunId } = body;
    if (!incidenciaId) return NextResponse.json({ error: "incidenciaId requerido" }, { status: 400 });

    const incidencia = await prisma.incidencia.findFirst({
      where: { id: incidenciaId, companyId },
    });
    if (!incidencia) return NextResponse.json({ error: "Incidencia no encontrada" }, { status: 404 });

    // Igual que al capturar: si su periodo ya se timbró para el empleado, la
    // incidencia queda como soporte del CFDI emitido y no se elimina.
    const timbrado = await periodoTimbrado(
      companyId, incidencia.employeeId, incidencia.fecha, incidencia.fechaFin
    );
    if (timbrado) {
      return NextResponse.json(
        { error: `El periodo ${timbrado} ya está timbrado para este empleado — la incidencia no se puede eliminar.` },
        { status: 409 }
      );
    }

    if (payrollRunId) {
      const val = await validarRunParaRecalculo(payrollRunId, companyId, incidencia.employeeId);
      if ("error" in val) return NextResponse.json({ error: val.error }, { status: val.status });
    }

    await prisma.incidencia.delete({ where: { id: incidencia.id } });

    registrarBitacora({
      companyId,
      userId: session.user.id,
      actorEmail: session.user.email ?? null,
      accion: "nomina.incidencia.eliminar",
      entidad: "Incidencia",
      entidadId: incidencia.id,
      detalle: metadatosIncidencia(incidencia, payrollRunId),
      req,
    });

    let recalculo = null;
    if (payrollRunId) {
      recalculo = await recalcularPayrollRun(payrollRunId, incidencia.employeeId);
    }

    return NextResponse.json({ ok: true, recalculo });
  }

  return NextResponse.json({ error: "action inválido" }, { status: 400 });
}
