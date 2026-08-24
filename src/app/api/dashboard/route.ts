import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { TaxDeclarationType } from "@prisma/client";
import { getObligacionesPorRegimen } from "@/lib/obligaciones";
import { conCalculoEnVivo, montoDeObligacion } from "@/lib/obligaciones-monto";
import { detectComplementosPendientes } from "@/lib/complementos";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { computeTaxPosition } from "@/lib/impuestos";
import { getAsimiladosResumen } from "@/lib/fiscal/asimilados";
import { fielStatus } from "@/lib/fiel";
import { computeEstadoDatos } from "@/lib/estado-datos";

// GET /api/dashboard?companyId=xxx
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId)
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1; // 1-based

  // Current month boundaries
  const monthFrom = new Date(year, month - 1, 1);
  const monthTo   = new Date(year, month, 1);

  // ── Período fiscal EN JUEGO (mensuales) ───────────────────────────────────
  // El contador no piensa en el mes calendario: del día 1 al ~17 se trabaja el
  // MES ANTERIOR (su IVA/ISR/DIOT vencen el 17). El mes anterior deja de estar
  // "en juego" cuando su declaración ya se presentó; sólo entonces la tarjeta
  // de impuestos avanza al mes en curso (como avance acumulado).
  const prevDate    = new Date(year, month - 2, 1);
  const prevYear    = prevDate.getFullYear();
  const prevMonth   = prevDate.getMonth() + 1;
  const prevPeriodo = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;

  // ── Build last-6-months ranges ────────────────────────────────────────────
  const months6: { year: number; month: number; from: Date; to: Date; label: string }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(year, month - 1 - i, 1);
    months6.push({
      year:  d.getFullYear(),
      month: d.getMonth() + 1,
      from:  new Date(d.getFullYear(), d.getMonth(), 1),
      to:    new Date(d.getFullYear(), d.getMonth() + 1, 1),
      label: d.toLocaleDateString("es-MX", { month: "short", year: "2-digit" }),
    });
  }

  // ── Parallel queries ──────────────────────────────────────────────────────
  const [
    ingresosThisMonth,
    gastosThisMonth,
    ivaTaxesEmitidas,
    ivaTaxesRecibidas,
    recentInvoices,
    bankAccounts,
    savedDeclaracion,
    company,
    mesAnteriorPresentado,
    asimilados,
    invoiceCount,
    satRequests,
  ] = await Promise.all([
    // Ingresos this month
    prisma.invoice.aggregate({
      where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: monthFrom, lt: monthTo } },
      _sum: { subtotal: true, total: true },
      _count: { id: true },
    }),
    // Gastos this month
    prisma.invoice.aggregate({
      where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: monthFrom, lt: monthTo } },
      _sum: { subtotal: true, total: true },
      _count: { id: true },
    }),
    // IVA trasladado this month (emitidas)
    prisma.invoiceTax.aggregate({
      where: {
        invoice: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: monthFrom, lt: monthTo } },
        tipo: "IVA",
        retencion: false,
      },
      _sum: { importe: true },
    }),
    // IVA acreditable this month (recibidas)
    prisma.invoiceTax.aggregate({
      where: {
        invoice: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: monthFrom, lt: monthTo } },
        tipo: "IVA",
        retencion: false,
      },
      _sum: { importe: true },
    }),
    // Recent 6 invoices (newest first)
    prisma.invoice.findMany({
      where: {
        companyId,
        status: "STAMPED",
        tipo: { in: ["INGRESO", "EGRESO"] },
      },
      include: { customer: { select: { razonSocial: true, rfc: true } } },
      orderBy: { fecha: "desc" },
      take: 6,
    }),
    // Bank accounts with unmatched count
    prisma.bankAccount.findMany({
      where: { companyId },
      include: {
        _count: { select: { transactions: true } },
        transactions: {
          where: { status: "UNMATCHED" },
          select: { id: true, monto: true, tipo: true },
        },
      },
    }),
    // Latest saved declaration
    prisma.taxDeclaration.findFirst({
      where: { companyId, tipo: TaxDeclarationType.IVA_MENSUAL },
      orderBy: { periodo: "desc" },
    }),
    // Company for régimen + obligations
    prisma.company.findUnique({
      where: { id: companyId },
      include: { obligations: { where: { activa: true } } },
    }),
    // ¿El mes anterior ya se presentó? Decide el período de la tarjeta de
    // impuestos (IVA_MENSUAL manda como declaración mensual principal).
    prisma.taxDeclaration.findFirst({
      where: {
        companyId,
        tipo: TaxDeclarationType.IVA_MENSUAL,
        periodo: prevPeriodo,
        status: { in: ["FILED", "PAID"] },
      },
      select: { id: true },
    }),
    // Asimilados a salarios recibidos (Art. 94) — null si la empresa no recibe.
    getAsimiladosResumen(companyId, year, month),
    // ¿Hay al menos una factura? (take: 1 → conteo barato de existencia)
    prisma.invoice.count({ where: { companyId }, take: 1 }),
    // Solicitudes de descarga al SAT (acotado) para derivar estadoDatos.
    // Solo lectura: este GET nunca dispara una sincronización.
    prisma.satSyncRequest.findMany({
      where: { companyId, tipo: { in: ["EMITIDOS", "RECIBIDOS"] } },
      select: { status: true, year: true, month: true },
      orderBy: { createdAt: "desc" },
      take: 300,
    }),
  ]);

  // ── Posición fiscal del período EN JUEGO (motor real) ─────────────────────
  // Mes anterior sin presentar → ese es el período de la tarjeta "¿Cuánto
  // debo?" (vence el 17 de este mes). Ya presentado → mes en curso como
  // avance (vence el 17 del mes siguiente).
  const fiscalEnCurso = !!mesAnteriorPresentado;
  const fiscalYear    = fiscalEnCurso ? year : prevYear;
  const fiscalMonth   = fiscalEnCurso ? month : prevMonth;
  // Source of truth for "¿Cuánto debo?" (IVA flujo + ISR por régimen), not the
  // rough ivaEstimado below.
  const taxPosition = await computeTaxPosition(companyId, fiscalYear, fiscalMonth);
  // Misma llave que usan las obligaciones (`periodoKey`), para poder cruzarlas.
  const periodoFiscalKey = `${fiscalYear}-${String(fiscalMonth).padStart(2, "0")}`;

  // ── 6-month trend ─────────────────────────────────────────────────────────
  const trendData = await Promise.all(
    months6.map(async (m) => {
      const [ing, gas] = await Promise.all([
        prisma.invoice.aggregate({
          where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: m.from, lt: m.to } },
          _sum: { subtotal: true },
        }),
        prisma.invoice.aggregate({
          where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: m.from, lt: m.to } },
          _sum: { subtotal: true },
        }),
      ]);
      return {
        label:    m.label,
        periodo:  `${m.year}-${String(m.month).padStart(2, "0")}`,
        ingresos: ing._sum.subtotal ?? 0,
        gastos:   gas._sum.subtotal ?? 0,
      };
    })
  );

  // ── IVA estimation ────────────────────────────────────────────────────────
  const ivaTrasladado  = ivaTaxesEmitidas._sum.importe  ?? 0;
  const ivaAcreditable = ivaTaxesRecibidas._sum.importe ?? 0;
  const ivaEstimado    = ivaTrasladado - ivaAcreditable;

  // ── Upcoming obligations (next 45 days) ────────────────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const inXDays = new Date(today);
  inXDays.setDate(inXDays.getDate() + 45);

  // Ensure obligations seeded
  let obligations = company?.obligations ?? [];
  if (obligations.length === 0 && company?.regimenFiscal) {
    const obList = getObligacionesPorRegimen(company.regimenFiscal);
    if (obList.length > 0) {
      await Promise.all(
        obList.map((ob) =>
          prisma.companyObligation.upsert({
            where: { companyId_tipo: { companyId, tipo: ob.tipo } },
            update: {},
            create: {
              companyId,
              tipo:          ob.tipo,
              descripcion:   ob.descripcion,
              periodicidad:  ob.periodicidad,
              diaVencimiento: ob.diaVencimiento,
              mesVencimiento: ob.mesVencimiento ?? null,
              fuente:        "REGIMEN",
            },
          })
        )
      );
      obligations = await prisma.companyObligation.findMany({
        where: { companyId, activa: true },
      });
    }
  }

  // Calculate next due date for each obligation
  const MONTH_NAMES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
  const upcomingObs: {
    tipo: string;
    descripcion: string;
    periodicidad: string;
    dueDate: string;
    dueDateFmt: string;
    periodo: string;
    /** Declaration period key to match filings against (YYYY-MM monthly/bimestral; ejercicio year for anual). */
    periodoKey: string;
    daysUntil: number;
    status: "OVERDUE" | "SOON" | "UPCOMING";
  }[] = [];

  for (const ob of obligations) {
    if (ob.periodicidad === "ANUAL") {
      const dueYear = ob.mesVencimiento && ob.mesVencimiento < month ? year + 1 : year;
      const dueM    = ob.mesVencimiento ?? 3;
      const due     = new Date(dueYear, dueM - 1, ob.diaVencimiento);
      if (due >= today && due <= inXDays) {
        const diff = Math.round((due.getTime() - today.getTime()) / 86400000);
        upcomingObs.push({
          tipo:         ob.tipo,
          descripcion:  ob.descripcion,
          periodicidad: ob.periodicidad,
          dueDate:      due.toISOString().substring(0, 10),
          dueDateFmt:   `${ob.diaVencimiento} ${MONTH_NAMES[dueM - 1]} ${dueYear}`,
          periodo:      `${dueYear}`,
          periodoKey:   `${dueYear - 1}`, // anual: ejercicio declarado (año anterior al vencimiento)
          daysUntil:    diff,
          status:       diff === 0 ? "OVERDUE" : diff <= 7 ? "SOON" : "UPCOMING",
        });
      }
    } else {
      // MENSUAL / BIMESTRAL — del mes ANTERIOR al siguiente. El offset -1 es
      // esencial: del día 1 al ~17 el trámite en juego es el del mes pasado
      // (junio vence el 17 de julio) — sin él, el tablero decía "nada urgente"
      // a días de un vencimiento real. También se conservan vencidos SIN
      // presentar hasta 45 días atrás (luego se filtra lo ya presentado).
      const lookbackFrom = new Date(today);
      lookbackFrom.setDate(lookbackFrom.getDate() - 45);
      for (const offset of [-1, 0, 1]) {
        const d     = new Date(year, month - 1 + offset, 1);
        const y2    = d.getFullYear();
        const m2    = d.getMonth() + 1;
        const dueM  = m2 + 1 > 12 ? 1 : m2 + 1;          // following month
        const dueY  = m2 + 1 > 12 ? y2 + 1 : y2;
        const due   = new Date(dueY, dueM - 1, ob.diaVencimiento);

        if (due >= lookbackFrom && due <= inXDays) {
          const periodoStr = ob.periodicidad === "BIMESTRAL"
            ? `Bim ${Math.ceil(m2 / 2)} ${y2}`
            : `${MONTH_NAMES[m2 - 1]} ${y2}`;

          const diff = Math.round((due.getTime() - today.getTime()) / 86400000);
          upcomingObs.push({
            tipo:         ob.tipo,
            descripcion:  ob.descripcion,
            periodicidad: ob.periodicidad,
            dueDate:      due.toISOString().substring(0, 10),
            dueDateFmt:   `${ob.diaVencimiento} ${MONTH_NAMES[dueM - 1]} ${dueY}`,
            periodo:      periodoStr,
            periodoKey:   `${y2}-${String(m2).padStart(2, "0")}`, // periodo declarado (mes que cubre la obligación)
            daysUntil:    diff,
            status:       diff < 0 ? "OVERDUE" : diff <= 7 ? "SOON" : "UPCOMING",
          });
          // Sin break: se juntan todas las ocurrencias del rango y DESPUÉS de
          // consultar qué está presentado se elige una por obligación (la
          // pendiente más próxima) — con break, junio presentado ocultaría
          // el trámite de julio.
        }
      }
    }
  }

  // Sort by dueDate
  upcomingObs.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  // Check filing status for each
  const filedCheck = await Promise.all(
    upcomingObs.map(async (ob) => {
      // Only query if tipo maps to a valid TaxDeclarationType enum value
      const tipoEnum = Object.values(TaxDeclarationType).includes(ob.tipo as TaxDeclarationType)
        ? (ob.tipo as TaxDeclarationType)
        : null;
      // Match THIS obligation's period — not just any filed declaration of the
      // tipo, otherwise an earlier month's filing marks every period presentada.
      // Anual periodos vary in format (YYYY / YYYY-MM), so match by prefix.
      const periodoFilter =
        ob.periodicidad === "ANUAL" ? { startsWith: ob.periodoKey } : ob.periodoKey;
      // Se consultan TODOS los estados, no sólo los presentados. Un período
      // vencido y sin presentar suele tener su fila en borrador con el importe
      // ya calculado — que es justo el número que el aviso "tienes N vencidas"
      // prometía y nunca decía. El estado sigue decidiendo si CUENTA como
      // presentada; lo que cambia es que ya no se tira el importe.
      const decl = tipoEnum
        ? await prisma.taxDeclaration.findFirst({
            where: { companyId, tipo: tipoEnum, periodo: periodoFilter },
            orderBy: [{ status: "desc" }, { periodo: "desc" }],
          })
        : null;
      // Si esta obligación es del período fiscal EN JUEGO, el tablero ya lo
      // calculó desde los CFDIs (computeTaxPosition, arriba) y lo enseña en la
      // tarjeta «¿Cuánto debo?». Sin esto la banda decía «sin importe» encima
      // de la cifra que la propia página mostraba dos bloques más abajo —el
      // tablero contradiciéndose a sí mismo (visto en producción, MERCEDES
      // TRESPALACIOS: banda «4 vencidas · sin importe», tarjeta $333.79).
      const esPeriodoCalculado = ob.periodoKey === periodoFiscalKey;
      const { monto, motivo, estimado } = conCalculoEnVivo(
        montoDeObligacion(ob.tipo, decl),
        ob.tipo,
        esPeriodoCalculado ? { iva: taxPosition.iva.pagar, isr: taxPosition.isr.isrPagar } : null,
      );
      return {
        ...ob,
        filed: !!decl && (decl.status === "FILED" || decl.status === "PAID"),
        monto,
        // `true` = lo calculamos nosotros de los CFDIs, no lo acusó el SAT.
        montoEstimado: estimado,
        // Por qué no hay cifra: "informativa" (no se paga) vs "sin_calcular".
        montoMotivo: motivo,
        // El acuse es EL entregable del contador: si ya se presentó, se lleva
        // a la portada en vez de hacerlo buscarlo.
        acuseUrl: decl?.acuseUrl ?? null,
        lineaCaptura: decl?.lineaCaptura ?? null,
        fechaPresentacion: decl?.fechaPresentacion?.toISOString() ?? null,
      };
    })
  );

  // Una fila por obligación: la ocurrencia SIN presentar más próxima a vencer;
  // si todas las del rango ya se presentaron, la más reciente (badge ✓). Así el
  // mes anterior pendiente desplaza al mes en curso, y al presentarlo la lista
  // avanza sola al siguiente período.
  const porTipo = new Map<string, typeof filedCheck>();
  for (const o of filedCheck) {
    const arr = porTipo.get(o.tipo) ?? [];
    arr.push(o);
    porTipo.set(o.tipo, arr);
  }
  const obligacionesSeleccion: typeof filedCheck = [];
  for (const arr of porTipo.values()) {
    arr.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    obligacionesSeleccion.push(arr.find((o) => !o.filed) ?? arr[arr.length - 1]);
  }
  obligacionesSeleccion.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  // ── Bank reconciliation summary ───────────────────────────────────────────
  const bankSummary = bankAccounts.map((acct) => ({
    id:           acct.id,
    banco:        acct.banco,
    nombre:       acct.nombre,
    numeroCuenta: acct.numeroCuenta,
    totalTx:      acct._count.transactions,
    unmatchedCount: acct.transactions.length,
    unmatchedTotal: acct.transactions.reduce((s, t) => s + Math.abs(t.monto), 0),
  }));

  const totalUnmatched = bankSummary.reduce((s, a) => s + a.unmatchedCount, 0);

  // ── Recent invoices ───────────────────────────────────────────────────────
  const recentRows = recentInvoices.map((inv) => ({
    id:          inv.id,
    tipo:        inv.tipo,
    fecha:       inv.fecha,
    contraparte: inv.customer?.razonSocial ?? "—",
    rfc:         inv.customer?.rfc         ?? "—",
    total:       inv.total,
    status:      inv.status,
  }));

  // ── Current month KPIs ────────────────────────────────────────────────────
  const ingresosDelMes = ingresosThisMonth._sum.subtotal ?? 0;
  const gastosDelMes   = gastosThisMonth._sum.subtotal   ?? 0;
  const utilidadBruta  = ingresosDelMes - gastosDelMes;

  // ISR provisional now lives on its own ISR_PROVISIONAL row; the IVA_MENSUAL row
  // above carries only IVA. Pull the matching ISR figure for the card, falling
  // back to any legacy folded value still on the IVA_MENSUAL row.
  let lastIsrPagar = savedDeclaracion?.isrPagar ?? null;
  if (savedDeclaracion && lastIsrPagar == null) {
    const isrRow = await prisma.taxDeclaration.findFirst({
      where: { companyId, tipo: TaxDeclarationType.ISR_PROVISIONAL, periodo: savedDeclaracion.periodo },
      select: { isrPagar: true },
    });
    lastIsrPagar = isrRow?.isrPagar ?? null;
  }

  // Complementos de pago pendientes (REP owed on collected PPD invoices).
  const complementos = await detectComplementosPendientes(companyId, now);

  // ── Lo que se debe este mes (motor fiscal real, no estimación) ────────────
  // IVA en flujo de efectivo + ISR por régimen. El IVA/ISR mensual se presenta
  // ~día 17 del mes siguiente. isr puede ser null (sin coeficiente/tarifa).
  const MES_ABBR = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
  // FIEL (e.firma) expiry status — proactive "por vencer / vencida" warning.
  const fiel = company
    ? fielStatus({ fielCer: company.fielCer, fielVigencia: company.fielVigencia })
    : null;

  // Vence el 17 del mes SIGUIENTE al período en juego (Art. 5.1 RMF; sin los
  // días extra por sexto dígito — criterio conservador).
  const taxDue = new Date(fiscalYear, fiscalMonth, 17);
  const isrPagarMes = taxPosition.isr.isrPagar;
  const totalPagarMes = taxPosition.iva.pagar + (isrPagarMes ?? 0);
  const MES_LARGO = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

  // ── Estado de datos ("¿por qué está vacío mi tablero?") ───────────────────
  const estadoDatos = computeEstadoDatos({
    invoiceCount,
    fielOk: !!fiel && fiel.estado !== "sin_fiel",
    requests: satRequests,
    ultimaSincronizacion: company?.lastAutoSyncAt ?? null,
  });

  // ── Apertura fiscal: nudge de revisión del punto de partida ───────────────
  // Se sugiere confirmar cuando ya hay CON QUÉ revisar (e.firma configurada y
  // descarga histórica terminada) y aún no se ha confirmado.
  const aperturaConfirmada = company?.aperturaConfirmadaAt != null;
  const apertura = {
    confirmada: aperturaConfirmada,
    nudge:
      !aperturaConfirmada &&
      !!fiel &&
      fiel.estado !== "sin_fiel" &&
      company?.satBackfillCompletedAt != null,
  };

  return NextResponse.json({
    periodo: { year, month },
    fiel,
    estadoDatos,
    apertura,
    taxThisMonth: {
      iva: taxPosition.iva.pagar,
      isr: isrPagarMes,
      total: totalPagarMes,
      saldoAFavor: taxPosition.iva.saldoAFavor,
      // Período fiscal en juego (puede diferir del mes calendario) + modo:
      // "por_presentar" = mes anterior aún sin declarar; "en_curso" = avance
      // del mes corriente (el anterior ya se presentó).
      periodo: `${fiscalYear}-${String(fiscalMonth).padStart(2, "0")}`,
      periodoFmt: `${MES_LARGO[fiscalMonth - 1]} ${fiscalYear}`,
      modo: fiscalEnCurso ? "en_curso" : "por_presentar",
      vence: taxDue.toISOString().substring(0, 10),
      venceFmt: `${taxDue.getDate()} ${MES_ABBR[taxDue.getMonth()]} ${taxDue.getFullYear()}`,
      diasRestantes: Math.round((taxDue.getTime() - today.getTime()) / 86400000),
      tarifaVerificada: taxPosition.isr.tarifaVerificada,
      // Coeficiente aplicado + sugerido (para avisar de un ajuste desactualizado).
      coeficiente: taxPosition.isr.coeficiente,
      coeficienteSugerido: taxPosition.isr.coeficienteSugerido ?? null,
      coeficienteSugeridoFuente: taxPosition.isr.coeficienteSugeridoFuente ?? null,
    },
    // Asimilados a salarios recibidos (Art. 94): ingreso + ISR retenido del mes y
    // acumulado del año. null si la empresa no recibe asimilados.
    asimilados: asimilados
      ? { mes: asimilados.mes, anual: asimilados.anual }
      : null,
    kpis: {
      ingresosDelMes,
      gastosDelMes,
      utilidadBruta,
      ivaEstimado,
      ivaTrasladado,
      ivaAcreditable,
      facturasEmitidas: ingresosThisMonth._count.id,
      facturasRecibidas: gastosThisMonth._count.id,
    },
    trend: trendData,
    upcomingObligations: obligacionesSeleccion.slice(0, 5),
    recentInvoices: recentRows,
    bankSummary,
    totalUnmatched,
    complementos: {
      stats: complementos.stats,
      // Top few most-urgent for the dashboard card.
      pendientes: complementos.pendientes.slice(0, 5),
    },
    lastDeclaracion: savedDeclaracion ? {
      periodo: savedDeclaracion.periodo,
      status:  savedDeclaracion.status,
      ivaPagar: savedDeclaracion.ivaPagar,
      isrPagar: lastIsrPagar,
    } : null,
  });
}
