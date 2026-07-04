// ─────────────────────────────────────────────────────────────────────────────
// Apertura fiscal — el punto de partida de la empresa, armado con PROCEDENCIA
// por dato para que el contador lo revise y lo CONFIRME una vez.
//
// Hoy el estado inicial (saldo a favor de IVA, pérdidas por amortizar,
// coeficiente, pagos provisionales previos, obligaciones) se ensambla en
// silencio desde el backfill del SAT y el sync de acuses de Syntage; si una
// pieza llega mal, todos los meses posteriores heredan el error y sólo los
// eslabones FALTANTES se avisan (advertencias de cadena), nunca los ERRÓNEOS.
// Esta pantalla responde «¿de dónde salió cada número?» y deja corregirlo.
//
// Patrón de la casa: la DECISIÓN (fuente/editable de cada dato) es una función
// PURA sobre insumos ya consultados (decidirApertura) — probada sin base de
// datos — y estadoApertura() reúne los insumos en consultas acotadas (conteos,
// banderas y filas chicas; nunca listas grandes ni bytes de PDF).
//
// El saldo a favor de IVA inicial NO es una fuente de arrastre nueva: vive en
// la fila TaxDeclaration IVA_MENSUAL del mes ANTERIOR al primer mes computado
// (ivaSaldoFavor), exactamente la fila que computeTaxPosition ya lee (Art. 6
// LIVA). La corrección manual crea/actualiza esa fila con isHistorical=true —
// el mismo mecanismo del import de acuses del onboarding.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";
import type { DeclarationStatus } from "@prisma/client";
import { getSatSyncStatus } from "../sat-status";
import { coeficienteAnualConHistorial } from "../impuestos";

// ── Tipos ────────────────────────────────────────────────────────────────────

export type FuenteTipo =
  | "acuse" // extraído de un acuse del SAT (backfill Syntage o PDF subido)
  | "manual" // capturado/corregido por el contador
  | "calculado" // derivado por la app (declaración guardada in-app, CFDIs, anual calculada)
  | "regimen" // sembrado a partir del régimen fiscal
  | "csf" // tomado de la Constancia de Situación Fiscal
  | "nomina" // derivado de la nómina registrada
  | "sin-dato"; // no hay dato — hay que capturarlo

export interface FuenteDato {
  tipo: FuenteTipo;
  /** Referencia legible cuando aplica: periodo del acuse ("2026-05"), ejercicio de la anual, etc. */
  referencia?: string;
  /** Etiqueta en español formal lista para mostrar («del acuse de mayo de 2026»). */
  etiqueta: string;
}

/** Fila IVA_MENSUAL del mes anterior al primer mes computado (marcadores de origen, sin bytes). */
export interface DeclaracionAnteriorInput {
  ivaSaldoFavor: number | null;
  status: string;
  isHistorical: boolean;
  /** Tiene rastro de acuse del SAT (PDF, línea de captura, URL o datos extraídos). */
  tieneAcuse: boolean;
}

export interface PagoProvisionalInput {
  periodo: string; // "YYYY-MM"
  isrPagar: number | null;
  isHistorical: boolean;
  tieneAcuse: boolean;
}

export interface AperturaInputs {
  hoy: Date;
  rfc: string;
  regimenFiscal: string;
  /** Primer mes computado por la app: el de la factura timbrada más antigua ("YYYY-MM"). */
  primerPeriodo: string;
  declaracionAnterior: DeclaracionAnteriorInput | null;
  coeficiente: {
    manual: number | null;
    manualAnio: number | null;
    /** Derivado de la mejor declaración anual guardada (Art. 14, fracc. I). */
    deAnual: { valor: number; ejercicio: number } | null;
    /** El aplicado en el último pago provisional capturado de un acuse. */
    deProvisional: { valor: number; periodo: string } | null;
  };
  /** Remanente manual de pérdidas PM en Company (gana sobre la anual). */
  perdidaManual: { valor: number | null; anio: number | null };
  /** Remanente extraído de la anual del ejercicio anterior (isrPerdidaPendiente). */
  perdidaDeAnual: { valor: number; ejercicio: number } | null;
  /** Ledger PerdidaFiscal (Art. 57) — lo consume el provisional PF. */
  perdidasLedger: {
    ejercicio: number;
    montoOriginal: number;
    saldoActualizado: number;
    origen: string; // "CALCULADA" | "IMPORTADA"
  }[];
  /** ISR_PROVISIONAL guardados del ejercicio en curso, anteriores al mes actual. */
  pagosProvisionales: PagoProvisionalInput[];
  obligaciones: { tipo: string; descripcion: string; activa: boolean; fuente: string }[];
  nomina: { empleadosActivos: number; corridasImportadasSat: number };
  sincronizacion: {
    periodosCubiertos: number;
    periodosTotales: number;
    faltantes: string[];
    backfillTerminado: boolean;
  };
  confirmacion: { confirmadaAt: Date | null; confirmadaPor: string | null };
}

export interface EstadoApertura {
  /** Primer mes que la app computa ("YYYY-MM"). */
  primerPeriodo: string;
  /** Mes cuya declaración alimenta el arrastre del primer mes ("YYYY-MM"). */
  periodoAnterior: string;
  esPersonaMoral: boolean;
  ivaSaldoFavor: { valor: number | null; fuente: FuenteDato; editable: boolean };
  coeficiente: {
    aplica: boolean; // sólo persona moral (Art. 14)
    valor: number | null;
    anio: number | null;
    fuente: FuenteDato;
    editable: boolean;
  };
  /** Remanente de pérdidas PM (Art. 14) que amortiza el provisional. */
  perdidaPendiente: {
    aplica: boolean;
    valor: number | null;
    ejercicio: number | null;
    fuente: FuenteDato;
    editable: boolean;
  };
  /** Ledger de pérdidas por ejercicio (Art. 57) — lo consume el provisional PF. */
  perdidasPorAmortizar: {
    ejercicio: number;
    montoOriginal: number;
    saldoActualizado: number;
    fuente: FuenteDato;
  }[];
  pagosProvisionalesEjercicio: { mes: number; periodo: string; isrPagado: number; fuente: FuenteDato }[];
  obligaciones: { tipo: string; descripcion: string; activa: boolean; fuente: FuenteDato }[];
  nomina: { empleadosActivos: number; corridasImportadas: number };
  sincronizacion: {
    periodosCubiertos: number;
    periodosTotales: number;
    faltantes: string[];
    backfillTerminado: boolean;
  };
  confirmada: boolean;
  confirmadaAt: string | null;
  confirmadaPor: string | null;
}

// ── Helpers puros ────────────────────────────────────────────────────────────

const MESES_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

export function nombrePeriodo(periodo: string): string {
  const [y, m] = periodo.split("-").map(Number);
  return m >= 1 && m <= 12 ? `${MESES_ES[m - 1]} de ${y}` : periodo;
}

export function periodoDe(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Mes anterior a un periodo "YYYY-MM" (cruza ejercicio: enero → diciembre anterior). */
export function periodoAnteriorDe(periodo: string): string {
  const [y, m] = periodo.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

const SIN_DATO: FuenteDato = { tipo: "sin-dato", etiqueta: "sin dato — captúralo" };

/** Fuente de una fila TaxDeclaration según sus rastros de origen. */
function fuenteDeDeclaracion(row: { isHistorical: boolean; tieneAcuse: boolean }, periodo: string): FuenteDato {
  if (row.tieneAcuse) {
    return { tipo: "acuse", referencia: periodo, etiqueta: `del acuse de ${nombrePeriodo(periodo)}` };
  }
  if (row.isHistorical) {
    return { tipo: "manual", referencia: periodo, etiqueta: "capturado manualmente" };
  }
  return { tipo: "calculado", referencia: periodo, etiqueta: "calculado y guardado en la app" };
}

const FUENTES_OBLIGACION: Record<string, FuenteDato> = {
  REGIMEN: { tipo: "regimen", etiqueta: "derivada del régimen fiscal" },
  CSF: { tipo: "csf", etiqueta: "de la Constancia de Situación Fiscal" },
  NOMINA: { tipo: "nomina", etiqueta: "derivada de la nómina registrada" },
};

// ── Decisión pura ────────────────────────────────────────────────────────────

/**
 * Decide el snapshot de apertura (valor + fuente + editable por dato) a partir
 * de insumos ya consultados. Función PURA (sin DB) — se prueba aislada.
 */
export function decidirApertura(i: AperturaInputs): EstadoApertura {
  const periodoAnterior = periodoAnteriorDe(i.primerPeriodo);
  // Persona moral = RFC de 12 caracteres; sólo PM usa coeficiente (Art. 14) y
  // remanente en Company — las PF amortizan vía el ledger PerdidaFiscal (Art. 106).
  const esPersonaMoral = i.rfc.trim().length === 12;

  // Saldo a favor de IVA inicial: la fila IVA_MENSUAL del mes anterior.
  const decl = i.declaracionAnterior;
  const ivaSaldoFavor = {
    valor: decl ? (decl.ivaSaldoFavor ?? 0) : null,
    fuente: decl ? fuenteDeDeclaracion(decl, periodoAnterior) : SIN_DATO,
    editable: true,
  };

  // Coeficiente de utilidad — misma prioridad que computeTaxPosition:
  // manual (si su año coincide con el ejercicio en curso o es null) → anual →
  // provisional capturado → sin dato. (El fallback "calculado de CFDIs" del
  // motor es una estimación débil: aquí se muestra como sin dato para empujar
  // la captura del valor real.)
  const year = i.hoy.getFullYear();
  const c = i.coeficiente;
  let coeficiente: EstadoApertura["coeficiente"];
  if (!esPersonaMoral) {
    coeficiente = { aplica: false, valor: null, anio: null, fuente: SIN_DATO, editable: false };
  } else if (c.manual != null && (c.manualAnio === year || c.manualAnio == null)) {
    coeficiente = {
      aplica: true,
      valor: c.manual,
      anio: c.manualAnio,
      fuente: { tipo: "manual", etiqueta: "capturado manualmente" },
      editable: true,
    };
  } else if (c.deAnual) {
    coeficiente = {
      aplica: true,
      valor: c.deAnual.valor,
      anio: c.deAnual.ejercicio + 1,
      fuente: {
        tipo: "acuse",
        referencia: String(c.deAnual.ejercicio),
        etiqueta: `de la declaración anual ${c.deAnual.ejercicio}`,
      },
      editable: true,
    };
  } else if (c.deProvisional) {
    coeficiente = {
      aplica: true,
      valor: c.deProvisional.valor,
      anio: Number(c.deProvisional.periodo.slice(0, 4)),
      fuente: {
        tipo: "acuse",
        referencia: c.deProvisional.periodo,
        etiqueta: `del pago provisional de ${nombrePeriodo(c.deProvisional.periodo)}`,
      },
      editable: true,
    };
  } else {
    coeficiente = { aplica: true, valor: null, anio: null, fuente: SIN_DATO, editable: true };
  }

  // Remanente de pérdidas PM (Art. 14): manual gana; después la anual previa.
  let perdidaPendiente: EstadoApertura["perdidaPendiente"];
  if (!esPersonaMoral) {
    perdidaPendiente = { aplica: false, valor: null, ejercicio: null, fuente: SIN_DATO, editable: false };
  } else if (i.perdidaManual.valor != null) {
    perdidaPendiente = {
      aplica: true,
      valor: i.perdidaManual.valor,
      ejercicio: i.perdidaManual.anio,
      fuente: { tipo: "manual", etiqueta: "capturado manualmente" },
      editable: true,
    };
  } else if (i.perdidaDeAnual) {
    perdidaPendiente = {
      aplica: true,
      valor: i.perdidaDeAnual.valor,
      ejercicio: i.perdidaDeAnual.ejercicio,
      fuente: {
        tipo: "acuse",
        referencia: String(i.perdidaDeAnual.ejercicio),
        etiqueta: `de la declaración anual ${i.perdidaDeAnual.ejercicio}`,
      },
      editable: true,
    };
  } else {
    perdidaPendiente = { aplica: true, valor: null, ejercicio: null, fuente: SIN_DATO, editable: true };
  }

  // Ledger de pérdidas (Art. 57): IMPORTADA = acuse/captura inicial; CALCULADA
  // = generada por la declaración anual calculada en la app.
  const perdidasPorAmortizar = i.perdidasLedger
    .slice()
    .sort((a, b) => a.ejercicio - b.ejercicio)
    .map((p) => ({
      ejercicio: p.ejercicio,
      montoOriginal: p.montoOriginal,
      saldoActualizado: p.saldoActualizado,
      fuente:
        p.origen === "IMPORTADA"
          ? ({ tipo: "manual", etiqueta: "importada del acuse o capturada manualmente" } as FuenteDato)
          : ({ tipo: "calculado", etiqueta: "calculada por la declaración anual en la app" } as FuenteDato),
    }));

  const pagosProvisionalesEjercicio = i.pagosProvisionales
    .slice()
    .sort((a, b) => (a.periodo < b.periodo ? -1 : 1))
    .map((p) => ({
      mes: Number(p.periodo.slice(5, 7)),
      periodo: p.periodo,
      isrPagado: p.isrPagar ?? 0,
      fuente: fuenteDeDeclaracion(p, p.periodo),
    }));

  const obligaciones = i.obligaciones.map((o) => ({
    tipo: o.tipo,
    descripcion: o.descripcion,
    activa: o.activa,
    fuente: FUENTES_OBLIGACION[o.fuente] ?? {
      tipo: "calculado" as FuenteTipo,
      etiqueta: "registrada en la app",
    },
  }));

  return {
    primerPeriodo: i.primerPeriodo,
    periodoAnterior,
    esPersonaMoral,
    ivaSaldoFavor,
    coeficiente,
    perdidaPendiente,
    perdidasPorAmortizar,
    pagosProvisionalesEjercicio,
    obligaciones,
    nomina: {
      empleadosActivos: i.nomina.empleadosActivos,
      corridasImportadas: i.nomina.corridasImportadasSat,
    },
    sincronizacion: i.sincronizacion,
    confirmada: i.confirmacion.confirmadaAt != null,
    confirmadaAt: i.confirmacion.confirmadaAt?.toISOString() ?? null,
    confirmadaPor: i.confirmacion.confirmadaPor,
  };
}

// ── Ensamblado (consultas acotadas) ──────────────────────────────────────────

const GUARDADA_STATUSES: DeclarationStatus[] = ["CALCULATED", "FILED", "PAID"];

/** Rastro de acuse en una fila (sin traer los bytes del PDF). */
function tieneAcuseDe(row: {
  acusePdfNombre: string | null;
  acuseUrl: string | null;
  lineaCaptura: string | null;
  acuseData: unknown;
  fechaPresentacion: Date | null;
}): boolean {
  return (
    row.acusePdfNombre != null ||
    row.acuseUrl != null ||
    row.lineaCaptura != null ||
    row.acuseData != null ||
    row.fechaPresentacion != null
  );
}

/**
 * Primer mes computado por la app: el de la factura timbrada más antigua.
 * Sin facturas todavía → el mes actual (el arrastre alimentaría a este mes).
 */
export async function primerPeriodoComputado(companyId: string, hoy: Date = new Date()): Promise<string> {
  const primera = await prisma.invoice.aggregate({
    where: { companyId, status: "STAMPED" },
    _min: { fecha: true },
  });
  return primera._min.fecha ? periodoDe(primera._min.fecha) : periodoDe(hoy);
}

/**
 * Snapshot de apertura de la empresa con procedencia por dato. Consultas
 * acotadas (conteos, banderas y filas chicas) y decisión en función pura.
 * Sin auth — el llamador debe autorizar el acceso a `companyId` antes.
 */
export async function estadoApertura(companyId: string, hoy: Date = new Date()): Promise<EstadoApertura> {
  const year = hoy.getFullYear();
  const prevYear = year - 1;
  const periodoActual = periodoDe(hoy);

  const [company, primerPeriodo] = await Promise.all([
    prisma.company.findUnique({
      where: { id: companyId },
      select: {
        rfc: true,
        regimenFiscal: true,
        coeficienteUtilidad: true,
        coeficienteAnio: true,
        perdidaFiscalPendiente: true,
        perdidaFiscalAnio: true,
        aperturaConfirmadaAt: true,
        aperturaConfirmadaPor: true,
      },
    }),
    primerPeriodoComputado(companyId, hoy),
  ]);
  if (!company) throw new Error("Empresa no encontrada");

  const periodoAnterior = periodoAnteriorDe(primerPeriodo);

  const declSelect = {
    acusePdfNombre: true,
    acuseUrl: true,
    lineaCaptura: true,
    acuseData: true,
    fechaPresentacion: true,
    isHistorical: true,
    status: true,
  } as const;

  const [declAnterior, annualDecls, coefProvRow, perdidas, pagosProv, obligaciones, empleadosActivos, corridasSat, sat] =
    await Promise.all([
      // La MISMA fila que computeTaxPosition lee para el arrastre (Art. 6 LIVA).
      prisma.taxDeclaration.findFirst({
        where: {
          companyId,
          tipo: "IVA_MENSUAL",
          periodo: periodoAnterior,
          status: { in: GUARDADA_STATUSES },
        },
        select: { ivaSaldoFavor: true, ...declSelect },
      }),
      // Anuales guardadas de los últimos 5 ejercicios (mismas que el motor).
      prisma.taxDeclaration.findMany({
        where: {
          companyId,
          tipo: "DECLARACION_ANUAL",
          OR: Array.from({ length: 5 }, (_, k) => ({ periodo: { startsWith: String(prevYear - k) } })),
          status: { in: GUARDADA_STATUSES },
        },
        orderBy: { periodo: "desc" },
        select: {
          periodo: true,
          isrIngresos: true,
          isrDeducciones: true,
          isrBaseGravable: true,
          isrCoeficienteUtilidad: true,
          isrPerdidaPendiente: true,
        },
      }),
      prisma.taxDeclaration.findFirst({
        where: { companyId, tipo: "ISR_PROVISIONAL", isrCoeficienteUtilidad: { not: null } },
        orderBy: { periodo: "desc" },
        select: { periodo: true, isrCoeficienteUtilidad: true },
      }),
      prisma.perdidaFiscal.findMany({
        where: { companyId },
        select: { ejercicioOrigen: true, montoOriginal: true, saldoActualizado: true, origen: true, agotada: true },
      }),
      // Pagos provisionales guardados del ejercicio en curso, previos al mes actual.
      prisma.taxDeclaration.findMany({
        where: {
          companyId,
          tipo: "ISR_PROVISIONAL",
          periodo: { gte: `${year}-01`, lt: periodoActual },
          status: { in: GUARDADA_STATUSES },
        },
        select: { periodo: true, isrPagar: true, ...declSelect },
      }),
      prisma.companyObligation.findMany({
        where: { companyId },
        orderBy: { tipo: "asc" },
        select: { tipo: true, descripcion: true, activa: true, fuente: true },
      }),
      prisma.employee.count({ where: { companyId, isActive: true } }),
      prisma.payrollRun.count({ where: { companyId, origen: "SAT" } }),
      getSatSyncStatus(companyId, hoy),
    ]);

  // Coeficiente derivado de las anuales con la regla de arrastre del Art. 14
  // (hasta 5 ejercicios atrás) — reutiliza la función pura del motor.
  const anual = coeficienteAnualConHistorial(annualDecls, prevYear);

  // Remanente de pérdidas de la anual del ejercicio inmediato anterior — misma
  // regla que computeTaxPosition (no anuales más viejas).
  const anualPrev = annualDecls.find((r) => r.periodo.startsWith(String(prevYear))) ?? null;

  const inputs: AperturaInputs = {
    hoy,
    rfc: company.rfc,
    regimenFiscal: company.regimenFiscal,
    primerPeriodo,
    declaracionAnterior: declAnterior
      ? {
          ivaSaldoFavor: declAnterior.ivaSaldoFavor,
          status: declAnterior.status,
          isHistorical: declAnterior.isHistorical,
          tieneAcuse: tieneAcuseDe(declAnterior),
        }
      : null,
    coeficiente: {
      manual: company.coeficienteUtilidad,
      manualAnio: company.coeficienteAnio,
      deAnual: anual ? { valor: anual.coeficiente, ejercicio: anual.ejercicio } : null,
      deProvisional:
        coefProvRow?.isrCoeficienteUtilidad != null
          ? { valor: coefProvRow.isrCoeficienteUtilidad, periodo: coefProvRow.periodo }
          : null,
    },
    perdidaManual: { valor: company.perdidaFiscalPendiente, anio: company.perdidaFiscalAnio },
    perdidaDeAnual:
      anualPrev?.isrPerdidaPendiente != null
        ? { valor: anualPrev.isrPerdidaPendiente, ejercicio: prevYear }
        : null,
    perdidasLedger: perdidas
      .filter((p) => !p.agotada)
      .map((p) => ({
        ejercicio: p.ejercicioOrigen,
        montoOriginal: p.montoOriginal,
        saldoActualizado: p.saldoActualizado,
        origen: p.origen,
      })),
    pagosProvisionales: pagosProv.map((p) => ({
      periodo: p.periodo,
      isrPagar: p.isrPagar,
      isHistorical: p.isHistorical,
      tieneAcuse: tieneAcuseDe(p),
    })),
    obligaciones,
    nomina: { empleadosActivos, corridasImportadasSat: corridasSat },
    sincronizacion: {
      periodosCubiertos: sat.periodos.completos,
      periodosTotales: sat.periodos.total,
      faltantes: sat.faltantes,
      backfillTerminado: sat.backfillCompleted,
    },
    confirmacion: {
      confirmadaAt: company.aperturaConfirmadaAt,
      confirmadaPor: company.aperturaConfirmadaPor,
    },
  };

  return decidirApertura(inputs);
}

// ── Persistencia del saldo a favor inicial ───────────────────────────────────

/**
 * Persiste el saldo a favor de IVA INICIAL en la fila IVA_MENSUAL del mes
 * anterior al primer mes computado — la MISMA fila que computeTaxPosition lee
 * para el arrastre (Art. 6 LIVA); no se inventa una segunda fuente. Espeja el
 * import de acuses del onboarding: crea la fila con status FILED e
 * isHistorical=true (origen manual = fila histórica SIN rastro de acuse), o
 * actualiza la existente conservando su acuse como referencia.
 *
 * Devuelve el periodo tocado y el valor anterior (para la bitácora).
 */
export async function guardarSaldoFavorInicial(
  companyId: string,
  valor: number | null,
  hoy: Date = new Date()
): Promise<{ periodo: string; anterior: number | null; creada: boolean }> {
  const primerPeriodo = await primerPeriodoComputado(companyId, hoy);
  const periodo = periodoAnteriorDe(primerPeriodo);

  const existente = await prisma.taxDeclaration.findFirst({
    where: { companyId, tipo: "IVA_MENSUAL", periodo },
    orderBy: { updatedAt: "desc" },
    select: { id: true, ivaSaldoFavor: true, status: true },
  });

  if (existente) {
    await prisma.taxDeclaration.update({
      where: { id: existente.id },
      data: {
        ivaSaldoFavor: valor,
        // Una fila DRAFT no alimenta el arrastre: al capturar el saldo inicial
        // se promueve a FILED histórica (igual que el import de acuses).
        ...(GUARDADA_STATUSES.includes(existente.status) ? {} : { status: "FILED", isHistorical: true }),
      },
    });
    return { periodo, anterior: existente.ivaSaldoFavor, creada: false };
  }

  if (valor == null) return { periodo, anterior: null, creada: false }; // nada que borrar

  await prisma.taxDeclaration.create({
    data: {
      companyId,
      tipo: "IVA_MENSUAL",
      periodo,
      status: "FILED",
      isHistorical: true,
      ivaSaldoFavor: valor,
    },
  });
  return { periodo, anterior: null, creada: true };
}
