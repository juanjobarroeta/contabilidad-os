import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, getEffectiveCompanyMembership, requireUser } from "@/lib/authz";
import { gateEscritura } from "@/lib/subscription";
import { COE_CODES } from "@/lib/contabilidad/catalog";

// Inventario periódico (Fase 1): el conteo físico del mes que postMonth
// convierte en costo de venta (inicial + entradas − conteo → DR 501/CR 115).
//
// GET  ?companyId&year&month → { aplica, conteo }
//   `aplica` = la cuenta de inventario tiene vida (asientos en 115) o hay
//   compras del período con naturaleza INVENTARIO — para que la carta en
//   Cierre no sea ruido en empresas de puros servicios.
// POST { companyId, year, month, valorFinal, notas? } → upsert. Un período
//   CLOSED no se toca (misma disciplina que las pólizas).

async function member(req: Request, companyId: string) {
  const user = await requireUser(req);
  const m = await getEffectiveCompanyMembership(user.id, companyId);
  return { user, m };
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const companyId = searchParams.get("companyId") ?? "";
    const year = Number(searchParams.get("year"));
    const month = Number(searchParams.get("month"));
    if (!companyId || !Number.isFinite(year) || !Number.isFinite(month)) {
      return NextResponse.json({ error: "companyId, year y month requeridos" }, { status: 400 });
    }
    const { m } = await member(req, companyId);
    if (!m) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

    const cta = await prisma.chartAccount.findFirst({
      where: { companyId, OR: [{ subcuenta: COE_CODES.INVENTARIO }, { cuentaSAT: COE_CODES.INVENTARIO }] },
      select: { id: true },
    });
    const [asientos115, comprasInventario, conteo] = await Promise.all([
      cta
        ? prisma.accountingEntry.count({ where: { companyId, chartAccountId: cta.id }, take: 1 })
        : Promise.resolve(0),
      prisma.invoice.count({
        where: {
          companyId, tipo: "EGRESO", status: "STAMPED", naturaleza: "INVENTARIO",
          fecha: {
            gte: new Date(Date.UTC(year, Math.min(month, 13) - 1, 1)),
            lt: new Date(Date.UTC(year, Math.min(month, 12), 1)),
          },
        },
        take: 1,
      }),
      prisma.inventarioConteo.findUnique({
        where: { companyId_year_month: { companyId, year, month } },
        select: { valorFinal: true, notas: true, updatedAt: true },
      }),
    ]);

    return NextResponse.json({
      aplica: asientos115 > 0 || comprasInventario > 0 || conteo !== null,
      conteo: conteo
        ? { valorFinal: Number(conteo.valorFinal), notas: conteo.notas, updatedAt: conteo.updatedAt }
        : null,
    });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const companyId = String(body?.companyId ?? "");
    const year = Number(body?.year);
    const month = Number(body?.month);
    const valorFinal = Number(body?.valorFinal);
    if (!companyId || !Number.isFinite(year) || !Number.isFinite(month)) {
      return NextResponse.json({ error: "companyId, year y month requeridos" }, { status: 400 });
    }
    if (!Number.isFinite(valorFinal) || valorFinal < 0) {
      return NextResponse.json({ error: "valorFinal debe ser un monto ≥ 0" }, { status: 422 });
    }
    const { user, m } = await member(req, companyId);
    if (!m || m.role === "VIEWER") return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
    const gate = await gateEscritura(user.id);
    if (gate) return gate;

    const period = await prisma.accountingPeriod.findUnique({
      where: { companyId_year_month: { companyId, year, month } },
      select: { status: true },
    });
    if (period?.status === "CLOSED") {
      return NextResponse.json(
        { error: "El período está cerrado — reábrelo para cambiar el conteo." },
        { status: 409 },
      );
    }

    const conteo = await prisma.inventarioConteo.upsert({
      where: { companyId_year_month: { companyId, year, month } },
      update: { valorFinal, notas: body?.notas ?? null },
      create: { companyId, year, month, valorFinal, notas: body?.notas ?? null },
    });
    return NextResponse.json({
      ok: true,
      conteo: { valorFinal: Number(conteo.valorFinal), notas: conteo.notas },
    });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
