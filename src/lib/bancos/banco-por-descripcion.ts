// ─────────────────────────────────────────────────────────────────────────────
// ¿De qué banco es este lote? — inferido por cómo escribe sus descripciones.
//
// Los lotes anteriores a 2026-09 se guardaron con `ImportBatch.banco` en null
// (la ruta CSV/pegado tiraba el banco que detectaba el parser). Sin eso no hay
// forma de marcar «archivo de Banorte en cuenta Scotiabank» en un lote viejo.
// Pero cada banco arma sus descripciones con etiquetas propias
// (spei-descripcion.ts documenta dos): con un puñado de renglones basta para
// reconocer al autor.
//
// REGLA DE LA CASA: ante la duda, null. Sólo se emite un banco cuando una
// fracción clara de los renglones lleva SU firma y ningún otro banco compite.
// Un banco mal inferido pinta de rojo un lote legítimo, que es peor que no
// pintar nada.
//
// PURO.
// ─────────────────────────────────────────────────────────────────────────────

interface Firma {
  banco: string;
  /** Un renglón "es" de este banco si cumple CUALQUIERA de estas expresiones. */
  patrones: RegExp[];
}

const FIRMAS: Firma[] = [
  {
    banco: "Banorte",
    patrones: [
      // "SPEI RECIBIDO, BCO:0014 SANTANDER, DEL CLIENTE …, CONCEPTO: …"
      /\bBCO:\s*\d{3,4}\b/,
      // "=REFERENCIA  CTA/CLABE: 0121…, BEM SPEI, …" (SPEI enviado)
      /^=?\s*REFERENCIA\s+CTA\/CLABE/i,
      /\bBEM SPEI\b/,
      // "(BANCA POR INTERNET), CARGO POR COMISION CEP"
      /^\(BANCA POR INTERNET\)/i,
    ],
  },
  {
    banco: "Banco del Bajío",
    patrones: [
      // "SPEI Enviado: | Institucion Receptora: … | Beneficiario: … |
      //  Cuenta Beneficiario: … | Clave de Rastreo: …"
      /\|\s*Instituci[oó]n (Receptora|Emisora):/i,
      /\|\s*Cuenta (Beneficiario|Ordenante):/i,
      /\|\s*Clave de Rastreo:/i,
    ],
  },
];

/** Fracción mínima de renglones con firma para afirmar un banco. */
const FRACCION_MINIMA = 0.3;

/**
 * Banco que escribió estas descripciones, o null si no se reconoce con
 * claridad. Umbral: al menos 30 % de los renglones (y nunca menos de dos,
 * salvo que sólo haya uno) llevan la firma de UN banco, y ningún otro banco
 * alcanza el umbral.
 */
export function inferirBancoPorDescripciones(descripciones: readonly string[]): string | null {
  const filas = descripciones.map((d) => (d ?? "").trim()).filter((d) => d.length > 0);
  if (filas.length === 0) return null;

  const minimo = Math.max(filas.length === 1 ? 1 : 2, Math.ceil(filas.length * FRACCION_MINIMA));
  const candidatos = FIRMAS.map((f) => ({
    banco: f.banco,
    n: filas.filter((d) => f.patrones.some((re) => re.test(d))).length,
  })).filter((c) => c.n >= minimo);

  if (candidatos.length !== 1) return null;
  return candidatos[0].banco;
}
