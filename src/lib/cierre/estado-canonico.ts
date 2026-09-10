// ─────────────────────────────────────────────────────────────────────────────
// ESTADO CANÓNICO DEL CIERRE MENSUAL — contrato puro, sin Prisma.
//
// Los motores, la declaración y AccountingPeriod son hechos distintos. Antes
// cada pantalla elegía uno y podía llamar «cerrado» a un mes con un bloqueo
// activo. Este contrato impone una sola precedencia:
//
//   cierre externo > bloqueo / evidencia desconocida > cerrado > contabilizado > listo
//
// Un estado físico POSTED/CLOSED se conserva como dato (`estadoContable`), pero
// nunca se expone como fase operativa ni habilita entregables si hoy existe un
// bloqueo duro. Así un cambio tardío de evidencia no queda tapado por una marca
// verde histórica.
// ─────────────────────────────────────────────────────────────────────────────

import type { ClavePasoCierre } from "./claves";
import type { EstadoCalculado, SenalPaso } from "./workflow";

export type EstadoContableCierre = "DRAFT" | "POSTED" | "CLOSED";
export type FaseCierreCanonica = "BLOQUEADO" | "LISTO" | "CONTABILIZADO" | "CERRADO";
export type OrigenCierre = "CONTABILIDAD_OS" | "FUERA_DE_CONTABILIDAD_OS" | null;
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
  /** Dónde se cerró el periodo; evita atribuir a ContabilidadOS un cierre importado. */
  origenCierre: OrigenCierre;
  /** Sin bloqueo duro en la evidencia vigente. */
  listo: boolean;
  /** Pólizas generadas en el ledger y sin bloqueo vigente. */
  contabilizado: boolean;
  /** Periodo cerrado aquí o importado como cierre histórico externo. */
  cerrado: boolean;
  /** Los entregables definitivos sólo existen con el ledger contabilizado. */
  descargable: boolean;
  /** Transición admitida por el contrato; el motor aplica sus guardas adicionales. */
  puedeContabilizar: boolean;
  bloqueos: BloqueoCierre[];
}

export interface EntradaEstadoCierre {
  estadoContable: EstadoContableCierre | null;
  /** Declaración FILED/PAID importada como historia, cerrada antes de operar aquí. */
  declaracionExterna?: boolean;
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
    // Entregables espera de forma normal mientras Contabilidad o Declaración
    // sigan en atención. No puede bloquear la transición que precisamente
    // genera las pólizas que necesita. Cualquier otro `espera` sin su bloqueo
    // de dependencia sí es evidencia incompleta y falla cerrado.
    const esperaHuerfana = aplican.find(
      (p) => p.clave !== "entregables" && p.estadoCalculado === "espera"
    );
    if (esperaHuerfana) {
      bloqueos.push({
        paso: esperaHuerfana.clave,
        titulo: esperaHuerfana.titulo,
        tipo: "DEPENDENCIA",
        detalle: detalleBloqueo(esperaHuerfana, "Un paso anterior todavía impide continuar."),
      });
    }
  }

  const declaradoEnPasos = aplican.some(
    (p) =>
      p.clave === "declaracion" &&
      p.senales.some((s) => s.clave === "fx:declaracion-periodo" && s.estado === "ok")
  );
  const cierreExterno = input.declaracionExterna === true;
  const declarado = cierreExterno || declaradoEnPasos;
  const sinBloqueos = bloqueos.length === 0;
  const estadoContableContabilizado = input.estadoContable === "POSTED" || input.estadoContable === "CLOSED";
  const contabilizado = sinBloqueos && estadoContableContabilizado;
  const cerradoEnContabilidadOS =
    sinBloqueos &&
    (input.estadoContable === "CLOSED" || (input.estadoContable === "POSTED" && declarado));
  // Una declaración histórica importada prueba que el periodo se cerró fuera
  // del producto. No inventa pólizas ni abre entregables: esos dos hechos
  // siguen dependiendo del ledger y de sus bloqueos vigentes.
  const cerrado = cierreExterno || cerradoEnContabilidadOS;
  const fase: FaseCierreCanonica = cierreExterno
    ? "CERRADO"
    : !sinBloqueos
      ? "BLOQUEADO"
      : cerradoEnContabilidadOS
        ? "CERRADO"
        : contabilizado
          ? "CONTABILIZADO"
          : "LISTO";

  return {
    fase,
    estadoContable: input.estadoContable,
    declarado,
    origenCierre: cierreExterno ? "FUERA_DE_CONTABILIDAD_OS" : cerradoEnContabilidadOS ? "CONTABILIDAD_OS" : null,
    listo: sinBloqueos,
    contabilizado,
    cerrado,
    descargable: contabilizado,
    puedeContabilizar: sinBloqueos && !estadoContableContabilizado,
    bloqueos,
  };
}
