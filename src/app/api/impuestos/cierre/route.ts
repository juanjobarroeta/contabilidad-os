import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { computeTaxPosition } from "@/lib/impuestos";
import { calcularVencimiento, type ObligacionConfig } from "@/lib/obligaciones";
import { Prisma, type TaxDeclarationType } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// Cierre mensual — the "ready to file" workspace for a single period.
//
// Consolidates every obligation due that month into two presentation units:
//   1. Declaración federal — IVA mensual + ISR provisional + retenciones de ISR
//      (nómina). In Mexico these are presented together in ONE declaration with
//      ONE línea de captura, so we model them as a single fileable unit and
//      mirror the acuse across the three TaxDeclaration rows.
//   2. DIOT — informativa de operaciones con terceros, filed separately (its own
//      acuse, no payment / línea de captura).
//
// GET returns the live computed amounts + persisted filing state + a readiness
// checklist. POST persists "marcar presentada" for either unit.
// ─────────────────────────────────────────────────────────────────────────────

const FEDERAL_CONFIG: ObligacionConfig = {
  tipo: "FEDERAL",
  descripcion: "Declaración provisional de impuestos federales",
  periodicidad: "MENSUAL",
  diaVencimiento: 17,
};
const DIOT_CONFIG: ObligacionConfig = {
  tipo: "DIOT",
  descripcion: "DIOT",
  periodicidad: "MENSUAL",
  diaVencimiento: 17,
};

const FILED_STATUSES = ["FILED", "PAID"];

/** Sum of ISR retenido (nómina) entered for the month — the enteramiento amount. */
async function nominaRetencionesMes(companyId: string, from: Date, to: Date): Promise<number> {
  const agg = await prisma.payrollItem.aggregate({
    where: {
      payrollRun: {
        companyId,
        status: { in: ["CALCULATED", "STAMPED", "PAID"] },
        fechaPago: { gte: from, lt: to },
      },
    },
    _sum: { isrRetenido: true },
  });
  return agg._sum.isrRetenido ?? 0;
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const month = parseInt(searchParams.get("month") ?? "");
  const year = parseInt(searchParams.get("year") ?? "");

  if (!companyId || isNaN(month) || isNaN(year)) {
    return NextResponse.json({ error: "companyId, month y year son requeridos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const periodo = `${year}-${String(month).padStart(2, "0")}`;
  const from = new Date(year, month - 1, 1);
  const to = new Date(year, month, 1);

  const [pos, obligaciones, declaraciones, nominaRet, egresosConIvaCount, cfdiCount, nominaRunsCount] =
    await Promise.all([
      computeTaxPosition(companyId, year, month),
      prisma.companyObligation.findMany({ where: { companyId, activa: true } }),
      prisma.taxDeclaration.findMany({
        where: { companyId, periodo, tipo: { in: ["IVA_MENSUAL", "ISR_PROVISIONAL", "RETENCIONES_ISR", "DIOT"] } },
        select: {
          tipo: true, status: true, lineaCaptura: true, acuseUrl: true,
          fechaPresentacion: true, fechaLimitePago: true, acuseData: true,
        },
      }),
      nominaRetencionesMes(companyId, from, to),
      prisma.invoice.count({
        where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: from, lt: to } },
      }),
      prisma.invoice.count({
        where: { companyId, status: "STAMPED", fecha: { gte: from, lt: to } },
      }),
      prisma.payrollRun.count({
        where: { companyId, fechaPago: { gte: from, lt: to } },
      }),
    ]);

  const has = (tipo: string) => obligaciones.some((o) => o.tipo === tipo);
  const declOf = (tipo: string) => declaraciones.find((d) => d.tipo === tipo);

  // ── Federal unit ──────────────────────────────────────────────────────────
  // Which sub-obligations make up the federal declaration for this company.
  const tieneNomina = has("RETENCIONES_ISR") && nominaRet > 0;
  const federalLineas: { tipo: string; descripcion: string; monto: number; tipoMonto: "pagar" | "favor" | "enterar" }[] = [];
  if (has("IVA_MENSUAL")) {
    federalLineas.push(
      pos.iva.saldoAFavor > 0
        ? { tipo: "IVA_MENSUAL", descripcion: "IVA mensual (saldo a favor)", monto: pos.iva.saldoAFavor, tipoMonto: "favor" }
        : { tipo: "IVA_MENSUAL", descripcion: "IVA mensual", monto: pos.iva.pagar, tipoMonto: "pagar" },
    );
  }
  if (has("ISR_PROVISIONAL")) {
    federalLineas.push({
      tipo: "ISR_PROVISIONAL",
      descripcion: "ISR pago provisional",
      monto: pos.isr.isrPagar ?? 0,
      tipoMonto: "pagar",
    });
  }
  if (tieneNomina) {
    federalLineas.push({
      tipo: "RETENCIONES_ISR",
      descripcion: "ISR retenciones por sueldos y salarios",
      monto: nominaRet,
      tipoMonto: "enterar",
    });
  }

  const totalAPagar = federalLineas
    .filter((l) => l.tipoMonto !== "favor")
    .reduce((s, l) => s + l.monto, 0);
  const saldoFavorIva = pos.iva.saldoAFavor;

  // The IVA_MENSUAL row is the canonical carrier of the federal acuse (mirrored
  // there + onto the ISR/retenciones rows on file). Fall back across the unit.
  const federalDecl = declOf("IVA_MENSUAL") ?? declOf("ISR_PROVISIONAL") ?? declOf("RETENCIONES_ISR");
  const federalVencimiento = calcularVencimiento(FEDERAL_CONFIG, periodo);
  const federalEstado = estadoFor(federalDecl?.status ?? null, federalVencimiento);

  // ── DIOT unit ───────────────────────────────────────────────────────────────
  const diotDecl = declOf("DIOT");
  const diot = has("DIOT")
    ? {
        aplica: true,
        proveedores: egresosConIvaCount,
        vencimiento: calcularVencimiento(DIOT_CONFIG, periodo).toISOString(),
        estado: estadoFor(diotDecl?.status ?? null, calcularVencimiento(DIOT_CONFIG, periodo)),
        acuseUrl: diotDecl?.acuseUrl ?? null,
        fechaPresentacion: diotDecl?.fechaPresentacion ?? null,
      }
    : null;

  // ── Readiness checklist ───────────────────────────────────────────────────
  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() + 1 === month;
  const readiness = {
    cfdisSincronizados: {
      ok: cfdiCount > 0,
      aplica: true,
      detail: cfdiCount > 0 ? `${cfdiCount} CFDI sincronizados` : "Sin CFDIs sincronizados este mes",
    },
    nominaTimbrada: {
      ok: !has("RETENCIONES_ISR") || nominaRunsCount > 0,
      aplica: has("RETENCIONES_ISR"),
      detail: has("RETENCIONES_ISR")
        ? nominaRunsCount > 0
          ? `${nominaRunsCount} nómina(s) del mes`
          : "No hay nóminas registradas este mes"
        : "Sin obligación de retenciones",
    },
    periodoCerrado: {
      ok: !isCurrentMonth,
      aplica: true,
      detail: isCurrentMonth ? "El mes en curso aún puede recibir más CFDIs" : "Periodo concluido",
    },
  };

  const obligacionesPresentadas =
    (federalEstado === "FILED" ? 1 : 0) + (diot && diot.estado === "FILED" ? 1 : 0);
  const obligacionesTotal = 1 + (diot ? 1 : 0);

  return NextResponse.json({
    periodo,
    month,
    year,
    federal: {
      lineas: federalLineas,
      totalAPagar,
      saldoFavorIva,
      vencimiento: federalVencimiento.toISOString(),
      estado: federalEstado,
      lineaCaptura: federalDecl?.lineaCaptura ?? null,
      acuseUrl: federalDecl?.acuseUrl ?? null,
      fechaPresentacion: federalDecl?.fechaPresentacion ?? null,
      acuseData: federalDecl?.acuseData ?? null,
      // True once the figures have been persisted (so "marcar presentada" is safe).
      calculado: !!declOf("IVA_MENSUAL") || !!declOf("ISR_PROVISIONAL"),
    },
    diot,
    readiness,
    resumen: {
      totalAPagar,
      obligacionesPresentadas,
      obligacionesTotal,
      mesCerrado: obligacionesPresentadas === obligacionesTotal && obligacionesTotal > 0,
    },
  });
}

type Estado = "FILED" | "PENDING" | "OVERDUE" | "UPCOMING";
function estadoFor(status: string | null, vencimiento: Date): Estado {
  if (status && FILED_STATUSES.includes(status)) return "FILED";
  const now = new Date();
  if (vencimiento < now) return "OVERDUE";
  if (vencimiento.getTime() - now.getTime() < 30 * 24 * 60 * 60 * 1000) return "UPCOMING";
  return "PENDING";
}

// ── POST — mark a presentation unit as filed (or revert) ──────────────────────
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { companyId, periodo, action, lineaCaptura, acuseUrl, fechaPresentacion, fechaLimitePago, acuse } = body as {
    companyId?: string; periodo?: string; action?: string;
    lineaCaptura?: string | null; acuseUrl?: string | null;
    fechaPresentacion?: string | null; fechaLimitePago?: string | null;
    acuse?: AcuseFederal | null;
  };

  if (!companyId || !periodo || !action) {
    return NextResponse.json({ error: "Datos incompletos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  const [yearStr, monthStr] = periodo.split("-");
  const year = parseInt(yearStr);
  const month = parseInt(monthStr);
  if (isNaN(year) || isNaN(month)) {
    return NextResponse.json({ error: "periodo inválido" }, { status: 400 });
  }
  const from = new Date(year, month - 1, 1);
  const to = new Date(year, month, 1);

  const acusePatch = {
    lineaCaptura: lineaCaptura ?? null,
    acuseUrl: acuseUrl ?? null,
    fechaPresentacion: fechaPresentacion ? new Date(fechaPresentacion) : new Date(),
    fechaLimitePago: fechaLimitePago ? new Date(fechaLimitePago) : null,
  };

  if (action === "file-federal" || action === "unfile-federal") {
    const filing = action === "file-federal";
    const pos = await computeTaxPosition(companyId, year, month);
    const nominaRet = await nominaRetencionesMes(companyId, from, to);
    const status = filing ? "FILED" : "CALCULATED";

    // When an acuse PDF was captured, its filed figures are authoritative (they
    // drive carry-forward); otherwise we persist the app-computed position as
    // before. The diffs between the two are stored so a filing error stays visible.
    const useAcuse = filing && !!acuse;
    const pick = (filed: number | null | undefined, computed: number): number =>
      useAcuse && filed != null ? filed : computed;

    const ivaTrasladado = pick(acuse?.ivaCausado, pos.iva.trasladado);
    const ivaAcreditable = pick(acuse?.ivaAcreditable, pos.iva.acreditable);
    const ivaPagar = pick(acuse?.ivaAPagar, pos.iva.pagar);
    const ivaSaldoFavor = pick(acuse?.ivaAFavor, pos.iva.saldoAFavor);
    const isrIngresos = pick(acuse?.isrIngresos, pos.isr.ingresosAcumulados);
    const isrPagar = pick(acuse?.isrAPagar, pos.isr.isrPagar ?? 0);
    const coeficiente =
      useAcuse && acuse?.coeficienteUtilidadAplicado != null
        ? acuse.coeficienteUtilidadAplicado
        : pos.isr.coeficiente;
    const acuseData = useAcuse ? buildAcuseData(acuse!, pos, nominaRet) : null;

    // Upsert the three federal rows with their figures + shared acuse, so a
    // never-saved period can still be filed in one click.
    await prisma.$transaction(async (tx) => {
      await upsertRow(tx, companyId, periodo, "IVA_MENSUAL", {
        status,
        ivaTrasladadoCobrado: ivaTrasladado,
        ivaAcreditableGastado: ivaAcreditable,
        ivaPagar,
        ivaSaldoFavor,
        acuseData: acuseData ?? Prisma.DbNull,
        ...(filing ? acusePatch : clearAcuse()),
      });
      await upsertRow(tx, companyId, periodo, "ISR_PROVISIONAL", {
        status,
        isrIngresos,
        isrBaseGravable: pos.isr.utilidadFiscal,
        isrTasa: 0.3,
        isrPagar,
        ...(typeof coeficiente === "number" && { isrCoeficienteUtilidad: coeficiente }),
        ...(filing ? acusePatch : clearAcuse()),
      });
      if (nominaRet > 0) {
        await upsertRow(tx, companyId, periodo, "RETENCIONES_ISR", {
          status,
          retencionesIsr: nominaRet,
          ...(filing ? acusePatch : clearAcuse()),
        });
      }
    });

    return NextResponse.json({ ok: true, action, diffs: acuseData?.diffs ?? [] });
  }

  if (action === "file-diot" || action === "unfile-diot") {
    const filing = action === "file-diot";
    await upsertRow(prisma, companyId, periodo, "DIOT", {
      status: filing ? "FILED" : "CALCULATED",
      ...(filing ? acusePatch : clearAcuse()),
    });
    return NextResponse.json({ ok: true, action });
  }

  return NextResponse.json({ error: "acción no reconocida" }, { status: 400 });
}

function clearAcuse() {
  return { lineaCaptura: null, acuseUrl: null, fechaPresentacion: null, fechaLimitePago: null };
}

// ── Acuse extraction (cierre) ─────────────────────────────────────────────────
// Filed figures extracted from the SAT acuse PDF (subset of /api/onboarding/
// parse-document's acuseMensual that's relevant to the federal declaration).
interface AcuseFederal {
  tipoImpuesto?: string | null;
  tipoPago?: string | null;
  rfc?: string | null;
  periodoMes?: number | null;
  periodoAnio?: number | null;
  ivaCausado?: number | null;
  ivaAcreditable?: number | null;
  ivaAPagar?: number | null;
  ivaAFavor?: number | null;
  ivaSaldoFavorAplicado?: number | null;
  isrIngresos?: number | null;
  isrAPagar?: number | null;
  coeficienteUtilidadAplicado?: number | null;
  lineaCaptura?: string | null;
  fechaPresentacion?: string | null;
}

type Pos = Awaited<ReturnType<typeof computeTaxPosition>>;
interface AcuseDiff { campo: string; filed: number; computed: number; delta: number }

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Build the stored acuse record: filed values + computed snapshot + flagged diffs. */
function buildAcuseData(acuse: AcuseFederal, pos: Pos, nominaRet: number) {
  const AMT_TOL = 1;       // MXN — rounding slack
  const COEF_TOL = 0.0001; // coeficiente is a 4-decimal ratio
  const computedCoef = typeof pos.isr.coeficiente === "number" ? pos.isr.coeficiente : null;
  const diffs: AcuseDiff[] = [];

  const cmpAmt = (campo: string, filed: number | null | undefined, computed: number) => {
    if (filed == null) return;
    const delta = round2(filed - computed);
    if (Math.abs(delta) > AMT_TOL) diffs.push({ campo, filed: round2(filed), computed: round2(computed), delta });
  };
  cmpAmt("IVA a pagar", acuse.ivaAPagar, pos.iva.pagar);
  cmpAmt("IVA a favor", acuse.ivaAFavor, pos.iva.saldoAFavor);
  cmpAmt("ISR a pagar", acuse.isrAPagar, pos.isr.isrPagar ?? 0);
  if (acuse.coeficienteUtilidadAplicado != null && computedCoef != null) {
    const delta = Math.round((acuse.coeficienteUtilidadAplicado - computedCoef) * 1e6) / 1e6;
    if (Math.abs(delta) > COEF_TOL) {
      diffs.push({ campo: "Coeficiente de utilidad", filed: acuse.coeficienteUtilidadAplicado, computed: computedCoef, delta });
    }
  }

  return {
    extractedAt: new Date().toISOString(),
    tipoImpuesto: acuse.tipoImpuesto ?? null,
    tipoPago: acuse.tipoPago ?? null,
    rfc: acuse.rfc ?? null,
    filed: {
      ivaCausado: acuse.ivaCausado ?? null,
      ivaAcreditable: acuse.ivaAcreditable ?? null,
      ivaAPagar: acuse.ivaAPagar ?? null,
      ivaAFavor: acuse.ivaAFavor ?? null,
      ivaSaldoFavorAplicado: acuse.ivaSaldoFavorAplicado ?? null,
      isrIngresos: acuse.isrIngresos ?? null,
      isrAPagar: acuse.isrAPagar ?? null,
      coeficiente: acuse.coeficienteUtilidadAplicado ?? null,
      lineaCaptura: acuse.lineaCaptura ?? null,
      fechaPresentacion: acuse.fechaPresentacion ?? null,
    },
    computed: {
      ivaPagar: round2(pos.iva.pagar),
      ivaSaldoFavor: round2(pos.iva.saldoAFavor),
      isrPagar: round2(pos.isr.isrPagar ?? 0),
      coeficiente: computedCoef,
      nominaRet: round2(nominaRet),
    },
    diffs,
  };
}

// Minimal upsert-by-(company,tipo,periodo) usable inside or outside a transaction.
type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0] | typeof prisma;
async function upsertRow(
  client: TxClient,
  companyId: string,
  periodo: string,
  tipo: TaxDeclarationType,
  patch: Record<string, unknown>,
) {
  const existing = await client.taxDeclaration.findFirst({
    where: { companyId, tipo, periodo },
    select: { id: true },
  });
  return existing
    ? client.taxDeclaration.update({ where: { id: existing.id }, data: patch })
    : client.taxDeclaration.create({ data: { companyId, tipo, periodo, status: "CALCULATED", ...patch } });
}
