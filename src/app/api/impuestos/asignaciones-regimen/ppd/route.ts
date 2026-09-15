import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { rangoPeriodoMensual } from "@/lib/fiscal/periodo-operativo";
import { companyRegimenCodesForPeriod } from "@/lib/fiscal/regimen-capabilities";
import { invoiceRegimenPeriodContext } from "@/lib/fiscal/regimen-allocation";
import {
  projectPpdRegimenAllocation,
  proratePpdBaseCentavos,
  type PpdRegimenReadinessApiResponse,
  type PpdRegimenReadinessFailureCode,
} from "@/lib/fiscal/regimen-payment-allocation";
import { normalizarUuid, variantesUuid } from "@/lib/fiscal/uuid";

const PENDING_PREVIEW_LIMIT = 25;

const LIMITACIONES = [
  "La proyección usa la asignación del CFDI padre y la FechaPago del REP.",
  "Un cambio de régimen entre emisión y pago requiere revisión del contador.",
  "No separa IVA ni modifica cálculos, declaraciones o cierres.",
];

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

function toMicropesos(value: number | null): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const micros = Math.round((value + Number.EPSILON) * 1_000_000);
  return Number.isSafeInteger(micros) ? micros : null;
}

// GET /api/impuestos/asignaciones-regimen/ppd?companyId=xxx&year=2026&month=8
// Read-only readiness for REP-linked cash flow. No tax engine consumes it.
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

  const { from, to } = rangoPeriodoMensual(period);
  const paymentEffectiveRegimenCodes = companyRegimenCodesForPeriod({
    regimenFiscal: company.regimenFiscal,
    regimenes: company.regimenes,
    from,
    to,
  });
  const links = await prisma.pagoDoctoRelacionado.findMany({
    where: {
      fechaPago: { gte: from, lt: to },
      pagoInvoice: { companyId, tipo: "PAGO", status: "STAMPED" },
    },
    select: {
      id: true,
      parentUuid: true,
      impPagado: true,
      fechaPago: true,
      pagoInvoice: {
        select: { id: true, uuid: true, serie: true, folio: true },
      },
    },
    orderBy: [{ fechaPago: "desc" }, { id: "asc" }],
  });

  const parentUuidVariants = variantesUuid(links.map((link) => link.parentUuid));
  const parents = parentUuidVariants.length > 0
    ? await prisma.invoice.findMany({
        where: { companyId, uuid: { in: parentUuidVariants } },
        select: {
          id: true,
          uuid: true,
          tipo: true,
          status: true,
          metodoPago: true,
          fecha: true,
          serie: true,
          folio: true,
          subtotal: true,
          total: true,
          moneda: true,
          contraparteNombre: true,
          contraparteRfc: true,
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
      })
    : [];

  const parentsByUuid = new Map<string, typeof parents>();
  for (const parent of parents) {
    if (!parent.uuid) continue;
    const key = normalizarUuid(parent.uuid);
    const current = parentsByUuid.get(key) ?? [];
    current.push(parent);
    parentsByUuid.set(key, current);
  }

  const evaluated = links.map((link) => {
    const matchingParents = parentsByUuid.get(normalizarUuid(link.parentUuid)) ?? [];
    const base = {
      id: link.id,
      parentUuid: link.parentUuid,
      fechaPago: link.fechaPago?.toISOString() ?? null,
      pago: {
        invoiceId: link.pagoInvoice.id,
        uuid: link.pagoInvoice.uuid,
        serie: link.pagoInvoice.serie,
        folio: link.pagoInvoice.folio,
      },
    };

    if (matchingParents.length === 0) {
      return {
        ...base,
        ok: false as const,
        code: "PARENT_INVOICE_NOT_FOUND" as const,
        error: "El REP referencia un CFDI padre que no está disponible en esta empresa.",
        parent: null,
      };
    }
    if (matchingParents.length > 1) {
      return {
        ...base,
        ok: false as const,
        code: "PARENT_UUID_AMBIGUOUS" as const,
        error: "Hay más de un CFDI padre con el mismo UUID normalizado; no se puede proyectar el pago.",
        parent: null,
      };
    }

    const parent = matchingParents[0];
    const parentSummary = {
      invoiceId: parent.id,
      uuid: parent.uuid,
      tipo: parent.tipo,
      fecha: parent.fecha.toISOString(),
      serie: parent.serie,
      folio: parent.folio,
      contraparte: parent.customer?.razonSocial ?? parent.contraparteNombre,
      rfc: parent.customer?.rfc ?? parent.contraparteRfc,
      moneda: parent.moneda,
    };
    if (
      parent.status !== "STAMPED"
      || parent.metodoPago !== "PPD"
      || (parent.tipo !== "INGRESO" && parent.tipo !== "EGRESO")
    ) {
      return {
        ...base,
        ok: false as const,
        code: "PARENT_INVOICE_NOT_ELIGIBLE" as const,
        error: "El CFDI padre no es un ingreso o egreso PPD timbrado.",
        parent: parentSummary,
      };
    }
    if (parent.moneda.trim().toUpperCase() !== "MXN") {
      return {
        ...base,
        ok: false as const,
        code: "FOREIGN_CURRENCY_REQUIRES_REVIEW" as const,
        error: "El CFDI padre está en moneda extranjera y el REP no conserva aún la equivalencia necesaria para proyectarlo con seguridad.",
        parent: parentSummary,
      };
    }

    const impPagadoMicropesos = toMicropesos(link.impPagado === null ? null : Number(link.impPagado));
    const parentSubtotalMicropesos = toMicropesos(Number(parent.subtotal));
    const parentTotalMicropesos = toMicropesos(Number(parent.total));
    if (impPagadoMicropesos === null || parentSubtotalMicropesos === null || parentTotalMicropesos === null) {
      return {
        ...base,
        ok: false as const,
        code: "PAYMENT_AMOUNT_UNAVAILABLE" as const,
        error: "Falta un importe monetario válido en el REP o en su CFDI padre.",
        parent: parentSummary,
      };
    }

    const proration = proratePpdBaseCentavos({
      impPagadoMicropesos,
      parentSubtotalMicropesos,
      parentTotalMicropesos,
    });
    if (!proration.ok) {
      return {
        ...base,
        ok: false as const,
        code: proration.code,
        error: proration.error,
        parent: parentSummary,
      };
    }

    const parentContext = invoiceRegimenPeriodContext({
      fecha: parent.fecha,
      regimenFiscal: company.regimenFiscal,
      regimenes: company.regimenes,
    });
    const projection = projectPpdRegimenAllocation({
      baseCentavos: proration.amount,
      parentEffectiveRegimenCodes: parentContext?.regimenCodes ?? [],
      paymentEffectiveRegimenCodes,
      assignment: parent.regimenAssignment,
    });
    if (!projection.ok) {
      return {
        ...base,
        ok: false as const,
        code: projection.code,
        error: projection.error,
        parent: parentSummary,
      };
    }

    return {
      ...base,
      ok: true as const,
      parent: parentSummary,
      source: projection.source,
      baseCentavos: projection.baseCentavos,
      allocations: projection.allocations,
    };
  });

  const failures = evaluated.filter((row): row is Extract<typeof row, { ok: false }> => !row.ok);
  const countCode = (code: PpdRegimenReadinessFailureCode) => failures.filter((row) => row.code === code).length;
  const parentFailureCodes = new Set<PpdRegimenReadinessFailureCode>([
    "PARENT_INVOICE_NOT_FOUND",
    "PARENT_UUID_AMBIGUOUS",
    "PARENT_INVOICE_NOT_ELIGIBLE",
  ]);
  const assignedBuckets = failures.filter((row) =>
    parentFailureCodes.has(row.code)
    || row.code === "PAYMENT_AMOUNT_UNAVAILABLE"
    || row.code === "FOREIGN_CURRENCY_REQUIRES_REVIEW"
    || row.code === "ASSIGNMENT_REQUIRED"
    || row.code === "REGIME_TRANSITION_REVIEW"
  ).length;

  const response: PpdRegimenReadinessApiResponse = {
    periodo: `${period.year}-${String(period.month).padStart(2, "0")}`,
    estado: links.length === 0 ? "SIN_PAGOS_PPD" : failures.length === 0 ? "COMPLETA" : "PENDIENTE",
    evidenciaCompleta: failures.length === 0,
    resumen: {
      totalRelaciones: links.length,
      proyectables: evaluated.length - failures.length,
      pendientes: failures.length,
      sinFacturaPadre: failures.filter((row) => parentFailureCodes.has(row.code)).length,
      sinImporte: countCode("PAYMENT_AMOUNT_UNAVAILABLE"),
      monedaExtranjera: countCode("FOREIGN_CURRENCY_REQUIRES_REVIEW"),
      sinAsignacion: countCode("ASSIGNMENT_REQUIRED"),
      transicionesRegimen: countCode("REGIME_TRANSITION_REVIEW"),
      otros: failures.length - assignedBuckets,
    },
    pagosPendientes: failures.slice(0, PENDING_PREVIEW_LIMIT),
    alcance: "RELACIONES_PPD_CON_FECHA_PAGO_EN_EL_MES",
    usadaEnCalculoAutomatico: false,
    limitaciones: LIMITACIONES,
  };
  return NextResponse.json(response);
}
