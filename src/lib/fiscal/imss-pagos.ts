import { prisma } from "../prisma";
import { calcularVencimiento } from "../obligaciones";
import { elegirMovimientoSugerido, VENTANA_DIAS_SUGERENCIA } from "../conciliacion-impuestos";
import type { DeclarationStatus } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// Ciclo de pago de cuotas IMSS (SIPARE) — LSS Art. 39.
//
//   - MENSUAL: cuotas obrero-patronales del mes, a pagar a más tardar el día 17
//     del mes siguiente (recorrido a día hábil), vía línea de captura SIPARE.
//   - BIMESTRAL: RCV + amortizaciones Infonavit del bimestre, a pagar el día 17
//     del mes siguiente al CIERRE del bimestre (ene-feb → 17 mar, …,
//     nov-dic → 17 ene del año siguiente).
//
// El ESTIMADO sale de la nómina timbrada (agregados de PayrollItem), con dos
// salvedades documentadas — el SUA determina la cifra exacta y el usuario la
// ajusta al registrar el pago:
//
//   1. `imssPatronal` guardado es el TOTAL patronal, que ya incluye RCV
//      (retiro 2% + cesantía y vejez progresiva), un ramo que en realidad se
//      entera BIMESTRALMENTE. La nómina guardada no lo desglosa, así que el
//      estimado mensual es ligeramente mayor al SIPARE mensual estricto.
//   2. `infonavit` guardado son las amortizaciones de crédito retenidas al
//      trabajador; la aportación patronal del 5% de vivienda no se calcula en
//      la nómina, por lo que el estimado bimestral es un piso, no la cifra
//      final.
//
// La decisión del renglón del checklist vive en decidirChecklist (pura); las
// filas se guardan como TaxDeclaration con tipos IMSS_MENSUAL / IMSS_BIMESTRAL.
// El periodo bimestral se llavea con el MES QUE CIERRA el bimestre ("2026-02"
// = ene-feb), manteniendo el formato "YYYY-MM" uniforme.
// ─────────────────────────────────────────────────────────────────────────────

const MESES_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function periodoStr(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Días (fechas calendario, sin horas) de `hoy` a `fecha`; negativo = vencida. */
function diasPara(fecha: Date, hoy: Date): number {
  const a = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
  const b = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

// ── Periodo mensual ───────────────────────────────────────────────────────────

export interface EstimadoImssMensual {
  imssObrero: number;
  imssPatronal: number;
  total: number;
}

export interface PeriodoImssMensual {
  periodo: string; // "YYYY-MM"
  /** Día 17 del mes siguiente, recorrido a día hábil (cruza ejercicio en dic). */
  fechaLimite: Date;
  estimado: EstimadoImssMensual;
}

/**
 * Periodo de cuotas IMSS mensuales: estimado desde las sumas de nómina provistas
 * y fecha límite (día 17 del mes siguiente en día hábil — reutiliza
 * calcularVencimiento del motor de obligaciones). Función PURA.
 */
export function periodoImssMensual(
  year: number,
  month: number,
  sums: { imssObrero: number; imssPatronal: number }
): PeriodoImssMensual {
  const periodo = periodoStr(year, month);
  const fechaLimite = calcularVencimiento(
    { tipo: "IMSS_MENSUAL", descripcion: "Cuotas IMSS mensuales", periodicidad: "MENSUAL", diaVencimiento: 17 },
    periodo
  );
  const imssObrero = r2(sums.imssObrero);
  const imssPatronal = r2(sums.imssPatronal);
  return {
    periodo,
    fechaLimite,
    estimado: { imssObrero, imssPatronal, total: r2(imssObrero + imssPatronal) },
  };
}

// ── Bimestre ──────────────────────────────────────────────────────────────────

export interface BimestreImss {
  /** 1-6 (ene-feb = 1 … nov-dic = 6). */
  bimestre: number;
  /** Los dos meses del bimestre, 1-12. */
  meses: [number, number];
  /** true cuando `month` es el mes que CIERRA el bimestre (feb, abr, jun, ago, oct, dic). */
  cierraBimestre: boolean;
  /** Periodo con que se llavea la fila IMSS_BIMESTRAL: el mes de cierre, "YYYY-MM". */
  periodo: string;
  /** "enero-febrero de 2026" — para textos. */
  etiqueta: string;
  /** Día 17 del mes siguiente al cierre del bimestre, en día hábil (nov-dic → 17 ene). */
  fechaLimite: Date;
}

/**
 * Bimestre IMSS al que pertenece `month`, con su fecha límite de pago de
 * RCV + Infonavit (LSS Art. 39). Función PURA.
 */
export function bimestreDe(year: number, month: number): BimestreImss {
  const bimestre = Math.ceil(month / 2);
  const mesCierre = bimestre * 2;
  const meses: [number, number] = [mesCierre - 1, mesCierre];
  const fechaLimite = calcularVencimiento(
    { tipo: "IMSS_BIMESTRAL", descripcion: "RCV e Infonavit bimestral", periodicidad: "BIMESTRAL", diaVencimiento: 17 },
    `${year}-B${bimestre}`
  );
  return {
    bimestre,
    meses,
    cierraBimestre: month === mesCierre,
    periodo: periodoStr(year, mesCierre),
    etiqueta: `${MESES_ES[meses[0] - 1]}-${MESES_ES[meses[1] - 1]} de ${year}`,
    fechaLimite,
  };
}

export interface EstimadoImssBimestral {
  /** Amortizaciones de crédito Infonavit retenidas en los dos meses. */
  infonavit: number;
  total: number;
}

/**
 * Estimado bimestral (RCV + Infonavit) desde las sumas de los dos meses del
 * bimestre. La nómina guardada sólo desglosa las amortizaciones Infonavit
 * retenidas — RCV viaja dentro del total patronal mensual y la aportación
 * patronal del 5% no se calcula — así que es un PISO; el SUA da la cifra exacta.
 * Función PURA.
 */
export function estimadoImssBimestral(
  sumsMeses: Array<{ infonavit: number }>
): EstimadoImssBimestral {
  const infonavit = r2(sumsMeses.reduce((s, m) => s + m.infonavit, 0));
  return { infonavit, total: infonavit };
}

// ── Estado agregado (DB) ──────────────────────────────────────────────────────

export interface ImssDeclRow {
  id: string;
  status: DeclarationStatus;
  monto: number | null;
  lineaCaptura: string | null;
  fechaPresentacion: string | null; // ISO
  fechaLimitePago: string | null; // ISO
  acuseUrl: string | null;
  /**
   * true cuando el pago ya tiene un movimiento bancario MATCHED vinculado
   * (conciliado vía match-impuesto en /bancos). Un pago registrado a mano en
   * Cumplimiento nace sin evidencia — la tarjeta lo señala y el vínculo se
   * hace en Bancos → Buscar coincidencia.
   */
  conciliadaBanco: boolean;
}

/**
 * Movimiento bancario sugerido como pago de la obligación: el mejor egreso
 * UNMATCHED dentro de ±3 días de la fecha límite y ±1% del monto objetivo
 * (cifra registrada o estimado). SÓLO sugerencia — los pagos de impuestos son
 * de alto riesgo y nunca se auto-concilian; la tarjeta lo muestra y el usuario
 * decide (PATCH match-impuesto).
 */
export interface MovimientoSugeridoImss {
  id: string;
  fecha: string; // ISO date "YYYY-MM-DD"
  descripcion: string;
  monto: number;
}

export interface EstadoImssMensual {
  periodo: string;
  fechaLimite: string; // ISO date "YYYY-MM-DD"
  diasRestantes: number;
  vencida: boolean;
  estimado: EstimadoImssMensual;
  declaracion: ImssDeclRow | null;
  presentada: boolean;
  pagada: boolean;
  movimientoSugerido: MovimientoSugeridoImss | null;
}

export interface EstadoImssBimestral {
  bimestre: number;
  periodo: string; // mes de cierre "YYYY-MM"
  meses: [number, number];
  etiqueta: string;
  fechaLimite: string; // ISO date
  diasRestantes: number;
  vencida: boolean;
  estimado: EstimadoImssBimestral;
  declaracion: ImssDeclRow | null;
  presentada: boolean;
  pagada: boolean;
  movimientoSugerido: MovimientoSugeridoImss | null;
}

export interface EstadoPagosImss {
  periodo: string;
  year: number;
  month: number;
  nomina: { tieneEmpleados: boolean; corridasDelMes: number; timbradasDelMes: number };
  mensual: EstadoImssMensual;
  /** Sólo cuando `month` CIERRA un bimestre (feb, abr, jun, ago, oct, dic). */
  bimestral: EstadoImssBimestral | null;
}

const PAGADA: DeclarationStatus[] = ["PAID"];
const PRESENTADA: DeclarationStatus[] = ["FILED", "PAID"];

// Mismos estatus de corrida que el GET de /api/impuestos usa para agregar la
// nómina del mes — así el estimado coincide con la tarjeta de nómina vecina.
const RUN_STATUSES = ["CALCULATED", "STAMPED", "PAID"] as const;

function toDeclRow(d: {
  id: string;
  status: DeclarationStatus;
  imssCuotas: number | null;
  lineaCaptura: string | null;
  fechaPresentacion: Date | null;
  fechaLimitePago: Date | null;
  acuseUrl: string | null;
  bankTransactions: { id: string }[];
} | null): ImssDeclRow | null {
  if (!d) return null;
  return {
    id: d.id,
    status: d.status,
    monto: d.imssCuotas,
    lineaCaptura: d.lineaCaptura,
    fechaPresentacion: d.fechaPresentacion?.toISOString() ?? null,
    fechaLimitePago: d.fechaLimitePago?.toISOString() ?? null,
    acuseUrl: d.acuseUrl,
    conciliadaBanco: d.bankTransactions.length > 0,
  };
}

const DECL_SELECT = {
  id: true,
  status: true,
  imssCuotas: true,
  lineaCaptura: true,
  fechaPresentacion: true,
  fechaLimitePago: true,
  acuseUrl: true,
  // ¿Ya hay evidencia bancaria? (v1: a lo más un movimiento por declaración.)
  bankTransactions: { where: { status: "MATCHED" as const }, select: { id: true }, take: 1 },
} as const;

/**
 * Mejor egreso UNMATCHED como sugerencia de pago (±3 días de la fecha límite,
 * ±1% del objetivo). La decisión es pura (elegirMovimientoSugerido); aquí sólo
 * se acota la consulta. Null cuando no hay objetivo (>0) o nada califica.
 */
async function movimientoSugeridoPara(
  companyId: string,
  objetivo: number | null | undefined,
  fechaLimite: Date
): Promise<MovimientoSugeridoImss | null> {
  if (objetivo == null || !isFinite(objetivo) || objetivo <= 0) return null;
  const desde = new Date(fechaLimite.getTime() - (VENTANA_DIAS_SUGERENCIA + 1) * 86_400_000);
  const hasta = new Date(fechaLimite.getTime() + (VENTANA_DIAS_SUGERENCIA + 1) * 86_400_000);
  const movimientos = await prisma.bankTransaction.findMany({
    where: { companyId, status: "UNMATCHED", monto: { lt: 0 }, fecha: { gte: desde, lte: hasta } },
    select: { id: true, fecha: true, descripcion: true, monto: true, status: true },
    take: 100,
  });
  const mejor = elegirMovimientoSugerido(objetivo, fechaLimite, movimientos);
  if (!mejor) return null;
  return {
    id: mejor.id,
    fecha: mejor.fecha.toISOString().slice(0, 10),
    descripcion: mejor.descripcion,
    monto: mejor.monto,
  };
}

/**
 * Estado del ciclo de pago IMSS de la empresa para un mes: estimado mensual +
 * fila IMSS_MENSUAL, y — cuando el mes cierra bimestre — estimado RCV/Infonavit
 * + fila IMSS_BIMESTRAL. Sin auth: el llamador autoriza `companyId` antes.
 */
export async function estadoPagosImss(
  companyId: string,
  year: number,
  month: number,
  hoy: Date = new Date()
): Promise<EstadoPagosImss> {
  const periodo = periodoStr(year, month);
  const bim = bimestreDe(year, month);
  const from = new Date(year, month - 1, 1);
  const to = new Date(year, month, 1);
  // Primer mes del bimestre (para el agregado bimestral, sólo en mes de cierre).
  const fromBim = new Date(year, bim.meses[0] - 1, 1);

  const [sumsMes, sumsBimestre, corridas, empleadosActivos, declMensual, declBimestral] =
    await Promise.all([
      prisma.payrollItem.aggregate({
        where: {
          payrollRun: { companyId, status: { in: [...RUN_STATUSES] }, fechaPago: { gte: from, lt: to } },
        },
        _sum: { imssObrero: true, imssPatronal: true, infonavit: true },
      }),
      bim.cierraBimestre
        ? prisma.payrollItem.aggregate({
            where: {
              payrollRun: { companyId, status: { in: [...RUN_STATUSES] }, fechaPago: { gte: fromBim, lt: to } },
            },
            _sum: { infonavit: true },
          })
        : Promise.resolve(null),
      prisma.payrollRun.findMany({
        where: { companyId, fechaPago: { gte: from, lt: to } },
        select: { status: true },
      }),
      prisma.employee.count({ where: { companyId, isActive: true } }),
      prisma.taxDeclaration.findFirst({
        where: { companyId, tipo: "IMSS_MENSUAL", periodo },
        select: DECL_SELECT,
      }),
      bim.cierraBimestre
        ? prisma.taxDeclaration.findFirst({
            where: { companyId, tipo: "IMSS_BIMESTRAL", periodo: bim.periodo },
            select: DECL_SELECT,
          })
        : Promise.resolve(null),
    ]);

  const mensualPeriodo = periodoImssMensual(year, month, {
    imssObrero: sumsMes._sum.imssObrero ?? 0,
    imssPatronal: sumsMes._sum.imssPatronal ?? 0,
  });
  const diasMensual = diasPara(mensualPeriodo.fechaLimite, hoy);

  // Sugerencia de conciliación (sólo si el pago sigue pendiente): la cifra
  // registrada (SUA) manda sobre el estimado de nómina.
  const pagadaMensual = declMensual != null && PAGADA.includes(declMensual.status);
  const objetivoMensual = declMensual?.imssCuotas ?? mensualPeriodo.estimado.total;
  const sugeridoMensual = pagadaMensual
    ? null
    : await movimientoSugeridoPara(companyId, objetivoMensual, mensualPeriodo.fechaLimite);

  const mensual: EstadoImssMensual = {
    periodo,
    fechaLimite: mensualPeriodo.fechaLimite.toISOString().slice(0, 10),
    diasRestantes: diasMensual,
    vencida: diasMensual < 0,
    estimado: mensualPeriodo.estimado,
    declaracion: toDeclRow(declMensual),
    presentada: declMensual != null && PRESENTADA.includes(declMensual.status),
    pagada: pagadaMensual,
    movimientoSugerido: sugeridoMensual,
  };

  let bimestral: EstadoImssBimestral | null = null;
  if (bim.cierraBimestre) {
    const estimadoBim = estimadoImssBimestral([{ infonavit: sumsBimestre?._sum.infonavit ?? 0 }]);
    const diasBim = diasPara(bim.fechaLimite, hoy);
    const pagadaBim = declBimestral != null && PAGADA.includes(declBimestral.status);
    const objetivoBim = declBimestral?.imssCuotas ?? estimadoBim.total;
    const sugeridoBim = pagadaBim
      ? null
      : await movimientoSugeridoPara(companyId, objetivoBim, bim.fechaLimite);
    bimestral = {
      bimestre: bim.bimestre,
      periodo: bim.periodo,
      meses: bim.meses,
      etiqueta: bim.etiqueta,
      fechaLimite: bim.fechaLimite.toISOString().slice(0, 10),
      diasRestantes: diasBim,
      vencida: diasBim < 0,
      estimado: estimadoBim,
      declaracion: toDeclRow(declBimestral),
      presentada: declBimestral != null && PRESENTADA.includes(declBimestral.status),
      pagada: pagadaBim,
      movimientoSugerido: sugeridoBim,
    };
  }

  return {
    periodo,
    year,
    month,
    nomina: {
      tieneEmpleados: empleadosActivos > 0,
      corridasDelMes: corridas.length,
      timbradasDelMes: corridas.filter((r) => r.status === "STAMPED" || r.status === "PAID").length,
    },
    mensual,
    bimestral,
  };
}
