/**
 * POST /api/contabilidad/apertura/desde-ce { companyId, anio?, mes?, usar? }
 *   → genera el asiento de apertura (saldos iniciales) con la balanza que YA
 *     bajamos del SAT (CeBalanzaMes): la última si no se indica el mes.
 *     Mismo camino que subir el XML de la balanza (importarBalanzaParsed →
 *     postApertura, idempotente: reemplaza la apertura anterior y no toca
 *     asientos CFDI/NÓMINA/BANCO), sin pedirle a nadie un archivo que ya
 *     tenemos. `usar` "final" (arranque del mes siguiente, por defecto) o
 *     "inicial".
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireWriter, withAuthz } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";
import { AperturaError } from "@/lib/contabilidad/apertura";
import { importarBalanzaParsed } from "@/lib/contabilidad/ce-import-apply";

const schema = z.object({
  companyId: z.string().min(1),
  anio: z.number().int().min(2000).max(2100).optional(),
  mes: z.number().int().min(1).max(12).optional(),
  usar: z.enum(["inicial", "final"]).optional(),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "cuerpo inválido" }, { status: 400 });
  const { companyId, usar } = parsed.data;
  const { user } = await requireWriter(companyId, req);

  const periodo =
    parsed.data.anio && parsed.data.mes
      ? { anio: parsed.data.anio, mes: parsed.data.mes }
      : await prisma.ceBalanzaMes.findFirst({ where: { companyId }, orderBy: [{ anio: "desc" }, { mes: "desc" }], select: { anio: true, mes: true } });
  if (!periodo) return NextResponse.json({ error: "No tenemos ninguna balanza del SAT de esta empresa todavía." }, { status: 404 });

  const filas = await prisma.ceBalanzaMes.findMany({
    where: { companyId, anio: periodo.anio, mes: periodo.mes },
    select: { numCta: true, saldoIni: true, debe: true, haber: true, saldoFin: true },
  });
  if (filas.length === 0) return NextResponse.json({ error: `No hay balanza del SAT de ${periodo.anio}-${String(periodo.mes).padStart(2, "0")}.` }, { status: 404 });

  try {
    const r = await importarBalanzaParsed(
      companyId,
      { rfc: null, anio: periodo.anio, mes: periodo.mes, cuentas: filas.map((f) => ({ numCta: f.numCta, saldoIni: Number(f.saldoIni), debe: Number(f.debe), haber: Number(f.haber), saldoFin: Number(f.saldoFin) })) },
      { usar: usar ?? "final" },
    );
    await registrarBitacora({
      companyId,
      userId: user.id,
      accion: "contabilidad.apertura.desde-ce",
      detalle: { anio: periodo.anio, mes: periodo.mes, usar: usar ?? "final", entries: r.entries },
    });
    return NextResponse.json({ ok: true, periodo, balanza: r });
  } catch (e) {
    if (e instanceof AperturaError) return NextResponse.json({ error: e.message, diferencia: e.diferencia }, { status: 400 });
    throw e;
  }
});
