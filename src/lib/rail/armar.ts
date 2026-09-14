import { ORDEN_SALUD, TITULO_SALUD, type ClaveSalud, type EstadoSalud } from "@/lib/salud/claves";
import type { DeltaSalud, DimensionSalud } from "@/lib/salud/evaluar";
import { etiquetaPeriodo, tituloDeTipo, type TipoSolicitud } from "@/lib/solicitudes/claves";
import { ORDEN_ESTADO, TITULO_ESTADO_RENGLON, type RenglonResumen } from "@/lib/contador/claves";
import type { GrupoRail } from "@/lib/hallazgos/agrupar";

// ─────────────────────────────────────────────────────────────────────────────
// EL RAIL v3: TRABAJO, NO PROBLEMAS. PURO.
//
// El rail viejo era una lista de hallazgos, y por eso nadie lo abría: «13,778
// posibles duplicados» no es información, es un número que paraliza. Un rail
// que sólo cuenta problemas le pasa el trabajo entero al humano y se queda
// tranquilo por haber avisado.
//
// Tres bloques, y el orden es el argumento:
//
//   1. LO QUE HICE      — porque un asistente que no puede enseñar su trabajo
//                         no se distingue de uno que no hizo nada.
//   2. LO QUE NECESITO  — lo único que el despacho NO puede resolver solo. Es
//                         lo más accionable de la pantalla y por eso va antes
//                         que el diagnóstico.
//   3. CÓMO VAMOS       — el estado, al final: es contexto, no tarea.
//
// REGLA DURA: ningún conteo crudo. Un check que produce miles de renglones se
// presenta como UNA revisión con muestra y triage, o no se presenta. A ese
// volumen el número ya no informa: informa que el check está atrapando un
// patrón legítimo, y eso es lo que hay que decir.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A partir de cuántos casos un grupo deja de ser una lista y pasa a ser una
 * revisión.
 *
 * No es un número estético. Por debajo, el contador puede recorrer los casos
 * uno por uno y el conteo le sirve de plan. Por encima, recorrerlos es
 * imposible y el conteo sólo transmite que hay algo roto — casi siempre el
 * propio check, que está marcando un patrón normal del negocio.
 */
export const UMBRAL_REVISION = 50;

export interface HechoRail {
  /** Texto en pasado: lo que quedó hecho. */
  texto: string;
  /** A dónde lleva, si hay dónde mirarlo. */
  href?: string | null;
}

export interface PedidoRail {
  id: string;
  titulo: string;
  detalle: string;
  /** Cuántos días lleva esperando. Un pedido viejo es trabajo detenido. */
  dias: number;
  href?: string | null;
}

export interface RevisionRail {
  /** El grupo que se volvió inmanejable. */
  titulo: string;
  casos: number;
  /** Dos o tres ejemplos: lo que se necesita para juzgar si el check acierta. */
  muestra: string[];
  /** Lo que hay que hacer con el bulto, no con cada caso. */
  triage: string;
  href: string;
}

export interface DimensionRail {
  clave: ClaveSalud;
  titulo: string;
  estado: EstadoSalud;
  detalle: string;
  /** Qué le pasó hoy, si cambió. */
  cambio: string | null;
}

export interface Rail {
  hice: HechoRail[];
  necesito: PedidoRail[];
  revisiones: RevisionRail[];
  vamos: DimensionRail[];
  /** Cuándo fue la última pasada. null = el agente no ha pasado todavía. */
  ultimaPasada: string | null;
}

export interface EntradaRail {
  /** Los renglones del último `resumen_corrida`. */
  renglones: RenglonResumen[];
  ultimaPasada: string | null;
  solicitudes: { id: string; tipo: TipoSolicitud; motivo: string; periodo: string | null; dias: number }[];
  dimensiones: DimensionSalud[];
  deltas: DeltaSalud[];
  grupos: GrupoRail[];
}

/** Máximos por bloque. Un rail que hay que recorrer con scroll ya falló. */
export const MAX_HICE = 5;
export const MAX_NECESITO = 5;
export const MAX_REVISIONES = 3;

/**
 * Convierte un grupo de hallazgos en lo que corresponde. PURA.
 *
 * Por debajo del umbral es trabajo y va a «necesito»; por encima es una
 * revisión con muestra. Devolver `null` significa que ese grupo no merece
 * espacio en el rail.
 */
export function comoRevision(g: GrupoRail): RevisionRail | null {
  if (g.count < UMBRAL_REVISION) return null;
  return {
    titulo: g.titulo,
    casos: g.count,
    muestra: g.muestra ? [g.muestra] : [],
    // A este volumen el trabajo NO es resolver los casos: es decidir si la
    // regla que los produjo está bien. Decirlo aquí evita que alguien intente
    // lo primero durante semanas.
    triage: `Son demasiados para atenderlos uno por uno. Revisa una muestra y decide si la regla está marcando un patrón normal del negocio (facturas recurrentes idénticas, por ejemplo) antes de trabajarlos.`,
    href: g.href,
  };
}

const TITULO_PEDIDO_VIEJO = (dias: number) =>
  dias >= 21 ? `lleva ${dias} días esperando` : dias <= 1 ? "pedido hoy" : `pedido hace ${dias} días`;

/**
 * Arma el rail. PURA.
 *
 * Todo el criterio vive aquí para poderlo probar: el componente sólo pinta.
 */
export function armarRail(e: EntradaRail): Rail {
  // ── 1. Lo que hice ────────────────────────────────────────────────────────
  // Sólo lo ATENDIDO. Un «lo que hice» que incluye pendientes no es un reporte
  // de trabajo, es la lista de problemas otra vez con otro encabezado.
  const hice: HechoRail[] = e.renglones
    .filter((r) => r.estado === "atendido")
    .slice(0, MAX_HICE)
    .map((r) => ({ texto: r.titulo, href: null }));

  // ── 2. Lo que necesito de ti ──────────────────────────────────────────────
  // Primero lo que una persona tiene que DECIDIR (nadie más puede), después lo
  // que se le pidió al cliente, de lo más viejo a lo más nuevo.
  const escalados: PedidoRail[] = e.renglones
    .filter((r) => r.estado === "escalado")
    .map((r, i) => ({
      id: `escalado-${i}`,
      titulo: r.titulo,
      detalle: `${r.causa} ${r.accion}`.trim(),
      dias: 0,
      href: null,
    }));

  const pedidos: PedidoRail[] = [...e.solicitudes]
    .sort((a, b) => b.dias - a.dias)
    .map((s) => ({
      id: s.id,
      titulo: `${tituloDeTipo(s.tipo)}${s.periodo ? ` · ${etiquetaPeriodo(s.periodo)}` : ""}`,
      detalle: s.motivo,
      dias: s.dias,
      href: null,
    }));

  // Los grupos de hallazgos por DEBAJO del umbral sí son trabajo concreto.
  const deHallazgos: PedidoRail[] = e.grupos
    .filter((g) => g.count < UMBRAL_REVISION)
    .map((g) => ({
      id: g.href,
      titulo: g.titulo,
      detalle: g.verbo,
      dias: 0,
      href: g.href,
    }));

  const necesito = [...escalados, ...pedidos, ...deHallazgos].slice(0, MAX_NECESITO);

  // ── 3. Revisiones: lo que no cabe como lista ──────────────────────────────
  const revisiones = e.grupos
    .map(comoRevision)
    .filter((r): r is RevisionRail => r !== null)
    .sort((a, b) => b.casos - a.casos)
    .slice(0, MAX_REVISIONES);

  // ── 4. Cómo vamos ─────────────────────────────────────────────────────────
  // Las nueve dimensiones SIEMPRE, en su orden de atención: una que desaparece
  // cuando está bien haría imposible distinguir «mejoró» de «ya no se mide».
  const porClave = new Map(e.dimensiones.map((d) => [d.clave, d]));
  const cambios = new Map(e.deltas.map((d) => [d.clave, d]));
  const vamos: DimensionRail[] = ORDEN_SALUD.filter((c) => porClave.has(c)).map((c) => {
    const d = porClave.get(c)!;
    const delta = cambios.get(c);
    return {
      clave: c,
      titulo: TITULO_SALUD[c],
      estado: d.estado,
      detalle: d.detalle,
      cambio: delta
        ? delta.direccion === "nuevo"
          ? "nuevo hoy"
          : `${delta.de ?? "?"} → ${delta.a}`
        : null,
    };
  });

  return { hice, necesito, revisiones, vamos, ultimaPasada: e.ultimaPasada };
}

/** Cómo se lee la espera de un pedido. PURA. */
export function esperaEnTexto(dias: number): string {
  return TITULO_PEDIDO_VIEJO(dias);
}

/** El renglón del resumen, para la tarjeta de «lo que hice». PURA. */
export function etiquetaRenglon(r: RenglonResumen): string {
  return `${TITULO_ESTADO_RENGLON[r.estado]}: ${r.titulo}`;
}

/** Orden de los renglones del resumen, reexportado para el componente. */
export { ORDEN_ESTADO };
