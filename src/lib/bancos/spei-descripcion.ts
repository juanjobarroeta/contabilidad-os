// ─────────────────────────────────────────────────────────────────────────────
// La contraparte que ya venía en el estado de cuenta.
//
// Un SPEI en el estado de cuenta NO es texto libre: el banco lo arma con campos
// ETIQUETADOS. Lo que cambia entre bancos es el separador y el agrupamiento, no
// las etiquetas. Dos renglones reales:
//
//   Banorte (comas):
//     SPEI RECIBIDO, BCO:0014 SANTANDER, DEL CLIENTE STRIPE PAYMENTS MEXICO
//     S DE RL DE CV, CONCEPTO: STRIPE, REFERENCIA: 0693689
//
//   Banco del Bajío (pipes, y DOS etiquetas en un mismo tramo):
//     SPEI Enviado: | Institucion Receptora: NU MEXICO | Beneficiario: KATIA
//     FABIOLA CORDERO BERNARDINO (Dato no verificado por esta institucion) |
//     Cuenta Beneficiario: 638180000152107570 RFC Beneficiario: ND |
//     Referencia: 2772602 | Hora: 11:29:46 | Clave de Rastreo: BB27726020704
//     Concepto del Pago: PAGO N
//
// POR ESO ESTE MOTOR NO PARTE POR SEPARADOR. La primera versión partía por comas
// y contra Bajío rescataba UN campo de siete: el separador es "|" y ahí van
// "Cuenta Beneficiario:" y "RFC Beneficiario:" pegadas en el mismo tramo. Partir
// por el separador es apostarle a una convención que cada banco escribe distinto.
//
// En su lugar se ESCANEAN LAS ETIQUETAS: se busca cada etiqueta conocida en
// cualquier parte del texto y su valor es lo que va hasta la siguiente etiqueta.
// Agregar un banco nuevo es agregar renglones a una tabla, no un parser nuevo.
//
// LO QUE ESTO DESBLOQUEA: Bajío escribe "RFC Beneficiario:" como campo propio. En
// este renglón viene "ND", pero cuando viene lleno es el RFC de la contraparte
// GRATIS — el dato que cierra la conciliación, sin pedirle nada a Banxico. Y la
// "Clave de Rastreo" viene etiquetada en el propio texto, que es la llave del CEP
// para cuando el RFC no venga.
//
// REGLA DE LA CASA: ante la duda, NO se emite el campo. Un nombre mal cortado o
// una CLABE inventada envenenan la conciliación automática — y una conciliación
// mal aplicada cuesta mucho más que una que no se aplicó.
//
// PURO.
// ─────────────────────────────────────────────────────────────────────────────

export interface DatosSpei {
  /** Llave primaria del CEP de Banxico. */
  claveRastreo?: string;
  /** Nombre de la contraparte tal como lo escribió su banco. */
  contraparteNombre?: string;
  /** RFC de la contraparte. Gratis cuando el banco lo trae como campo propio. */
  contraparteRfc?: string;
  /** CLABE de 18 dígitos, ya validada con su dígito de control. */
  contraparteClabe?: string;
  /** Código de institución de 3 dígitos (el prefijo de la CLABE): "014". */
  bancoContraparteCodigo?: string;
  /** Nombre del banco tal como lo escribió el estado de cuenta. */
  bancoContraparteNombre?: string;
  /** Concepto que capturó el ordenante. */
  concepto?: string;
  /** Referencia numérica del SPEI (hasta 7 dígitos). */
  referenciaNumerica?: string;
  /** Hora del movimiento (HH:MM:SS) — desempata SPEI idénticos del mismo día. */
  hora?: string;
  /**
   * Línea de captura de un pago de impuestos (20 posiciones). No es SPEI, pero
   * viaja en la misma descripción y empata DIRECTO contra TaxDeclaration — el
   * modelo ya tiene `taxDeclarationId` esperándola.
   */
  lineaCaptura?: string;
}

// ── CLABE ────────────────────────────────────────────────────────────────────

/**
 * Dígito de control de una CLABE (18 dígitos): pesos 3,7,1 cíclicos sobre los
 * primeros 17, cada producto módulo 10, y el resultado es (10 − Σ mod 10) mod 10.
 *
 * Se valida en serio porque una CLABE mal leída (un OCR que confunde 8 con 3, un
 * corte a la mitad) apunta a la cuenta de otra persona. Vale más no tener CLABE
 * que tener una equivocada. Verificado contra CLABEs reales de dos bancos
 * distintos en los tests.
 */
export function clabeValida(clabe: string): boolean {
  if (!/^\d{18}$/.test(clabe)) return false;
  const pesos = [3, 7, 1];
  let suma = 0;
  for (let i = 0; i < 17; i++) {
    suma += (Number(clabe[i]) * pesos[i % 3]) % 10;
  }
  return (10 - (suma % 10)) % 10 === Number(clabe[17]);
}

/** Los 3 primeros dígitos de la CLABE son la institución. */
export function bancoDeClabe(clabe: string): string | undefined {
  return clabeValida(clabe) ? clabe.slice(0, 3) : undefined;
}

// ── Clave de rastreo ─────────────────────────────────────────────────────────

/**
 * ¿Este token parece una clave de rastreo?
 *
 * El campo admite hasta 30 caracteres y cada banco arma el suyo, así que no hay
 * formato que validar — sólo se puede descartar lo que claramente NO lo es. Se
 * exige: sin espacios, 10–30 alfanuméricos, y con dígitos. El mínimo de 10 es lo
 * que separa una clave de rastreo de un folio o un número de sucursal, que es el
 * falso positivo que importa evitar (pediríamos CEPs con basura y pagaríamos).
 */
export function pareceClaveRastreo(token: string): boolean {
  const t = token.trim().toUpperCase();
  if (!/^[A-Z0-9]{10,30}$/.test(t)) return false;
  return /\d/.test(t);
}

// ── Escáner de etiquetas ─────────────────────────────────────────────────────

type Campo =
  | "banco"
  | "bancoConCodigo"
  | "nombre"
  | "rfc"
  | "clabe"
  | "referencia"
  | "claveRastreo"
  | "concepto"
  | "hora"
  | "lineaCaptura";

/**
 * Tabla de etiquetas. EL ORDEN IMPORTA: la alternancia se resuelve por posición
 * más a la izquierda, así que las etiquetas LARGAS van primero — sin eso,
 * "Beneficiario:" se comería la de "Cuenta Beneficiario:" y guardaríamos una
 * CLABE en el campo del nombre.
 */
const ETIQUETAS: ReadonlyArray<{ campo: Campo; re: string }> = [
  { campo: "clabe", re: String.raw`Cuenta\s+(?:Beneficiario|Ordenante|CLABE)\s*:` },
  { campo: "clabe", re: String.raw`CTA\s*\/\s*CLABE\s*:` },
  { campo: "clabe", re: String.raw`CLABE\s*:` },
  { campo: "rfc", re: String.raw`RFC\s+(?:Beneficiario|Ordenante|Receptor|Emisor)\s*:` },
  { campo: "banco", re: String.raw`Instituci[oó]n\s+(?:Receptora|Emisora|Beneficiaria)\s*:` },
  { campo: "bancoConCodigo", re: String.raw`BCO\s*:` },
  { campo: "claveRastreo", re: String.raw`Clave\s+de\s+Rastreo\s*:` },
  { campo: "concepto", re: String.raw`Concepto\s+del\s+Pago\s*:` },
  { campo: "concepto", re: String.raw`Concepto\s*:` },
  { campo: "referencia", re: String.raw`Referencia\s+Num[eé]rica\s*:` },
  { campo: "referencia", re: String.raw`Referencia\s*:` },
  { campo: "hora", re: String.raw`Hora\s*:` },
  { campo: "lineaCaptura", re: String.raw`REF\.\s*` },
  // Bajío a veces separa con pipe en vez de dos puntos: "Beneficiario | TESOFE
  // INGRESOS FEDERALES REC". Aceptar ambos es lo que rescata al beneficiario en
  // los pagos de impuestos, donde saber que es la TESOFE confirma el destino.
  { campo: "nombre", re: String.raw`(?:Beneficiario|Ordenante)\s*[:|]` },
  // Banorte no usa dos puntos: "DEL CLIENTE STRIPE PAYMENTS…".
  { campo: "nombre", re: String.raw`\bDEL?\s+CLIENTE\s+` },
  { campo: "nombre", re: String.raw`\bAL?\s+CLIENTE\s+` },
];

const RE_ETIQUETAS = new RegExp(ETIQUETAS.map((e) => `(${e.re})`).join("|"), "gi");

/** Valores que el banco escribe para decir "no tengo este dato". */
const RE_SIN_DATO = /^(?:ND|N\/D|NA|N\/A|NO\s+DISPONIBLE|-+|\.+)$/i;

/** RFC de persona moral (12) o física (13). */
const RE_RFC = /^([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})$/;

/**
 * Limpia el valor de una etiqueta: quita separadores de orilla, el paréntesis
 * aclaratorio que Bajío le cuelga al nombre ("(Dato no verificado por esta
 * institucion)") y el ruido de relleno.
 */
function limpiarValor(v: string): string {
  return v
    .replace(/\([^)]*\)/g, " ") // aclaraciones entre paréntesis
    .replace(/[|;]+/g, " ")
    // El punto NO se quita de la orilla derecha: "S. DE R.L. DE C.V." lo lleva
    // como parte de la abreviatura y recortarlo deja la razón social mocha.
    .replace(/^[\s,.:;|-]+/g, "")
    .replace(/[\s,:;|-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Desarma la descripción de un movimiento bancario.
 *
 * `columnaCriptica` es la columna que algunos bancos (Banorte) llenan con la
 * clave de rastreo y que se descartaba por "ilegible" — lo es para una persona,
 * no para Banxico.
 */
export function parseSpei(descripcion: string, columnaCriptica?: string): DatosSpei {
  const out: DatosSpei = {};
  const texto = (descripcion ?? "").trim();

  // La columna dedicada gana sobre lo que se encuentre en el texto.
  const criptica = (columnaCriptica ?? "").trim().toUpperCase();
  if (criptica && pareceClaveRastreo(criptica)) out.claveRastreo = criptica;

  if (!texto) return out;

  // 1. Ubicar TODAS las etiquetas y su posición.
  const hits: { campo: Campo; ini: number; fin: number }[] = [];
  for (const m of texto.matchAll(RE_ETIQUETAS)) {
    // El índice del grupo que capturó identifica la etiqueta.
    const idx = m.slice(1).findIndex((g) => g !== undefined);
    if (idx < 0) continue;
    hits.push({ campo: ETIQUETAS[idx].campo, ini: m.index, fin: m.index + m[0].length });
  }

  // 2. El valor de cada etiqueta llega hasta donde empieza la siguiente.
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const hasta = i + 1 < hits.length ? hits[i + 1].ini : texto.length;
    const valor = limpiarValor(texto.slice(h.fin, hasta));
    if (!valor || RE_SIN_DATO.test(valor)) continue;
    asignar(out, h.campo, valor);
  }

  // 3. Barridos que no dependen de etiqueta: una CLABE o un RFC sueltos en el
  //    texto. Sólo rellenan huecos — la etiqueta explícita siempre manda.
  if (!out.contraparteClabe) {
    for (const m of texto.matchAll(/\b(\d{18})\b/g)) {
      if (clabeValida(m[1])) {
        out.contraparteClabe = m[1];
        out.bancoContraparteCodigo ??= bancoDeClabe(m[1]);
        break;
      }
    }
  }
  if (!out.contraparteRfc) {
    const m = /\b([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})\b/.exec(texto.toUpperCase());
    if (m) out.contraparteRfc = m[1];
  }

  return out;
}

/** Asigna un valor ya limpio al campo que le toca, validando lo validable. */
function asignar(out: DatosSpei, campo: Campo, valor: string): void {
  switch (campo) {
    case "clabe": {
      // El valor puede traer más texto pegado; se busca el bloque de 18 dígitos.
      const m = /\b(\d{18})\b/.exec(valor);
      if (m && clabeValida(m[1])) {
        out.contraparteClabe ??= m[1];
        out.bancoContraparteCodigo ??= bancoDeClabe(m[1]);
      }
      return;
    }
    case "rfc": {
      const v = valor.toUpperCase();
      if (RE_RFC.test(v)) out.contraparteRfc ??= v;
      return;
    }
    case "banco":
      out.bancoContraparteNombre ??= valor.toUpperCase();
      return;
    case "bancoConCodigo": {
      // "0014 SANTANDER" → código 014 (el banco lo escribe a 4 dígitos) + nombre.
      const m = /^(\d{3,4})\s*(.*)$/.exec(valor);
      if (!m) return;
      out.bancoContraparteCodigo ??= m[1].slice(-3);
      if (m[2].trim()) out.bancoContraparteNombre ??= m[2].trim().toUpperCase();
      return;
    }
    case "nombre":
      out.contraparteNombre ??= valor.toUpperCase();
      return;
    case "referencia": {
      if (!/^\d{1,7}$/.test(valor)) return;
      out.referenciaNumerica ??= valor.replace(/^0+/, "") || "0";
      return;
    }
    case "claveRastreo": {
      const token = valor.split(/\s+/)[0].toUpperCase();
      if (pareceClaveRastreo(token)) out.claveRastreo ??= token;
      return;
    }
    case "concepto":
      out.concepto ??= valor;
      return;
    case "hora": {
      const m = /^(\d{1,2}:\d{2}(?::\d{2})?)/.exec(valor);
      if (m) out.hora ??= m[1];
      return;
    }
    case "lineaCaptura": {
      // 20 posiciones alfanuméricas. Se exige que traiga letras Y dígitos: un
      // folio de 20 dígitos puros no es una línea de captura.
      const token = valor.split(/\s+/)[0].toUpperCase();
      if (/^[A-Z0-9]{20}$/.test(token) && /[A-Z]/.test(token) && /\d/.test(token)) {
        out.lineaCaptura ??= token;
      }
      return;
    }
  }
}

// ── Puente a las columnas de BankTransaction ─────────────────────────────────

export interface CamposContraparte {
  claveRastreo: string | null;
  contraparteNombre: string | null;
  contraparteRfc: string | null;
  contraparteClabe: string | null;
  contraparteBanco: string | null;
  conceptoPago: string | null;
  lineaCaptura: string | null;
}

/**
 * Traduce lo extraído a las columnas de BankTransaction.
 *
 * Vive aquí, no en el import, porque lo usan DOS caminos que tienen que
 * coincidir campo por campo: la importación de un estado nuevo y el backfill
 * de lo ya guardado. Si divergen, un movimiento importado hoy y el mismo
 * movimiento reprocesado mañana quedarían distintos.
 *
 * `undefined` se vuelve `null`: en Prisma, `undefined` significa "no toques
 * esta columna" y el backfill necesita poder BORRAR un valor que ya no aplica.
 */
export function camposContraparte(d: DatosSpei): CamposContraparte {
  // El banco va como "014 SANTANDER" cuando se tienen ambos; si sólo hay uno,
  // ese. Guardar el código pegado al nombre evita una columna más y deja el
  // dato legible en la tarjeta del movimiento.
  const banco = [d.bancoContraparteCodigo, d.bancoContraparteNombre].filter(Boolean).join(" ");
  return {
    claveRastreo: d.claveRastreo ?? null,
    contraparteNombre: d.contraparteNombre ?? null,
    contraparteRfc: d.contraparteRfc ?? null,
    contraparteClabe: d.contraparteClabe ?? null,
    contraparteBanco: banco || null,
    conceptoPago: d.concepto ?? null,
    lineaCaptura: d.lineaCaptura ?? null,
  };
}

/** ¿Este movimiento tiene algo que extraer? Corta trabajo en el backfill. */
export function tieneContraparte(c: CamposContraparte): boolean {
  return Object.values(c).some((v) => v != null);
}

/**
 * ¿Este movimiento es un SPEI interbancario, es decir, tiene CEP?
 *
 * Sólo las transferencias interbancarias generan comprobante en Banxico. Los
 * traspasos dentro del mismo banco, el efectivo, los cheques, los cargos de
 * tarjeta y las comisiones NO — y consultarlos es gastar y quedarse igual.
 */
export function esSpeiInterbancario(descripcion: string): boolean {
  const d = (descripcion ?? "").toUpperCase();
  if (!/\bSPEI\b|TRANSFERENCIA\s+INTERBANCARIA|TRANSF\.?\s+INTERB/.test(d)) return false;
  // La comisión por transferencia menciona SPEI y hasta comparte la clave de
  // rastreo del envío, pero es un cobro del banco: no tiene comprobante propio.
  if (/COMISI[OÓ]N|\bIVA\b/.test(d)) return false;
  return true;
}

/**
 * ¿Es el cobro de comisión de una transferencia?
 *
 * Bajío emite la comisión como movimiento aparte PERO con la misma clave de
 * rastreo y referencia del envío que la generó. Eso permite colgarla de su
 * transferencia en vez de dejarla como un gasto suelto que alguien tiene que
 * conciliar a mano cada mes.
 */
export function esComisionDeTransferencia(descripcion: string): boolean {
  const d = (descripcion ?? "").toUpperCase();
  return /COMISI[OÓ]N/.test(d) && /TRANSFERENCIA|SPEI|ENV[IÍ]O/.test(d);
}
