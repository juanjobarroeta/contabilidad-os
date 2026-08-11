import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, isOperador, requireUser } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";
import { calcularScoreCredito } from "@/lib/credito/score";
import { cargarInsumosCredito } from "@/lib/credito/insumos";
import { generarAnalisisCredito } from "@/lib/credito/analisis";

// ─────────────────────────────────────────────────────────────────────────────
// Portal de crédito — SÓLO operador de plataforma. Es el negocio de crédito
// del operador, no parte de la operación contable de las empresas.
//
// GET  /api/creditos                → portafolio: empresas activas con su
//                                     última evaluación (si existe).
// GET  /api/creditos?companyId=xxx  → historial de evaluaciones de la empresa.
// POST /api/creditos { companyId }  → evalúa AHORA (carga insumos, corre el
//                                     score y guarda el snapshot inmutable).
// PATCH /api/creditos { id, decision?, notas? } → registra la resolución
//                                     humana; score/desglose NUNCA se editan.
// ─────────────────────────────────────────────────────────────────────────────

async function requireOperador(req: Request): Promise<{ id: string } | NextResponse> {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  if (!(await isOperador(user.id))) {
    return NextResponse.json({ error: "Sólo el operador de plataforma" }, { status: 403 });
  }
  return user;
}

export async function GET(req: Request) {
  const user = await requireOperador(req);
  if (user instanceof NextResponse) return user;

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");

  if (companyId) {
    const evaluaciones = await prisma.creditoEvaluacion.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return NextResponse.json({ evaluaciones });
  }

  // Portafolio: todas las empresas activas + su última evaluación.
  const companies = await prisma.company.findMany({
    where: { isActive: true },
    select: { id: true, rfc: true, razonSocial: true, regimenFiscal: true, tier: true },
    orderBy: { razonSocial: "asc" },
  });
  const ultimas = await prisma.creditoEvaluacion.findMany({
    orderBy: { createdAt: "desc" },
    distinct: ["companyId"],
    select: {
      companyId: true, score: true, banda: true, limiteSugerido: true,
      provisional: true, decision: true, createdAt: true,
    },
  });
  const porCompany = new Map(ultimas.map((e) => [e.companyId, e]));
  return NextResponse.json({
    portafolio: companies.map((c) => ({ ...c, ultimaEvaluacion: porCompany.get(c.id) ?? null })),
  });
}

export async function POST(req: Request) {
  const user = await requireOperador(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => ({}));
  const companyId = String(body?.companyId ?? "").trim();
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, rfc: true, razonSocial: true, regimenFiscal: true },
  });
  if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

  const insumos = await cargarInsumosCredito(companyId);
  const resultado = calcularScoreCredito(insumos);

  // Memo de IA: parte del snapshot. Best-effort — si Claude falla, la
  // evaluación se guarda sin memo (el score numérico no depende de la IA).
  const analisis = await generarAnalisisCredito({
    razonSocial: company.razonSocial,
    rfc: company.rfc,
    regimenFiscal: company.regimenFiscal,
    resultado,
    insumos,
    companyId,
  });

  const evaluacion = await prisma.creditoEvaluacion.create({
    data: {
      companyId,
      createdByUserId: user.id,
      score: resultado.score,
      banda: resultado.banda,
      limiteSugerido: resultado.limiteSugerido,
      provisional: resultado.provisional,
      // Snapshot íntegro: desglose + insumos tal como se evaluaron hoy.
      detalle: JSON.parse(
        JSON.stringify({
          dimensiones: resultado.dimensiones,
          insumos,
          flujoLibreMensual: resultado.flujoLibreMensual,
          pagoMensualMax: resultado.pagoMensualMax,
          capacidadDesglose: resultado.capacidadDesglose,
        }),
      ),
      cobertura: resultado.cobertura,
      analisis,
    },
  });

  registrarBitacora({
    accion: "credito.evaluar",
    userId: user.id,
    companyId,
    entidad: "CreditoEvaluacion",
    entidadId: evaluacion.id,
    detalle: { score: resultado.score, banda: resultado.banda, provisional: resultado.provisional },
  });

  return NextResponse.json({ evaluacion });
}

export async function PATCH(req: Request) {
  const user = await requireOperador(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => ({}));
  const id = String(body?.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "id requerido" }, { status: 400 });

  const existing = await prisma.creditoEvaluacion.findUnique({ where: { id }, select: { id: true, companyId: true } });
  if (!existing) return NextResponse.json({ error: "Evaluación no encontrada" }, { status: 404 });

  const updated = await prisma.creditoEvaluacion.update({
    where: { id },
    data: {
      ...(body.decision !== undefined ? { decision: body.decision ? String(body.decision) : null } : {}),
      ...(body.notas !== undefined ? { notas: body.notas ? String(body.notas) : null } : {}),
    },
  });

  registrarBitacora({
    accion: "credito.resolver",
    userId: user.id,
    companyId: existing.companyId,
    entidad: "CreditoEvaluacion",
    entidadId: id,
    detalle: { decision: updated.decision },
  });

  return NextResponse.json({ evaluacion: updated });
}
