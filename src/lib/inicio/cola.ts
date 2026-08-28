// ─────────────────────────────────────────────────────────────────────────────
// LA COLA DE TRABAJO DEL DESPACHO — el lente multi-RFC del nuevo Inicio.
//
// Del rediseño Piloto (docs/REDISENO-PILOTO.md, Propuesta A): una fila por
// cosa-que-hacer, UNA acción por fila, ordenadas por urgencia real. Se arma
// con señales BARATAS ya batcheadas (el patrón de /api/despacho/cockpit) —
// jamás computeTaxPosition ni la balanza en abanico sobre 18 empresas.
//
// Núcleo puro para poder probar el ranking sin base de datos.
// ─────────────────────────────────────────────────────────────────────────────

export type CategoriaCola = "FISCAL" | "NOMINA" | "BANCOS" | "CIERRE" | "SETUP";
export type UrgenciaCola = "vencido" | "hoy" | "pronto" | "cuando_quieras";

export interface FilaCola {
  companyId: string;
  empresa: string;
  rfc: string;
  categoria: CategoriaCola;
  detalle: string;
  monto: number | null;
  /** Etiqueta de vencimiento lista para pintar («venció 17 ago», «hoy»…). */
  vence: string;
  urgencia: UrgenciaCola;
  cta: { label: string; href: string };
}

export interface SenalesEmpresa {
  companyId: string;
  razonSocial: string;
  rfc: string;
  /** Declaración del periodo fiscal en juego (mes anterior). */
  declaracion: {
    estado: "presentada" | "calculada" | "pendiente" | "vencida";
    aPagar: number | null;
    periodoLabel: string; // «julio»
    venceLabel: string; // «17 ago»
  };
  nomina: {
    runsSinTimbrar: { totalNeto: number; empleados: number }[];
    corridasDelMes: number;
    empleadosActivos: number;
    setupCompleto: boolean;
  };
  banco: {
    sinClasificar: number; // UNMATCHED + IGNORED sin categoría
  };
  cierre: {
    mesAnteriorPosteado: boolean;
    /** Sólo se ofrece cerrar cuando el resto de la fila está limpio. */
    label: string; // «julio»
  };
  hallazgosCriticos: number;
}

const ORDEN_URGENCIA: Record<UrgenciaCola, number> = {
  vencido: 0,
  hoy: 1,
  pronto: 2,
  cuando_quieras: 3,
};

export interface ResumenCola {
  vencidoMonto: number;
  vencidoSinImporte: number;
  rfcsVencidos: number;
  declaracionesPorPresentar: number;
  nominasSinTimbrar: number;
  movimientosSinClasificar: number;
}

/** Arma las filas de una empresa, en su orden de prioridad interno. */
export function filasDeEmpresa(s: SenalesEmpresa, opts: { diaDelMes: number }): FilaCola[] {
  const filas: FilaCola[] = [];
  const base = { companyId: s.companyId, empresa: s.razonSocial, rfc: s.rfc };

  // 1. Fiscal — la declaración manda.
  if (s.declaracion.estado === "vencida") {
    filas.push({
      ...base,
      categoria: "FISCAL",
      detalle: `Declaración de ${s.declaracion.periodoLabel} sin presentar — recargos corriendo (CFF 17-A)`,
      monto: s.declaracion.aPagar,
      vence: `venció ${s.declaracion.venceLabel}`,
      urgencia: "vencido",
      cta: { label: "Presentar", href: "/impuestos" },
    });
  } else if (s.declaracion.estado === "calculada" || s.declaracion.estado === "pendiente") {
    filas.push({
      ...base,
      categoria: "FISCAL",
      detalle:
        s.declaracion.estado === "calculada"
          ? `Declaración de ${s.declaracion.periodoLabel} calculada, lista para presentar`
          : `Declaración de ${s.declaracion.periodoLabel} por preparar`,
      monto: s.declaracion.aPagar,
      vence: s.declaracion.venceLabel,
      urgencia: "pronto",
      cta: { label: "Presentar", href: "/impuestos" },
    });
  }

  // 2. Nómina — timbrar lo calculado; calcular lo que falta de la quincena.
  if (s.nomina.runsSinTimbrar.length > 0) {
    const neto = s.nomina.runsSinTimbrar.reduce((t, r) => t + r.totalNeto, 0);
    const recibos = s.nomina.runsSinTimbrar.reduce((t, r) => t + r.empleados, 0);
    filas.push({
      ...base,
      categoria: "NOMINA",
      detalle: `Corrida calculada sin timbrar — ${recibos} recibo${recibos === 1 ? "" : "s"}`,
      monto: neto,
      vence: "hoy",
      urgencia: "hoy",
      cta: { label: "Timbrar", href: "/nomina?tab=corridas" },
    });
  } else if (
    s.nomina.empleadosActivos > 0 &&
    s.nomina.corridasDelMes === 0 &&
    opts.diaDelMes >= 13
  ) {
    filas.push({
      ...base,
      categoria: "NOMINA",
      detalle: `Sin corrida este mes — ${s.nomina.empleadosActivos} empleado${s.nomina.empleadosActivos === 1 ? "" : "s"} activo${s.nomina.empleadosActivos === 1 ? "" : "s"}`,
      monto: null,
      vence: "esta quincena",
      urgencia: "pronto",
      cta: { label: "Calcular", href: "/nomina?tab=corridas" },
    });
  }

  // 3. Bancos — lo sin clasificar bloquea el cierre (disciplina del motor).
  if (s.banco.sinClasificar > 0) {
    filas.push({
      ...base,
      categoria: "BANCOS",
      detalle: `${s.banco.sinClasificar} movimiento${s.banco.sinClasificar === 1 ? "" : "s"} sin clasificar`,
      monto: null,
      vence: "antes del cierre",
      urgencia: "pronto",
      cta: { label: "Conciliar", href: "/bancos" },
    });
  }

  // 4. Setup a medias con nómina en juego.
  if (!s.nomina.setupCompleto && s.nomina.empleadosActivos > 0) {
    filas.push({
      ...base,
      categoria: "SETUP",
      detalle: "Setup de nómina incompleto (registro patronal o timbrado)",
      monto: null,
      vence: "—",
      urgencia: "cuando_quieras",
      cta: { label: "Completar", href: "/empresa" },
    });
  }

  // 5. Cierre — sólo cuando la fila está limpia: nada vencido, banco al día.
  if (
    !s.cierre.mesAnteriorPosteado &&
    s.declaracion.estado === "presentada" &&
    s.banco.sinClasificar === 0 &&
    s.nomina.runsSinTimbrar.length === 0
  ) {
    filas.push({
      ...base,
      categoria: "CIERRE",
      detalle: `${s.cierre.label} listo para cerrar`,
      monto: null,
      vence: "cuando quieras",
      urgencia: "cuando_quieras",
      cta: { label: "Cerrar mes", href: "/contabilidad/cierre" },
    });
  }

  return filas;
}

/** La cola completa: filas de todas las empresas, ordenadas por urgencia. */
export function armarCola(
  empresas: SenalesEmpresa[],
  opts: { diaDelMes: number; maxFilasPorEmpresa?: number },
): { filas: FilaCola[]; resumen: ResumenCola } {
  const max = opts.maxFilasPorEmpresa ?? 2;
  const filas = empresas
    .flatMap((s) => filasDeEmpresa(s, opts).slice(0, max))
    .sort(
      (a, b) =>
        ORDEN_URGENCIA[a.urgencia] - ORDEN_URGENCIA[b.urgencia] ||
        (b.monto ?? 0) - (a.monto ?? 0),
    );

  const vencidas = empresas.filter((e) => e.declaracion.estado === "vencida");
  const resumen: ResumenCola = {
    vencidoMonto: vencidas.reduce((t, e) => t + (e.declaracion.aPagar ?? 0), 0),
    vencidoSinImporte: vencidas.filter((e) => e.declaracion.aPagar === null).length,
    rfcsVencidos: vencidas.length,
    declaracionesPorPresentar: empresas.filter((e) => e.declaracion.estado !== "presentada").length,
    nominasSinTimbrar: empresas.filter((e) => e.nomina.runsSinTimbrar.length > 0).length,
    movimientosSinClasificar: empresas.reduce((t, e) => t + e.banco.sinClasificar, 0),
  };
  return { filas, resumen };
}
