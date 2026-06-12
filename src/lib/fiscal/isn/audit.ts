// ─────────────────────────────────────────────────────────────────────────────
// ISN auditor. Turns the per-entidad computation into Hallazgos (same shape as
// the CFDI auditor) so they persist identically. The headline check is the
// SUCURSALES risk: payroll in >1 state ⇒ ISN must be declared separately in each.
// ─────────────────────────────────────────────────────────────────────────────

import type { Contexto } from "../rules";
import type { Hallazgo } from "../audit/types";
import { calcularIsnPorEntidad } from "./calc";
import type { EmpleadoNomina, FuenteBase } from "./types";

const fmt = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);

const ISN_FUNDAMENTO = { ley: "Leyes de Hacienda estatales", articulo: "ISN" };

export function auditarIsn(
  empleados: EmpleadoNomina[],
  ctxBase: Contexto,
  fuente: FuenteBase = "estimado",
): Hallazgo[] {
  const resumen = calcularIsnPorEntidad(empleados, ctxBase, fuente);
  const baseLabel = fuente === "payroll" ? "nómina del periodo" : "estimada (salario diario)";
  const hallazgos: Hallazgo[] = [];

  // Per-entidad: surface the estimated ISN obligation (info), or flag states
  // we have no rate for (warn).
  for (const r of resumen.porEntidad) {
    if (r.tasa === null || r.isn === null) {
      hallazgos.push({
        checkClave: "isn.sin_tasa",
        severidad: "warn",
        mensaje: `Hay nómina en ${r.entidad} (${r.numEmpleados} empl., base ${fmt(r.baseMensual)}) pero no se tiene tasa ISN para ese estado.`,
        referencias: [r.entidad],
        fundamento: ISN_FUNDAMENTO,
        sugerencia: "Captura la tasa ISN del estado en el catálogo de reglas para poder estimarlo.",
      });
      continue;
    }
    const aprox = r.nota ? ` (nota: ${r.nota})` : "";
    hallazgos.push({
      checkClave: "isn.obligacion",
      severidad: "info",
      mensaje: `ISN estimado en ${r.entidad}: ${fmt(r.isn)} (${(r.tasa * 100).toFixed(2)}% sobre ${fmt(r.baseMensual)}, ${r.numEmpleados} empl.; base ${baseLabel})${aprox}.`,
      referencias: [r.entidad],
      fundamento: r.fundamento ?? ISN_FUNDAMENTO,
      sugerencia: r.verificado
        ? "Declara y paga el ISN ante la secretaría de finanzas del estado."
        : "Verifica la tasa ISN vigente del estado antes de declarar; aún no está validada contra el texto de ley.",
    });
  }

  // Sucursales: payroll spread across multiple states.
  if (resumen.numEntidades > 1) {
    const estados = resumen.porEntidad.map((r) => r.entidad).join(", ");
    hallazgos.push({
      checkClave: "isn.multiestado",
      severidad: "warn",
      mensaje: `Tienes nómina en ${resumen.numEntidades} estados (${estados}). El ISN se declara y paga POR SEPARADO en cada entidad, a la tasa de cada una — no en una sola.`,
      referencias: resumen.porEntidad.map((r) => r.entidad),
      fundamento: ISN_FUNDAMENTO,
      sugerencia: "Registra a la empresa ante la secretaría de finanzas de cada estado y presenta una declaración de ISN por entidad.",
    });
  }

  // Employees we can't place in a state → their ISN isn't being computed.
  if (resumen.empleadosSinEntidad > 0) {
    hallazgos.push({
      checkClave: "isn.empleados_sin_entidad",
      severidad: "warn",
      mensaje: `${resumen.empleadosSinEntidad} empleado(s) activo(s) sin clave de entidad federativa válida: su ISN no se está calculando.`,
      referencias: [],
      fundamento: ISN_FUNDAMENTO,
      sugerencia: "Asigna la clave de entidad federativa (claveEntFed) de prestación del servicio a cada empleado.",
    });
  }

  return hallazgos;
}
