import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// Incidencias — CRUD for absences, overtime, sick leave, etc.
//
// GET  /api/nomina/incidencias?companyId=xxx&periodo=2026-04
// POST /api/nomina/incidencias — create one or many
// ─────────────────────────────────────────────────────────────────────────────

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
    const { employeeId, tipo, fecha, fechaFin, dias, horas, folioImss, ramoImss, notas, periodo } = body;

    if (!employeeId || !tipo || !fecha) {
      return NextResponse.json({ error: "employeeId, tipo y fecha requeridos" }, { status: 400 });
    }

    // Validate employee belongs to company
    const emp = await prisma.employee.findFirst({
      where: { id: employeeId, companyId },
      select: { id: true },
    });
    if (!emp) return NextResponse.json({ error: "Empleado no encontrado" }, { status: 404 });

    // Auto-calculate dias if fechaFin provided
    let calculatedDias = dias ? Number(dias) : 1;
    if (fechaFin && !dias) {
      const start = new Date(fecha);
      const end = new Date(fechaFin);
      calculatedDias = Math.max(1, Math.floor((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1);
    }

    // Auto-derive periodo from fecha
    const fechaDate = new Date(fecha);
    const derivedPeriodo = periodo ?? `${fechaDate.getFullYear()}-${String(fechaDate.getMonth() + 1).padStart(2, "0")}`;

    const incidencia = await prisma.incidencia.create({
      data: {
        companyId,
        employeeId,
        tipo,
        fecha: new Date(fecha),
        fechaFin: fechaFin ? new Date(fechaFin) : null,
        dias: calculatedDias,
        horas: horas ? Number(horas) : null,
        folioImss: folioImss ?? null,
        ramoImss: ramoImss ?? null,
        notas: notas ?? null,
        periodo: derivedPeriodo,
      },
    });

    return NextResponse.json({ ok: true, incidencia }, { status: 201 });
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
        const fechaDate = new Date(inc.fecha);
        const periodo = `${fechaDate.getFullYear()}-${String(fechaDate.getMonth() + 1).padStart(2, "0")}`;

        let dias = inc.dias ?? 1;
        if (inc.fechaFin && !inc.dias) {
          const end = new Date(inc.fechaFin);
          dias = Math.max(1, Math.floor((end.getTime() - fechaDate.getTime()) / (1000 * 60 * 60 * 24)) + 1);
        }

        await prisma.incidencia.create({
          data: {
            companyId,
            employeeId: inc.employeeId,
            tipo: inc.tipo as "FALTA" | "FALTA_JUSTIFICADA" | "INCAPACIDAD" | "PERMISO_CON_GOCE" | "PERMISO_SIN_GOCE" | "HORAS_EXTRA" | "VACACIONES" | "RETARDO",
            fecha: fechaDate,
            fechaFin: inc.fechaFin ? new Date(inc.fechaFin) : null,
            dias,
            horas: inc.horas ?? null,
            notas: inc.notas ?? null,
            periodo,
          },
        });
        created++;
      } catch (e) {
        errors.push(`${inc.employeeId}: ${e instanceof Error ? e.message : "Error"}`);
      }
    }

    return NextResponse.json({ ok: errors.length === 0, created, errors });
  }

  // Delete
  if (action === "delete") {
    const { incidenciaId } = body;
    if (!incidenciaId) return NextResponse.json({ error: "incidenciaId requerido" }, { status: 400 });

    await prisma.incidencia.deleteMany({
      where: { id: incidenciaId, companyId },
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "action inválido" }, { status: 400 });
}
