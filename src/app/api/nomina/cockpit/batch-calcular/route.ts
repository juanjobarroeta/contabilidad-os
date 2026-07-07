import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { createPayrollRun } from "@/lib/nomina/payroll-run";
import type { PayrollRunType } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/nomina/cockpit/batch-calcular — calcula la quincena en LOTE para
// varias empresas desde el cockpit del despacho. Acción SEGURA y reversible:
// sólo CREA + CALCULA corridas (status=CALCULATED). NO timbra (sin Facturapi /
// CFDI) y NO dispersa. Reutiliza createPayrollRun() — no recalcula nada aquí.
//
// Reglas de omisión por empresa (no aborta el lote):
//  - Sin permiso de escritura (VIEWER o sin acceso): skipped "sin permisos".
//  - Idempotencia: ya existe una PayrollRun no-DRAFT para el MISMO periodo
//    (periodoInicio/periodoFin): skipped "ya tiene corrida".
//  - Sin empleados activos: skipped "sin empleados".
// ─────────────────────────────────────────────────────────────────────────────

// Petición de larga duración (calcula la nómina completa de varias empresas
// en secuencia) — mismo patrón que api/ai/chat/route.ts.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type BatchResult = {
  companyId: string;
  razonSocial: string;
  runId?: string;
  itemCount?: number;
  totalNeto?: number;
  skipped?: string;
  error?: string;
  warnings?: string[];
};

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;

  const body = await req.json();
  const { companyIds, tipo, periodoInicio, periodoFin, fechaPago, diasPagados } = body as {
    companyIds?: string[];
    tipo?: PayrollRunType;
    periodoInicio?: string;
    periodoFin?: string;
    fechaPago?: string;
    diasPagados?: number;
  };

  if (!Array.isArray(companyIds) || companyIds.length === 0) {
    return NextResponse.json({ error: "companyIds requerido" }, { status: 400 });
  }
  if (!tipo || !periodoInicio || !periodoFin || !fechaPago || !diasPagados) {
    return NextResponse.json({ error: "Faltan campos requeridos" }, { status: 400 });
  }

  const inicio = new Date(periodoInicio);
  const fin = new Date(periodoFin);
  const pago = new Date(fechaPago);
  const dias = Number(diasPagados);
  // Mismo formato de periodo que createPayrollRun, para cotejar idempotencia.
  const periodoKey = `${inicio.toISOString().split("T")[0]}/${fin.toISOString().split("T")[0]}`;

  // Deduplicar ids por si acaso.
  const ids = Array.from(new Set(companyIds));

  const results: BatchResult[] = [];

  // Secuencial: es puro DB/CPU, sin llamadas externas, y evita saturar el pool.
  for (const companyId of ids) {
    // Razón social para el reporte (y para validar que la empresa existe).
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { razonSocial: true },
    });
    const razonSocial = company?.razonSocial ?? companyId;

    try {
      // AUTZ por empresa: misma comprobación que /api/nomina/run.
      const member = await getEffectiveCompanyMembership(userId, companyId);
      if (!member || member.role === "VIEWER") {
        results.push({ companyId, razonSocial, skipped: "sin permisos" });
        continue;
      }

      // IDEMPOTENCIA: ¿ya hay corrida no-DRAFT para el mismo periodo?
      const existente = await prisma.payrollRun.findFirst({
        where: { companyId, periodo: periodoKey, status: { not: "DRAFT" } },
        select: { id: true },
      });
      if (existente) {
        results.push({ companyId, razonSocial, skipped: "ya tiene corrida" });
        continue;
      }

      // Sin empleados activos → omitir (createPayrollRun también lo rechaza,
      // pero lo distinguimos para un reporte claro).
      const activos = await prisma.employee.count({
        where: { companyId, isActive: true },
      });
      if (activos === 0) {
        results.push({ companyId, razonSocial, skipped: "sin empleados" });
        continue;
      }

      const result = await createPayrollRun({
        companyId,
        tipo,
        periodoInicio: inicio,
        periodoFin: fin,
        fechaPago: pago,
        diasPagados: dias,
      });

      if (!result.ok) {
        results.push({ companyId, razonSocial, error: result.error ?? "Error al calcular" });
        continue;
      }

      const warnings: string[] = [];
      if (result.tarifaWarning) warnings.push(result.tarifaWarning);
      if (result.salarioMinimoWarning) warnings.push(result.salarioMinimoWarning);

      results.push({
        companyId,
        razonSocial,
        runId: result.runId,
        itemCount: result.itemCount,
        totalNeto: result.totalNeto,
        warnings: warnings.length ? warnings : undefined,
      });
    } catch (e) {
      results.push({
        companyId,
        razonSocial,
        error: e instanceof Error ? e.message : "Error desconocido",
      });
    }
  }

  const creados = results.filter((r) => r.runId).length;
  const omitidos = results.filter((r) => r.skipped).length;
  const errores = results.filter((r) => r.error).length;

  return NextResponse.json({ ok: true, results, creados, omitidos, errores });
}
