import type { Accion, RefCopiloto } from "./tarjetas";

// ─────────────────────────────────────────────────────────────────────────────
// «SUELTA LA MASCOTA Y TE LO EXPLICO» — la parte pura.
//
// La explicación corta la redacta un modelo barato con el registro cargado;
// las ACCIONES no: son reglas. Un botón que aparece o no según lo que el
// modelo improvise es un botón en el que nadie confía. Aquí se decide qué
// acción le toca a cada elemento, y la acción es siempre un turno (el chat lo
// propone y el usuario confirma) o una navegación — nunca una escritura.
// ─────────────────────────────────────────────────────────────────────────────

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

function texto(ref: RefCopiloto): string {
  return norm([ref.titulo, ...Object.values(ref.datos ?? {})].join(" "));
}

/** La acción que corresponde al elemento (máx. 1); «Preguntar más» la pone el cliente. */
export function accionesPara(ref: RefCopiloto): Accion[] {
  const t = texto(ref);
  const vencida = /vencid|atrasad|omitid/.test(t);

  if ((ref.tipo === "obligacion" || ref.tipo === "obligacion_mes") && /diot/.test(t) && vencida) {
    return [{ label: "Preparar DIOT", kind: "turno", icon: "zap", primary: true, seed: `Prepara la ${ref.titulo}.` }];
  }
  if ((ref.tipo === "obligacion" || ref.tipo === "obligacion_mes") && vencida) {
    return [
      { label: "¿Cómo la regularizo?", kind: "turno", icon: "zap", primary: true, seed: `${ref.titulo} está vencida. ¿Cómo la regularizo y cuánto me cuesta el atraso?` },
    ];
  }
  if (ref.tipo === "hallazgo" && /69-?b|efos|materialidad/.test(t)) {
    return [
      { label: "Armar expediente", kind: "turno", icon: "zap", primary: true, seed: `Ayúdame a armar el expediente de materialidad para: ${ref.titulo}.` },
    ];
  }
  if (ref.tipo === "movimiento" && /sin (cfdi|factura)/.test(t)) {
    return [{ label: "Pedir CFDI", kind: "turno", icon: "mail", primary: true, seed: `Redacta el correo para pedir el CFDI de este movimiento: ${ref.titulo}.` }];
  }
  if (ref.tipo === "movimiento" && /sin conciliar|pendiente/.test(t)) {
    return [{ label: "Buscar su factura", kind: "turno", icon: "zap", primary: true, seed: `Busca la factura que empata con este movimiento: ${ref.titulo}.` }];
  }
  if (ref.tipo === "kpi" && /iva/.test(t)) {
    return [{ label: "Simular con más gastos", kind: "turno", icon: "zap", primary: true, seed: "Simula cuánto bajaría mi IVA con más gastos con CFDI." }];
  }
  if (ref.tipo === "empresa") {
    return [{ label: "¿Qué atiendo aquí?", kind: "turno", icon: "zap", primary: true, seed: `¿Qué es lo más urgente de ${ref.titulo}?` }];
  }
  return [];
}

/** Llave de caché: el mismo registro sin cambios no se vuelve a explicar. */
export function llaveExplicacion(companyId: string, ref: RefCopiloto): string {
  const datos = ref.datos ? JSON.stringify(ref.datos) : "";
  return [companyId, ref.tipo, ref.id, ref.updatedAt ?? datos].join("|");
}

/** El mensaje para el modelo barato. El registro ya viene cargado (o no hay). */
export function promptExplicacion(ref: RefCopiloto, registro: Record<string, unknown> | null, ruta?: string): string {
  const lineas = [
    `Elemento: ${ref.tipo} — «${ref.titulo}»`,
    ruta ? `Pantalla: ${ruta}` : null,
    ref.datos && Object.keys(ref.datos).length
      ? `Lo que se ve en pantalla:\n${Object.entries(ref.datos).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`
      : null,
    registro ? `Registro en la base:\n${JSON.stringify(registro)}` : null,
  ].filter(Boolean);
  return lineas.join("\n\n");
}

export const SISTEMA_EXPLICACION = `Eres el copiloto de Contabilidad OS (contabilidad y fiscal de México). El usuario soltó la mascota sobre un elemento de la pantalla para que se lo expliques.
Responde en español, en MÁXIMO 2 frases cortas y llanas: qué es y qué significa para él (si hay algo que hacer, dilo). Usa sólo los datos que recibes; no inventes cifras, fechas ni artículos. Sin saludos, sin markdown, sin listas.`;

/** Caché en memoria del proceso, con TTL y tope. Suficiente para un endpoint barato. */
export class CacheExplicaciones<T> {
  private mapa = new Map<string, { valor: T; vence: number }>();
  constructor(
    private ttlMs = 60 * 60 * 1000,
    private max = 500,
  ) {}
  get(k: string, ahora = Date.now()): T | undefined {
    const e = this.mapa.get(k);
    if (!e) return undefined;
    if (e.vence <= ahora) {
      this.mapa.delete(k);
      return undefined;
    }
    return e.valor;
  }
  set(k: string, valor: T, ahora = Date.now()): void {
    if (this.mapa.size >= this.max) {
      const primera = this.mapa.keys().next().value;
      if (primera !== undefined) this.mapa.delete(primera);
    }
    this.mapa.set(k, { valor, vence: ahora + this.ttlMs });
  }
}
