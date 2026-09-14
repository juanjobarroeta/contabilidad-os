import type { EntradaDecision, RazonDecision } from "@/lib/decisiones";

// ─────────────────────────────────────────────────────────────────────────────
// POR QUÉ LA AUTO-CONCILIACIÓN DECIDIÓ LO QUE DECIDIÓ. PURO.
//
// El motor puntúa y aplica; aquí se traduce ese puntaje a frases que un
// contador pueda verificar de un vistazo. Vive aparte del motor a propósito:
// no toca el scoring, así que narrar no puede cambiar lo que se concilia.
//
// EL ORDEN DE LAS SEÑALES NO ES ARBITRARIO — es el mismo que fijó la lectura
// del voucher de la terminal. La identidad de la contraparte (RFC, nombre,
// CLABE ya vista, folio nombrado en el concepto) identifica a QUIÉN; el importe
// sólo CONFIRMA. Al revés es exactamente como en agosto un traspaso de $30,000
// se casó con la factura de un paciente: cinco facturas de $3,770 en ocho días
// y el importe no distingue una de otra.
//
// Por eso la razón más importante que puede escribir este módulo no es la que
// explica un match, sino `conciliacion.sin-identidad`: se aplicó sin una sola
// señal de quién es la contraparte. Ese renglón es el que hay que poder buscar.
// ─────────────────────────────────────────────────────────────────────────────

/** Qué señales vio el motor en un candidato. Booleanos, no puntos. */
export interface SenalesCandidato {
  /** El RFC de la contraparte del banco es el de la factura. */
  rfcExacto: boolean;
  /** Respaldo histórico: el RFC aparece suelto en el concepto del banco. */
  rfcEnTexto: boolean;
  /** El nombre de la contraparte empata con el de la factura. */
  nombre: boolean;
  /** El concepto del banco nombra la serie/folio de la factura. */
  folio: boolean;
  /** La CLABE ya se le había visto a ese RFC en un movimiento conciliado. */
  clabeConocida: boolean;
  /** El importe empata al centavo (con la tolerancia del lote si aplica). */
  importeExacto: boolean;
  /** El lote es de una tarjeta y la factura declara la contraria. */
  tarjetaContraria: boolean;
  /** Dentro de un lote de terminal: parecido pero no exacto. */
  cercaEnLote: boolean;
}

export interface CandidatoPuntuado {
  invoiceId: string;
  /** Cómo se nombra la factura en pantalla: "A-123 · ACME · $3,770.00". */
  etiqueta: string;
  score: number;
  senales: SenalesCandidato;
}

/**
 * Los umbrales del motor, repetidos aquí SÓLO como valor por omisión para que
 * este módulo siga siendo puro (importarlos del motor arrastraría Prisma a un
 * archivo que existe justamente para poder probarse sin base). El motor pasa
 * los suyos explícitamente, así que si cambian allá, mandan los de allá.
 */
export const UMBRAL_POR_OMISION = 130;
export const BRECHA_POR_OMISION = 20;

export interface DecisionConciliacion {
  /** true si el motor aplicó el match; false si lo dejó sin conciliar. */
  aplicado: boolean;
  /** Candidatos ordenados por score, el mejor primero. Puede venir vacío. */
  candidatos: CandidatoPuntuado[];
  /** El umbral de auto-aplicación vigente (AUTO_MATCH_MIN_SCORE). */
  umbral: number;
  /** La brecha mínima contra el segundo (AUTO_MATCH_AMBIGUITY_GAP). */
  brecha: number;
  /** "CREDITO" | "DEBITO" cuando el movimiento es liquidación de terminal. */
  tarjetaLote: string | null;
}

/** ¿Alguna señal dice QUIÉN es la contraparte? El importe no cuenta: confirma. */
export function tieneIdentidad(s: SenalesCandidato): boolean {
  return s.rfcExacto || s.rfcEnTexto || s.nombre || s.folio || s.clabeConocida;
}

/** Las señales de identidad que sí prendieron, en palabras. PURA. */
export function senalesEnPalabras(s: SenalesCandidato): string[] {
  const out: string[] = [];
  if (s.rfcExacto) out.push("el RFC de la contraparte");
  if (s.rfcEnTexto) out.push("el RFC escrito en el concepto");
  if (s.clabeConocida) out.push("la CLABE ya vista con ese RFC");
  if (s.folio) out.push("el folio nombrado en el concepto");
  if (s.nombre) out.push("el nombre de la contraparte");
  if (s.importeExacto) out.push("el importe exacto");
  return out;
}

/** El tipo de tarjeta del lote, escrito como se lee en español. PURA. */
export function tarjetaEnPalabras(tarjeta: string | null): string | null {
  if (!tarjeta) return null;
  if (tarjeta === "CREDITO") return "crédito";
  if (tarjeta === "DEBITO") return "débito";
  return tarjeta.toLowerCase();
}

/** Por qué ESTE candidato no ganó, en una frase. PURA. */
function motivoDescarte(
  c: CandidatoPuntuado,
  ganador: CandidatoPuntuado,
  tarjetaLote: string | null,
): RazonDecision {
  if (c.senales.tarjetaContraria) {
    const lote = tarjetaEnPalabras(tarjetaLote);
    const contraria = lote === "crédito" ? "débito" : "crédito";
    return {
      regla: "terminal.tarjeta-contraria",
      detalle: lote
        ? `${c.etiqueta}: el lote del banco es de ${lote} y la factura declara ${contraria}. Ese dinero no pudo liquidar esa factura.`
        : `${c.etiqueta}: la forma de pago de la factura contradice la tarjeta del lote. Ese dinero no pudo liquidar esa factura.`,
      score: c.score,
      candidatoId: c.invoiceId,
      candidatoTipo: "Invoice",
    };
  }
  if (c.senales.cercaEnLote) {
    return {
      regla: "terminal.cerca-pero-no-exacto",
      detalle: `${c.etiqueta}: dentro de un lote de terminal el importe se parece pero no empata al centavo, y ahí la diferencia no es una comisión.`,
      score: c.score,
      candidatoId: c.invoiceId,
      candidatoTipo: "Invoice",
    };
  }
  return {
    regla: "conciliacion.puntaje-menor",
    detalle: `${c.etiqueta}: ${c.score} puntos contra ${ganador.score} del elegido.`,
    score: c.score,
    candidatoId: c.invoiceId,
    candidatoTipo: "Invoice",
  };
}

/**
 * Las razones de una decisión de auto-conciliación, ordenadas por relevancia.
 *
 * La primera razón siempre es el veredicto (qué se hizo y con qué regla); luego
 * las señales del ganador; luego los descartes. `acotarRazones` corta por la
 * cola, así que ese orden es el que decide qué sobrevive.
 */
export function razonesDeAutoConciliacion(d: DecisionConciliacion): RazonDecision[] {
  const razones: RazonDecision[] = [];
  const [mejor, segundo] = d.candidatos;

  if (d.candidatos.length === 0) {
    return [
      {
        regla: "conciliacion.sin-candidatos",
        detalle:
          "No hay ninguna factura del mismo sentido en la ventana de fechas con un importe compatible. Sin candidatos no hay nada que decidir.",
      },
    ];
  }

  if (d.aplicado && mejor) {
    razones.push({
      regla: "conciliacion.aplicada",
      detalle: `Se concilió con ${mejor.etiqueta}: ${mejor.score} puntos, sobre el umbral de ${d.umbral}.`,
      score: mejor.score,
      candidatoId: mejor.invoiceId,
      candidatoTipo: "Invoice",
    });

    // La señal que más importa revisar después: se aplicó sin saber de quién era.
    if (!tieneIdentidad(mejor.senales)) {
      razones.push({
        regla: "conciliacion.sin-identidad",
        detalle:
          "Ninguna señal dice QUIÉN es la contraparte (ni RFC, ni nombre, ni CLABE conocida, ni folio en el concepto): se emparejó por importe y fecha. Conviene revisarlo.",
        candidatoId: mejor.invoiceId,
        candidatoTipo: "Invoice",
      });
    } else {
      razones.push({
        regla: "conciliacion.identidad",
        detalle: `Lo identifican ${senalesEnPalabras(mejor.senales).join(", ")}.`,
        candidatoId: mejor.invoiceId,
        candidatoTipo: "Invoice",
      });
    }

    razones.push(
      segundo
        ? {
            regla: "conciliacion.sin-ambiguedad",
            detalle: `El siguiente candidato quedó ${mejor.score - segundo.score} puntos abajo (hacen falta ${d.brecha} para poder distinguirlos).`,
            score: segundo.score,
            candidatoId: segundo.invoiceId,
            candidatoTipo: "Invoice",
          }
        : {
            regla: "conciliacion.candidato-unico",
            detalle: "Era el único candidato en la ventana.",
          },
    );
  } else if (mejor) {
    // Rechazo: primero la regla que lo bloqueó, que es lo que hay que resolver.
    const ambiguo = segundo != null && mejor.score - segundo.score < d.brecha;
    if (mejor.score < d.umbral) {
      razones.push({
        regla: "conciliacion.bajo-umbral",
        detalle: `El mejor candidato (${mejor.etiqueta}) llegó a ${mejor.score} puntos y hacen falta ${d.umbral} para aplicar solo. Falta evidencia, no candidatos.`,
        score: mejor.score,
        candidatoId: mejor.invoiceId,
        candidatoTipo: "Invoice",
      });
    } else if (ambiguo && segundo) {
      razones.push({
        regla: "conciliacion.ambiguo",
        detalle: `Dos candidatos empatados (${mejor.score} y ${segundo.score} puntos, hacen falta ${d.brecha} de diferencia): con esta información no se puede saber cuál es, y adivinar bloquearía al bueno.`,
        score: mejor.score,
        candidatoId: mejor.invoiceId,
        candidatoTipo: "Invoice",
      });
    }
    if (!tieneIdentidad(mejor.senales)) {
      razones.push({
        regla: "conciliacion.sin-identidad",
        detalle: "Ningún candidato trae señal de contraparte: el banco no dice quién pagó.",
      });
    }
  }

  if (d.tarjetaLote) {
    razones.push({
      regla: "terminal.lote",
      detalle: `El movimiento es la liquidación de una terminal de ${tarjetaEnPalabras(d.tarjetaLote)}: es un lote de varias ventas, no un cobro suelto.`,
    });
  }

  // Los descartados, del más cercano al más lejano.
  if (mejor) {
    for (const c of d.candidatos.slice(1)) razones.push(motivoDescarte(c, mejor, d.tarjetaLote));
  }

  return razones;
}

/** La versión de ESTA lógica de conciliación, para poder leer un rastro viejo. */
export const MOTOR_CONCILIACION = "auto-conciliar";
export const VERSION_CONCILIACION = "1";

const dinero = (n: number) =>
  `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Cómo se nombra una factura en el rastro. PURA.
 *
 * Con serie/folio y contraparte, porque un id de base de datos no le dice nada
 * a quien está revisando por qué su movimiento quedó así.
 */
export function etiquetaFactura(inv: {
  id: string;
  serie?: string | null;
  folio?: string | null;
  total: unknown;
  customer?: { razonSocial?: string | null } | null;
  contraparteNombre?: string | null;
}): string {
  const folio = [inv.serie, inv.folio].filter(Boolean).join("-");
  const quien = inv.customer?.razonSocial ?? inv.contraparteNombre ?? null;
  return [folio || `factura ${inv.id.slice(0, 8)}`, quien, dinero(Number(inv.total))]
    .filter(Boolean)
    .join(" · ");
}

/**
 * La decisión completa, lista para escribir. PURA.
 *
 * Un match se escribe SIEMPRE (pasa una vez y el movimiento sale del universo
 * sin conciliar). Un rechazo se marca `repetible`: se vuelve a tomar en cada
 * corrida, así que sólo debe guardarse cuando el razonamiento cambió.
 */
export function decisionDeConciliacion(entrada: {
  companyId: string;
  tx: { id: string; monto: number; fecha: Date; descripcion: string };
  aplicado: boolean;
  candidatos: CandidatoPuntuado[];
  tarjetaLote: string | null;
  umbral?: number;
  brecha?: number;
}): EntradaDecision {
  const d: DecisionConciliacion = {
    aplicado: entrada.aplicado,
    candidatos: entrada.candidatos,
    umbral: entrada.umbral ?? UMBRAL_POR_OMISION,
    brecha: entrada.brecha ?? BRECHA_POR_OMISION,
    tarjetaLote: entrada.tarjetaLote,
  };
  const ganador = entrada.aplicado ? entrada.candidatos[0] : undefined;
  return {
    companyId: entrada.companyId,
    entidad: "BankTransaction",
    entidadId: entrada.tx.id,
    motor: MOTOR_CONCILIACION,
    motorVersion: VERSION_CONCILIACION,
    accion: entrada.aplicado ? "match" : "rechazo",
    resultado: {
      invoiceId: ganador?.invoiceId ?? null,
      score: ganador?.score ?? null,
      candidatos: entrada.candidatos.length,
      monto: entrada.tx.monto,
      identidad: ganador ? tieneIdentidad(ganador.senales) : null,
    },
    razones: razonesDeAutoConciliacion(d),
    refs: entrada.candidatos.map((c) => c.invoiceId),
    repetible: !entrada.aplicado,
  };
}
