// ─────────────────────────────────────────────────────────────────────────────
// ¿Este proveedor persona física es un MÉDICO? Se decide por lo que factura.
//
// El bootstrap tomaba «PF con retención de ISR» como médico, y eso atrapa al
// arrendador, al que cobra intereses, a la imprenta y a la de los uniformes:
// todos retienen ISR. Aquí se clasifica por los conceptos de sus CFDIs:
// ClaveProdServ del SAT (8510 servicios de salud, 8512 servicios médicos)
// más la descripción, contra exclusiones explícitas (renta, intereses,
// insumos, ambulancia, laboratorio ambiental, mantenimiento…). El peso es el
// importe, no el número de renglones, para que un médico que además factura
// un «pago» genérico no se pierda.
// ─────────────────────────────────────────────────────────────────────────────

export interface ConceptoCfdi {
  claveProdServ: string | null | undefined;
  descripcion: string | null | undefined;
  importe: number;
  cuentaPredial?: string | null;
}

export type ClasificacionProveedor = "MEDICO" | "MIXTO" | "NO_MEDICO";

export interface ResultadoClasificacion {
  clasificacion: ClasificacionProveedor;
  /** Proporción del importe que es servicio médico (0-1). */
  proporcionMedica: number;
  importeMedico: number;
  importeTotal: number;
  /** Qué no es médico y pesa: "renta", "intereses", "insumos"… */
  motivos: string[];
}

const RE_MEDICO =
  /HONORARIO|MEDIC[OA]S?\b|CIRUG|ANESTES|CONSULTA|QUIRURG|INTERCONSULTA|VALORACI|INTERPRETACI|BIOPSIA|ENDOSCOP|COLONOSCOP|ECOGUIAD|PROCEDIMIENTO M[EÉ]DICO|ATENCI[OÓ]N M[EÉ]DICA|TERAPIA RESPIRATORIA|HEMODI[AÁ]LISIS|RADIOLOG|IMAGENOLOG|PATOLOG|LABORATORIO CL[IÍ]NICO/i;

/** Exclusiones con nombre, por descripción o por familia de ClaveProdServ. */
const EXCLUSIONES: Array<{ motivo: string; re?: RegExp; claves?: RegExp }> = [
  // El orden importa: «renta de equipo» antes que «renta» de inmueble.
  { motivo: "renta de equipo", re: /RENTA DE (EQUIPO|CISTOSCOPIO|ENDOC[AÁ]MARA|FUENTE|LENTE|RESECT|VENTILADOR|MONITOR)/i },
  { motivo: "renta", re: /\bRENTA\b|ARRENDAMIENTO|ALQUILER/i, claves: /^8013(15|1[0-9])/ },
  { motivo: "intereses", re: /INTERESES|FINANCIAMIENTO|PR[EÉ]STAMO/i, claves: /^8410/ },
  { motivo: "ambulancia", re: /AMBULANCIA/i, claves: /^921019/ },
  { motivo: "uniformes", re: /UNIFORME|\bBATAS?\b|CHAZARILLA|FILIPINA|PIJAMA QUIR/i, claves: /^5310/ },
  { motivo: "mantenimiento", re: /MANTENIMIENTO|INSTALACI[OÓ]N|LAVADO DE CISTERNA|VERIFICACI[OÓ]N/i, claves: /^(72|81|76|78)/ },
  { motivo: "laboratorio ambiental", re: /MICROBIOL[OÓ]GICO DE (AGUA|AMBIENTE|SUPERFICIE)/i },
  // Bienes (segmentos 1x-6x del catálogo del SAT): insumos, equipo, papelería…
  // aunque la descripción diga «para médicos» o «posquirúrgico».
  { motivo: "insumos", claves: /^[1-6]\d/ },
];

/** Servicios de salud del SAT: 8510 (hospitalarios/consulta), 8512 (médicos especialistas), 8513 (imagenología), 8514 (laboratorio clínico). */
const RE_CLAVE_MEDICA = /^851[0-4]/;
/** 8516 son servicios de apoyo médico (terapia respiratoria, etc.): cuentan como clínicos, no como honorarios de médico. */
const RE_CLAVE_APOYO = /^8516/;

const limpiar = (s: string | null | undefined) => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();

/** Clasifica UN concepto: médico, apoyo clínico o excluido (con motivo). */
export function clasificarConcepto(c: ConceptoCfdi): { medico: boolean; motivo: string | null } {
  const clave = (c.claveProdServ ?? "").trim();
  const desc = limpiar(c.descripcion);
  if (c.cuentaPredial && c.cuentaPredial.trim()) return { medico: false, motivo: "renta" };
  // 1. Exclusiones por descripción (renta, intereses, uniformes…) mandan.
  for (const ex of EXCLUSIONES) {
    if (ex.re && ex.re.test(desc)) return { medico: false, motivo: ex.motivo };
  }
  // 2. Servicios de salud por clave del SAT.
  if (RE_CLAVE_MEDICA.test(clave) || RE_CLAVE_APOYO.test(clave)) return { medico: true, motivo: null };
  // 3. Bienes y servicios excluidos por clave: un drenaje «posquirúrgico» es insumo.
  for (const ex of EXCLUSIONES) {
    if (ex.claves && ex.claves.test(clave)) return { medico: false, motivo: ex.motivo };
  }
  // 4. Servicios con clave genérica (84111506 «servicios de facturación»…): la descripción decide.
  if (RE_MEDICO.test(desc)) return { medico: true, motivo: null };
  // «PAGO», «ANTICIPO» y descripciones genéricas: neutras, no suman ni restan.
  return { medico: false, motivo: null };
}

/**
 * Clasifica al proveedor por el importe de sus conceptos: MEDICO si al menos
 * la mitad de lo facturado es servicio médico, MIXTO entre 10 % y 50 % (que lo
 * confirme una persona), NO_MEDICO por debajo. Sin conceptos → NO_MEDICO.
 */
export function clasificarProveedorMedico(conceptos: ConceptoCfdi[]): ResultadoClasificacion {
  let medico = 0;
  let total = 0;
  const pesoMotivo = new Map<string, number>();
  for (const c of conceptos) {
    const importe = Math.max(0, Number(c.importe) || 0);
    const r = clasificarConcepto(c);
    if (r.medico) medico += importe;
    else if (r.motivo) pesoMotivo.set(r.motivo, (pesoMotivo.get(r.motivo) ?? 0) + importe);
    if (r.medico || r.motivo) total += importe;
  }
  const proporcion = total > 0 ? medico / total : 0;
  const motivos = [...pesoMotivo.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
  const clasificacion: ClasificacionProveedor = total === 0 ? "NO_MEDICO" : proporcion >= 0.5 ? "MEDICO" : proporcion >= 0.1 ? "MIXTO" : "NO_MEDICO";
  return { clasificacion, proporcionMedica: Math.round(proporcion * 1000) / 1000, importeMedico: medico, importeTotal: total, motivos };
}
