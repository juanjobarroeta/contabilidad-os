import { evaluarCierre } from "./evaluar";
import type { EstadoCierreCanonico } from "./estado-canonico";

export const CODIGO_CIERRE_NO_DESCARGABLE = "CIERRE_NO_DESCARGABLE" as const;

export type ResultadoCompuertaEntregable =
  | { ok: true; estado: EstadoCierreCanonico | null }
  | {
      ok: false;
      status: 409;
      body: {
        code: typeof CODIGO_CIERRE_NO_DESCARGABLE;
        error: string;
        estado: EstadoCierreCanonico;
      };
    };

/**
 * Una sola respuesta para cualquier entregable definitivo del periodo. Así un
 * XML individual no puede saltarse un bloqueo que ya detiene el paquete ZIP.
 */
export function compuertaParaEstado(estado: EstadoCierreCanonico): ResultadoCompuertaEntregable {
  if (estado.descargable) return { ok: true, estado };

  const detalle = estado.bloqueos[0]?.detalle;
  return {
    ok: false,
    status: 409,
    body: {
      code: CODIGO_CIERRE_NO_DESCARGABLE,
      error:
        estado.bloqueos.length > 0
          ? `El periodo tiene bloqueos activos${detalle ? `: ${detalle}` : "."}`
          : "Contabiliza el periodo antes de descargar el entregable definitivo.",
      estado,
    },
  };
}

/**
 * Aplica la fase canónica a los meses operativos. El mes 13 pertenece al
 * cierre anual: no tiene declaración mensual ni los demás pasos de este
 * flujo. Sus generadores con movimientos conservan la guarda física propia.
 */
export async function evaluarCompuertaEntregable(
  companyId: string,
  year: number,
  month: number
): Promise<ResultadoCompuertaEntregable> {
  if (month === 13) return { ok: true, estado: null };
  const cierre = await evaluarCierre(companyId, year, month, { fresco: true });
  return compuertaParaEstado(cierre.estado);
}
