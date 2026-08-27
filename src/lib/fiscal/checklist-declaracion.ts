import { prisma } from "../prisma";
import { computeTaxPosition } from "../impuestos";
import {
  detectComplementosPendientes,
  detectComplementosRecibidosPendientes,
} from "../complementos";
import { calcularVencimiento } from "../obligaciones";
import { bimestreDe } from "./imss-pagos";
import { formatCurrency } from "../utils";

// ─────────────────────────────────────────────────────────────────────────────
// Checklist de la declaración mensual — responde "¿qué necesito para declarar
// este mes?" con una lista ordenada y accionable, derivada de los datos vivos.
//
// La DECISIÓN de cada punto (listo/pendiente/atención/no aplica) es una función
// PURA sobre insumos ya consultados (decidirChecklist), para poder probarla sin
// base de datos. checklistDeclaracion() reúne los insumos en UNA pasada de
// consultas acotadas (conteos y banderas — nada de listas grandes) reutilizando
// los motores existentes:
//   - computeTaxPosition → IVA/ISR del periodo + advertencias de cadena rota
//   - detectComplementos(Recibidos)Pendientes → REP por emitir / de proveedores
//   - SatSyncRequest → cobertura de la descarga del SAT para el periodo
//   - BankTransaction UNMATCHED → conciliación bancaria del mes
//   - TaxDeclaration / CompanyObligation → DIOT y estado de la declaración
//   - Employee / PayrollRun → nómina del mes timbrada
//   - calcularVencimiento (obligaciones) → día 17 del mes siguiente, en hábil
//
// Es la MISMA llamada agregada para la UI (tarjeta en "Del mes"), la API GET y
// el asistente de chat/WhatsApp — una sola fuente de verdad.
// ─────────────────────────────────────────────────────────────────────────────

export type ChecklistEstado = "listo" | "pendiente" | "atencion" | "no-aplica";

export interface ChecklistItem {
  clave: string;
  titulo: string;
  estado: ChecklistEstado;
  detalle: string;
  accionUrl?: string;
}

export interface ChecklistDeclaracion {
  periodo: string; // "YYYY-MM"
  year: number;
  month: number;
  /** Fecha límite de presentación (día 17 del mes siguiente, recorrida a hábil). ISO date. */
  fechaLimite: string;
  /** Días de hoy a la fecha límite (negativo = vencida). */
  diasRestantes: number;
  vencida: boolean;
  items: ChecklistItem[];
  resumen: { listos: number; pendientes: number; atencion: number; noAplica: number; total: number };
}

/** Insumos ya consultados sobre los que se decide cada punto (sin DB). */
export interface ChecklistInputs {
  year: number;
  month: number;
  hoy: Date;
  /** Vencimiento de la declaración (ver fechaLimiteDeclaracion). */
  fechaLimite: Date;
  /** Apertura fiscal (punto de partida) revisada y confirmada por el contador. */
  aperturaConfirmada: boolean;
  /** Descarga del SAT del periodo terminada (SatSyncRequest FINISHED) por dirección. */
  satEmitidosCompleto: boolean;
  satRecibidosCompleto: boolean;
  /** Avisos de computeTaxPosition: meses con CFDI sin declaración guardada. */
  advertenciasCadena: string[];
  /** Movimientos bancarios UNMATCHED con fecha dentro del mes. */
  movimientosSinConciliar: number;
  /** REP que NOSOTROS debemos emitir por cobros PPD del mes. */
  repPorEmitir: { total: number; vencidos: number; montoPendiente: number };
  /** REP que los PROVEEDORES nos deben por gastos PPD pagados en el mes. */
  repProveedores: { total: number; vencidos: number };
  /** Posición del periodo (de computeTaxPosition — la misma llamada, sin recalcular). */
  iva: { pagar: number; saldoAFavor: number };
  isrPagar: number | null;
  diot: { aplica: boolean; generada: boolean; presentada: boolean };
  nomina: { tieneEmpleados: boolean; corridasDelMes: number; timbradasDelMes: number };
  /**
   * Cuotas IMSS (SIPARE) del periodo. `aplica` = hay empleados activos o
   * corridas de nómina en el mes. El estimado sale de la nómina timbrada (el
   * SUA da la cifra exacta). `bimestre` sólo viene en meses que CIERRAN
   * bimestre (feb, abr, jun, ago, oct, dic): RCV + Infonavit.
   */
  imss: {
    aplica: boolean;
    estimadoMensual: number;
    pagadaMensual: boolean;
    bimestre: { etiqueta: string; estimado: number; pagada: boolean } | null;
  };
  declaracionGuardada: boolean;
  declaracionPresentada: boolean;
}

const MESES_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function fmtFechaLarga(d: Date): string {
  return `${d.getDate()} de ${MESES_ES[d.getMonth()]} de ${d.getFullYear()}`;
}

/**
 * Fecha límite de la declaración mensual del periodo: día 17 del MES SIGUIENTE
 * (Art. 5.1 del decreto vigente sin considerar días adicionales por RFC),
 * recorrida al día hábil siguiente cuando cae en fin de semana o feriado —
 * reutiliza calcularVencimiento del motor de obligaciones (maneja el cruce de
 * ejercicio: diciembre vence el 17 de enero del año siguiente).
 */
export function fechaLimiteDeclaracion(year: number, month: number): Date {
  const periodo = `${year}-${String(month).padStart(2, "0")}`;
  return calcularVencimiento(
    { tipo: "FEDERAL", descripcion: "Declaración mensual", periodicidad: "MENSUAL", diaVencimiento: 17 },
    periodo
  );
}

/** Días (en fechas calendario, sin horas) de `hoy` a `fechaLimite`; negativo = vencida. */
export function diasParaFechaLimite(fechaLimite: Date, hoy: Date): number {
  const a = new Date(fechaLimite.getFullYear(), fechaLimite.getMonth(), fechaLimite.getDate());
  const b = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

/**
 * Decide el estado de cada punto del checklist a partir de insumos ya
 * consultados. Función PURA (sin DB) — la lógica de decisión se prueba aislada.
 * El orden de la lista es el orden recomendado de trabajo.
 */
export function decidirChecklist(i: ChecklistInputs): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const linkMes = `/impuestos?tab=presentar&month=${i.month}&year=${i.year}`;
  const linkPapeles = `/impuestos?tab=papeles&month=${i.month}&year=${i.year}`;

  // 0. Apertura fiscal confirmada — va PRIMERO: un punto de partida erróneo
  // (saldo a favor inicial, pérdidas, coeficiente, obligaciones) se hereda a
  // TODOS los meses siguientes, así que se revisa antes que cualquier otra cosa.
  items.push({
    clave: "apertura",
    titulo: "Punto de partida fiscal",
    estado: i.aperturaConfirmada ? "listo" : "atencion",
    detalle: i.aperturaConfirmada
      ? "El punto de partida fiscal (saldo a favor inicial, pérdidas por amortizar, coeficiente y obligaciones) está revisado y confirmado."
      : "El punto de partida fiscal aún no está confirmado. Revisa el saldo a favor de IVA inicial, las pérdidas por amortizar, el coeficiente de utilidad y las obligaciones: un error en el arranque se arrastra a todos los meses.",
    accionUrl: "/empresa/apertura",
  });

  // 1. Sincronización SAT del periodo (emitidos Y recibidos terminados).
  const satCompleto = i.satEmitidosCompleto && i.satRecibidosCompleto;
  const faltanDirecciones = [
    ...(!i.satEmitidosCompleto ? ["emitidos"] : []),
    ...(!i.satRecibidosCompleto ? ["recibidos"] : []),
  ].join(" y ");
  items.push({
    clave: "sincronizacion-sat",
    titulo: "Sincronización con el SAT",
    estado: satCompleto ? "listo" : "atencion",
    detalle: satCompleto
      ? "Los CFDI emitidos y recibidos del periodo ya se descargaron del SAT."
      : `Falta completar la descarga de CFDI ${faltanDirecciones} del periodo. Sin ella, los cálculos pueden estar incompletos.`,
    accionUrl: linkMes,
  });

  // 2. Cadena de declaraciones anteriores (advertencias del motor de impuestos).
  items.push({
    clave: "cadena-declaraciones",
    titulo: "Declaraciones de meses anteriores",
    estado: i.advertenciasCadena.length === 0 ? "listo" : "atencion",
    detalle:
      i.advertenciasCadena.length === 0
        ? "La cadena de arrastre está íntegra: los meses anteriores con actividad tienen declaración guardada."
        : i.advertenciasCadena[0],
    accionUrl: "/impuestos?tab=historial",
  });

  // 3. Conciliación bancaria del mes.
  const sc = i.movimientosSinConciliar;
  items.push({
    clave: "conciliacion-bancaria",
    titulo: "Conciliación bancaria",
    estado: sc === 0 ? "listo" : "pendiente",
    detalle:
      sc === 0
        ? "Todos los movimientos bancarios del mes están conciliados."
        : `${sc} movimiento(s) bancario(s) del mes sin conciliar. Concílialos para sustentar el flujo de efectivo del periodo.`,
    accionUrl: "/bancos",
  });

  // 4. Complementos de pago (REP) que nosotros debemos emitir por cobros del mes.
  const re = i.repPorEmitir;
  items.push({
    clave: "complementos-por-emitir",
    titulo: "Complementos de pago por emitir",
    estado: re.total === 0 ? "listo" : re.vencidos > 0 ? "atencion" : "pendiente",
    detalle:
      re.total === 0
        ? "No hay cobros PPD del mes pendientes de complemento de pago (REP)."
        : `${re.total} cobro(s) PPD del mes sin REP emitido` +
          (re.vencidos > 0 ? ` — ${re.vencidos} ya vencido(s) (límite legal: día 5 del mes siguiente al pago)` : "") +
          `; ${formatCurrency(re.montoPendiente)} sin complementar.`,
    accionUrl: linkMes,
  });

  // 5. REP que los proveedores nos deben (riesgo de deducción).
  const rp = i.repProveedores;
  items.push({
    clave: "complementos-proveedores",
    titulo: "Complementos de proveedores",
    estado: rp.total === 0 ? "listo" : rp.vencidos > 0 ? "atencion" : "pendiente",
    detalle:
      rp.total === 0
        ? "Los gastos PPD pagados en el mes ya cuentan con el REP del proveedor."
        : `${rp.total} gasto(s) PPD pagado(s) en el mes sin REP del proveedor` +
          (rp.vencidos > 0 ? ` — ${rp.vencidos} ya vencido(s)` : "") +
          ". Sin el complemento, la deducción y el IVA acreditable están en riesgo; solicítalo al proveedor.",
    accionUrl: "/facturas",
  });

  // 6. Posición calculada del periodo (IVA + ISR).
  const ivaTexto =
    i.iva.saldoAFavor > 0
      ? `IVA con saldo a favor de ${formatCurrency(i.iva.saldoAFavor)}`
      : `IVA a pagar ${formatCurrency(i.iva.pagar)}`;
  items.push({
    clave: "posicion-calculada",
    titulo: "IVA e ISR del periodo",
    estado: i.isrPagar == null ? "atencion" : "listo",
    detalle:
      i.isrPagar == null
        ? `${ivaTexto}. El ISR provisional no se pudo determinar (falta el coeficiente de utilidad o la tarifa del ejercicio); revísalo en los papeles de trabajo.`
        : `${ivaTexto} · ISR provisional a pagar ${formatCurrency(i.isrPagar)}.`,
    accionUrl: linkPapeles,
  });

  // 7. DIOT (sólo si la empresa tiene la obligación registrada).
  items.push({
    clave: "diot",
    titulo: "DIOT",
    estado: !i.diot.aplica
      ? "no-aplica"
      : i.diot.presentada
        ? "listo"
        : "pendiente",
    detalle: !i.diot.aplica
      ? "Esta empresa no tiene registrada la obligación de DIOT."
      : i.diot.presentada
        ? "La DIOT del periodo ya está presentada."
        : i.diot.generada
          ? "La DIOT del periodo está generada; falta presentarla al SAT."
          : "La DIOT del periodo está pendiente: genera el archivo y preséntala.",
    accionUrl: i.diot.aplica ? linkMes : undefined,
  });

  // 8. Nómina del mes timbrada (sólo si hay empleados activos).
  const n = i.nomina;
  const nominaEstado: ChecklistEstado = !n.tieneEmpleados
    ? "no-aplica"
    : n.corridasDelMes > 0 && n.timbradasDelMes >= n.corridasDelMes
      ? "listo"
      : "pendiente";
  items.push({
    clave: "nomina",
    titulo: "Nómina del mes",
    estado: nominaEstado,
    detalle: !n.tieneEmpleados
      ? "La empresa no tiene empleados activos."
      : n.corridasDelMes === 0
        ? "No hay corridas de nómina registradas en el mes; regístralas y tímbralas para enterar las retenciones."
        : n.timbradasDelMes >= n.corridasDelMes
          ? `Las ${n.corridasDelMes} corrida(s) de nómina del mes están timbradas.`
          : `${n.corridasDelMes - n.timbradasDelMes} de ${n.corridasDelMes} corrida(s) de nómina del mes sin timbrar.`,
    accionUrl: n.tieneEmpleados ? "/nomina" : undefined,
  });

  // 8b. Ajuste anual de ISR de sueldos (Art. 97 LISR) — SÓLO en diciembre:
  // es el mes donde el ajuste se materializa (la diferencia a favor se
  // compensa contra la retención de DICIEMBRE y la diferencia a cargo se
  // retiene ahí para enterarse a más tardar en febrero — Art. 97, cuarto
  // párrafo). Punto INFORMATIVO en v1: no hay persistencia de "ajuste
  // aplicado", así que siempre aparece pendiente con liga al reporte; un
  // estado "listo" real requiere la fase 2 (aplicar el ajuste a la corrida
  // de diciembre y registrarlo).
  if (i.month === 12) {
    const aplicaAjuste = n.tieneEmpleados || n.corridasDelMes > 0;
    items.push({
      clave: "ajuste-anual",
      titulo: "Ajuste anual de ISR de sueldos",
      estado: aplicaAjuste ? "pendiente" : "no-aplica",
      detalle: aplicaAjuste
        ? "Diciembre es el mes del ajuste anual (Art. 97 LISR): recalcula el ISR del ejercicio de cada trabajador con la tarifa anual y compáralo contra lo retenido. La diferencia a cargo se retiene en diciembre y se entera a más tardar en febrero; la diferencia a favor se compensa contra la retención de diciembre y las siguientes. Revisa el reporte por trabajador."
        : "La empresa no tiene empleados activos ni nómina en el mes; no hay ajuste anual de ISR que calcular.",
      accionUrl: aplicaAjuste ? `/nomina/ajuste-anual?ejercicio=${i.year}` : undefined,
    });
  }

  // 9. Cuotas IMSS (SIPARE) — mensuales (obrero-patronales, día 17 del mes
  // siguiente) y, en meses que cierran bimestre, RCV + Infonavit (LSS Art. 39).
  // El monto mostrado es un ESTIMADO desde la nómina timbrada; el SUA determina
  // la cifra exacta y el usuario la ajusta al registrar el pago.
  const im = i.imss;
  const diasImss = diasParaFechaLimite(i.fechaLimite, i.hoy);
  const imssPendiente = !im.pagadaMensual || (im.bimestre != null && !im.bimestre.pagada);
  const imssEstado: ChecklistEstado = !im.aplica
    ? "no-aplica"
    : !imssPendiente
      ? "listo"
      : diasImss < 0
        ? "atencion"
        : "pendiente";
  const bimTxt = im.bimestre
    ? im.bimestre.pagada
      ? ` El bimestre ${im.bimestre.etiqueta} (RCV e Infonavit) ya está pagado.`
      : ` Además cierra el bimestre ${im.bimestre.etiqueta}: RCV e Infonavit (estimado ${formatCurrency(im.bimestre.estimado)}, sin la aportación patronal de vivienda) vencen la misma fecha.`
    : "";
  items.push({
    clave: "cuotas-imss",
    titulo: "Cuotas IMSS (SIPARE)",
    estado: imssEstado,
    detalle: !im.aplica
      ? "La empresa no tiene empleados activos ni nómina en el mes; no hay cuotas IMSS que enterar."
      : !imssPendiente
        ? `Las cuotas IMSS del periodo están pagadas.${bimTxt}`
        : (im.pagadaMensual
            ? "Las cuotas IMSS mensuales ya están pagadas."
            : `Cuotas IMSS del mes: ${formatCurrency(im.estimadoMensual)} estimado desde tu nómina timbrada — el SUA determina la cifra exacta.`) +
          bimTxt +
          (diasImss < 0
            ? ` La fecha límite (${fmtFechaLarga(i.fechaLimite)}) ya venció; paga cuanto antes con tu línea de captura SIPARE para limitar actualización y recargos.`
            : ` Vence el ${fmtFechaLarga(i.fechaLimite)}; registra el pago con tu línea de captura SIPARE.`),
    accionUrl: im.aplica ? "/nomina" : undefined,
  });

  // 10. Declaración del periodo guardada / presentada.
  items.push({
    clave: "declaracion-periodo",
    titulo: "Declaración del periodo",
    estado: i.declaracionPresentada ? "listo" : "pendiente",
    detalle: i.declaracionPresentada
      ? "La declaración del periodo ya está presentada."
      : i.declaracionGuardada
        ? "La declaración está calculada y guardada; falta presentarla al SAT y capturar el acuse."
        : "La declaración del periodo aún no se guarda: calcula, presenta y captura el acuse.",
    accionUrl: linkMes,
  });

  // 11. Fecha límite (día 17 del mes siguiente, en día hábil).
  const dias = diasParaFechaLimite(i.fechaLimite, i.hoy);
  const fechaTxt = fmtFechaLarga(i.fechaLimite);
  items.push({
    clave: "fecha-limite",
    titulo: "Fecha límite",
    estado: i.declaracionPresentada ? "listo" : dias < 0 ? "atencion" : "pendiente",
    detalle: i.declaracionPresentada
      ? `Presentada. La fecha límite del periodo era el ${fechaTxt}.`
      : dias < 0
        ? `La fecha límite (${fechaTxt}) venció hace ${Math.abs(dias)} día(s). Presenta cuanto antes para limitar actualización y recargos.`
        : dias === 0
          ? `La declaración vence HOY (${fechaTxt}).`
          : `Vence el ${fechaTxt} — quedan ${dias} día(s).`,
    accionUrl: linkMes,
  });

  return items;
}

const GUARDADA_STATUSES = ["CALCULATED", "FILED", "PAID"];
const PRESENTADA_STATUSES = ["FILED", "PAID"];

/**
 * Checklist agregado del periodo: consulta los insumos (conteos y banderas,
 * todo acotado) en paralelo y decide con la función pura. Sin auth — el
 * llamador debe autorizar el acceso a `companyId` antes.
 */
export async function checklistDeclaracion(
  companyId: string,
  year: number,
  month: number,
  hoy: Date = new Date()
): Promise<ChecklistDeclaracion> {
  const periodo = `${year}-${String(month).padStart(2, "0")}`;
  const from = new Date(year, month - 1, 1);
  const to = new Date(year, month, 1);
  // Bimestre IMSS: en meses de cierre (feb, abr, …, dic) el renglón de cuotas
  // incluye RCV + Infonavit del bimestre. Su fila IMSS_BIMESTRAL se llavea con
  // el MISMO periodo (el mes de cierre), así cabe en la consulta de declRows.
  const bimImss = bimestreDe(year, month);
  const fromBimestre = new Date(year, bimImss.meses[0] - 1, 1);
  const NOMINA_RUN_STATUSES = ["CALCULATED", "STAMPED", "PAID"] as const;

  const [
    pos,
    satFinished,
    movimientosSinConciliar,
    repEmitir,
    repProveedores,
    obligaciones,
    declRows,
    empleadosActivos,
    corridasNomina,
    companyRow,
    imssSumsMes,
    imssSumsBimestre,
  ] = await Promise.all([
    // La MISMA llamada que alimenta la página de impuestos y el asistente —
    // incluye las advertencias de cadena de declaraciones rota.
    computeTaxPosition(companyId, year, month),
    prisma.satSyncRequest.findMany({
      where: { companyId, year, month, status: "FINISHED" },
      select: { tipo: true },
    }),
    prisma.bankTransaction.count({
      where: { companyId, status: "UNMATCHED", fecha: { gte: from, lt: to } },
    }),
    detectComplementosPendientes(companyId, hoy),
    detectComplementosRecibidosPendientes(companyId, hoy),
    prisma.companyObligation.findMany({
      where: { companyId, activa: true },
      select: { tipo: true },
    }),
    prisma.taxDeclaration.findMany({
      where: {
        companyId,
        periodo,
        tipo: { in: ["IVA_MENSUAL", "ISR_PROVISIONAL", "RETENCIONES_ISR", "DIOT", "IMSS_MENSUAL", "IMSS_BIMESTRAL"] },
      },
      select: { tipo: true, status: true },
    }),
    prisma.employee.count({ where: { companyId, isActive: true } }),
    prisma.payrollRun.findMany({
      where: { companyId, fechaPago: { gte: from, lt: to } },
      select: { status: true },
    }),
    prisma.company.findUnique({
      where: { id: companyId },
      select: { aperturaConfirmadaAt: true },
    }),
    // Estimado de cuotas IMSS del mes (mismos estatus de corrida que el GET de
    // /api/impuestos, para que la cifra coincida con la tarjeta de nómina).
    prisma.payrollItem.aggregate({
      where: {
        payrollRun: { companyId, status: { in: [...NOMINA_RUN_STATUSES] }, fechaPago: { gte: from, lt: to } },
      },
      _sum: { imssObrero: true, imssPatronal: true },
    }),
    // Infonavit del bimestre — sólo en meses que cierran bimestre.
    bimImss.cierraBimestre
      ? prisma.payrollItem.aggregate({
          where: {
            payrollRun: { companyId, status: { in: [...NOMINA_RUN_STATUSES] }, fechaPago: { gte: fromBimestre, lt: to } },
          },
          _sum: { infonavit: true },
        })
      : Promise.resolve(null),
  ]);

  // Cobertura del SAT para el periodo: mismas semánticas que getSatSyncStatus
  // (un periodo está completo cuando EMITIDOS y RECIBIDOS están FINISHED),
  // consultado directo para el mes pedido — sin depender del recorte a 12
  // periodos de `faltantes`.
  const tiposFinished = new Set(satFinished.map((r) => r.tipo));

  // REP del MES: los detectores son de toda la empresa; aquí interesan los
  // pagos cuyo último pago cayó dentro del periodo consultado.
  const delMes = (ultimoPago: string) => ultimoPago.startsWith(periodo);
  const repEmitirMes = repEmitir.pendientes.filter((p) => delMes(p.ultimoPago));
  const repProveedoresMes = repProveedores.pendientes.filter((p) => delMes(p.ultimoPago));

  const declOf = (tipo: string) => declRows.find((d) => d.tipo === tipo);
  // Unidad federal: la fila IVA_MENSUAL es la portadora canónica del acuse
  // (misma convención que /api/impuestos/cierre), con fallback a ISR/retenciones.
  const federalDecl = declOf("IVA_MENSUAL") ?? declOf("ISR_PROVISIONAL") ?? declOf("RETENCIONES_ISR");
  const diotDecl = declOf("DIOT");
  const diotAplica = obligaciones.some((o) => o.tipo === "DIOT");

  const corridas = corridasNomina.length;
  const timbradas = corridasNomina.filter((r) => r.status === "STAMPED" || r.status === "PAID").length;

  // Cuotas IMSS (SIPARE): pagada = fila con status PAID. El estimado es un
  // redondeo a centavos de los agregados de nómina.
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const imssMensualDecl = declOf("IMSS_MENSUAL");
  const imssBimestralDecl = declOf("IMSS_BIMESTRAL");
  const imss: ChecklistInputs["imss"] = {
    aplica: empleadosActivos > 0 || corridas > 0,
    estimadoMensual: r2(Number(imssSumsMes._sum.imssObrero ?? 0) + Number(imssSumsMes._sum.imssPatronal ?? 0)),
    pagadaMensual: imssMensualDecl?.status === "PAID",
    bimestre: bimImss.cierraBimestre
      ? {
          etiqueta: bimImss.etiqueta,
          estimado: r2(Number(imssSumsBimestre?._sum.infonavit ?? 0)),
          pagada: imssBimestralDecl?.status === "PAID",
        }
      : null,
  };

  const fechaLimite = fechaLimiteDeclaracion(year, month);

  const inputs: ChecklistInputs = {
    year,
    month,
    hoy,
    fechaLimite,
    aperturaConfirmada: companyRow?.aperturaConfirmadaAt != null,
    satEmitidosCompleto: tiposFinished.has("EMITIDOS"),
    satRecibidosCompleto: tiposFinished.has("RECIBIDOS"),
    advertenciasCadena: pos.advertencias,
    movimientosSinConciliar,
    repPorEmitir: {
      total: repEmitirMes.length,
      vencidos: repEmitirMes.filter((p) => p.urgencia === "VENCIDO").length,
      montoPendiente: Math.round(repEmitirMes.reduce((s, p) => s + p.montoPendiente, 0) * 100) / 100,
    },
    repProveedores: {
      total: repProveedoresMes.length,
      vencidos: repProveedoresMes.filter((p) => p.urgencia === "VENCIDO").length,
    },
    iva: { pagar: pos.iva.pagar, saldoAFavor: pos.iva.saldoAFavor },
    isrPagar: pos.isr.isrPagar,
    diot: {
      aplica: diotAplica,
      generada: diotDecl != null && GUARDADA_STATUSES.includes(diotDecl.status),
      presentada: diotDecl != null && PRESENTADA_STATUSES.includes(diotDecl.status),
    },
    nomina: {
      tieneEmpleados: empleadosActivos > 0,
      corridasDelMes: corridas,
      timbradasDelMes: timbradas,
    },
    imss,
    declaracionGuardada: federalDecl != null && GUARDADA_STATUSES.includes(federalDecl.status),
    declaracionPresentada: federalDecl != null && PRESENTADA_STATUSES.includes(federalDecl.status),
  };

  const items = decidirChecklist(inputs);
  const diasRestantes = diasParaFechaLimite(fechaLimite, hoy);

  return {
    periodo,
    year,
    month,
    fechaLimite: fechaLimite.toISOString().slice(0, 10),
    diasRestantes,
    vencida: diasRestantes < 0,
    items,
    resumen: {
      listos: items.filter((it) => it.estado === "listo").length,
      pendientes: items.filter((it) => it.estado === "pendiente").length,
      atencion: items.filter((it) => it.estado === "atencion").length,
      noAplica: items.filter((it) => it.estado === "no-aplica").length,
      total: items.length,
    },
  };
}
