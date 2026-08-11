import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireModule, requireWriter, withAuthz } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/automotriz/refacciones/conteo — conteo físico (fase 4b).
//
// Recibe las cantidades CONTADAS y registra un movimiento AJUSTE por la
// diferencia contra la existencia derivada (Σ kardex) de cada parte. El stock
// derivado de CFDIs es aproximado hasta el primer conteo — este endpoint es lo
// que lo vuelve confiable. No postea al ledger; la valuación fiscal del
// inventario sigue siendo tema del cierre.
// ─────────────────────────────────────────────────────────────────────────────

const r2 = (n: number) => Math.round(n * 100) / 100;

const schema = z.object({
  companyId: z.string().min(1),
  items: z
    .array(
      z.object({
        refaccionId: z.string().min(1),
        cantidadContada: z.number().min(0).max(1_000_000),
      })
    )
    .min(1)
    .max(500),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { companyId, items } = parsed.data;

  await requireWriter(companyId, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  // Una cantidad por parte (el último renglón gana si el conteo repitió).
  const contadas = new Map(items.map((i) => [i.refaccionId, i.cantidadContada]));
  const ids = [...contadas.keys()];

  const [refacciones, sumas] = await Promise.all([
    prisma.refaccion.findMany({
      where: { id: { in: ids }, companyId },
      select: { id: true, numeroParte: true },
    }),
    prisma.refaccionMovimiento.groupBy({
      by: ["refaccionId"],
      where: { refaccionId: { in: ids } },
      _sum: { cantidad: true },
    }),
  ]);
  if (refacciones.length !== ids.length) {
    return NextResponse.json({ error: "Alguna refacción no existe o no es de esta empresa" }, { status: 400 });
  }
  const existencias = new Map(sumas.map((s) => [s.refaccionId, s._sum.cantidad ?? 0]));

  const fecha = new Date();
  const ajustes: Array<{ refaccionId: string; numeroParte: string; existencia: number; contada: number; ajuste: number }> = [];
  for (const r of refacciones) {
    const existencia = r2(existencias.get(r.id) ?? 0);
    const contada = contadas.get(r.id)!;
    const ajuste = r2(contada - existencia);
    if (ajuste !== 0) ajustes.push({ refaccionId: r.id, numeroParte: r.numeroParte, existencia, contada, ajuste });
  }

  if (ajustes.length) {
    await prisma.refaccionMovimiento.createMany({
      data: ajustes.map((a) => ({
        refaccionId: a.refaccionId,
        invoiceId: null,
        tipo: "AJUSTE" as const,
        cantidad: a.ajuste,
        montoUnitario: null,
        fecha,
      })),
    });
  }

  return NextResponse.json({
    contadas: ids.length,
    ajustadas: ajustes.length,
    sinDiferencia: ids.length - ajustes.length,
    ajustes,
  });
});
