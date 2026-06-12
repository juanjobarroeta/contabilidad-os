// ─────────────────────────────────────────────────────────────────────────────
// ISN computation. Groups active employees by entidad and resolves each state's
// rate via getRule — never a hardcoded rate. The rate is the GENERAL rate; for
// progressive/sobretasa states (see `nota`) the figure is an approximation.
// ─────────────────────────────────────────────────────────────────────────────

import { getRule, type Contexto } from "../rules";
import type { EmpleadoNomina, ResultadoIsnEntidad, ResumenIsn } from "./types";

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Compute ISN per entidad. `ctxBase` is the company's context (from
 * construirContexto); the entidad is overridden per employee-group so each
 * state's rate is resolved as of `ctxBase.fecha`.
 */
export function calcularIsnPorEntidad(
  empleados: EmpleadoNomina[],
  ctxBase: Contexto,
): ResumenIsn {
  const activos = empleados.filter((e) => e.activo);

  const grupos = new Map<string, EmpleadoNomina[]>();
  let empleadosSinEntidad = 0;
  for (const e of activos) {
    if (!e.entidad) {
      empleadosSinEntidad++;
      continue;
    }
    const arr = grupos.get(e.entidad) ?? [];
    arr.push(e);
    grupos.set(e.entidad, arr);
  }

  const porEntidad: ResultadoIsnEntidad[] = [];
  let isnTotal = 0;

  for (const [entidad, emps] of grupos) {
    const baseMensual = r2(emps.reduce((s, e) => s + e.baseMensual, 0));
    const regla = getRule<number>("isn.tasa", { ...ctxBase, entidad: entidad as Contexto["entidad"] });
    const tasa = regla?.valor ?? null;
    const isn = tasa !== null ? r2(baseMensual * tasa) : null;
    if (isn !== null) isnTotal += isn;
    porEntidad.push({
      entidad: entidad as ResultadoIsnEntidad["entidad"],
      numEmpleados: emps.length,
      baseMensual,
      tasa,
      isn,
      verificado: regla?.verificado ?? false,
      nota: regla?.nota,
      fundamento: regla?.fundamento,
    });
  }

  // Orden estable: mayor ISN primero (los nulos al final).
  porEntidad.sort((a, b) => (b.isn ?? -1) - (a.isn ?? -1));

  return {
    porEntidad,
    empleadosSinEntidad,
    numEntidades: porEntidad.length,
    isnTotal: r2(isnTotal),
  };
}
