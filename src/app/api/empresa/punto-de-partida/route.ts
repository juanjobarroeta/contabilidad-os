/**
 * GET /api/empresa/punto-de-partida?companyId=
 *   → { pasos, listos, total, siguiente } — qué tiene la empresa para arrancar
 *     (CSF, e.firma, catálogo propio, saldos iniciales, bancos, CFDI), qué
 *     falta y qué archivo pedirle. Sólo lectura; el evaluador es puro
 *     (lib/empresa/punto-de-partida.ts) y aquí sólo se juntan los hechos.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, withAuthz } from "@/lib/authz";
import { fielStatus } from "@/lib/fiel";
import { periodoDeTexto } from "@/lib/bancos/periodo-lote";
import { evaluarPuntoDePartida } from "@/lib/empresa/punto-de-partida";

export const GET = withAuthz(async (req: Request) => {
  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId") ?? "";
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  await requireMembership(companyId, undefined, req);

  const [company, obligaciones, catalogo, ultimaBalanzaSat, apertura, cuentasBancarias, ultimoLote, cfdis, ultimaSync] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { fielCer: true, fielVigencia: true } }),
    prisma.companyObligation.count({ where: { companyId } }),
    prisma.chartAccount.aggregate({ where: { companyId, isActive: true, codAgrup: { not: null } }, _count: { _all: true }, _max: { createdAt: true } }),
    prisma.ceBalanzaMes.findFirst({ where: { companyId }, orderBy: [{ anio: "desc" }, { mes: "desc" }], select: { anio: true, mes: true } }),
    prisma.accountingEntry.findFirst({ where: { companyId, fuente: "APERTURA" }, select: { id: true } }),
    prisma.bankAccount.count({ where: { companyId } }),
    prisma.importBatch.findFirst({ where: { bankAccount: { companyId } }, orderBy: { createdAt: "desc" }, select: { periodo: true, createdAt: true } }),
    prisma.invoice.count({ where: { companyId } }),
    prisma.satSyncRequest.findFirst({ where: { companyId, status: "FINISHED" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

  const fiel = fielStatus(company);
  const ultimoPeriodo = ultimoLote
    ? periodoDeTexto(ultimoLote.periodo) ?? `${ultimoLote.createdAt.getUTCFullYear()}-${String(ultimoLote.createdAt.getUTCMonth() + 1).padStart(2, "0")}`
    : null;

  return NextResponse.json(
    evaluarPuntoDePartida({
      hoy: new Date(),
      fiel: fiel.estado,
      fielVigencia: company.fielVigencia,
      obligaciones,
      cuentasPropias: catalogo._count._all,
      ultimaCargaCatalogo: catalogo._max.createdAt,
      ultimaBalanzaSat,
      aperturaHecha: Boolean(apertura),
      cuentasBancarias,
      ultimoEstadoDeCuenta: ultimoPeriodo,
      cfdis,
      ultimaSincronizacionSat: ultimaSync?.createdAt ?? null,
    }),
  );
});
