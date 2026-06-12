// ─────────────────────────────────────────────────────────────────────────────
// Frescura del cerebro — el cerebro audita SU PROPIA actualidad. Cruza el
// registro de fuentes (sources.ts) con el estado real del catálogo de reglas y
// la cobertura del INPC, y levanta avisos cuando una fuente quedó atrás para el
// ejercicio en curso o sigue sin cablearse. Es a nivel SISTEMA (no por empresa);
// lo corre un cron de cierre/apertura de ejercicio.
// ─────────────────────────────────────────────────────────────────────────────

import { CATALOGO } from "./rules";
import { FUENTES, type Cadencia } from "./sources";
import { mesesAtrasadoInpc } from "./actualizacion";

export interface HallazgoFrescura {
  clave: string;
  severidad: "info" | "warn";
  cadencia: Cadencia;
  mensaje: string;
}

/** Registro de fuente → clave del catálogo de reglas, cuando aplica. */
const CLAVE_CATALOGO: Record<string, string> = {
  ISN: "isn.tasa",
  UMA: "uma.valor",
  "SALARIO-MINIMO": "salario_minimo.general",
};

/** Año más reciente con regla para una clave del catálogo (0 si ninguna). */
function maxAnioVigencia(claveCatalogo: string): number {
  return CATALOGO.filter((r) => r.clave === claveCatalogo).reduce(
    (max, r) => Math.max(max, Number(r.vigenciaDesde.slice(0, 4))),
    0,
  );
}

/**
 * Revisa la frescura de todas las fuentes a la fecha `hoy`. Devuelve:
 *  - warn: fuente atrasada (INPC > 2 meses, o sin valor del ejercicio en curso).
 *  - info: fuente identificada pero aún no cableada al cerebro (backlog).
 * Da un mes de gracia a las anuales (no avisa en enero, cuando aún se publican).
 */
export function revisarFrescura(hoy: Date = new Date()): HallazgoFrescura[] {
  const anio = hoy.getUTCFullYear();
  const mes = hoy.getUTCMonth() + 1;
  const out: HallazgoFrescura[] = [];

  for (const f of FUENTES) {
    if (f.estado === "pendiente") {
      out.push({
        clave: f.clave,
        severidad: "info",
        cadencia: f.cadencia,
        mensaje: `Fuente identificada pero sin cablear al cerebro: ${f.nombre}.`,
      });
      continue;
    }

    if (f.clave === "INPC") {
      const atraso = mesesAtrasadoInpc(hoy);
      if (atraso > 2) {
        out.push({
          clave: "INPC",
          severidad: "warn",
          cadencia: "mensual",
          mensaje: `Serie INPC atrasada ${atraso} meses — actualízala.`,
        });
      }
      continue;
    }

    const catClave = CLAVE_CATALOGO[f.clave];
    if (f.cadencia === "anual" && catClave) {
      const ultimoAnio = maxAnioVigencia(catClave);
      // Gracia de un mes: las anuales se publican a inicios de año.
      if (ultimoAnio < anio && mes >= 2) {
        out.push({
          clave: f.clave,
          severidad: "warn",
          cadencia: "anual",
          mensaje: `Sin valor de ${f.clave} para el ejercicio ${anio} (último: ${ultimoAnio}). Actualizar.`,
        });
      }
    }
  }

  return out;
}

/** ¿Hay algún aviso de atraso (warn)? Para el modo --strict del cron. */
export function hayAtrasos(hoy: Date = new Date()): boolean {
  return revisarFrescura(hoy).some((h) => h.severidad === "warn");
}
