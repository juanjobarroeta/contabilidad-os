import type Anthropic from "@anthropic-ai/sdk";

// ─────────────────────────────────────────────────────────────────────────────
// TARJETAS Y ACCIONES DEL COPILOTO — el contrato entre el modelo y el chat.
//
// El texto sigue siendo la respuesta; una tarjeta es lo que se lee de un
// vistazo (una cifra, una obligación, la lista de lo urgente) y una acción es
// el siguiente paso a un tap. El modelo las pide con dos herramientas de
// PRESENTACIÓN que no tocan la base: el servidor las sanea, las manda por SSE
// (`{type:"card", card}`) y las guarda en el mensaje.
//
// Puro y sin Node: lo importa el cliente (para pintar) y el servidor (para
// sanear). Todo lo que viene del modelo pasa por `sanearTarjeta` antes de
// llegar a la pantalla: nada de rutas externas, nada de textos sin tope.
// ─────────────────────────────────────────────────────────────────────────────

export type Tono = "red" | "amber" | "jade" | "slate";
export type Fila = [string, string];
export type IconoAccion = "zap" | "arrow" | "mail" | "file" | "check";

export interface Accion {
  label: string;
  kind: "navegar" | "turno";
  /** navegar: ruta interna (empieza con «/»). */
  href?: string;
  /** turno: lo que se manda como siguiente mensaje del usuario. */
  seed?: string;
  icon?: IconoAccion;
  primary?: boolean;
}

export interface ItemLista {
  titulo: string;
  sub?: string;
  tono: Tono;
  estatus: string;
}

export type Card =
  | { type: "obligacion"; titulo: string; tono: Tono; estatus: string; filas: Fila[] }
  | { type: "cifra"; etiqueta: string; valor: string; filas?: Fila[]; nota?: string }
  | { type: "lista"; items: ItemLista[] }
  | { type: "pasos"; items: string[] }
  | { type: "hecho"; titulo: string; filas: Fila[] }
  | { type: "borrador"; para: string; asunto: string; cuerpo: string }
  | { type: "retomar"; cuando: string; titulo: string; nota: string }
  /** «Guardado en memoria: …» — lo emite el servidor, no el modelo. */
  | { type: "memoria"; texto: string }
  | { type: "acciones"; acciones: Accion[] };

/** El elemento de la pantalla sobre el que se soltó la mascota. */
export interface RefCopiloto {
  tipo: TipoRef;
  id: string;
  titulo: string;
  /** Datos visibles del elemento (estatus, monto, mes…). Pocos y cortos. */
  datos?: Record<string, string>;
  /** Fecha de la última modificación, si la pantalla la conoce (llave de caché). */
  updatedAt?: string;
  /** Ruta desde la que se soltó (se pinta en la píldora). */
  ruta?: string;
}

export const TIPOS_REF = [
  "obligacion",
  "obligacion_mes",
  "hallazgo",
  "factura",
  "movimiento",
  "cuenta",
  "kpi",
  "empresa",
] as const;
export type TipoRef = (typeof TIPOS_REF)[number];

const TONOS: readonly Tono[] = ["red", "amber", "jade", "slate"];
const ICONOS: readonly IconoAccion[] = ["zap", "arrow", "mail", "file", "check"];

export const MAX_FILAS = 8;
export const MAX_ITEMS = 8;
export const MAX_ACCIONES = 3;
export const MAX_DATOS_REF = 8;

const txt = (v: unknown, max: number): string => {
  if (typeof v !== "string" && typeof v !== "number") return "";
  const s = String(v).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const multilinea = (v: unknown, max: number): string => {
  if (typeof v !== "string") return "";
  const s = v.trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const tono = (v: unknown): Tono => (TONOS.includes(v as Tono) ? (v as Tono) : "slate");

/** Sólo rutas internas de la app: nada de `//host`, esquemas ni saltos de línea. */
export function esRutaInterna(v: unknown): v is string {
  return typeof v === "string" && /^\/(?!\/)[^\s\\]*$/.test(v) && v.length <= 200;
}

function filas(v: unknown): Fila[] {
  if (!Array.isArray(v)) return [];
  const out: Fila[] = [];
  for (const f of v) {
    // Acepta [k, v] y {k, v} (lo segundo es lo que pide el esquema de la tool).
    const k = Array.isArray(f) ? f[0] : (f as { k?: unknown })?.k;
    const val = Array.isArray(f) ? f[1] : (f as { v?: unknown })?.v;
    const a = txt(k, 60);
    const b = txt(val, 80);
    if (a && b) out.push([a, b]);
    if (out.length >= MAX_FILAS) break;
  }
  return out;
}

export function sanearAccion(v: unknown): Accion | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const label = txt(o.label, 40);
  if (!label) return null;
  const icon = ICONOS.includes(o.icon as IconoAccion) ? (o.icon as IconoAccion) : undefined;
  const primary = o.primary === true ? true : undefined;
  if (o.kind === "navegar") {
    if (!esRutaInterna(o.href)) return null;
    return { label, kind: "navegar", href: o.href, icon: icon ?? "arrow", primary };
  }
  if (o.kind === "turno") {
    const seed = multilinea(o.seed, 400);
    if (!seed) return null;
    return { label, kind: "turno", seed, icon, primary };
  }
  return null;
}

export function sanearAcciones(v: unknown): Accion[] {
  if (!Array.isArray(v)) return [];
  return v.map(sanearAccion).filter((a): a is Accion => a !== null).slice(0, MAX_ACCIONES);
}

/**
 * Sanea una tarjeta (venga del modelo o de la base). Devuelve null si no hay
 * con qué pintarla: una tarjeta vacía es peor que ninguna.
 */
export function sanearTarjeta(v: unknown): Card | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const tipo = o.type ?? o.tipo;
  switch (tipo) {
    case "obligacion": {
      const titulo = txt(o.titulo, 80);
      if (!titulo) return null;
      return { type: "obligacion", titulo, tono: tono(o.tono), estatus: txt(o.estatus, 30) || "—", filas: filas(o.filas) };
    }
    case "cifra": {
      const etiqueta = txt(o.etiqueta, 60);
      const valor = txt(o.valor, 30);
      if (!etiqueta || !valor) return null;
      const f = filas(o.filas);
      const nota = txt(o.nota, 240);
      return { type: "cifra", etiqueta, valor, ...(f.length ? { filas: f } : {}), ...(nota ? { nota } : {}) };
    }
    case "lista": {
      const items: ItemLista[] = [];
      for (const it of Array.isArray(o.items) ? o.items : []) {
        const r = (it ?? {}) as Record<string, unknown>;
        const titulo = txt(r.titulo, 80);
        if (!titulo) continue;
        const sub = txt(r.sub, 100);
        items.push({ titulo, ...(sub ? { sub } : {}), tono: tono(r.tono), estatus: txt(r.estatus, 24) || "—" });
        if (items.length >= MAX_ITEMS) break;
      }
      return items.length ? { type: "lista", items } : null;
    }
    case "pasos": {
      const fuente = Array.isArray(o.pasos) ? o.pasos : o.items;
      const items = (Array.isArray(fuente) ? fuente : []).map((s) => txt(s, 80)).filter(Boolean).slice(0, MAX_ITEMS);
      return items.length ? { type: "pasos", items } : null;
    }
    case "hecho": {
      const titulo = txt(o.titulo, 80);
      if (!titulo) return null;
      return { type: "hecho", titulo, filas: filas(o.filas) };
    }
    case "borrador": {
      const asunto = txt(o.asunto, 120);
      const cuerpo = multilinea(o.cuerpo, 2000);
      if (!asunto || !cuerpo) return null;
      return { type: "borrador", para: txt(o.para, 120), asunto, cuerpo };
    }
    case "retomar": {
      const titulo = txt(o.titulo, 80);
      if (!titulo) return null;
      return { type: "retomar", cuando: txt(o.cuando, 30), titulo, nota: txt(o.nota, 240) };
    }
    case "memoria": {
      const texto = txt(o.texto, 200);
      return texto ? { type: "memoria", texto } : null;
    }
    case "acciones": {
      const acciones = sanearAcciones(o.acciones);
      return acciones.length ? { type: "acciones", acciones } : null;
    }
    default:
      return null;
  }
}

export function sanearTarjetas(v: unknown): Card[] {
  if (!Array.isArray(v)) return [];
  return v.map(sanearTarjeta).filter((c): c is Card => c !== null);
}

/** Sanea la referencia que manda el cliente (data-copiloto). */
export function sanearRef(v: unknown): RefCopiloto | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!TIPOS_REF.includes(o.tipo as TipoRef)) return null;
  const id = txt(o.id, 80);
  const titulo = txt(o.titulo, 100);
  if (!id || !titulo) return null;
  let datos: Record<string, string> | undefined;
  if (o.datos && typeof o.datos === "object" && !Array.isArray(o.datos)) {
    datos = {};
    for (const [k, val] of Object.entries(o.datos as Record<string, unknown>).slice(0, MAX_DATOS_REF)) {
      const kk = txt(k, 40);
      const vv = txt(val, 80);
      if (kk && vv) datos[kk] = vv;
    }
    if (!Object.keys(datos).length) datos = undefined;
  }
  const updatedAt = txt(o.updatedAt, 40) || undefined;
  const ruta = esRutaInterna(o.ruta) ? o.ruta : undefined;
  return { tipo: o.tipo as TipoRef, id, titulo, ...(datos ? { datos } : {}), ...(updatedAt ? { updatedAt } : {}), ...(ruta ? { ruta } : {}) };
}

// ── Herramientas de presentación (sólo el chat de la app) ───────────────────

export const TOOL_TARJETA = "mostrar_tarjeta";
export const TOOL_ACCIONES = "ofrecer_acciones";
export const NOMBRES_PRESENTACION = new Set([TOOL_TARJETA, TOOL_ACCIONES]);

const FILAS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: { k: { type: "string" }, v: { type: "string" } },
    required: ["k", "v"],
  },
  description: "Renglones etiqueta → valor (máx. 8). Valores ya formateados: «$26,667», «14», «17 oct».",
} as const;

export const toolsPresentacion: Anthropic.Tool[] = [
  {
    name: TOOL_TARJETA,
    description:
      "Pinta una TARJETA debajo de tu respuesta en el chat de la app. No consulta ni cambia datos: úsala DESPUÉS de tener las cifras reales de otras herramientas, nunca con números inventados. Úsala con moderación (una o dos por respuesta) cuando se lea mejor que en prosa: «cifra» para un importe con su desglose (IVA a cargo, ISR del mes); «obligacion» para una obligación o un hallazgo con su estatus; «lista» para lo urgente ordenado (máx. 8); «pasos» ANTES de un trabajo de varias herramientas, con los pasos que vas a seguir (el chat los marca conforme avanzas); «hecho» cuando terminaste algo, con lo que quedó; «borrador» para un correo que el usuario puede copiar y enviar. Tu texto sigue siendo la respuesta: la tarjeta no repite lo que ya dijiste.",
    input_schema: {
      type: "object",
      properties: {
        tipo: { type: "string", enum: ["obligacion", "cifra", "lista", "pasos", "hecho", "borrador"] },
        titulo: { type: "string", description: "obligacion / hecho: el título (p. ej. «DIOT · septiembre»)." },
        tono: { type: "string", enum: ["red", "amber", "jade", "slate"], description: "obligacion: red vencida o riesgo, amber por vencer, jade al día, slate neutro." },
        estatus: { type: "string", description: "obligacion: la etiqueta del chip («Vencida», «Lista 69-B», «5 días»)." },
        etiqueta: { type: "string", description: "cifra: qué es el importe («IVA a cargo · septiembre»)." },
        valor: { type: "string", description: "cifra: el importe ya formateado («$26,667»)." },
        nota: { type: "string", description: "cifra: una frase de contexto, opcional." },
        filas: FILAS_SCHEMA,
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              titulo: { type: "string" },
              sub: { type: "string" },
              tono: { type: "string", enum: ["red", "amber", "jade", "slate"] },
              estatus: { type: "string" },
            },
            required: ["titulo", "tono", "estatus"],
          },
          description: "lista: los renglones.",
        },
        pasos: { type: "array", items: { type: "string" }, description: "pasos: 2–5 pasos cortos, en el orden en que los harás." },
        para: { type: "string", description: "borrador: destinatario (correo o nombre)." },
        asunto: { type: "string", description: "borrador: asunto." },
        cuerpo: { type: "string", description: "borrador: el texto del correo." },
      },
      required: ["tipo"],
    },
  },
  {
    name: TOOL_ACCIONES,
    description:
      "Ofrece hasta 3 BOTONES con el siguiente paso, debajo de tu respuesta. «navegar» lleva a una pantalla de la app (href interno: /cumplimiento, /impuestos, /bancos…). «turno» manda `seed` como el siguiente mensaje del usuario (p. ej. «Prepara la DIOT de septiembre»): si ese paso cambia datos, en ese turno usarás una herramienta proponer_* y el usuario confirma con su tap — un botón NUNCA ejecuta nada por sí mismo. Marca primary sólo en el más probable. Úsala al final de la respuesta y sólo si hay un siguiente paso claro.",
    input_schema: {
      type: "object",
      properties: {
        acciones: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Texto del botón, 1–4 palabras." },
              kind: { type: "string", enum: ["navegar", "turno"] },
              href: { type: "string" },
              seed: { type: "string" },
              icon: { type: "string", enum: ["zap", "arrow", "mail", "file", "check"] },
              primary: { type: "boolean" },
            },
            required: ["label", "kind"],
          },
        },
      },
      required: ["acciones"],
    },
  },
];

/**
 * Ejecuta una herramienta de presentación: sanea y devuelve la tarjeta a
 * emitir junto con el resultado que ve el modelo.
 */
export function ejecutarPresentacion(
  nombre: string,
  input: Record<string, unknown>,
): { card: Card | null; resultado: string } {
  const card =
    nombre === TOOL_ACCIONES
      ? sanearTarjeta({ type: "acciones", acciones: input.acciones })
      : sanearTarjeta({ ...input, type: input.tipo });
  if (!card) {
    return {
      card: null,
      resultado: JSON.stringify({ error: "La tarjeta no se mostró: faltan campos o son inválidos. Sigue con texto." }),
    };
  }
  return { card, resultado: JSON.stringify({ ok: true, mostrada: card.type }) };
}
