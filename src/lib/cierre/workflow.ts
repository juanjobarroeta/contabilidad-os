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
  /** Tools del copiloto permitidas en este paso (fase 2). */
  tools: string[];
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
    checks: ["fx:apertura"],
    dependeDe: [],
    tools: ["query_obligations", "query_tax_declarations"],
    href: () => "/empresa/apertura",
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
    ],
    href: () => "/bancos",
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
    tools: ["query_tax_position", "query_tax_declarations", "search_fiscal_knowledge", "get_valor_fiscal"],
    href: (ctx) => `/impuestos?tab=papeles&${mes(ctx)}`,
    requiereConfirmacion: true,
    bloqueaSiError: false,
  },
  {
    clave: "diot",
    titulo: "DIOT",
    descripcion: "Archivo generado y presentado.",
    aplica: (ctx) => ctx.tieneDiot,
    checks: ["fx:diot"],
    dependeDe: ["impuestos"],
    tools: ["query_tax_declarations"],
    href: (ctx) => `/impuestos?tab=presentar&${mes(ctx)}`,
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
    requiereConfirmacion: true,
    bloqueaSiError: false,
  },
  {
    clave: "declaracion",
    titulo: "Declaración",
    descripcion: "Presentada en el SAT, acuse capturado y pago conciliado en banco.",
    aplica: () => true,
    checks: ["fx:declaracion-periodo", "fx:fecha-limite", "x:pago_conciliado"],
    dependeDe: ["impuestos", "diot"],
    tools: ["query_tax_position", "query_tax_declarations", "query_obligations"],
    href: (ctx) => `/impuestos?tab=presentar&${mes(ctx)}`,
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
    requiereConfirmacion: false,
    bloqueaSiError: false,
  },
];

if (PASOS.map((p) => p.clave).join(",") !== ORDEN_PASOS.join(",")) {
  throw new Error("cierre/workflow: PASOS y ORDEN_PASOS (claves.ts) no coinciden");
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
      if (x.cuentasBanco === 0) return null;
      return x.cuentasFirmadas < x.cuentasBanco
        ? {
            clave,
            estado: "warn",
            resumen: `${x.cuentasFirmadas} de ${plural(x.cuentasBanco, "cuenta con la conciliación del mes firmada", "cuentas con la conciliación del mes firmada")}`,
            cta: { label: "Firmar conciliación", href: "/contabilidad/conciliacion" },
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
    } else {
      const s = senalExtra(ref, h.extras, h.ctx);
      if (s) out.push(s);
    }
  }
  return out;
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
      out.push({ ...base, estadoCalculado: "no_aplica", detalle: null, senales: [], hechos, hashEvidencia: hashEvidencia(hechos) });
      return;
    }

    const senales = senalesDelPaso(def, h);
    const hechos: Record<string, unknown> = {
      senales: senales.map((s) => ({ clave: s.clave, estado: s.estado, resumen: s.resumen })),
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
    } else if (!grave) {
      estado = sinMotores ? "sin_datos" : senales.length === 0 ? "sin_datos" : "listo";
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
  const y = hoy.getFullYear();
  const m = hoy.getMonth() + 1;
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
