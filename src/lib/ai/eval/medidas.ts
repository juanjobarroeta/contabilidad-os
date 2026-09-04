// ─────────────────────────────────────────────────────────────────────────────
// Medidas PURAS del eval del copiloto: tipos, normalización de citas, extracción
// de citas de un texto y el resumen. Sin Prisma, sin Anthropic, sin next-auth —
// para que se prueben con vitest sin levantar nada.
// ─────────────────────────────────────────────────────────────────────────────

export interface ResultadoPregunta {
  id: string;
  tema: string;
  pregunta: string;
  fundamentos: string[];
  recuperacion: {
    hit: boolean;
    citas: string[];
    /** Qué modo/rerank corrió de verdad (prueba en el log de que la palanca se activó). */
    busqueda?: { modo: string; rerank: boolean; candidatos: number; referenciasExactas: string[] };
  };
  respuesta?: {
    texto: string;
    citasEnTexto: string[];
    /** Citas que el texto afirma y la KB NO devolvió en este turno. */
    citasFueraDeKB: string[];
    citaPresente: boolean;
    /** Sólo en preguntas con valoresEsperados: ¿la respuesta trae todos los números esperados? */
    valorCorrecto?: boolean;
    rondas: number;
    /** Fase 3: qué hizo el pase de verificación con esta respuesta. */
    verificacion?: {
      verificada: boolean;
      corregida: boolean;
      problemas: { afirmacion: string; cita: string; motivo: string }[];
      citasNoVerificables: string[];
      ms: number;
    };
    ms: number;
  };
  juez?: {
    fundamentoCorrecto: boolean;
    noInventa: boolean;
    respondeLoPreguntado: boolean;
    comentario: string;
  };
  error?: string;
}

// ── Citas: normalizar y extraer ───────────────────────────────────────────────

/** «Art. 17-H Bis CFF» / «ART 17-H BIS CFF» / «artículo 17-H bis del CFF» → «ART. 17-H BIS CFF». */
export function normalizarCita(c: string): string {
  return (
    c
      .toUpperCase()
      .replace(/ART[ÍI]CULO/g, "ART.")
      .replace(/\bART\b(?!\.)/g, "ART.")
      .replace(/\s+(?:DE\s+LA|DEL)\s+/g, " ")
      // LIVA, CFF y LIEPS numeran con ordinal («Artículo 5o.», «2o.-A») y así
      // lo cita la KB: «Art. 5o LIVA». El contador escribe «Art. 5 LIVA». Sin
      // esto, c16/j31 contaban como fallo teniendo el artículo correcto.
      .replace(/\b(\d+)O\.?(?=[\s-]|$)/g, "$1")
      // El agente escribe «Art. 27-III LISR» (artículo 27, fracción III) y la
      // KB cita «Art. 27 LISR»: la fracción no es otro artículo. Sólo se
      // quitan romanos de 2+ letras o V/X sueltos — «17-L CFF», «18-I LIVA» y
      // «113-E LISR» son artículos reales y se conservan.
      .replace(/\b(\d+(?:-[A-Z]+)?)-(?:[IVXL]{2,}|V|X)(?=\s|$)/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
  );
}

const RE_ART = /\bart(?:[íi]culo|\.)?\s*(\d+(?:-[A-Z]+)?(?:\s+bis)?)\s*(?:,?\s*(?:fracci[óo]n\s+[IVXL]+\s*)?)?(?:de\s+la\s+|del\s+)?(RLISR|RLIVA|RCFF|CCOM|LGSM|RLFPIORPI|LFPIORPI|LFDC|RACERF|RIPAEDI|LHPUE|CFPUE|CFCDMX|LISR|LIVA|CFF|LIEPS|LSS|LINFONAVIT|LFT)\b/gi;
const RE_REGLA = /\bregla\s+(\d+(?:\.\d+){2,3})\b(?:\s*(?:de\s+la\s+)?(RMF(?:-\d{4})?))?/gi;

/** Citas a leyes/reglas que la RESPUESTA afirma (para detectar inventadas). */
export function extraerCitas(texto: string): string[] {
  const out = new Set<string>();
  for (const m of texto.matchAll(RE_ART)) out.add(normalizarCita(`Art. ${m[1]} ${m[2]}`));
  for (const m of texto.matchAll(RE_REGLA)) out.add(normalizarCita(`Regla ${m[1]} ${m[2] ?? "RMF"}`));
  return [...out];
}

/** Una regla se compara sin el sufijo de año (RMF vs RMF-2026). */
export function claveCita(c: string): string {
  return normalizarCita(c).replace(/\bRMF-\d{4}\b/, "RMF");
}

/**
 * ¿La respuesta menciona TODOS los números esperados? Tolera formato: «$2,050.00»,
 * «2 050», «2,050», «2.07 %», «2.07%». Un entero esperado también acepta la
 * forma con «.00». Puro.
 */
export function valoresPresentes(texto: string, esperados: number[]): boolean {
  const plano = texto.replace(/[\u00a0\s]+/g, " ");
  const numeros = new Set<string>();
  for (const m of plano.matchAll(/\d[\d,. ]*\d|\d/g)) {
    const limpio = m[0].replace(/[ ,]/g, "");
    const n = Number(limpio);
    if (Number.isFinite(n)) numeros.add(n.toFixed(2));
    // «2,050» pudo venir como «2.050» (separador europeo) — sólo si tiene 3 decimales exactos.
    if (/^\d{1,3}(\.\d{3})+$/.test(limpio)) numeros.add(Number(limpio.replace(/\./g, "")).toFixed(2));
  }
  return esperados.every((e) => numeros.has(e.toFixed(2)));
}

export function algunaCoincide(esperadas: string[], obtenidas: string[]): boolean {
  const set = new Set(obtenidas.map(claveCita));
  return esperadas.some((e) => set.has(claveCita(e)));
}

// ── Resumen ──────────────────────────────────────────────────────────────────

export interface ResumenEval {
  n: number;
  conError: number;
  recuperacionHit: number;
  citaPresente: number | null;
  citasFueraDeKB: number | null;
  fundamentoCorrecto: number | null;
  noInventa: number | null;
  respondeLoPreguntado: number | null;
  /** Sobre las preguntas con valoresEsperados que tuvieron respuesta; null si no hubo. */
  valorCorrecto: number | null;
}

/** Porcentajes (0–100) sobre las preguntas SIN error; null si esa capa no corrió. */
export function resumir(rs: ResultadoPregunta[]): ResumenEval {
  const ok = rs.filter((r) => !r.error);
  const pct = (xs: ResultadoPregunta[], f: (r: ResultadoPregunta) => boolean) =>
    xs.length === 0 ? null : Math.round((xs.filter(f).length / xs.length) * 1000) / 10;
  const conResp = ok.filter((r) => r.respuesta);
  const conJuez = ok.filter((r) => r.juez);
  const conValor = conResp.filter((r) => r.respuesta?.valorCorrecto !== undefined);
  return {
    n: rs.length,
    conError: rs.length - ok.length,
    recuperacionHit: pct(ok, (r) => r.recuperacion.hit) ?? 0,
    citaPresente: pct(conResp, (r) => !!r.respuesta?.citaPresente),
    citasFueraDeKB: pct(conResp, (r) => (r.respuesta?.citasFueraDeKB.length ?? 0) > 0),
    fundamentoCorrecto: pct(conJuez, (r) => !!r.juez?.fundamentoCorrecto),
    noInventa: pct(conJuez, (r) => !!r.juez?.noInventa),
    respondeLoPreguntado: pct(conJuez, (r) => !!r.juez?.respondeLoPreguntado),
    valorCorrecto: pct(conValor, (r) => !!r.respuesta?.valorCorrecto),
  };
}
