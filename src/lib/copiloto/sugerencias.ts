import { DESTINOS } from "@/lib/navigation";

// ─────────────────────────────────────────────────────────────────────────────
// SUGERENCIAS POR PANTALLA — la fila de píldoras encima del compositor.
//
// Primero lo que el copiloto necesita de ti (el `necesito[]` del rail, como
// acciones: es lo único que el despacho no puede resolver solo), luego una o
// dos preguntas propias de la pantalla. Las preguntas no prometen datos: el
// modelo los consulta con sus herramientas cuando la pregunta llega.
// ─────────────────────────────────────────────────────────────────────────────

export interface Sugerencia {
  texto: string;
  /** Lo que se manda como turno al tocarla. */
  seed: string;
  tipo: "accion" | "pregunta";
}

export interface PedidoParaSugerencia {
  id: string;
  titulo: string;
  detalle: string;
}

const PREGUNTAS: Array<{ prefijo: string; items: Array<Omit<Sugerencia, "tipo"> & { tipo?: Sugerencia["tipo"] }> }> = [
  {
    prefijo: "/dashboard",
    items: [
      { texto: "Resumen del mes", seed: "¿Qué tengo pendiente este mes? Ordénalo por urgencia." },
      { texto: "Preparar DIOT", seed: "Prepara la DIOT del último mes.", tipo: "accion" },
      { texto: "Pedir CFDI faltante", seed: "¿Qué gastos pagados no tienen CFDI? Ayúdame a pedirlos.", tipo: "accion" },
    ],
  },
  {
    prefijo: "/impuestos",
    items: [
      { texto: "¿Por qué debo este IVA?", seed: "¿Por qué debo este IVA? Explícame de dónde sale." },
      { texto: "Simular con más gastos", seed: "Simula cuánto bajarían mis impuestos con más gastos con CFDI.", tipo: "accion" },
    ],
  },
  {
    prefijo: "/contabilidad",
    items: [
      { texto: "Generar XML de balanza", seed: "¿La balanza del último mes está lista para generar el XML del SAT?", tipo: "accion" },
      { texto: "¿Qué es el Anexo 24?", seed: "¿Qué es el Anexo 24 y qué me pide?" },
    ],
  },
  {
    prefijo: "/cumplimiento",
    items: [
      { texto: "Preparar DIOT", seed: "Prepara la DIOT del último mes.", tipo: "accion" },
      { texto: "Proveedor 69-B", seed: "¿Tengo proveedores en la lista 69-B? ¿Qué hago con ellos?" },
    ],
  },
  {
    prefijo: "/hallazgos",
    items: [{ texto: "¿Cuál atiendo primero?", seed: "De los hallazgos abiertos, ¿cuál atiendo primero y por qué?" }],
  },
  {
    prefijo: "/despacho",
    items: [{ texto: "¿Cuál atiendo primero?", seed: "De mi cartera, ¿qué empresa atiendo primero y por qué?" }],
  },
  {
    prefijo: "/bancos",
    items: [{ texto: "¿Qué falta conciliar?", seed: "¿Qué movimientos faltan por conciliar y cuáles empato primero?" }],
  },
  {
    prefijo: "/facturas",
    items: [{ texto: "Facturas canceladas", seed: "¿Hay facturas canceladas que afecten lo ya declarado?" }],
  },
  {
    prefijo: "/nomina",
    items: [{ texto: "¿Cómo va la nómina?", seed: "¿Cómo va la nómina de este periodo? ¿Falta timbrar algo?" }],
  },
];

const POR_DEFECTO: Sugerencia[] = [
  { texto: "Resumen del mes", seed: "¿Qué tengo pendiente este mes? Ordénalo por urgencia.", tipo: "pregunta" },
];

const coincide = (ruta: string, prefijo: string) => ruta === prefijo || ruta.startsWith(`${prefijo}/`);

/** Las sugerencias para una ruta: pedidos del rail primero, luego preguntas. */
export function sugerenciasPara(pathname: string, necesito: PedidoParaSugerencia[] = [], max = 4): Sugerencia[] {
  const ruta = pathname.split("?")[0] || "/";
  const out: Sugerencia[] = necesito.slice(0, 2).map((p) => ({
    texto: p.titulo.length > 34 ? `${p.titulo.slice(0, 33)}…` : p.titulo,
    seed: `Ayúdame con esto: ${p.titulo}. ${p.detalle}`.trim(),
    tipo: "accion",
  }));
  const propias = PREGUNTAS.find((g) => coincide(ruta, g.prefijo))?.items ?? [];
  for (const s of propias.length ? propias : POR_DEFECTO) {
    if (out.length >= max) break;
    if (out.some((o) => o.texto === s.texto)) continue;
    out.push({ texto: s.texto, seed: s.seed, tipo: s.tipo ?? "pregunta" });
  }
  return out;
}

/** El título legible de una ruta, por el destino más específico que la contiene. */
export function tituloDeRuta(pathname: string): string {
  const ruta = pathname.split("?")[0] || "/";
  let mejor: { href: string; label: string } | null = null;
  for (const d of DESTINOS) {
    const href = d.href.split("?")[0];
    if (!coincide(ruta, href)) continue;
    if (!mejor || href.length > mejor.href.length) mejor = { href, label: d.label };
  }
  return mejor?.label ?? "Contabilidad OS";
}
