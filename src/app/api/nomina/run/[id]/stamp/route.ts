import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, getEffectiveCompanyMembership, requireUser } from "@/lib/authz";
import { gateEscritura } from "@/lib/subscription";
import { stampPayrollRun, type StampOpciones } from "@/lib/nomina/payroll-run";
import { resolverFechaCfdi } from "@/lib/nomina/fecha-cfdi";
import { registrarBitacora } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

// POST /api/nomina/run/[id]/stamp
// Body opcional: { fechaCfdi?: "AAAA-MM-DD" } — fecha de emisión del CFDI
// (máx. 72 h atrás por regla SAT; el mes fiscal lo fija la FechaPago).
// Autz: sesión web O token de servicio (Bearer) — JCPT timbra la corrida que
// creó desde su roster. La emisión ante el SAT es idéntica y las mismas
// reglas aplican (membresía efectiva, VIEWER no timbra, gating de escritura).
export async function POST(req: Request, { params }: Params) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { id } = await params;
  const run = await prisma.payrollRun.findUnique({ where: { id }, select: { companyId: true } });
  if (!run) return NextResponse.json({ error: "Corrida no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(user.id, run.companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  // Gating de suscripción (bandera SUBSCRIPTION_ENFORCEMENT_ENABLED).
  const gate = await gateEscritura(user.id);
  if (gate) return gate;

  // Fecha de emisión opcional (el body puede venir vacío — comportamiento previo).
  const body = (await req.json().catch(() => null)) as { fechaCfdi?: unknown } | null;
  const opciones: StampOpciones = {};
  if (typeof body?.fechaCfdi === "string" && body.fechaCfdi) {
    const res = resolverFechaCfdi(body.fechaCfdi);
    if (res.error) return NextResponse.json({ error: res.error }, { status: 400 });
    if (res.fechaCfdi) opciones.fechaCfdi = res.fechaCfdi;
  }

  const result = await stampPayrollRun(id, opciones);

  // Bitácora de seguridad: timbrado de nómina (fire-and-forget).
  if (result.ok || result.stamped > 0) {
    registrarBitacora({
      companyId: run.companyId,
      userId: user.id,
      actorEmail: user.email ?? null,
      accion: "nomina.timbrar",
      entidad: "PayrollRun",
      entidadId: id,
      detalle: { stamped: result.stamped, total: result.total, errores: result.errors.length },
      req,
    });
  }

  return NextResponse.json(result);
}
