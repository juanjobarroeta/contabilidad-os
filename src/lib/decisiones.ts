import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

// ─────────────────────────────────────────────────────────────────────────────
// RASTRO DE DECISIÓN DE LOS MOTORES — el porqué, escrito.
//
// Los motores deterministas ya dejaban su RESULTADO (este movimiento quedó
// conciliado con esta factura). Lo que se perdía era el razonamiento: qué
// candidatos había, cuál ganó, y con qué regla se descartaron los demás.
//
// Sin eso, un match equivocado es indistinguible de uno bueno hasta que alguien
// reconstruye el mes a mano — que es exactamente lo que pasó en agosto con el
// traspaso de $30,000 casado contra la factura de un paciente.
//
// Este módulo es el equivalente de `audit.ts` para las decisiones de los
// motores, y copia su ergonomía a propósito:
//
//   · Es append-only. Una decisión no se corrige, se escribe otra encima.
//   · Es best-effort y NO se espera (`void`): el rastro nunca debe tumbar ni
//     frenar al motor que lo produce. Si la escritura falla, se registra en el
//     log y la conciliación sigue.
//   · `razones` son LEGIBLES. Un score suelto no explica nada; una regla con su
//     detalle en palabras sí («el lote es de crédito y la factura es de
//     débito»). Esa frase es la que se le enseña al contador en la mesa.
//
// A diferencia de AuditLog, aquí SÍ hay FK a Company con cascada: esto es
// operación, no bitácora de seguridad. El rastro de una empresa dada de baja no
// le sirve a nadie, y la bitácora de seguridad ya cubre la baja en sí.
//
// NUNCA guardar secretos: es metadata de decisiones (ids, montos, reglas).
// ─────────────────────────────────────────────────────────────────────────────

/** Quién tomó la decisión. El default es el motor: lo demás es la excepción. */
export type ActorDecision = "motor" | "usuario" | "agente";

/**
 * Una razón: la regla que aplicó y qué vio, en palabras.
 *
 * `regla` es una clave ESTABLE (se agrupa y se cuenta por ella). `detalle` es
 * para el humano y puede cambiar de redacción sin romper nada.
 */
export interface RazonDecision {
  /** Clave estable: "conciliacion.umbral", "terminal.tarjeta-contraria", … */
  regla: string;
  /** Una frase verificable de un vistazo. Sin jerga de implementación. */
  detalle: string;
  /** Peso de la señal, cuando la regla puntúa. */
  score?: number;
  /** La entidad que la regla consideró: el candidato descartado, el ganador. */
  candidatoId?: string;
  /** Modelo de `candidatoId` ("Invoice", "TaxDeclaration"), si no es obvio. */
  candidatoTipo?: string;
}

export interface EntradaDecision {
  companyId: string;
  /** Modelo afectado: "BankTransaction", "Invoice", "FiscalHallazgo", … */
  entidad: string;
  entidadId: string;
  /** "auto-conciliar" | "terminal" | "rep-aplicar" | "traspasos" | … */
  motor: string;
  /** Versión de la LÓGICA. La fija el motor; sirve para leer un rastro viejo. */
  motorVersion?: string;
  actor?: ActorDecision;
  actorId?: string | null;
  /** "match" | "rechazo" | "ignorar" | "abrir" | "resolver" | … */
  accion: string;
  /** Qué quedó. Libre por motor; sólo metadatos. */
  resultado?: Prisma.InputJsonValue | null;
  razones: RazonDecision[];
  /** Otras entidades consideradas o tocadas (candidatos, patas de un traspaso). */
  refs?: string[];
  /**
   * Marca esta decisión como REPETIBLE: se vuelve a tomar idéntica en cada
   * corrida mientras nada cambie (típicamente un rechazo).
   *
   * Con la marca puesta, `filtrarDecisionesNuevas` calcula su huella y descarta
   * las que ya están escritas. Sin ella, la decisión siempre se escribe.
   */
  repetible?: boolean;
}

/**
 * Cuántas razones se guardan por decisión.
 *
 * Un movimiento puede traer decenas de candidatos y guardarlos todos haría de
 * esta tabla la más pesada del sistema sin que nadie los lea: la mesa enseña la
 * regla que decidió y unos cuantos descartes representativos. Las razones vienen
 * ORDENADAS por relevancia desde el motor, así que cortar por la cola conserva
 * lo que explica la decisión.
 */
export const MAX_RAZONES = 12;

/** Largo máximo del detalle. Una frase, no un párrafo. */
export const MAX_DETALLE = 300;

/** Cuántas entidades se guardan en `refs`. */
export const MAX_REFS = 40;

/**
 * Acota una lista de razones a lo que vale la pena guardar. PURA.
 *
 * Corta por la cola (las razones llegan ordenadas por relevancia) y, si sobran,
 * deja constancia de cuántas se omitieron: «y 14 candidatos más» es información,
 * y sin ella el rastro miente por omisión — parecería que sólo hubo 12.
 */
export function acotarRazones(razones: RazonDecision[], max = MAX_RAZONES): RazonDecision[] {
  const limpias = razones.map((r) => ({
    ...r,
    detalle: r.detalle.length > MAX_DETALLE ? `${r.detalle.slice(0, MAX_DETALLE - 1)}…` : r.detalle,
  }));
  if (limpias.length <= max) return limpias;
  const omitidas = limpias.length - (max - 1);
  return [
    ...limpias.slice(0, max - 1),
    {
      regla: "omitidas",
      detalle: `y ${omitidas} razones más que no se guardaron (se conservan las ${max - 1} más relevantes).`,
    },
  ];
}

/**
 * Huella estable del razonamiento de una decisión. PURA.
 *
 * Resume motor + acción + las razones ya acotadas en una cadena corta. No es
 * criptográfica y no lo necesita: sólo tiene que cambiar cuando el razonamiento
 * cambia, dentro del ámbito de UNA entidad. Es FNV-1a de 32 bits para no
 * arrastrar `node:crypto` a un módulo que también se lee desde pruebas puras.
 */
export function huellaDeRazones(motor: string, accion: string, razones: RazonDecision[]): string {
  const texto = [
    motor,
    accion,
    ...acotarRazones(razones).map((r) => `${r.regla}|${r.detalle}|${r.score ?? ""}|${r.candidatoId ?? ""}`),
  ].join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Normaliza una entrada a la fila que se va a insertar. PURA. */
export function filaDeDecision(e: EntradaDecision): Prisma.DecisionMotorCreateManyInput {
  return {
    companyId: e.companyId,
    entidad: e.entidad,
    entidadId: e.entidadId,
    motor: e.motor,
    motorVersion: e.motorVersion ?? "1",
    actor: e.actor ?? "motor",
    actorId: e.actorId ?? null,
    accion: e.accion,
    resultado: e.resultado ?? undefined,
    razones: acotarRazones(e.razones) as unknown as Prisma.InputJsonValue,
    refs: (e.refs ?? []).slice(0, MAX_REFS),
    huella: e.repetible ? huellaDeRazones(e.motor, e.accion, e.razones) : null,
  };
}

/**
 * Quita las decisiones repetibles que ya están escritas tal cual. PURA.
 *
 * Se separa de la consulta para poder probarla: `escritas` es el conjunto de
 * huellas que ya existen para esas entidades.
 */
export function filtrarPorHuella(
  entradas: EntradaDecision[],
  escritas: ReadonlySet<string>,
): EntradaDecision[] {
  const vistas = new Set<string>();
  return entradas.filter((e) => {
    if (!e.repetible) return true;
    const clave = `${e.entidadId}:${huellaDeRazones(e.motor, e.accion, e.razones)}`;
    // Ya escrita en una corrida anterior, o duplicada dentro de ESTA corrida.
    if (escritas.has(clave) || vistas.has(clave)) return false;
    vistas.add(clave);
    return true;
  });
}

/**
 * Las decisiones que hay que escribir: las nuevas y las repetibles que cambiaron.
 *
 * Una sola consulta por corrida, no una por movimiento: el motor decide en
 * bucle y una lectura por vuelta multiplicaría los viajes a la base por el
 * tamaño de la cartera.
 */
export async function filtrarDecisionesNuevas(entradas: EntradaDecision[]): Promise<EntradaDecision[]> {
  const repetibles = entradas.filter((e) => e.repetible);
  if (repetibles.length === 0) return entradas;

  // Una corrida puede tocar varias empresas o entidades; se agrupa para no
  // consultar ids de una empresa dentro del ámbito de otra.
  const grupos = new Map<string, { companyId: string; entidad: string; ids: Set<string> }>();
  for (const e of repetibles) {
    const k = `${e.companyId}|${e.entidad}`;
    const g = grupos.get(k) ?? { companyId: e.companyId, entidad: e.entidad, ids: new Set<string>() };
    g.ids.add(e.entidadId);
    grupos.set(k, g);
  }

  const escritas = new Set<string>();
  for (const g of grupos.values()) {
    const previas = await prisma.decisionMotor.findMany({
      where: {
        companyId: g.companyId,
        entidad: g.entidad,
        entidadId: { in: [...g.ids] },
        huella: { not: null },
      },
      select: { entidadId: true, huella: true },
    });
    for (const p of previas) escritas.add(`${p.entidadId}:${p.huella}`);
  }
  return filtrarPorHuella(entradas, escritas);
}

/**
 * Escribe UNA decisión. Best-effort y sin esperar, como `registrarBitacora`.
 *
 * El motor no debe enterarse de que esto existe: si la escritura falla, el
 * movimiento igual quedó conciliado y eso es lo que importa.
 */
export function registrarDecision(entrada: EntradaDecision): void {
  try {
    void prisma.decisionMotor
      .create({ data: filaDeDecision(entrada) })
      .catch((e) => console.error("[decisiones] no se pudo registrar", e));
  } catch (e) {
    console.error("[decisiones] no se pudo registrar", e);
  }
}

/**
 * Escribe MUCHAS decisiones de una corrida en un solo INSERT.
 *
 * Los motores deciden en bucle (una vez por movimiento sin conciliar), y una
 * inserción por vuelta multiplica los viajes a la base por el tamaño de la
 * cartera. El idiom de la casa para eso es acumular y cerrar con `createMany`.
 */
export function registrarDecisiones(entradas: EntradaDecision[]): void {
  if (entradas.length === 0) return;
  try {
    void prisma.decisionMotor
      .createMany({ data: entradas.map(filaDeDecision) })
      .catch((e) => console.error("[decisiones] no se pudo registrar el lote", e));
  } catch (e) {
    console.error("[decisiones] no se pudo registrar el lote", e);
  }
}

export interface DecisionRegistrada {
  id: string;
  createdAt: Date;
  motor: string;
  motorVersion: string;
  actor: string;
  actorId: string | null;
  accion: string;
  resultado: unknown;
  razones: RazonDecision[];
  refs: string[];
}

/**
 * La historia de UNA entidad, de lo más reciente a lo más viejo.
 *
 * Es la consulta de la ficha «Historia» de la mesa. El `companyId` no es
 * decorativo: entra en el índice y es el candado de inquilino.
 */
export async function historiaDeEntidad(
  companyId: string,
  entidad: string,
  entidadId: string,
  limite = 50,
): Promise<DecisionRegistrada[]> {
  const filas = await prisma.decisionMotor.findMany({
    where: { companyId, entidad, entidadId },
    orderBy: { createdAt: "desc" },
    take: limite,
    select: {
      id: true,
      createdAt: true,
      motor: true,
      motorVersion: true,
      actor: true,
      actorId: true,
      accion: true,
      resultado: true,
      razones: true,
      refs: true,
    },
  });
  return filas.map((f) => ({ ...f, razones: (f.razones ?? []) as unknown as RazonDecision[] }));
}
