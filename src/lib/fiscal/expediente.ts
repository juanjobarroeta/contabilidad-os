// ─────────────────────────────────────────────────────────────────────────────
// EL EXPEDIENTE: todo lo presentado al SAT por una empresa, en una sola lista.
//
// Lo que se presenta vive en tres sitios distintos —TaxDeclaration (anual, IVA,
// ISR, IEPS, retenciones, DIOT), CeBalanzaMes (las balanzas que el SAT nos
// devuelve) y CoeEnvio (los envíos de CE hechos desde aquí)— y hasta ahora
// había que saber en cuál buscar. Esto los normaliza a un renglón por
// documento, con su periodo, su fecha y de dónde salió.
//
// PURA: los insumos ya vienen consultados. La procedencia importa tanto como
// el hecho — no es lo mismo un acuse del SAT guardado que una fila que alguien
// capturó a mano, y la pantalla tiene que poder decirlo.
// ─────────────────────────────────────────────────────────────────────────────

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

export const ETIQUETA_TIPO: Record<string, string> = {
  DECLARACION_ANUAL: "Declaración anual",
  IVA_MENSUAL: "IVA",
  ISR_PROVISIONAL: "ISR provisional",
  IEPS_MENSUAL: "IEPS",
  RETENCIONES_ISR: "Retenciones de ISR",
  IMSS_MENSUAL: "IMSS",
  IMSS_BIMESTRAL: "IMSS bimestral",
  DIOT: "DIOT",
  CERO: "Declaración en ceros",
  CE_BALANZA: "Contabilidad electrónica (balanza)",
  CE_CATALOGO: "Contabilidad electrónica (catálogo)",
};

export interface FilaExpediente {
  clave: string;
  tipo: string;
  etiquetaTipo: string;
  /** "2025" (anual) o "2026-08" (mensual). */
  periodo: string;
  /** "agosto 2026" · "ejercicio 2025". */
  periodoLegible: string;
  /** Año al que pertenece, para agrupar. */
  anio: number;
  fecha: string | null;
  /** De dónde sabemos que se presentó. */
  origen: string;
  /** Ruta para ver/descargar el documento, si lo tenemos. */
  descarga: string | null;
  /** Línea de captura, cuando la fila la trae. */
  lineaCaptura: string | null;
}

export interface DeclaracionExpediente {
  id: string;
  tipo: string;
  periodo: string;
  status: string;
  fechaPresentacion: string | null;
  isHistorical: boolean;
  tienePdf: boolean;
  acuseUrl: string | null;
  lineaCaptura: string | null;
}

export interface EntradasExpediente {
  declaraciones: DeclaracionExpediente[];
  balanzas: { anio: number; mes: number; cuentas: number }[];
  envios: { tipoDoc: string; periodo: string; tipoEnvio: string; fecha: string }[];
}

const PRESENTADA = new Set(["FILED", "PAID"]);

export function periodoLegible(periodo: string): string {
  const [y, m] = periodo.split("-");
  const anio = Number(y);
  if (!m) return `ejercicio ${anio}`;
  const mes = Number(m);
  // "YYYY-13" es el cierre anual de la contabilidad electrónica.
  if (mes === 13) return `cierre del ejercicio ${anio}`;
  return mes >= 1 && mes <= 12 ? `${MESES[mes - 1]} ${anio}` : periodo;
}

function anioDe(periodo: string): number {
  return Number(periodo.slice(0, 4)) || 0;
}

/** Normaliza las tres fuentes a renglones del expediente, lo más nuevo arriba. */
export function filasExpediente(e: EntradasExpediente): FilaExpediente[] {
  const filas: FilaExpediente[] = [];

  for (const d of e.declaraciones) {
    if (!PRESENTADA.has(d.status)) continue;
    filas.push({
      clave: `decl:${d.id}`,
      tipo: d.tipo,
      etiquetaTipo: ETIQUETA_TIPO[d.tipo] ?? d.tipo,
      periodo: d.periodo,
      periodoLegible: periodoLegible(d.periodo),
      anio: anioDe(d.periodo),
      fecha: d.fechaPresentacion,
      origen: d.tienePdf
        ? "acuse del SAT guardado"
        : d.acuseUrl
          ? "acuse en línea"
          : d.isHistorical
            ? "capturada a mano"
            : "presentada desde la app",
      // Sólo se ofrece descarga cuando de verdad hay documento que abrir:
      // un botón que lleva a un PDF inexistente es peor que no tenerlo.
      descarga: d.tienePdf ? `/declaraciones/acuse/${d.id}` : d.acuseUrl,
      lineaCaptura: d.lineaCaptura,
    });
  }

  for (const b of e.balanzas) {
    const periodo = `${b.anio}-${String(b.mes).padStart(2, "0")}`;
    filas.push({
      clave: `ce:${periodo}`,
      tipo: "CE_BALANZA",
      etiquetaTipo: ETIQUETA_TIPO.CE_BALANZA,
      periodo,
      periodoLegible: periodoLegible(periodo),
      anio: b.anio,
      fecha: null,
      origen: `balanza que el SAT tiene registrada · ${b.cuentas} cuenta${b.cuentas === 1 ? "" : "s"}`,
      descarga: `/contabilidad/presentado?y=${b.anio}&m=${b.mes}`,
      lineaCaptura: null,
    });
  }

  // Envíos propios de CE: sólo los que el SAT todavía no nos devuelve como
  // balanza (si ya viene del SAT, esa fila es la buena — es la confirmación).
  const conBalanza = new Set(e.balanzas.map((b) => `${b.anio}-${String(b.mes).padStart(2, "0")}`));
  for (const s of e.envios) {
    if (s.tipoDoc === "BALANZA" && conBalanza.has(s.periodo)) continue;
    const tipo = s.tipoDoc === "CATALOGO" ? "CE_CATALOGO" : "CE_BALANZA";
    filas.push({
      clave: `envio:${s.tipoDoc}:${s.periodo}`,
      tipo,
      etiquetaTipo: ETIQUETA_TIPO[tipo],
      periodo: s.periodo,
      periodoLegible: periodoLegible(s.periodo),
      anio: anioDe(s.periodo),
      fecha: s.fecha,
      origen: `enviada desde aquí (${s.tipoEnvio === "C" ? "complementaria" : "normal"})`,
      descarga: null,
      lineaCaptura: null,
    });
  }

  return filas.sort((a, b) => (a.periodo === b.periodo ? a.etiquetaTipo.localeCompare(b.etiquetaTipo) : b.periodo.localeCompare(a.periodo)));
}
