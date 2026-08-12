// ─────────────────────────────────────────────────────────────────────────────
// Señales de implausibilidad: lo que el tablero afirma y no puede ser cierto.
//
// El reporte de cobertura detecta AUSENCIA — dinero que ninguna línea reclama.
// No detecta lo contrario, que resultó ser el error más caro de Margom: dinero
// clasificado con toda confianza en la línea equivocada. Un CFDI mal archivado
// está «cubierto» al 100% y el reporte de cobertura lo deja pasar sin decir nada.
//
// Lo que sí lo delata es la aritmética. El caso real:
//
//     Mano de obra (taller)   $317,190,852   costo $4,550,342   margen 98.6%
//                                                              10,286 órdenes
//
// Nada de eso es posible a la vez. Un taller no cobra $30,838 por orden y no
// gana 98.6% sobre mano de obra — un taller que factura $317M trae detrás una
// nómina de técnicos de nueve cifras, no de cuatro. Las dos causas resultaron
// ser reales y distintas: la carrocería/adaptaciones facturada bajo la clave de
// reparación de vehículos (78181500), cuyo costo es material y vive en otra
// línea; y la regex de texto que se lleva cualquier concepto que diga
// «SERVICIO», sea o no del taller.
//
// Reglas de esta casa, y son las que hacen que el reporte sirva:
//
//   • Una señal es una PREGUNTA, nunca una corrección. Aquí no se ajusta ningún
//     número: si el tablero está mal, se arregla el derivador, no el reporte.
//   • Las bandas son heurísticas de la industria y están a la vista, con su
//     razón escrita. Una banda escondida en el código es una opinión disfrazada
//     de hecho; el distribuidor tiene que poder discutirla.
//   • Se dice qué se esperaba y qué se vio. «Margen atípico» no sirve de nada;
//     «margen 98.6%, se espera 40–85% en mano de obra» se puede accionar.
// ─────────────────────────────────────────────────────────────────────────────

const r2 = (n: number) => Math.round(n * 100) / 100;

export type Severidad = "alta" | "media";

export interface Senal {
  linea: string;
  nombre: string;
  tipo: "margen" | "ticket" | "sin_costo" | "muestra_sesgada";
  severidad: Severidad;
  mensaje: string;
  /** Lo observado y lo esperado, para poder discutir la banda y no sólo el veredicto. */
  observado: number;
  esperado: string;
}

export interface LineaEvaluable {
  clave: string;
  nombre: string;
  ingreso: number;
  costo: number;
  /** Margen en porcentaje; null cuando no se pudo calcular. */
  margen: number | null;
  /** Órdenes, unidades o documentos que produjeron el ingreso. */
  documentos: number;
  /**
   * Ingreso que quedó FUERA del costeo (sin costo conocido o no comparable).
   * Es el insumo de la señal más traicionera: cuando la mayoría del ingreso se
   * excluye del margen, el margen que queda se calculó sobre la minoría que sí
   * se pudo costear — y esa minoría no es una muestra representativa, es la que
   * pasó el filtro. Fue exactamente lo que pasó en refacciones: el guardia de
   * unidades de medida sacó a los lubricantes (costo altísimo) y el margen
   * sobreviviente saltó a 98%. El número dejó de mentir hacia abajo y empezó a
   * mentir hacia arriba.
   */
  ingresoSinCosto?: number;
}

/**
 * Bandas plausibles por línea de negocio de una distribuidora mexicana. No son
 * ley: son el rango en que cae un negocio sano, y salirse de él es motivo de
 * pregunta, no de corrección. `ticket` va en pesos por documento.
 */
export const BANDAS: Record<
  string,
  { margen?: [number, number]; ticket?: [number, number]; razon: string }
> = {
  mano_obra: {
    margen: [40, 85],
    ticket: [500, 15_000],
    razon: "La mano de obra se vende contra la nómina del taller: por debajo de 40% el taller pierde dinero, por encima de 85% falta costo o sobra ingreso que no es del taller.",
  },
  refacciones_taller: {
    margen: [10, 45],
    razon: "El margen de refacciones lo fija el distribuidor y rara vez sale del 10–45%.",
  },
  refacciones_mostrador: {
    margen: [10, 45],
    razon: "Igual que en taller: el precio de mostrador sigue la lista del distribuidor.",
  },
  unidades_nuevas: {
    margen: [-2, 15],
    ticket: [80_000, 4_000_000],
    razon: "La unidad nueva se vende casi a costo; el dinero está en el bono, el seguro y el F&I, no en el margen de la unidad.",
  },
  unidades_seminuevas: {
    margen: [0, 25],
    ticket: [40_000, 3_000_000],
    razon: "El seminuevo da más margen que el nuevo, pero un 25%+ sostenido suele ser costo de compra faltante.",
  },
};

/** Umbral de ingreso para molestar con una señal. Debajo de esto no vale la pena. */
const MINIMO_RELEVANTE = 100_000;

/**
 * Evalúa las líneas del estado de resultados contra las bandas. Pura y sin
 * dependencias: recibe números, devuelve preguntas.
 */
export function senales(lineas: LineaEvaluable[]): Senal[] {
  const out: Senal[] = [];

  for (const l of lineas) {
    const banda = BANDAS[l.clave];
    if (!banda) continue;
    if (Math.abs(l.ingreso) < MINIMO_RELEVANTE) continue;

    if (banda.margen && l.margen != null) {
      const [min, max] = banda.margen;
      if (l.margen < min || l.margen > max) {
        out.push({
          linea: l.clave,
          nombre: l.nombre,
          tipo: "margen",
          severidad: l.margen > max + 10 || l.margen < min - 10 ? "alta" : "media",
          mensaje: `Margen de ${r2(l.margen)}% en ${l.nombre.toLowerCase()}. ${banda.razon}`,
          observado: r2(l.margen),
          esperado: `${min}% a ${max}%`,
        });
      }
    }

    if (banda.ticket && l.documentos > 0) {
      const ticket = l.ingreso / l.documentos;
      const [min, max] = banda.ticket;
      if (ticket < min || ticket > max) {
        out.push({
          linea: l.clave,
          nombre: l.nombre,
          tipo: "ticket",
          severidad: ticket > max * 2 || ticket < min / 2 ? "alta" : "media",
          mensaje: `Promedio de ${moneda(ticket)} por documento en ${l.nombre.toLowerCase()} (${l.documentos.toLocaleString("es-MX")} documentos). ${banda.razon}`,
          observado: r2(ticket),
          esperado: `${moneda(min)} a ${moneda(max)}`,
        });
      }
    }

    // Muestra sesgada: el margen se calculó sobre la parte del ingreso que SÍ
    // se pudo costear. Si esa parte es minoría, el margen no describe la línea
    // — describe al subconjunto que pasó el filtro, que es justo el de costo
    // más bajo. Va antes del cheque de «sin costo» porque una línea puede tener
    // costo mayor a cero y aun así estar calculada sobre una muestra inservible.
    const sinCosto = l.ingresoSinCosto ?? 0;
    const universo = Math.abs(l.ingreso) + Math.abs(sinCosto);
    if (universo >= MINIMO_RELEVANTE && Math.abs(sinCosto) > Math.abs(l.ingreso)) {
      const pct = r2((Math.abs(sinCosto) / universo) * 100);
      out.push({
        linea: l.clave,
        nombre: l.nombre,
        tipo: "muestra_sesgada",
        severidad: "alta",
        mensaje: `El ${pct}% del ingreso de ${l.nombre.toLowerCase()} quedó fuera del costeo, así que el margen se calculó sobre la minoría que sí tenía costo — y ésa es la de costo más bajo. El margen de esta línea no es comparable con nada hasta que se pueda costear la mayoría.`,
        observado: pct,
        esperado: "menos del 50% del ingreso sin costear",
      });
    }

    // Ingreso sin base de costo: no es un margen atípico, es una línea a la que
    // le falta el otro lado. Se separa del cheque de margen porque la causa es
    // distinta — casi siempre un derivador que no ha corrido.
    if (l.ingreso >= MINIMO_RELEVANTE && l.costo === 0) {
      out.push({
        linea: l.clave,
        nombre: l.nombre,
        tipo: "sin_costo",
        severidad: "alta",
        mensaje: `${l.nombre} facturó ${moneda(l.ingreso)} sin ningún costo asociado. La utilidad de esta línea no es real hasta que exista su base de costo.`,
        observado: 0,
        esperado: "un costo mayor a cero",
      });
    }
  }

  // Primero lo grave, y dentro de cada grado lo más caro.
  const peso = (s: Senal) => (s.severidad === "alta" ? 1 : 0);
  return out.sort((a, b) => peso(b) - peso(a) || Math.abs(b.observado) - Math.abs(a.observado));
}

function moneda(n: number): string {
  return `$${Math.round(n).toLocaleString("es-MX")}`;
}
