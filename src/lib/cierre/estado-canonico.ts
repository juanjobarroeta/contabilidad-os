// ─────────────────────────────────────────────────────────────────────────────
// ESTADO CANÓNICO DEL CIERRE MENSUAL — contrato puro, sin Prisma.
//
// Los motores, la declaración y AccountingPeriod son hechos distintos. Antes
// cada pantalla elegía uno y podía llamar «cerrado» a un mes con un bloqueo
// activo. Este contrato impone una sola precedencia:
//
//   bloqueo / evidencia desconocida > cerrado > posteado > listo
//
// Un estado físico POSTED/CLOSED se conserva como dato (`estadoContable`), pero
// nunca se expone como fase operativa ni habilita entregables si hoy existe un
// bloqueo duro. Así un cambio tardío de evidencia no queda tapado por una marca
// verde histórica.
// ─────────────────────────────────────────────────────────────────────────────

import type { ClavePasoCierre } from "./claves";
import type { EstadoCalculado, SenalPaso } from "./workflow";

export type EstadoContableCierre = "DRAFT" | "POSTED" | "CLOSED";
export type FaseCierreCanonica = "BLOQUEADO" | "LISTO" | "POSTEADO" | "CERRADO";
export type TipoBloqueoCierre = "MOTOR" | "SIN_DATOS" | "EVIDENCIA_CAMBIO" | "DEPENDENCIA";

export interface PasoParaEstadoCierre {
  clave: ClavePasoCierre;
  titulo: string;
  estadoCalculado: EstadoCalculado;
  estado: "PENDIENTE" | "CONFIRMADO" | "OMITIDO" | "REVISAR";
  detalle: string | null;
  senales: SenalPaso[];
}

export interface BloqueoCierre {
  paso: ClavePasoCierre;
  titulo: string;
  tipo: TipoBloqueoCierre;
  detalle: string;
}

export interface EstadoCierreCanonico {
  fase: FaseCierreCanonica;
  /** Estado persistido del ledger; puede discrepar de la fase si apareció un bloqueo. */
  estadoContable: EstadoContableCierre | null;
  /** Hecho externo: existe evidencia de presentación del periodo. */
  declarado: boolean;
  /** Sin bloqueo duro en la evidencia vigente. */
  listo: boolean;
  /** Ledger posteado y sin bloqueo vigente. */
  posteado: boolean;
  /** Periodo cerrado y sin bloqueo vigente. */
  cerrado: boolean;
  /** Los entregables definitivos sólo existen desde POSTEADO. */
  descargable: boolean;
  /** Transición admitida por el contrato; el motor aplica sus guardas adicionales. */
  puedePostear: boolean;
  bloqueos: BloqueoCierre[];
}

export interface EntradaEstadoCierre {
  estadoContable: EstadoContableCierre | null;
  pasos: ReadonlyArray<PasoParaEstadoCierre>;
}

function detalleBloqueo(paso: PasoParaEstadoCierre, fallback: string): string {
  return paso.detalle?.trim() || fallback;
}

/** Resuelve la única fase operativa que deben leer API, UI, pase y entregables. */
export function resolverEstadoCierre(input: EntradaEstadoCierre): EstadoCierreCanonico {
  const aplican = input.pasos.filter((p) => p.estadoCalculado !== "no_aplica");
  const bloqueos: BloqueoCierre[] = [];

  for (const paso of aplican) {
    if (paso.estadoCalculado === "bloquea") {
      bloqueos.push({
        paso: paso.clave,
        titulo: paso.titulo,
        tipo: "MOTOR",
        detalle: detalleBloqueo(paso, "El motor reportó un bloqueo activo."),
      });
    } else if (paso.estadoCalculado === "sin_datos") {
      bloqueos.push({
        paso: paso.clave,
        titulo: paso.titulo,
        tipo: "SIN_DATOS",
        detalle: detalleBloqueo(paso, "No hay evidencia suficiente para evaluar este paso."),
      });
    } else if (paso.estado === "REVISAR") {
      bloqueos.push({
        paso: paso.clave,
        titulo: paso.titulo,
        tipo: "EVIDENCIA_CAMBIO",
        detalle: detalleBloqueo(paso, "La evidencia cambió después de la última confirmación."),
      });
    }
  }

  // `espera` debe venir acompañado por el bloqueo de su dependencia. Si llega
  // aislado por datos persistidos incompletos, no inventamos un verde.
  if (bloqueos.length === 0) {
    const esperaHuerfana = aplican.find((p) => p.estadoCalculado === "espera");
    if (esperaHuerfana) {
      bloqueos.push({
        paso: esperaHuerfana.clave,
        titulo: esperaHuerfana.titulo,
        tipo: "DEPENDENCIA",
        detalle: detalleBloqueo(esperaHuerfana, "Un paso anterior todavía impide continuar."),
      });
    }
  }

  const declarado = aplican.some(
    (p) =>
      p.clave === "declaracion" &&
      p.senales.some((s) => s.clave === "fx:declaracion-periodo" && s.estado === "ok")
  );
  const sinBloqueos = bloqueos.length === 0;
  const estadoContablePosteado = input.estadoContable === "POSTED" || input.estadoContable === "CLOSED";
  const posteado = sinBloqueos && estadoContablePosteado;
  const cerrado =
    sinBloqueos &&
    (input.estadoContable === "CLOSED" || (input.estadoContable === "POSTED" && declarado));
  const fase: FaseCierreCanonica = !sinBloqueos
    ? "BLOQUEADO"
    : cerrado
      ? "CERRADO"
      : posteado
        ? "POSTEADO"
        : "LISTO";

  return {
    fase,
    estadoContable: input.estadoContable,
    declarado,
    listo: sinBloqueos,
    posteado,
    cerrado,
    descargable: posteado,
    puedePostear: sinBloqueos && !estadoContablePosteado,
    bloqueos,
  };
}
