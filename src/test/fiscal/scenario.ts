// Adapters assemble synthetic inputs only; they never read fixture expectations.
import { evaluarChecks } from "@/lib/contabilidad/ce-readiness";
import {
  decidirChecklist, diasParaFechaLimite, fechaLimiteDeclaracion,
  type ChecklistDeclaracion,
} from "@/lib/fiscal/checklist-declaracion";
import { fechaCalendarioIso } from "@/lib/obligaciones";
import { decidirPasos, type HechosCierre } from "@/lib/cierre/workflow";
import { resolverEstadoCierre } from "@/lib/cierre/estado-canonico";
import type { CierreEvaluado } from "@/lib/cierre/evaluar";
import type { CloseCase, RegimeCase } from "./fixtures/v1";

export const syntheticCompanyId = "qa-fiscal-synthetic-company";

export function periodNumbers(period: string) {
  const [year, month] = period.split("-").map(Number);
  return { year, month };
}

export function regimeRows(fixture: RegimeCase) {
  return fixture.rows.map((row) => ({
    ...row,
    since: row.since ? new Date(row.since) : null,
    endedAt: row.endedAt ? new Date(row.endedAt) : null,
  }));
}

export function fiscalScenario(input: CloseCase["input"]) {
  const { year, month } = periodNumbers(input.period);
  const hoy = new Date(input.now);
  const fechaLimite = fechaLimiteDeclaracion(year, month);
  const diasRestantes = diasParaFechaLimite(fechaLimite, hoy);
  const filed = input.declaration === "FILED" || input.declaration === "PAID";
  const items = decidirChecklist({
    year, month, hoy, fechaLimite,
    aperturaConfirmada: true, aperturaOrigenConocido: true, aperturaOrigenes: [],
    satEmitidosCompleto: true, satRecibidosCompleto: true,
    cfdisConXml: 10, cfdisSinXml: 0, cfdiFaltantes: 0, advertenciasCadena: [],
    movimientosBancarios: input.bankTotal, movimientosSinConciliar: input.bankPending,
    sinActividadBancariaConfirmada: input.noBankConfirmed,
    repPorEmitir: { total: 0, vencidos: 0, montoPendiente: 0 },
    repProveedores: { total: 0, vencidos: 0 },
    // Distinct sentinels, NOT independently calculated or certified tax amounts.
    iva: { pagar: 7, saldoAFavor: 0 }, isrPagar: 11,
    diot: { aplica: false, generada: false, presentada: false },
    nomina: { tieneEmpleados: false, corridasDelMes: 0, timbradasDelMes: 0 },
    imss: { aplica: false, estimadoMensual: 0, pagadaMensual: false, bimestre: null },
    declaracionGuardada: input.declaration !== null, declaracionPresentada: filed,
  });
  const checklist: ChecklistDeclaracion | null = input.enginesAvailable ? {
    periodo: input.period, year, month, fechaLimite: fechaCalendarioIso(fechaLimite),
    diasRestantes, vencida: diasRestantes < 0, items,
    resumen: {
      total: items.length,
      listos: items.filter((item) => item.estado === "listo").length,
      pendientes: items.filter((item) => item.estado === "pendiente").length,
      atencion: items.filter((item) => item.estado === "atencion").length,
      noAplica: items.filter((item) => item.estado === "no-aplica").length,
    },
    posicion: {
      iva: { trasladado: 7, acreditable: 0, saldoFavorAnterior: 0, pagar: 7, saldoAFavor: 0 },
      isr: {
        metodo: "PM_ART14", coeficiente: 0.1, coeficienteFuente: "manual",
        coeficienteSugerido: null, coeficienteSugeridoFuente: null, coeficienteBase: null,
        ingresosAcumulados: 100, baseGravable: 10, isrPagar: 11, perdidaFiscalPendiente: null,
      },
      advertencias: [],
    },
  } : null;
  const readiness = input.enginesAvailable ? evaluarChecks({
    cfdiCount: 10, lastSyncAt: hoy, now: hoy,
    bankTxCount: input.bankTotal, bankPendingClassificationCount: input.bankPending,
    sinActividadBancariaConfirmada: input.noBankConfirmed,
    totalCargos: 100, totalAbonos: 100, posted: input.accounting !== "DRAFT",
    requiereBalance: true, cuentasSinAgrupador: 0, esEmpresaNueva: false,
  }) : null;
  const hechos: HechosCierre = {
    ctx: { year, month, regimenFiscal: "601", requiereBalance: true,
      tieneEmpleados: false, tieneDiot: false, tieneBanco: true },
    hoy, checklist, readiness,
    extras: {
      cfdiFaltantes: 0, cuentasBanco: 1, cuentasSinEstado: input.bankTotal === 0 ? 1 : 0,
      cuentasFirmadas: input.bankTotal > 0 && input.bankPending === 0 ? 1 : 0,
      sinActividadBancariaConfirmada: input.noBankConfirmed,
      empleadosActivos: 0, empleadosSinRecibo: 0, idsePendientes: 0,
      hallazgosCriticos: 0, hallazgosEfos: 0,
      pagoConciliado: false, declaracionPagada: input.declaration === "PAID", apertura: null,
    },
  };
  const pasos = decidirPasos(hechos).map((paso) => ({
    ...paso, estado: "PENDIENTE" as const, confirmadoAt: null, confirmadoByUserId: null, nota: null,
  }));
  // DB evidence adapter: the actual evaluator queries historical FILED/PAID
  // rows. This pure harness does not claim to exercise that query/persistence.
  const estado = resolverEstadoCierre({
    estadoContable: input.accounting, declaracionExterna: input.historical && filed, pasos,
  });
  const cierre: CierreEvaluado = {
    companyId: syntheticCompanyId, year, month, periodo: input.period,
    cierreId: null, responsableUserId: null, conversationId: null, cerradoAt: null,
    accountingStatus: input.accounting, estado, pasos,
    resumen: {
      total: pasos.length, aplican: pasos.filter((p) => p.estadoCalculado !== "no_aplica").length,
      listos: pasos.filter((p) => p.estadoCalculado === "listo").length,
      atencion: pasos.filter((p) => p.estadoCalculado === "atencion").length,
      bloquean: pasos.filter((p) => p.estadoCalculado === "bloquea").length,
      confirmados: 0, completo: false,
    },
  };
  return { checklist, readiness, cierre };
}
