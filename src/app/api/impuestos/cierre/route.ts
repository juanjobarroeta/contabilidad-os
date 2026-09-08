import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { computeTaxPosition } from "@/lib/impuestos";
import { getAsimiladosResumen } from "@/lib/fiscal/asimilados";
import { detectComplementosPendientes } from "@/lib/complementos";
import { formatCurrency } from "@/lib/utils";
import { calcularVencimiento, type ObligacionConfig } from "@/lib/obligaciones";
import { Prisma, type TaxDeclarationType } from "@prisma/client";
import { evidenciaPresentacion } from "@/lib/fiscal/presentacion";
import { cargarNominaParaIsn } from "@/lib/fiscal/audit/service";
import { calcularIsnPorEntidad } from "@/lib/fiscal/isn";
import { causaIsn, periodoIsn } from "@/lib/fiscal/isn/periodo";
import { construirContexto } from "@/lib/fiscal/rules";
import { registrarBitacora } from "@/lib/audit";
import { leerRenglonesIeps } from "@/lib/fiscal/ieps/leer";
import { aPagarIeps, periodoIeps, type DecisionAcreditamiento } from "@/lib/fiscal/ieps/periodo";

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

// IEPS definitivo mensual (Art. 5º LIEPS): mismo día 17, pero es SU PROPIA
// declaración, con su propio acuse y su propia línea de captura — no un renglón
// de la de ISR e IVA. Por eso es una unidad aparte, como la DIOT.
const IEPS_CONFIG: ObligacionConfig = {
  tipo: "IEPS_MENSUAL",
  descripcion: "IEPS mensual",
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
  return Number(agg._sum.isrRetenido ?? 0);
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

  const [empresa, pos, complementos, obligaciones, declaraciones, nominaRet, egresosConIvaCount, cfdiCount, nominaRunsCount, asimilados] =
    await Promise.all([
      // La empresa: el ISN resuelve la tasa de cada estado con el contexto
      // fiscal (régimen, tipo de persona, sector), no con una tasa a mano.
      prisma.company.findUnique({
        where: { id: companyId },
        select: {
          rfc: true, regimenFiscal: true, actividadEconomica: true, codigoPostal: true,
          // La decisión del Art. 4º LIEPS: null = sin decidir, no «no acredita».
          iepsAcredita: true, iepsAcreditaAt: true, iepsAcreditaNota: true,
        },
      }),
      computeTaxPosition(companyId, year, month),
      detectComplementosPendientes(companyId),
      prisma.companyObligation.findMany({ where: { companyId, activa: true } }),
      prisma.taxDeclaration.findMany({
        where: { companyId, periodo, tipo: { in: ["IVA_MENSUAL", "ISR_PROVISIONAL", "RETENCIONES_ISR", "DIOT", "ISN_MENSUAL", "IEPS_MENSUAL"] } },
        select: {
          id: true, tipo: true, status: true, lineaCaptura: true, acuseUrl: true,
          fechaPresentacion: true, fechaLimitePago: true, acuseData: true, acusePdfNombre: true,
          isnEntidad: true,
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
      getAsimiladosResumen(companyId, year, month),
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
  // ISR que retuvimos a proveedores personas físicas (honorarios 10%,
  // arrendamiento): se entera en la misma declaración. Sólo si retuvimos.
  if (pos.isr.retenidoAProveedoresEnterar > 0.005) {
    federalLineas.push({
      tipo: "RETENCIONES_ISR",
      descripcion: "ISR retenido a proveedores (honorarios / arrendamiento)",
      monto: pos.isr.retenidoAProveedoresEnterar,
      tipoMonto: "enterar",
    });
  }
  // IVA que retuvimos a proveedores (servicios, arrendamiento, fletes): se entera
  // en la misma declaración mensual. Sólo aparece si efectivamente retuvimos.
  if (pos.iva.retenidoAProveedores > 0.005) {
    federalLineas.push({
      tipo: "RETENCIONES_IVA",
      descripcion: "IVA retenido a proveedores",
      monto: pos.iva.retenidoAProveedores,
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

  // ── ISN: unidad ESTATAL ─────────────────────────────────────────────────────
  // No lo cobra el SAT sino la tesorería del estado, así que no entra en
  // `federal` ni en su total: es su propio pago, a otra autoridad, con su propia
  // fecha. Lo causa tener nómina, no el régimen — como el IMSS.
  // Una fila por ESTADO: cada tesorería es su propia obligación, con su fecha y
  // su marcado. `declaraciones` ya trae las filas ISN_MENSUAL del periodo.
  const isnDecls = declaraciones.filter((d) => d.tipo === "ISN_MENSUAL");
  const isn = await (async () => {
    if (!empresa) return null;
    const { empleados, fuente } = await cargarNominaParaIsn(
      companyId,
      new Date(Date.UTC(year, month - 1, 1)).toISOString(),
    );
    const ctx = construirContexto(empresa, `${periodo}-01`);
    const p = periodoIsn(year, month, calcularIsnPorEntidad(empleados, ctx, fuente), ctx);
    if (!causaIsn(p)) return null;
    return {
      aplica: true,
      periodo: p.periodo,
      totalConocido: p.totalConocido,
      sinTasa: p.sinTasa,
      empleadosSinEntidad: p.empleadosSinEntidad,
      fuente: p.fuente,
      entidades: p.obligaciones.map((o) => {
        const decl = isnDecls.find((d) => d.isnEntidad === o.entidad);
        return {
          ...o,
          fechaLimite: o.fechaLimite.toISOString(),
          estado: estadoFor(decl?.status ?? null, o.fechaLimite),
          fechaPresentacion: decl?.fechaPresentacion ?? null,
          evidencia: evidenciaPresentacion(decl ?? null),
        };
      }),
    };
  })();

  // ── IEPS: unidad federal PROPIA ─────────────────────────────────────────────
  // Se presenta ante el SAT el mismo día 17, pero en su propia declaración de
  // pago definitivo (Art. 5º LIEPS), con su acuse y su línea de captura. Hasta
  // aquí el IEPS sólo existía copiado del acuse: la app lo veía en los CFDIs y
  // no lo declaraba.
  //
  // QUIÉN LO CAUSA SE DECIDE POR EVIDENCIA, no por el giro: si la empresa
  // trasladó IEPS en sus comprobantes, es contribuyente y hay declaración. La
  // obligación registrada (CSF) también lo enciende, porque una obligación sin
  // movimientos se presenta EN CEROS y callarla sería dejarla vencer.
  const iepsDecl = declOf("IEPS_MENSUAL");
  const ieps = await (async () => {
    const renglones = await leerRenglonesIeps(prisma, companyId, year, month);
    const p = periodoIeps(year, month, renglones);
    const obligado = has("IEPS_MENSUAL");
    if (!p.causa && p.pagado === 0 && !obligado) return null;

    // null = sin decidir. Se distingue de false a propósito: mientras nadie
    // conteste el Art. 4º, el monto del mes NO existe (`monto: null`).
    const decision: DecisionAcreditamiento =
      empresa?.iepsAcredita == null ? "sin_decidir" : empresa.iepsAcredita ? "acredita" : "no_acredita";
    const res = aPagarIeps(p, decision);
    const vencimiento = calcularVencimiento(IEPS_CONFIG, periodo);

    return {
      aplica: true,
      periodo: p.periodo,
      // De dónde nace la obligación: los comprobantes, el padrón, o los dos.
      origen: p.causa ? (obligado ? "cfdi+csf" : "cfdi") : "csf",
      trasladado: p.trasladado,
      pagado: p.pagado,
      pagadoAcreditable: p.pagadoAcreditable,
      pagadoNoAcreditable: p.pagadoNoAcreditable,
      pagadoSinClasificar: p.pagadoSinClasificar,
      retenido: p.retenido,
      renglones: p.renglones,
      porTasa: p.porTasa.map((t) => ({
        tasa: t.tasa,
        trasladado: t.trasladado,
        pagado: t.pagado,
        renglones: t.renglones,
        inciso: {
          certeza: t.inciso.certeza,
          etiqueta: t.inciso.etiqueta,
          acreditablePorInciso: t.inciso.acreditablePorInciso,
        },
      })),
      // La decisión del Art. 4º y su rastro. `monto: null` = falta contestarla.
      acreditamiento: {
        decision,
        decididoAt: empresa?.iepsAcreditaAt?.toISOString() ?? null,
        nota: empresa?.iepsAcreditaNota ?? null,
        // Sólo se pregunta si hay algo que acreditar: sin IEPS pagado a
        // proveedores la respuesta no cambia ningún número.
        hayQueDecidir: p.pagado > 0 && decision === "sin_decidir",
      },
      monto: res.monto,
      acreditado: res.acreditado,
      // Sobrante acreditable de su clase. NO baja el impuesto de otra (Art. 4º
      // fr. IV) ni se compensa fuera de ella (Art. 5º): viaja aparte del monto.
      saldoFavor: res.saldoFavor,
      porClase: res.porClase,
      completo: res.completo,
      motivo: res.motivo,
      // Traslada IEPS y no tiene la obligación en el padrón: eso no lo arregla
      // esta pantalla, pero callarlo sería dejar la declaración sin presentar.
      sinObligacionRegistrada: p.causa && !obligado,
      vencimiento: vencimiento.toISOString(),
      estado: estadoFor(iepsDecl?.status ?? null, vencimiento),
      lineaCaptura: iepsDecl?.lineaCaptura ?? null,
      acuseUrl: iepsDecl?.acuseUrl ?? null,
      fechaPresentacion: iepsDecl?.fechaPresentacion ?? null,
      evidencia: evidenciaPresentacion(iepsDecl ?? null),
      baseFecha: p.baseFecha,
    };
  })();

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
        evidencia: evidenciaPresentacion(diotDecl ?? null),
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
    // Cobros PPD sin REP: no bloquea, pero ese IVA aún no causa (base-REP) y el
    // complemento vence el día 5 del mes siguiente al pago. Surfacing it here
    // closes the loop with the cash-basis IVA engine.
    complementosPago: {
      ok: complementos.stats.totalPendientes === 0,
      aplica: true,
      detail:
        complementos.stats.totalPendientes === 0
          ? "Sin cobros PPD pendientes de complemento"
          : `${complementos.stats.totalPendientes} cobro(s) PPD sin REP` +
            (complementos.stats.vencidos > 0 ? ` — ${complementos.stats.vencidos} vencido(s)` : "") +
            ` (vence día 5; ${formatCurrency(complementos.stats.montoPendiente)} sin complementar)`,
    },
  };

  const obligacionesPresentadas =
    (federalEstado === "FILED" ? 1 : 0) +
    (diot && diot.estado === "FILED" ? 1 : 0) +
    (ieps && ieps.estado === "FILED" ? 1 : 0);
  const obligacionesTotal = 1 + (diot ? 1 : 0) + (ieps ? 1 : 0);

  return NextResponse.json({
    periodo,
    month,
    year,
    // Avisos del motor: cadena de arrastre rota (mes con CFDIs y sin declaración
    // guardada → saldo a favor de IVA / pagos provisionales de ISR en cero).
    advertencias: pos.advertencias,
    // Ingresos por asimilados a salarios recibidos (Art. 94); null si no hay.
    asimilados,
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
      // Acuse PDF guardado (lo trae el backfill de Syntage): id de la declaración
      // para descargarlo y bandera de disponibilidad. acusePdfNombre y acusePdf se
      // guardan juntos, así que el nombre es señal fiable de que el PDF existe.
      declaracionId: federalDecl?.id ?? null,
      acusePdfDisponible: !!federalDecl?.acusePdfNombre,
      // Qué prueba la presentación: acuse del SAT, registro del SAT, o la
      // palabra de alguien. La pantalla lo dice en vez de un «Presentada» pelón.
      evidencia: evidenciaPresentacion(federalDecl ?? null),
      // True once the figures have been persisted (so "marcar presentada" is safe).
      calculado: !!declOf("IVA_MENSUAL") || !!declOf("ISR_PROVISIONAL"),
    },
    diot,
    isn,
    ieps,
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
  const { companyId, periodo, action, lineaCaptura, acuseUrl, fechaPresentacion, fechaLimitePago, acuse, entidad: entidadBody, acredita: acreditaBody, nota: notaBody } = body as {
    companyId?: string; periodo?: string; action?: string; entidad?: string;
    acredita?: boolean; nota?: string | null;
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

  // Revertir borra los rastros del acuse (`clearAcuse`). Si la presentación la
  // trajo el SAT —acuse PDF guardado por el backfill de Syntage— revertirla
  // destruiría evidencia que no volvemos a pedir (el sync no re-crea filas que
  // ya existen) y dejaría el periodo mintiendo. No se puede des-presentar lo
  // que el SAT ya nos dijo que se presentó.
  if (
    action === "unfile-federal" ||
    action === "unfile-diot" ||
    action === "unfile-isn" ||
    action === "unfile-ieps"
  ) {
    const tipos =
      action === "unfile-diot"
        ? (["DIOT"] as const)
        : action === "unfile-isn"
          ? (["ISN_MENSUAL"] as const)
          : action === "unfile-ieps"
            ? (["IEPS_MENSUAL"] as const)
            : (["IVA_MENSUAL", "ISR_PROVISIONAL", "RETENCIONES_ISR"] as const);
    const conAcuse = await prisma.taxDeclaration.findFirst({
      where: { companyId, periodo, tipo: { in: [...tipos] }, acusePdfNombre: { not: null } },
      select: { acusePdfNombre: true },
    });
    if (conAcuse) {
      return NextResponse.json(
        {
          error:
            "Esta declaración tiene el acuse del SAT guardado: no se puede marcar como no presentada. " +
            "Si el acuse está mal, sube el correcto.",
        },
        { status: 409 },
      );
    }
  }

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
        // Saldo a favor RESICO generado este periodo (retención 1.25% > causado)
        // — eslabón del arrastre que el motor lee el mes siguiente.
        isrSaldoFavor: pos.isr.saldoAFavor > 0 ? round2(pos.isr.saldoAFavor) : null,
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

  // ISN: se presenta ante la tesorería de CADA ESTADO, no ante el SAT, así que
  // se marca uno por uno — `entidad` dice cuál. Al presentarlo se congela el
  // cálculo de ese estado: la nómina puede cambiar después y lo declarado no.
  if (action === "file-isn" || action === "unfile-isn") {
    const filing = action === "file-isn";
    const entidad = (entidadBody ?? "").trim();
    if (!entidad) {
      return NextResponse.json(
        { error: "Falta la entidad: el ISN se presenta por estado, uno a la vez." },
        { status: 400 },
      );
    }

    const existente = await prisma.taxDeclaration.findFirst({
      where: { companyId, periodo, tipo: "ISN_MENSUAL", isnEntidad: entidad },
      select: { id: true },
    });

    let isnPatch: Record<string, unknown> = {};
    if (filing) {
      const empresa = await prisma.company.findUnique({
        where: { id: companyId },
        select: { rfc: true, regimenFiscal: true, actividadEconomica: true, codigoPostal: true },
      });
      if (!empresa) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });
      const { empleados, fuente } = await cargarNominaParaIsn(
        companyId,
        new Date(Date.UTC(year, month - 1, 1)).toISOString(),
      );
      const ctx = construirContexto(empresa, `${periodo}-01`);
      const p = periodoIsn(year, month, calcularIsnPorEntidad(empleados, ctx, fuente), ctx);
      const o = p.obligaciones.find((x) => x.entidad === entidad);
      if (!o) {
        return NextResponse.json(
          { error: `No hay nómina en ${entidad} este periodo.` },
          { status: 409 },
        );
      }
      isnPatch = {
        isnPagar: o.importe,
        // Congelado: la base, la tasa y el fundamento con que se declaró, más
        // las salvedades. Si mañana cambia la nómina, lo presentado no cambia.
        isnDetalle: {
          entidad: o.entidad,
          numEmpleados: o.numEmpleados,
          baseMensual: o.baseMensual,
          tasa: o.tasa,
          fundamento: o.fundamento ?? null,
          nota: o.nota ?? null,
          tasaVerificada: o.tasaVerificada,
          vencimientoVerificado: o.vencimientoVerificado,
          fuente: p.fuente,
        },
      };
    }

    const data = {
      status: filing ? ("FILED" as const) : ("CALCULATED" as const),
      ...isnPatch,
      ...(filing ? acusePatch : clearAcuse()),
    };
    if (existente) {
      await prisma.taxDeclaration.update({ where: { id: existente.id }, data });
    } else {
      await prisma.taxDeclaration.create({
        data: { companyId, periodo, tipo: "ISN_MENSUAL", isnEntidad: entidad, ...data },
      });
    }
    return NextResponse.json({ ok: true, action, entidad });
  }

  // La decisión del Art. 4º LIEPS. No es una preferencia de pantalla: cambia el
  // importe del mes completo, así que se guarda con quién y cuándo, y va a la
  // bitácora. No borra ni recalcula lo ya presentado — eso quedó congelado en
  // `iepsDetalle` de cada periodo declarado.
  if (action === "decidir-ieps") {
    if (typeof acreditaBody !== "boolean") {
      return NextResponse.json(
        { error: "Falta la decisión: acredita true o false (Art. 4º LIEPS)." },
        { status: 400 },
      );
    }
    await prisma.company.update({
      where: { id: companyId },
      data: {
        iepsAcredita: acreditaBody,
        iepsAcreditaAt: new Date(),
        iepsAcreditaPor: session.user.id,
        iepsAcreditaNota: (notaBody ?? "").trim() || null,
      },
    });
    registrarBitacora({
      companyId,
      userId: session.user.id,
      accion: "ieps.acreditamiento.decidir",
      entidad: "Company",
      entidadId: companyId,
      detalle: { acredita: acreditaBody, nota: (notaBody ?? "").trim() || null },
    });
    return NextResponse.json({ ok: true, action, acredita: acreditaBody });
  }

  // IEPS: su propia declaración de pago definitivo (Art. 5º LIEPS), con su
  // acuse. Al presentarla se congela el desglose Y el criterio de
  // acreditamiento con el que se calculó.
  if (action === "file-ieps" || action === "unfile-ieps") {
    const filing = action === "file-ieps";
    let iepsPatch: Record<string, unknown> = {};
    if (filing) {
      const empresa = await prisma.company.findUnique({
        where: { id: companyId },
        select: { iepsAcredita: true },
      });
      const decision: DecisionAcreditamiento =
        empresa?.iepsAcredita == null ? "sin_decidir" : empresa.iepsAcredita ? "acredita" : "no_acredita";
      const p = periodoIeps(year, month, await leerRenglonesIeps(prisma, companyId, year, month));
      const res = aPagarIeps(p, decision);
      // Sin decisión no hay monto, y marcar presentada una cifra que no existe
      // dejaría el periodo mintiendo. Se contesta el Art. 4º primero.
      if (res.monto === null) {
        return NextResponse.json(
          {
            error:
              "Falta decidir si esta empresa acredita el IEPS que le trasladan (Art. 4º LIEPS). " +
              "Sin esa decisión el importe del mes no está determinado.",
          },
          { status: 409 },
        );
      }
      iepsPatch = {
        iepsPagar: res.monto,
        iepsSaldoFavor: res.saldoFavor > 0 ? res.saldoFavor : null,
        iepsDetalle: {
          trasladado: p.trasladado,
          pagado: p.pagado,
          pagadoAcreditable: p.pagadoAcreditable,
          pagadoNoAcreditable: p.pagadoNoAcreditable,
          pagadoSinClasificar: p.pagadoSinClasificar,
          retenido: p.retenido,
          acreditamiento: decision,
          acreditado: res.acreditado,
          saldoFavor: res.saldoFavor,
          porClase: res.porClase,
          completo: res.completo,
          baseFecha: p.baseFecha,
          porTasa: p.porTasa.map((t) => ({
            tasa: t.tasa,
            trasladado: t.trasladado,
            pagado: t.pagado,
            renglones: t.renglones,
            inciso: t.inciso.etiqueta,
            certeza: t.inciso.certeza,
          })),
        },
      };
    }
    await upsertRow(prisma, companyId, periodo, "IEPS_MENSUAL", {
      status: filing ? "FILED" : "CALCULATED",
      ...iepsPatch,
      ...(filing ? acusePatch : clearAcuse()),
    });
    return NextResponse.json({ ok: true, action });
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
