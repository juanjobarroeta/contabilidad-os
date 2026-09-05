// ─────────────────────────────────────────────────────────────────────────────
// PLANTILLAS de los avisos del pase diario — PURAS, sin modelo. Cada aviso es
// texto sobre datos que los motores ya calcularon; el modelo no interviene
// (costo cero y ninguna cifra inventada). Un `titulo` corto para el push y el
// inbox, un `cuerpo` de una o dos oraciones con la acción siguiente.
// ─────────────────────────────────────────────────────────────────────────────

import type { Delta } from "./avance";

export interface AvisoRedactado {
  titulo: string;
  cuerpo: string;
}

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

export function etiquetaPeriodo(year: number, month: number): string {
  return `${MESES[month - 1]} ${year}`;
}

/** Acción siguiente por señal; el genérico manda al paso. */
const ACCION: Record<string, string> = {
  "complementos-por-emitir": "Timbra el complemento de pago (REP) de cada cobro; el plazo legal es el día 5 del mes siguiente al pago.",
  "complementos-proveedores": "Pide el REP a cada proveedor: sin él, la deducción y el IVA acreditable están en riesgo.",
  sin_clasificar: "Concilia o categoriza los movimientos; mientras queden, el mes no cierra.",
  "conciliacion-bancaria": "Concilia los movimientos del mes para sustentar el flujo de efectivo.",
  banco: "Sube el estado de cuenta o conecta el banco: sin él el balance no cierra.",
  cuentas_sin_estado: "Sube el estado de cuenta de las cuentas que faltan.",
  firmas_conciliacion: "Revisa la conciliación de cada cuenta y fírmala.",
  cfdis: "Sincroniza con el SAT para no omitir facturas del periodo.",
  "sincronizacion-sat": "Completa la descarga de CFDI del periodo antes de calcular.",
  cfdi_faltantes: "Revisa los folios que el SAT reporta y que no tienen XML.",
  nomina: "Registra y timbra las corridas del mes para enterar las retenciones.",
  empleados_sin_recibo: "Verifica los empleados activos sin recibo timbrado en el mes.",
  "cuotas-imss": "Registra el pago de las cuotas con la línea de captura SIPARE.",
  idse_pendientes: "Presenta los movimientos afiliatorios en IDSE.",
  "cadena-declaraciones": "Guarda la declaración de los meses anteriores con actividad para que el arrastre sea íntegro.",
  "posicion-calculada": "Revisa el coeficiente de utilidad o la tarifa para que el ISR provisional se determine.",
  diot: "Genera el archivo de la DIOT y preséntalo.",
  cuadre: "Revisa los movimientos del periodo: la balanza no cuadra.",
  agrupadores: "Asigna el código agrupador del SAT a las cuentas que no lo tienen.",
  posteo: "Contabiliza el mes cuando bancos y CFDI estén completos.",
  hallazgos_criticos: "Revisa y resuelve los hallazgos críticos del auditor.",
  efos: "Revisa las operaciones con contribuyentes de la lista 69-B antes de deducir.",
  "declaracion-periodo": "Presenta la declaración en el SAT y captura el acuse.",
  apertura: "Confirma el punto de partida fiscal: un error de arranque se arrastra a todos los meses.",
};

/**
 * Redacta el aviso de un delta. Devuelve siempre texto (no hay caso «inusual»
 * en la fase 1: la plantilla genérica cubre cualquier señal con su resumen).
 */
export function redactarAviso(d: Delta, ctx: { empresa: string; year: number; month: number }): AvisoRedactado {
  const periodo = etiquetaPeriodo(ctx.year, ctx.month);
  const accion = ACCION[d.senal] ?? `Revisa el paso ${d.tituloPaso} del cierre.`;

  if (d.direccion === "vencio") {
    return {
      titulo: `${ctx.empresa}: declaración de ${periodo} vencida`,
      cuerpo: `${d.resumen}. Presenta cuanto antes para limitar actualización y recargos.`,
    };
  }
  if (d.direccion === "por_vencer") {
    const dias = d.diasRestantes ?? 0;
    return {
      titulo: `${ctx.empresa}: la declaración de ${periodo} vence ${dias === 0 ? "hoy" : `en ${dias} día${dias === 1 ? "" : "s"}`}`,
      cuerpo: `${d.resumen}. ${ACCION["declaracion-periodo"]}`,
    };
  }
  const verbo = d.direccion === "empeoro" ? "empeoró" : "necesita atención";
  return {
    titulo: `${ctx.empresa}: ${d.resumen}`,
    cuerpo: `Cierre de ${periodo} · ${d.tituloPaso} ${verbo}: ${d.resumen}. ${accion}`,
  };
}
