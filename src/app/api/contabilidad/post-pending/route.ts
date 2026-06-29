import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthzError, requireWriter } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { postMonthIfDraft } from "@/lib/contabilidad/posting";
import type { Prisma } from "@prisma/client";

const schema = z.object({
  companyId: z.string().min(1),
  year: z.number().int().min(2000).max(2100).optional(),
});

// POST /api/contabilidad/post-pending
// Body: { companyId, year? }
//
// Cierra/actualiza en lote todos los meses con CFDIs que aún están en DRAFT
// (o no existen como periodo). Usa postMonthIfDraft, que es CONSERVADOR:
//   - nunca toca periodos POSTED/CLOSED
//   - nunca postea un periodo que ya tenga asientos MANUAL (los preservaría el
//     usuario re-posteando manualmente)
//   - sólo postea meses que tengan al menos un CFDI
//
// Si se pasa `year`, se limita a ese ejercicio; de lo contrario barre todos los
// meses con CFDIs de la empresa.
export async function POST(req: Request) {
  try {
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos" }, { status: 400 });
    }
    const { companyId, year } = parsed.data;

    await requireWriter(companyId);

    // Descubre los (year, month) que tienen CFDIs STAMPED relevantes.
    const where: Prisma.InvoiceWhereInput = {
      companyId,
      status: "STAMPED",
      tipo: { in: ["INGRESO", "EGRESO", "NOMINA"] },
      ...(year
        ? {
            fecha: {
              gte: new Date(Date.UTC(year, 0, 1)),
              lt: new Date(Date.UTC(year + 1, 0, 1)),
            },
          }
        : {}),
    };

    const invoices = await prisma.invoice.findMany({
      where,
      select: { fecha: true },
    });

    // Junta los periodos únicos (UTC, igual que monthRange en posting.ts).
    const periodSet = new Set<string>();
    for (const inv of invoices) {
      const d = inv.fecha;
      periodSet.add(`${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`);
    }

    const periods = Array.from(periodSet)
      .map((k) => {
        const [y, m] = k.split("-").map(Number);
        return { year: y, month: m };
      })
      .sort((a, b) => a.year - b.year || a.month - b.month);

    let posted = 0;
    let skippedManual = 0;
    let skippedPosted = 0;
    const errors: string[] = [];

    for (const p of periods) {
      try {
        const r = await postMonthIfDraft(companyId, p.year, p.month);
        if (r.posted) posted++;
        else if (r.reason === "HAS_MANUAL_ENTRIES") skippedManual++;
        else if (r.reason === "ALREADY_POSTED") skippedPosted++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "error";
        errors.push(`${p.year}-${String(p.month).padStart(2, "0")}: ${msg}`);
      }
    }

    return NextResponse.json({
      ok: true,
      posted,
      skippedManual,
      skippedPosted,
      errors,
    });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    const msg = e instanceof Error ? e.message : "Error al actualizar los meses pendientes";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
