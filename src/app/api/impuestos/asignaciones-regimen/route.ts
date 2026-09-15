import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { rangoPeriodoMensual } from "@/lib/fiscal/periodo-operativo";
import {
  REGIMEN_LABELS,
  companyRegimenCodesForPeriod,
} from "@/lib/fiscal/regimen-capabilities";
import {
  evaluateRegimenAllocationReadiness,
  type RegimenAllocationReadinessApiResponse,
} from "@/lib/fiscal/regimen-allocation-readiness";

const LIMITACIONES = [
  "Esta revisión cubre CFDI timbrados de ingreso y egreso por fecha de emisión.",
  "Todavía no distribuye cobros o pagos PPD por fecha de flujo.",
  "No separa IVA ni cambia cálculos, declaraciones o cierres.",
];
const PENDING_PREVIEW_LIMIT = 25;

function parsePeriod(searchParams: URLSearchParams) {
  const year = Number(searchParams.get("year"));
  const month = Number(searchParams.get("month"));
  if (
    !Number.isInteger(year)
    || year < 2000
    || year > 2100
    || !Number.isInteger(month)
    || month < 1
    || month > 12
  ) return null;
  return { year, month };
}

// GET /api/impuestos/asignaciones-regimen?companyId=xxx&year=2026&month=8
// Period-level evidence queue only. It cannot unlock mixed-regime tax math.
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId")?.trim() ?? "";
  const period = parsePeriod(searchParams);
  if (!companyId || !period) {
    return NextResponse.json(
      { error: "companyId, year y month válidos son requeridos" },
      { status: 400 },
    );
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const { from, to } = rangoPeriodoMensual(period);
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: {
      regimenFiscal: true,
      regimenes: {
        select: { code: true, since: true, endedAt: true, active: true },
      },
    },
  });
  if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

  const effectiveRegimenCodes = companyRegimenCodesForPeriod({
    regimenFiscal: company.regimenFiscal,
    regimenes: company.regimenes,
    from,
    to,
  });

  // Single-regime and invalid-regime periods need no invoice scan. This route
  // is loaded from the ordinary invoice screen, so the common path must stay
  // cheap even for companies with a large CFDI archive.
  const regimeGate = evaluateRegimenAllocationReadiness({
    effectiveRegimenCodes,
    invoices: [],
  });

  const invoices = regimeGate.requiereAsignacion
    ? await prisma.invoice.findMany({
        where: {
          companyId,
          tipo: { in: ["INGRESO", "EGRESO"] },
          status: "STAMPED",
          fecha: { gte: from, lt: to },
        },
        select: {
          id: true,
          tipo: true,
          fecha: true,
          serie: true,
          folio: true,
          uuid: true,
          contraparteNombre: true,
          contraparteRfc: true,
          total: true,
          customer: { select: { razonSocial: true, rfc: true } },
          regimenAssignment: {
            select: {
              allocations: {
                select: { regimenCode: true, basisPoints: true },
                orderBy: { regimenCode: "asc" },
              },
            },
          },
        },
        orderBy: [{ fecha: "desc" }, { id: "asc" }],
      })
    : [];

  const readiness = regimeGate.requiereAsignacion
    ? evaluateRegimenAllocationReadiness({
        effectiveRegimenCodes,
        invoices: invoices.map((invoice) => ({
          id: invoice.id,
          assignment: invoice.regimenAssignment,
        })),
      })
    : regimeGate;
  const byId = new Map(readiness.facturas.map((invoice) => [invoice.id, invoice]));

  const response: RegimenAllocationReadinessApiResponse = {
    periodo: `${period.year}-${String(period.month).padStart(2, "0")}`,
    estado: readiness.estado,
    requiereAsignacion: readiness.requiereAsignacion,
    evidenciaCompleta: readiness.evidenciaCompleta,
    regimenesDisponibles: readiness.regimenCodes.map((code) => ({
      code,
      label: REGIMEN_LABELS[code] ?? null,
    })),
    regimenesNoReconocidos: readiness.regimenCodesNoReconocidos,
    resumen: readiness.resumen,
    facturasPendientes: invoices.flatMap((invoice) => {
      const evaluated = byId.get(invoice.id);
      if (!evaluated || evaluated.estado === "COMPLETA") return [];
      return [{
        id: invoice.id,
        // The query restricts this set; Prisma keeps the wider enum in its
        // inferred result type.
        tipo: invoice.tipo as "INGRESO" | "EGRESO",
        fecha: invoice.fecha.toISOString(),
        serie: invoice.serie,
        folio: invoice.folio,
        uuid: invoice.uuid,
        contraparte: invoice.customer?.razonSocial ?? invoice.contraparteNombre,
        rfc: invoice.customer?.rfc ?? invoice.contraparteRfc,
        total: Number(invoice.total),
        estado: evaluated.estado,
        ...(evaluated.observacion ? { observacion: evaluated.observacion } : {}),
      }];
    }).slice(0, PENDING_PREVIEW_LIMIT),
    alcance: "CFDI_TIMBRADOS_EMITIDOS_O_RECIBIDOS_EN_EL_MES",
    usadaEnCalculoAutomatico: false,
    limitaciones: LIMITACIONES,
  };

  return NextResponse.json(response);
}
