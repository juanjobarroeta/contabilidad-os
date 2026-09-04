// ─────────────────────────────────────────────────────────────────────────────
// Consulta unificada de VALORES fiscales vigentes para el copiloto (tool
// get_valor_fiscal): multas del CFF, tarifas ISR, UMA, salario mínimo,
// recargos y subsidio al empleo. Todo sale de las tablas versionadas del repo
// (nunca de memoria del modelo) y devuelve vigencia, fuente y `verificado`.
// Sin DB ni red: puro sobre las tablas, probado en vitest.
// ─────────────────────────────────────────────────────────────────────────────

import { getRule } from "./rules";
import { buscarMulta } from "./multas";
import { recargosPorMora, tasasRecargos } from "./recargos";
import { aplicarTarifa, subsidioEmpleo, tarifaAnualPF, tarifaMensualSueldos } from "./tarifas";

export type TipoValorFiscal = "multa" | "tarifa_isr" | "uma" | "salario_minimo" | "recargos" | "subsidio_empleo";

export interface ConsultaValorFiscal {
  tipo: TipoValorFiscal;
  /** multa: artículo del CFF («82», «84-B»). */
  articulo?: string;
  fraccion?: string;
  inciso?: string;
  /** tarifa_isr: «mensual» (Art. 96/116) o «anual» (Art. 152). */
  periodo?: "mensual" | "anual";
  /** tarifa_isr: base gravable para aplicar la tarifa; recargos: monto actualizado. */
  base?: number;
  /** recargos: meses (o fracción) de mora. */
  meses?: number;
  /** ISO YYYY-MM-DD; default hoy. */
  fecha?: string;
}

// UMA y salario mínimo aplican a todos (aplicabilidad "*"); el contexto es de relleno.
const ctxPara = (fecha: string) => ({ regimen: "601", actividades: [] as never[], tipoPersona: "PM" as const, fecha });

function fechaIso(f?: string): string {
  const d = f && /^\d{4}-\d{2}-\d{2}$/.test(f) ? new Date(`${f}T12:00:00Z`) : new Date();
  return (isNaN(d.getTime()) ? new Date() : d).toISOString().slice(0, 10);
}

/** Devuelve un objeto serializable para el modelo. Nunca lanza. */
export function consultarValorFiscal(q: ConsultaValorFiscal): Record<string, unknown> {
  const fecha = fechaIso(q.fecha);
  const ejercicio = Number(fecha.slice(0, 4));
  const noHay = (que: string) => ({
    tipo: q.tipo,
    fecha,
    error: `No hay ${que} vigente para ${fecha} en las tablas del sistema.`,
    instruccion: "Dilo al usuario y NO des un monto de memoria; sugiere consultar la fuente oficial.",
  });

  switch (q.tipo) {
    case "multa": {
      if (!q.articulo) return { tipo: q.tipo, error: "Falta `articulo` (p.ej. «82»)." };
      const r = buscarMulta({ articulo: q.articulo, fraccion: q.fraccion, inciso: q.inciso, fecha });
      if (!r) return noHay("tabla de multas del CFF (Anexo 5)");
      const art = q.articulo.replace(/^art(?:[íi]culo|\.)?\s*/i, "");
      return {
        tipo: q.tipo,
        fecha,
        cita: `Art. ${art} CFF`,
        fuente: r.tabla.fuente,
        url: r.tabla.url,
        vigenciaDesde: r.tabla.vigenciaDesde,
        vigenciaHasta: r.tabla.vigenciaHasta,
        verificado: r.tabla.verificado,
        moneda: "MXN",
        filas: r.filas.map((f) => ({ fraccion: f.fraccion, inciso: f.inciso, minimo: f.minimo, maximo: f.maximo, porcentaje: f.porcentaje ?? null, texto: f.texto })),
        nota:
          r.filas.length === 0
            ? "Ese artículo no tiene cantidades en el Anexo 5 (puede ser una infracción sin monto propio o un artículo sin cantidades actualizadas)."
            : "Montos actualizados por el SAT (Art. 17-A CFF). La infracción está en el artículo anterior (81 → multa 82; 83 → 84). Cita la fracción/inciso exactos.",
      };
    }
    case "tarifa_isr": {
      const periodo = q.periodo ?? "mensual";
      if (periodo === "anual") {
        const t = tarifaAnualPF(ejercicio);
        if (!t) return noHay("tarifa anual (Art. 152 LISR)");
        return {
          tipo: q.tipo,
          periodo,
          fecha,
          cita: "Art. 152 LISR",
          fuente: t.fuente,
          ejercicio: t.ejercicio,
          vigenciaDesde: t.vigenciaDesde,
          vigenciaHasta: t.vigenciaHasta,
          verificado: t.verificado,
          filas: t.filas,
          ...(q.base != null && q.base > 0 ? { base: q.base, impuesto: Math.round(aplicarTarifa(q.base, t.filas) * 100) / 100 } : {}),
        };
      }
      const m = tarifaMensualSueldos(ejercicio);
      if (!m) return noHay("tarifa mensual (Art. 96 LISR)");
      return {
        tipo: q.tipo,
        periodo,
        fecha,
        cita: "Art. 96 LISR",
        fuente: m.tarifa.fuente,
        ejercicio: m.tarifa.ejercicio,
        vigenciaDesde: m.tarifa.vigenciaDesde,
        vigenciaHasta: m.tarifa.vigenciaHasta,
        verificado: m.tarifa.verificado && m.vigente,
        nota: m.vigente ? "Misma tarifa mensual para arrendamiento (Art. 116)." : `Tarifa de ${m.tarifa.ejercicio} aplicada por arrastre: la de ${ejercicio} aún no está cargada; dilo.`,
        filas: m.tarifa.filas,
        ...(q.base != null && q.base > 0 ? { base: q.base, impuesto: Math.round(aplicarTarifa(q.base, m.tarifa.filas) * 100) / 100 } : {}),
      };
    }
    case "uma": {
      const r = getRule<{ diaria: number; mensual: number; anual: number }>("uma.valor", ctxPara(fecha));
      if (!r) return noHay("UMA");
      return {
        tipo: q.tipo,
        fecha,
        fuente: `${r.fundamento.ley} — ${r.fundamento.articulo ?? ""}`.trim(),
        verificado: r.verificado,
        moneda: "MXN",
        diaria: r.valor.diaria,
        mensual: r.valor.mensual,
        anual: r.valor.anual,
        nota: "La UMA entra en vigor el 1 de febrero de cada año (Art. 5 LUMA): en enero rige la del año anterior.",
      };
    }
    case "salario_minimo": {
      const g = getRule<number>("salario_minimo.general", ctxPara(fecha));
      const f = getRule<number>("salario_minimo.frontera", ctxPara(fecha));
      if (!g) return noHay("salario mínimo");
      return {
        tipo: q.tipo,
        fecha,
        fuente: `${g.fundamento.ley} — ${g.fundamento.articulo ?? ""}`.trim(),
        verificado: g.verificado,
        moneda: "MXN",
        generalDiario: g.valor,
        fronteraNorteDiario: f?.valor ?? null,
        nota: "Vigente desde el 1 de enero. El de la Zona Libre de la Frontera Norte aplica sólo en sus municipios.",
      };
    }
    case "recargos": {
      const t = tasasRecargos(fecha);
      if (!t) return noHay("tasa de recargos (LIF)");
      const calc = q.base != null && q.meses != null ? recargosPorMora(q.base, q.meses, fecha) : null;
      return {
        tipo: q.tipo,
        fecha,
        cita: "Art. 21 CFF",
        fuente: t.fuente,
        url: t.url,
        ejercicio: t.ejercicio,
        vigenciaDesde: t.vigenciaDesde,
        vigenciaHasta: t.vigenciaHasta,
        verificado: t.verificado,
        tasaMensualMora: t.mora,
        tasaMensualProrroga: t.prorroga,
        parcialidades: t.parcialidades,
        ...(calc ? { calculo: { montoActualizado: q.base, meses: calc.meses, recargos: calc.recargos } } : {}),
        nota: "Los recargos se causan por mes o fracción sobre la contribución ACTUALIZADA (Art. 17-A CFF), hasta por 5 años. La tasa de mora es la de prórroga de la LIF más 50 %.",
      };
    }
    case "subsidio_empleo": {
      const s = subsidioEmpleo(ejercicio);
      if (!s) return noHay("subsidio para el empleo");
      const uma = getRule<{ diaria: number; mensual: number; anual: number }>("uma.valor", ctxPara(fecha));
      return {
        tipo: q.tipo,
        fecha,
        fuente: s.fuente,
        ejercicio: s.ejercicio,
        vigenciaDesde: s.vigenciaDesde,
        vigenciaHasta: s.vigenciaHasta,
        verificado: s.verificado,
        pctUmaMensual: s.pctUmaMensual,
        pctUmaMensualEnero: s.pctUmaMensualEnero ?? null,
        topeIngresoMensual: s.topeIngresoMensual,
        ...(uma ? { montoMensualAprox: Math.round(uma.valor.mensual * s.pctUmaMensual * 100) / 100 } : {}),
        nota: "Monto único mensual = pct × UMA mensual, sólo si el ingreso mensual no excede el tope; reduce el ISR hasta cero, no se devuelve.",
      };
    }
    default:
      return { error: `tipo desconocido: ${String((q as { tipo?: unknown }).tipo)}` };
  }
}
