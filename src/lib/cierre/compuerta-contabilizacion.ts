import { evaluarCierre, invalidarCierre } from "./evaluar";
import type { EstadoCierreCanonico } from "./estado-canonico";

export const CODIGO_CIERRE_NO_CONTABILIZABLE = "CIERRE_NO_CONTABILIZABLE" as const;

export type OperacionContabilizacion = "CONTABILIZAR" | "RECONTABILIZAR";

export type ResultadoCompuertaContabilizacion =
  | {
      ok: true;
      estado: EstadoCierreCanonico;
      operacion: OperacionContabilizacion;
    }
  | {
      ok: false;
      status: 409;
      body: {
        code: typeof CODIGO_CIERRE_NO_CONTABILIZABLE;
        error: string;
        estado: EstadoCierreCanonico;
      };
    };

/**
 * Decide si el motor puede crear o regenerar las pólizas mensuales.
 *
 * - DRAFT/null necesita `puedeContabilizar`.
 * - POSTED puede regenerarse mientras siga abierto y la evidencia esté limpia.
 * - Una declaración que ya cerró el periodo exige reabrirlo explícitamente
 *   antes de regenerar el libro.
 */
export function compuertaParaContabilizacion(
  estado: EstadoCierreCanonico
): ResultadoCompuertaContabilizacion {
  if (estado.puedeContabilizar) {
    return { ok: true, estado, operacion: "CONTABILIZAR" };
  }

  const puedeRecontabilizar =
    estado.estadoContable === "POSTED" && estado.listo && !estado.cerrado;
  if (puedeRecontabilizar) {
    return { ok: true, estado, operacion: "RECONTABILIZAR" };
  }

  const detalle = estado.bloqueos[0]?.detalle;
  let error: string;
  if (estado.bloqueos.length > 0) {
    error = `El periodo tiene bloqueos activos${detalle ? `: ${detalle}` : "."}`;
  } else if (estado.estadoContable === "CLOSED") {
    error =
      "El ejercicio está cerrado. Reábrelo en Contabilidad › Cierre del mes antes de contabilizar este periodo.";
  } else if (estado.cerrado) {
    error =
      "El periodo ya está cerrado por una declaración presentada. Reábrelo explícitamente antes de volver a contabilizarlo.";
  } else {
    error = "El periodo todavía no está listo para contabilizarse.";
  }

  return {
    ok: false,
    status: 409,
    body: {
      code: CODIGO_CIERRE_NO_CONTABILIZABLE,
      error,
      estado,
    },
  };
}

/** Lee evidencia fresca: una transición contable nunca acepta la memo de UI. */
export async function evaluarCompuertaContabilizacion(
  companyId: string,
  year: number,
  month: number
): Promise<ResultadoCompuertaContabilizacion> {
  const cierre = await evaluarCierre(companyId, year, month, { fresco: true });
  return compuertaParaContabilizacion(cierre.estado);
}

/** El estado POSTED cambia el resultado del cierre; elimina la evaluación previa. */
export function invalidarCompuertaContabilizacion(
  companyId: string,
  year: number,
  month: number
): void {
  invalidarCierre(companyId, year, month);
}
