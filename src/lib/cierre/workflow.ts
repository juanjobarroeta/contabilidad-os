// ─────────────────────────────────────────────────────────────────────────────
// EL WORKFLOW DEL CIERRE GUIADO — definición PURA (sin Prisma).
//
// Doce pasos en el orden en que un contador cierra un mes, cada uno con:
//   · aplica(ctx)          — si el paso existe para esta empresa/periodo.
//   · checks               — qué señales lo alimentan: "ce:<clave>" viene de
//                            ce-readiness (motor contable), "fx:<clave>" del
//                            checklist de la declaración (motor fiscal) y
//                            "x:<clave>" de los extras que sólo este módulo
//                            consulta (faltantes del SAT, firmas de
//                            conciliación, recibos por empleado, hallazgos…).
//   · dependeDe            — generaliza la regla `espera` de pasos-cierre.ts:
//                            un paso cuya dependencia bloquea o espera no se
//                            pinta en verde aunque sus señales estén limpias.
//   · requiereConfirmacion — si el humano tiene que confirmarlo para cerrar.
//
// `decidirPasos(hechos)` es el corazón: recibe los resultados YA calculados
// por los motores y devuelve el estado de cada paso con «el número que
// importa» y los hechos que se hashean como evidencia. Ninguna cifra se
// calcula aquí: se reordena la verdad que los motores ya dijeron.
// ─────────────────────────────────────────────────────────────────────────────

import type { ReadinessResult } from "../contabilidad/ce-readiness";
import type { ChecklistDeclaracion, ChecklistItem } from "../fiscal/checklist-declaracion";
import { fechaFiscalEnMexico } from "../fiscal/periodo-operativo";
import { hashEvidencia } from "./evidencia";
import { ORDEN_PASOS, esClavePaso, type ClavePasoCierre } from "./claves";

export { ORDEN_PASOS, esClavePaso, type ClavePasoCierre };

/**
 * `listo` nada que hacer · `atencion` hay trabajo pero no impide avanzar ·
 * `bloquea` impide cerrar · `espera` bloqueado por un paso anterior ·
 * `no_aplica` el paso no existe para esta empresa · `sin_datos` no se pudo
 * evaluar todavía.
 */
export type EstadoCalculado = "listo" | "atencion" | "bloquea" | "espera" | "no_aplica" | "sin_datos";

/** Lo que decide si un paso aplica a la empresa en este periodo. */
export interface ContextoEmpresa {
  regimenFiscal: string;
  requiereBalance: boolean;
  tieneEmpleados: boolean;
  tieneDiot: boolean;
  /** Hay cuentas bancarias dadas de alta o movimientos en el periodo. */
  tieneBanco: boolean;
  year: number;
  month: number;
}

export interface DefinicionPaso {
  clave: ClavePasoCierre;
  titulo: string;
  /** Qué hace el contador en este paso, en una línea (para la UI y el prompt). */
  descripcion: string;
  aplica: (ctx: ContextoEmpresa) => boolean;
  checks: string[];
  dependeDe: ClavePasoCierre[];
  /**
   * Por dónde se empieza a revisar este paso. NO es una reja: el copiloto
   * conserva todas sus herramientas dentro del cierre (acotarlas lo dejaba
   * ciego y rompía la caché del prompt). Es una pista de arranque.
   */
  tools: string[];
  /** Qué comprueba un contador en este paso, para que el copiloto lo diga y lo revise. */
  revisar: string[];
  /** A dónde se va a trabajar el paso. */
  href: (ctx: ContextoEmpresa) => string;
  requiereConfirmacion: boolean;
  /** Si una señal en error bloquea el cierre (además de pintar el paso). */
  bloqueaSiError: boolean;
}

const mes = (ctx: ContextoEmpresa) => `month=${ctx.month}&year=${ctx.year}`;

export const PASOS: DefinicionPaso[] = [
  {
    clave: "apertura",
    titulo: "Punto de partida",
    descripcion: "Saldo a favor inicial, pérdidas por amortizar, coeficiente y obligaciones confirmados.",
    aplica: () => true,
    checks: ["fx:apertura", "x:coeficiente", "x:datos_apertura"],
    dependeDe: [],
    tools: [
      "query_obligations",
      "query_tax_declarations",
      "query_tax_position",
      "proponer_fijar_coeficiente",
      "proponer_fijar_perdida",
      "proponer_fijar_saldo_favor_iva",
      "proponer_confirmar_apertura",
    ],
    href: () => "/empresa/apertura",
    revisar: [
      "Que el saldo a favor de IVA inicial, las pérdidas y el coeficiente estén CAPTURADOS (no supuestos en cero)",
      "Que el coeficiente coincida con el que sale de la última anual",
      "Que las obligaciones registradas coincidan con la constancia de situación fiscal",
      "Que los pagos provisionales ya presentados del ejercicio estén cargados: alimentan el arrastre",
    ],
    requiereConfirmacion: true,
    bloqueaSiError: false,
  },
  {
    clave: "sat",
    titulo: "Documentos del SAT",
    descripcion: "CFDI emitidos y recibidos descargados, sin faltantes ni cancelaciones sin atender.",
    aplica: () => true,
    checks: ["ce:cfdis", "fx:sincronizacion-sat", "x:cfdi_faltantes"],
    dependeDe: [],
    tools: ["query_sat_sync_status", "query_invoices", "query_cancelaciones", "get_invoice_detail"],
    href: () => "/facturas",
    revisar: [
      "Que la descarga de emitidos y recibidos del periodo esté completa",
      "CFDI del censo del SAT sin XML (faltantes)",
      "Cancelaciones del periodo y si afectan un mes ya declarado",
    ],
    requiereConfirmacion: true,
    bloqueaSiError: true,
  },
  {
    clave: "nomina",
    titulo: "Nómina",
    descripcion: "Todas las corridas del mes timbradas y cada empleado activo con su recibo.",
    aplica: (ctx) => ctx.tieneEmpleados,
    checks: ["fx:nomina", "fx:ajuste-anual", "x:empleados_sin_recibo"],
    dependeDe: ["sat"],
    tools: ["query_employees", "get_valor_fiscal"],
    href: () => "/nomina?tab=corridas",
    revisar: [
      "Que cada empleado activo tenga su recibo timbrado del periodo",
      "Que el ISR retenido del timbrado cuadre con la tarifa del Art. 96 y el subsidio",
      "Cuotas obrero-patronales y el ISN de cada entidad donde hay empleados",
    ],
    requiereConfirmacion: true,
    bloqueaSiError: false,
  },
  {
    clave: "imss",
    titulo: "IMSS e Infonavit",
    descripcion: "Cuotas del mes (y del bimestre cuando cierra) pagadas con su línea SIPARE.",
    aplica: (ctx) => ctx.tieneEmpleados,
    checks: ["fx:cuotas-imss", "x:idse_pendientes"],
    dependeDe: ["nomina"],
    tools: ["query_employees", "query_obligations"],
    href: () => "/nomina?tab=cumplimiento",
    revisar: [
      "Cuotas del mes (y del bimestre cuando cierra) pagadas con su línea SIPARE",
      "Movimientos afiliatorios pendientes en IDSE",
    ],
    requiereConfirmacion: true,
    bloqueaSiError: false,
  },
  {
    clave: "banco",
    titulo: "Bancos",
    descripcion: "Estado de cuenta de cada cuenta cargado, movimientos conciliados y mes firmado.",
    aplica: () => true,
    checks: ["ce:banco", "ce:sin_clasificar", "fx:conciliacion-bancaria", "x:cuentas_sin_estado", "x:firmas_conciliacion"],
    dependeDe: ["sat"],
    tools: [
      "query_bank_transactions",
      "list_unmatched_transactions",
      "suggest_reconciliation_match",
      "categorize_transaction",
      "proponer_conciliacion",
      "proponer_categorizacion",
      "proponer_categorizacion_lote",
      "proponer_firmar_conciliacion",
    ],
    href: () => "/bancos",
    revisar: [
      "Que cada cuenta tenga su estado de cuenta del mes y el saldo inicial empate con el final del mes anterior",
      "Movimientos sin conciliar ni categorizar",
      "Que la conciliación del mes esté firmada en cada cuenta",
    ],
    requiereConfirmacion: true,
    bloqueaSiError: true,
  },
  {
    clave: "complementos",
    titulo: "Complementos de pago",
    descripcion: "REP emitidos por los cobros PPD del mes y REP de proveedores recibidos.",
    aplica: () => true,
    checks: ["fx:complementos-por-emitir", "fx:complementos-proveedores"],
    dependeDe: ["banco"],
    tools: ["query_complementos_pendientes", "query_complementos_recibidos_pendientes", "query_ppd_cartera", "preview_complemento"],
    href: (ctx) => `/impuestos?tab=presentar&${mes(ctx)}`,
    revisar: [
      "REP por emitir de los cobros PPD del mes y su plazo legal (día 5 del mes siguiente)",
      "REP que deben los proveedores: sin ellos la deducción y el IVA acreditable están en riesgo",
    ],
    requiereConfirmacion: true,
    bloqueaSiError: false,
  },
  {
    clave: "impuestos",
    titulo: "IVA, ISR y retenciones",
    descripcion: "Posición del periodo calculada con la cadena de arrastre íntegra.",
    aplica: () => true,
    checks: ["fx:cadena-declaraciones", "fx:posicion-calculada"],
    dependeDe: ["banco", "complementos"],
    tools: [
      "query_tax_position",
      "query_tax_declarations",
      "search_fiscal_knowledge",
      "get_valor_fiscal",
      "proponer_fijar_coeficiente",
    ],
    href: (ctx) => `/impuestos?tab=papeles&${mes(ctx)}`,
    revisar: [
      "IVA de flujo: trasladado cobrado, acreditable pagado y la proporción del Art. 5-V",
      "Cadena de arrastre: que los meses anteriores con actividad tengan su declaración guardada",
      "ISR provisional con su coeficiente, pérdidas amortizadas y pagos anteriores",
      "Retenciones de ISR e IVA a enterar",
      "IEPS del periodo si la empresa lo traslada: es declaración APARTE (Art. 5º LIEPS) y su importe depende de la decisión de acreditamiento del Art. 4º",
    ],
    requiereConfirmacion: true,
    bloqueaSiError: false,
  },
  {
    clave: "contabilidad",
    titulo: "Contabilidad",
    descripcion: "Mes contabilizado, balanza cuadrada y cuentas con código agrupador.",
    aplica: () => true,
    checks: ["ce:cuadre", "ce:agrupadores", "ce:posteo", "ce:capital_inicial"],
    dependeDe: ["banco"],
    tools: ["query_dashboard_kpis", "analyze_anomalies"],
    href: () => "/contabilidad/cierre",
    revisar: [
      "Que el mes esté contabilizado y la balanza cuadre",
      "Cuentas sin código agrupador del SAT",
      "El amarre: CFDI = pólizas = papel de IVA = banco = declaración",
    ],
    requiereConfirmacion: true,
    bloqueaSiError: true,
  },
  {
    clave: "revision",
    titulo: "Riesgos",
    descripcion: "Hallazgos críticos del auditor y coincidencias en la lista 69-B atendidos.",
    aplica: () => true,
    checks: ["x:hallazgos_criticos", "x:efos"],
    dependeDe: ["sat"],
    tools: ["analyze_anomalies", "proponer_resolver_hallazgo", "proponer_posponer_hallazgo", "search_fiscal_knowledge"],
    href: () => "/hallazgos",
    revisar: [
      "Hallazgos críticos abiertos del auditor",
      "Coincidencias en la lista 69-B, propias y de contrapartes",
      "Vigencia de CSD y e.firma",
    ],
    requiereConfirmacion: true,
    bloqueaSiError: false,
  },
  {
    clave: "diot",
    titulo: "DIOT",
    descripcion: "Archivo generado y presentado.",
    aplica: (ctx) => ctx.tieneDiot,
    checks: ["fx:diot"],
    // Va con lo que se presenta al SAT, al final, y después de la
    // contabilidad: la DIOT sale de los mismos proveedores pagados que cierra
    // el mes. Presentarla antes de postear es firmar cifras que aún se mueven
    // — y corregirla después es una complementaria.
    dependeDe: ["impuestos", "contabilidad"],
    tools: ["query_tax_declarations", "proponer_marcar_diot_presentada"],
    href: (ctx) => `/impuestos?tab=presentar&${mes(ctx)}#diot`,
    revisar: [
      "Que el archivo esté generado y presentado, y que los terceros y montos cuadren con el IVA acreditable",
      "Que alguien haya registrado la presentación: la DIOT no se sincroniza del SAT como las demás",
    ],
    requiereConfirmacion: true,
    bloqueaSiError: false,
  },
  {
    clave: "declaracion",
    titulo: "Declaración",
    descripcion: "Presentada en el SAT, acuse capturado y pago conciliado en banco.",
    aplica: () => true,
    checks: ["fx:declaracion-periodo", "fx:fecha-limite", "x:pago_conciliado"],
    // NO depende de la DIOT: son obligaciones distintas que vencen el mismo
    // día. Tener la DIOT aquí decía que presentar el IVA espera a la
    // informativa, y no es verdad.
    dependeDe: ["impuestos"],
    tools: ["query_tax_position", "query_tax_declarations", "query_obligations"],
    href: (ctx) => `/impuestos?tab=presentar&${mes(ctx)}`,
    revisar: [
      "Que la declaración esté presentada y el acuse capturado",
      "Que lo declarado coincida con lo calculado (diferencias del acuse)",
      "Que el pago esté conciliado con su línea de captura en banco",
    ],
    requiereConfirmacion: true,
    bloqueaSiError: false,
  },
  {
    clave: "entregables",
    titulo: "Entregables",
    descripcion: "Paquete del mes (XML de la CE, reportes) listo para el cliente.",
    aplica: () => true,
    checks: [],
    dependeDe: ["contabilidad", "declaracion"],
    tools: [],
    href: () => "/contabilidad/entregables",
    revisar: [
      "Que el paquete del mes (XML de la CE y reportes) esté completo para el cliente",
    ],
    requiereConfirmacion: false,
    bloqueaSiError: false,
  },
];

if (PASOS.map((p) => p.clave).join(",") !== ORDEN_PASOS.join(",")) {
  throw new Error("cierre/workflow: PASOS y ORDEN_PASOS (claves.ts) no coinciden");
}

/**
 * Tools que el copiloto puede usar SIEMPRE dentro del cierre, además de las del
 * paso activo: el estado del propio cierre, sus dos propuestas, y la ley (que
 * no depende del paso).
 */
export const TOOLS_SIEMPRE_CIERRE = [
  "query_cierre_estado",
  "query_cierre_paso",
  "proponer_confirmar_paso",
  "proponer_omitir_paso",
  "search_fiscal_knowledge",
  "get_articulo",
  "get_valor_fiscal",
];

/** Tools declaradas por un paso (subset que el chat expone en ese paso). */
export function toolsDelPaso(clave: ClavePasoCierre): string[] {
  return PASOS.find((p) => p.clave === clave)?.tools ?? [];
}

export function definicionPaso(clave: ClavePasoCierre): DefinicionPaso {
  const d = PASOS.find((p) => p.clave === clave);
  if (!d) throw new Error(`Paso de cierre desconocido: ${clave}`);
  return d;
}

// ── Hechos: lo que los motores ya calcularon ─────────────────────────────────

/** Extras que sólo el cierre consulta (conteos baratos, sin motores). */
export interface ExtrasCierre {
  /** CfdiFaltante del periodo (censo del SAT que no pudimos documentar). */
  cfdiFaltantes: number;
  /** Cuentas bancarias activas sin un solo movimiento en el periodo. */
  cuentasBanco: number;
  cuentasSinEstado: number;
  /** Cuentas con conciliación del mes firmada (ConciliacionBancaria.conciliadoAt). */
  cuentasFirmadas: number;
  /** El contador confirmó que todo el periodo careció de actividad bancaria. */
  sinActividadBancariaConfirmada: boolean;
  /** Empleados activos sin recibo timbrado en el mes. */
  empleadosActivos: number;
  empleadosSinRecibo: number;
  /** Movimientos IMSS (IDSE) pendientes de presentar. */
  idsePendientes: number;
  /** Hallazgos ABIERTOS del auditor con severidad error (sin snooze vigente). */
  hallazgosCriticos: number;
  /** Hallazgos ABIERTOS de la lista 69-B (propio o contrapartes). */
  hallazgosEfos: number;
  /** La declaración federal del periodo tiene su pago ligado a un movimiento bancario o está PAID. */
  pagoConciliado: boolean;
  declaracionPagada: boolean;
  /**
   * El punto de partida con la PROCEDENCIA de cada dato (estadoApertura). Es
   * la diferencia entre «saldo a favor inicial $0» y «no hay dato: hay que
   * capturarlo» — decir lo primero cuando es lo segundo es mentir con un cero.
   */
  apertura: ResumenApertura | null;
}

/** Un dato del punto de partida con de dónde salió. */
export interface DatoApertura {
  valor: number | null;
  /** acuse | manual | calculado | regimen | csf | nomina | sin-dato */
  fuente: string;
  /** Etiqueta lista para leer («del acuse de mayo de 2026»). */
  etiqueta: string;
  referencia?: string;
}

export interface ResumenApertura {
  confirmada: boolean;
  confirmadaAt: string | null;
  primerPeriodo: string;
  periodoAnterior: string;
  ivaSaldoFavor: DatoApertura;
  coeficiente: DatoApertura & { aplica: boolean; anio: number | null };
  perdidaPendiente: DatoApertura & { aplica: boolean; ejercicio: number | null };
  /** Ejercicios en el ledger de pérdidas (Art. 57). */
  perdidasPorAmortizar: number;
  /** Pagos provisionales del ejercicio ya conocidos, y cuántos vienen de un acuse. */
  pagosProvisionales: { total: number; conAcuse: number };
  /** Cobertura de la descarga del SAT desde el arranque. */
  sincronizacion: { periodosCubiertos: number; periodosTotales: number; faltantes: number };
  /**
   * LO QUE DICE la anual del ejercicio anterior, campo por campo. Sin esto, un
   * dato `sin-dato` sólo podía terminar en «captúralo»: ahora se puede decir
   * qué reporta la anual (o que no reporta nada) antes de pedir nada.
   */
  anualAnterior: {
    ejercicio: number;
    presentadaEl: string | null;
    isrIngresos: number | null;
    isrDeducciones: number | null;
    isrBaseGravable: number | null;
    isrCoeficienteUtilidad: number | null;
    isrPerdidaPendiente: number | null;
  } | null;
}

export interface HechosCierre {
  ctx: ContextoEmpresa;
  hoy: Date;
  readiness: ReadinessResult | null;
  checklist: ChecklistDeclaracion | null;
  extras: ExtrasCierre;
}

/** Una señal ya redactada por su motor, normalizada a un semáforo común. */
export interface SenalPaso {
  clave: string;
  estado: "ok" | "warn" | "error" | "na";
  /** El número que importa, listo para pintar. */
  resumen: string;
  cta?: { label: string; href: string };
}

export interface PasoEvaluado {
  clave: ClavePasoCierre;
  titulo: string;
  descripcion: string;
  orden: number;
  estadoCalculado: EstadoCalculado;
  /** El número que importa (de la señal más grave), o null si no hay señales. */
  detalle: string | null;
  senales: SenalPaso[];
  /**
   * Cifras del motor que este paso necesita (coeficiente, IVA, ISR…), ya
   * calculadas. Van dentro de `hechos` (y por tanto del hash) para que el
   * copiloto NUNCA tenga que pedirle al contador un dato que el sistema tiene.
   */
  cifras: Record<string, unknown>;
  /** Lo que se hashea: las señales con su cifra. */
  hechos: Record<string, unknown>;
  hashEvidencia: string;
  cta: { label: string; href: string };
  requiereConfirmacion: boolean;
  /** Sólo en pasos con vencimiento (declaración): ISO date y días restantes. */
  fechaLimite?: string;
  diasRestantes?: number;
}

const PESO: Record<SenalPaso["estado"], number> = { error: 0, warn: 1, ok: 2, na: 3 };

/** Primera oración de un detalle largo (el checklist redacta párrafos). */
function primeraOracion(texto: string): string {
  const corte = texto.search(/[.;]\s|\s—\s/);
  return corte > 0 ? texto.slice(0, corte).trim() : texto.trim();
}

function senalDeChecklist(item: ChecklistItem): SenalPaso {
  const estado: SenalPaso["estado"] =
    item.estado === "listo" ? "ok" : item.estado === "no-aplica" ? "na" : item.estado === "atencion" ? "warn" : "warn";
  return {
    clave: `fx:${item.clave}`,
    estado,
    resumen: primeraOracion(item.detalle),
    cta: item.accionUrl ? { label: item.titulo, href: item.accionUrl } : undefined,
  };
}

function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

/** Señales de los extras (conteos), redactadas aquí porque ningún motor las redacta. */
function senalCoeficiente(h: HechosCierre): SenalPaso | null {
  const isr = h.checklist?.posicion.isr;
  if (!isr) return null;
  // Sólo los regímenes que usan coeficiente (PM Art. 14) lo necesitan.
  if (isr.metodo !== "PM_ART14") return null;
  const clave = "x:coeficiente";
  if (isr.coeficiente != null) {
    return { clave, estado: "ok", resumen: `Coeficiente de utilidad ${isr.coeficiente} (${isr.coeficienteFuente})` };
  }
  if (isr.coeficienteSugerido != null) {
    const base = isr.coeficienteBase;
    return {
      clave,
      estado: "warn",
      resumen:
        `Sin coeficiente fijado; el sistema deduce ${isr.coeficienteSugerido}` +
        (base ? ` de la anual ${base.year}` : "") +
        " — confírmalo para que el ISR provisional se calcule",
      cta: { label: "Fijar coeficiente", href: "/empresa/apertura" },
    };
  }
  return {
    clave,
    estado: "warn",
    resumen: "Sin coeficiente de utilidad y sin anual de la cual deducirlo: el ISR provisional no se puede calcular",
    cta: { label: "Capturar la anual", href: "/declaraciones/historial" },
  };
}

/**
 * Qué datos del punto de partida están SIN CAPTURAR. Un cero capturado y un
 * cero por falta de dato se ven igual en la cifra y son cosas distintas: esta
 * señal los separa para que el copiloto no afirme saldos que nadie revisó.
 */
function senalDatosApertura(x: ExtrasCierre): SenalPaso | null {
  const a = x.apertura;
  if (!a) return null;
  const clave = "x:datos_apertura";
  const faltan: string[] = [];
  if (a.ivaSaldoFavor.fuente === "sin-dato") faltan.push("saldo a favor de IVA inicial");
  if (a.coeficiente.aplica && a.coeficiente.fuente === "sin-dato") faltan.push("coeficiente de utilidad");
  if (a.perdidaPendiente.aplica && a.perdidaPendiente.fuente === "sin-dato") faltan.push("pérdidas por amortizar");
  if (faltan.length > 0) {
    return {
      clave,
      estado: "warn",
      resumen: `Sin capturar en el punto de partida: ${faltan.join(", ")} — hoy se toman como cero`,
      cta: { label: "Capturar el punto de partida", href: "/empresa/apertura" },
    };
  }
  const origenes = [
    `saldo a favor de IVA ${a.ivaSaldoFavor.etiqueta}`,
    ...(a.coeficiente.aplica ? [`coeficiente ${a.coeficiente.etiqueta}`] : []),
    ...(a.perdidaPendiente.aplica ? [`pérdidas ${a.perdidaPendiente.etiqueta}`] : []),
  ];
  return { clave, estado: "ok", resumen: `Punto de partida con origen conocido: ${origenes.join("; ")}` };
}

function senalExtra(clave: string, x: ExtrasCierre, ctx: ContextoEmpresa): SenalPaso | null {
  switch (clave) {
    case "x:cfdi_faltantes":
      return x.cfdiFaltantes > 0
        ? {
            clave,
            estado: "warn",
            resumen: `${plural(x.cfdiFaltantes, "CFDI del censo del SAT sin XML", "CFDI del censo del SAT sin XML")}`,
            cta: { label: "Ver faltantes", href: "/facturas?tab=faltantes" },
          }
        : { clave, estado: "ok", resumen: "Sin CFDI faltantes frente al censo del SAT" };
    case "x:empleados_sin_recibo":
      if (x.empleadosActivos === 0) return null;
      return x.empleadosSinRecibo > 0
        ? {
            clave,
            estado: "warn",
            resumen: `${plural(x.empleadosSinRecibo, "empleado activo sin recibo timbrado en el mes", "empleados activos sin recibo timbrado en el mes")}`,
            cta: { label: "Ver nómina", href: "/nomina?tab=corridas" },
          }
        : { clave, estado: "ok", resumen: `${plural(x.empleadosActivos, "empleado con recibo del mes", "empleados con recibo del mes")}` };
    case "x:idse_pendientes":
      return x.idsePendientes > 0
        ? {
            clave,
            estado: "warn",
            resumen: `${plural(x.idsePendientes, "movimiento IMSS sin presentar en IDSE", "movimientos IMSS sin presentar en IDSE")}`,
            cta: { label: "Ver movimientos", href: "/nomina?tab=cumplimiento" },
          }
        : { clave, estado: "ok", resumen: "Sin movimientos IDSE pendientes" };
    case "x:cuentas_sin_estado":
      if (x.sinActividadBancariaConfirmada) {
        return { clave, estado: "ok", resumen: "Periodo confirmado sin actividad bancaria" };
      }
      if (x.cuentasBanco === 0) return null;
      return x.cuentasSinEstado > 0
        ? {
            clave,
            estado: ctx.requiereBalance ? "error" : "warn",
            resumen: `${x.cuentasSinEstado} de ${plural(x.cuentasBanco, "cuenta sin estado de cuenta del mes", "cuentas sin estado de cuenta del mes")}`,
            cta: { label: "Subir estado de cuenta", href: "/bancos?tab=cuentas" },
          }
        : { clave, estado: "ok", resumen: `${plural(x.cuentasBanco, "cuenta con movimientos del mes", "cuentas con movimientos del mes")}` };
    case "x:firmas_conciliacion":
      if (x.sinActividadBancariaConfirmada) {
        return { clave, estado: "ok", resumen: "Sin conciliaciones que firmar: periodo confirmado sin actividad bancaria" };
      }
      if (x.cuentasBanco === 0) return null;
      return x.cuentasFirmadas < x.cuentasBanco
        ? {
            clave,
            estado: "warn",
            resumen: `${x.cuentasFirmadas} de ${plural(x.cuentasBanco, "cuenta con la conciliación del mes firmada", "cuentas con la conciliación del mes firmada")}`,
            // El botón se llama «Dar por conciliada» y vive en Contabilidad →
            // Conciliación, no en Bancos: decirlo mal es mandar a buscar a ciegas.
            cta: { label: "Dar por conciliada (Contabilidad → Conciliación)", href: "/contabilidad/conciliacion" },
          }
        : { clave, estado: "ok", resumen: "Conciliación del mes firmada en todas las cuentas" };
    case "x:hallazgos_criticos":
      return x.hallazgosCriticos > 0
        ? {
            clave,
            estado: "warn",
            resumen: `${plural(x.hallazgosCriticos, "hallazgo crítico abierto", "hallazgos críticos abiertos")}`,
            cta: { label: "Ver hallazgos", href: "/hallazgos" },
          }
        : { clave, estado: "ok", resumen: "Sin hallazgos críticos abiertos" };
    case "x:efos":
      return x.hallazgosEfos > 0
        ? {
            clave,
            estado: "error",
            resumen: `${plural(x.hallazgosEfos, "coincidencia abierta en la lista 69-B", "coincidencias abiertas en la lista 69-B")}`,
            cta: { label: "Revisar 69-B", href: "/hallazgos?categoria=efos" },
          }
        : { clave, estado: "ok", resumen: "Sin coincidencias en la lista 69-B" };
    case "x:pago_conciliado":
      if (x.declaracionPagada || x.pagoConciliado) {
        return { clave, estado: "ok", resumen: "Pago de la declaración conciliado en banco" };
      }
      return null; // sin declaración presentada no hay pago que conciliar; fx:declaracion-periodo ya lo dice
    default:
      return null;
  }
}

function senalesDelPaso(def: DefinicionPaso, h: HechosCierre): SenalPaso[] {
  const out: SenalPaso[] = [];
  for (const ref of def.checks) {
    if (ref.startsWith("ce:")) {
      const c = h.readiness?.checks.find((x) => x.clave === ref.slice(3));
      if (c) out.push({ clave: ref, estado: c.estado, resumen: c.titulo, cta: c.cta });
    } else if (ref.startsWith("fx:")) {
      const it = h.checklist?.items.find((x) => x.clave === ref.slice(3));
      if (it) out.push(senalDeChecklist(it));
    } else if (ref === "x:coeficiente") {
      const s = senalCoeficiente(h);
      if (s) out.push(s);
    } else if (ref === "x:datos_apertura") {
      const s = senalDatosApertura(h.extras);
      if (s) out.push(s);
    } else {
      const s = senalExtra(ref, h.extras, h.ctx);
      if (s) out.push(s);
    }
  }
  return out;
}

/**
 * Las cifras que cada paso necesita, tomadas de lo que los motores YA
 * calcularon. Es la diferencia entre un copiloto que dice «tu coeficiente sale
 * en 0.0842 de la anual 2025, confírmalo» y uno que le pregunta al contador
 * por un dato que está en la base.
 */
function cifrasDelPaso(clave: ClavePasoCierre, h: HechosCierre): Record<string, unknown> {
  const pos = h.checklist?.posicion;
  if (!pos) return {};
  switch (clave) {
    case "apertura":
      return {
        ...(h.extras.apertura
          ? {
              // De dónde sale cada número del arranque. Un `sin-dato` significa
              // que NADIE lo capturó: no es un cero verificado.
              puntoDePartida: {
                confirmada: h.extras.apertura.confirmada,
                primerPeriodoComputado: h.extras.apertura.primerPeriodo,
                saldoFavorIvaInicial: h.extras.apertura.ivaSaldoFavor,
                perdidasPorAmortizarLedger: h.extras.apertura.perdidasPorAmortizar,
                perdidaPendiente: h.extras.apertura.perdidaPendiente,
                pagosProvisionalesConocidos: h.extras.apertura.pagosProvisionales,
                descargaSat: h.extras.apertura.sincronizacion,
                // Lo que la anual reporta: si la pérdida viene `sin-dato`, aquí
                // se ve si la anual trae una cifra o si de plano no la reporta.
                declaracionAnualAnterior: h.extras.apertura.anualAnterior,
              },
            }
          : {}),
        coeficiente: pos.isr.coeficiente,
        coeficienteFuente: pos.isr.coeficienteFuente,
        coeficienteSugerido: pos.isr.coeficienteSugerido,
        coeficienteSugeridoFuente: pos.isr.coeficienteSugeridoFuente,
        coeficienteBase: pos.isr.coeficienteBase,
        perdidaFiscalPendiente: pos.isr.perdidaFiscalPendiente,
        saldoFavorIvaAnterior: pos.iva.saldoFavorAnterior,
        metodoIsr: pos.isr.metodo,
      };
    case "impuestos":
      return {
        iva: pos.iva,
        isr: {
          metodo: pos.isr.metodo,
          coeficiente: pos.isr.coeficiente,
          ingresosAcumulados: pos.isr.ingresosAcumulados,
          baseGravable: pos.isr.baseGravable,
          isrPagar: pos.isr.isrPagar,
          perdidaFiscalPendiente: pos.isr.perdidaFiscalPendiente,
        },
        advertencias: pos.advertencias,
      };
    case "declaracion":
      return {
        ivaPagar: pos.iva.pagar,
        ivaSaldoAFavor: pos.iva.saldoAFavor,
        isrPagar: pos.isr.isrPagar,
        fechaLimite: h.checklist?.fechaLimite,
        diasRestantes: h.checklist?.diasRestantes,
      };
    default:
      return {};
  }
}

function peor(senales: SenalPaso[]): SenalPaso | null {
  const vivas = senales.filter((s) => s.estado !== "na");
  if (vivas.length === 0) return null;
  return vivas.reduce((a, b) => (PESO[a.estado] <= PESO[b.estado] ? a : b));
}

/**
 * Estado de los doce pasos en el orden del flujo. REGLA DE PROPAGACIÓN: un paso
 * cuya dependencia está en `bloquea` o `espera` queda en `espera` aunque sus
 * propias señales estén limpias — decirle «listo» a Declaración cuando el banco
 * bloquea la contabilidad sería mentir sobre lo único que el contador vino a
 * saber.
 */
export function decidirPasos(h: HechosCierre): PasoEvaluado[] {
  const estados = new Map<ClavePasoCierre, EstadoCalculado>();
  const out: PasoEvaluado[] = [];
  const sinMotores = h.readiness == null && h.checklist == null;

  PASOS.forEach((def, orden) => {
    const cta = { label: def.titulo, href: def.href(h.ctx) };
    const base = {
      clave: def.clave,
      titulo: def.titulo,
      descripcion: def.descripcion,
      orden,
      cta,
      requiereConfirmacion: def.requiereConfirmacion,
    };

    if (!def.aplica(h.ctx)) {
      const hechos = { aplica: false };
      estados.set(def.clave, "no_aplica");
      out.push({ ...base, estadoCalculado: "no_aplica", detalle: null, senales: [], cifras: {}, hechos, hashEvidencia: hashEvidencia(hechos) });
      return;
    }

    const senales = senalesDelPaso(def, h);
    const cifras = cifrasDelPaso(def.clave, h);
    const hechos: Record<string, unknown> = {
      senales: senales.map((s) => ({ clave: s.clave, estado: s.estado, resumen: s.resumen })),
      ...(Object.keys(cifras).length > 0 ? { cifras } : {}),
    };
    const grave = peor(senales);
    const bloqueadoPorDependencia = def.dependeDe.some((d) => {
      const e = estados.get(d);
      return e === "bloquea" || e === "espera";
    });

    let estado: EstadoCalculado;
    if (def.clave === "entregables") {
      // Sin señales propias: existe cuando contabilidad y declaración están listas.
      estado = bloqueadoPorDependencia
        ? "espera"
        : def.dependeDe.every((d) => estados.get(d) === "listo" || estados.get(d) === "no_aplica")
          ? "listo"
          : "espera";
    } else if (bloqueadoPorDependencia) {
      estado = "espera";
    } else if (sinMotores) {
      // Los dos motores caídos: no hay verde posible. Las señales de los
      // extras (que sí respondieron) se muestran, pero el estado dice la
      // verdad — un paso en verde aquí sería un verde inventado.
      estado = "sin_datos";
    } else if (!grave) {
      estado = senales.length === 0 ? "sin_datos" : "listo";
    } else if (grave.estado === "error") {
      estado = def.bloqueaSiError ? "bloquea" : "atencion";
    } else if (grave.estado === "warn") {
      estado = "atencion";
    } else {
      estado = "listo";
    }
    estados.set(def.clave, estado);

    const paso: PasoEvaluado = {
      ...base,
      estadoCalculado: estado,
      detalle:
        def.clave === "entregables"
          ? estado === "listo"
            ? "XML del periodo listos"
            : "Se generan al contabilizar y declarar el mes"
          : (grave?.resumen ?? null),
      senales,
      cifras,
      hechos,
      hashEvidencia: hashEvidencia(hechos),
      cta: grave?.cta ?? cta,
    };
    if (def.clave === "declaracion" && h.checklist) {
      paso.fechaLimite = h.checklist.fechaLimite;
      paso.diasRestantes = h.checklist.diasRestantes;
    }
    out.push(paso);
  });

  return out;
}

// ── Periodos en juego ────────────────────────────────────────────────────────

/**
 * Qué periodos avanza el pase diario: el mes anterior (el que se declara) y el
 * mes en curso (REP, conciliación y nómina se trabajan mientras corre), más
 * cualquier cierre anterior que siga abierto. Máximo 3, del más viejo al más
 * nuevo. PURA.
 */
export function periodosEnJuego(
  hoy: Date,
  abiertos: ReadonlyArray<{ year: number; month: number }>,
  max = 3
): { year: number; month: number }[] {
  const fechaMx = fechaFiscalEnMexico(hoy);
  const y = fechaMx.year;
  const m = fechaMx.month;
  const enCurso = { year: y, month: m };
  const anterior = m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 };
  const clave = (p: { year: number; month: number }) => p.year * 100 + p.month;
  const set = new Map<number, { year: number; month: number }>();
  for (const p of abiertos) if (clave(p) < clave(anterior)) set.set(clave(p), p);
  set.set(clave(anterior), anterior);
  set.set(clave(enCurso), enCurso);
  return [...set.values()].sort((a, b) => clave(a) - clave(b)).slice(-max);
}

export function periodoStr(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}
