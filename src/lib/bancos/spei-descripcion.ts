// ─────────────────────────────────────────────────────────────────────────────
// La contraparte que ya viene en el estado de cuenta.
//
// Un SPEI en el estado de cuenta NO es texto libre: el banco arma la descripción
// con segmentos etiquetados separados por comas. Ejemplo real (Banorte):
//
//   SPEI RECIBIDO, BCO:0014 SANTANDER, DEL CLIENTE STRIPE PAYMENTS MEXICO
//   S DE RL DE CV, CONCEPTO: STRIPE, REFERENCIA: 0693689
//
// Ahí van, ya escritos, el banco de la contraparte, su NOMBRE, el concepto que
// capturó el ordenante y la referencia numérica. Hoy todo eso se guarda como una
// sola cadena y encima le corremos reglas de keywords. Este motor lo desarma.
//
// POR QUÉ IMPORTA MÁS DE LO QUE PARECE: la CLAVE DE RASTREO es la llave primaria
// del CEP de Banxico. Sin ella no se puede pedir el comprobante — y con él viene
// el RFC de la contraparte, que es el dato que de verdad cierra la conciliación.
// Extraerla no es un lujo: es el prerrequisito de todo lo demás.
//
// REGLA DE LA CASA: ante la duda, NO se emite el campo. Un nombre mal cortado o
// una CLABE inventada envenenan la conciliación automática — y una conciliación
// mal aplicada cuesta mucho más que una que no se aplicó. Todo campo que sale de
// aquí es porque su patrón calzó sin ambigüedad.
//
// PURO.
// ─────────────────────────────────────────────────────────────────────────────

export interface DatosSpei {
  /** Llave primaria del CEP de Banxico. Sin esto no hay consulta. */
  claveRastreo?: string;
  /** Nombre de la contraparte tal como lo escribió su banco. */
  contraparteNombre?: string;
  /** RFC, sólo si el banco lo puso explícito (raro; el CEP sí lo trae siempre). */
  contraparteRfc?: string;
  /** CLABE de 18 dígitos, ya validada con su dígito de control. */
  contraparteClabe?: string;
  /** Código de institución de 3 dígitos (el prefijo de la CLABE): "014". */
  bancoContraparteCodigo?: string;
  /** Nombre del banco tal como lo escribió el estado de cuenta: "SANTANDER". */
  bancoContraparteNombre?: string;
  /** Concepto que capturó el ordenante. */
  concepto?: string;
  /** Referencia numérica del SPEI (hasta 7 dígitos). */
  referenciaNumerica?: string;
}

// ── CLABE ────────────────────────────────────────────────────────────────────

/**
 * Dígito de control de una CLABE (18 dígitos): pesos 3,7,1 cíclicos sobre los
 * primeros 17, cada producto módulo 10, y el resultado es (10 − Σ mod 10) mod 10.
 *
 * Se valida en serio porque una CLABE mal leída (un OCR que confunde 8 con 3, un
 * corte a la mitad) apunta a la cuenta de otra persona. Vale más no tener CLABE
 * que tener una equivocada.
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
 * un formato que validar — sólo se puede descartar lo que claramente NO lo es.
 * Se exige: sin espacios, 10–30 caracteres, alfanumérico, y con dígitos. El
 * mínimo de 10 es lo que separa una clave de rastreo de un folio o un número de
 * sucursal, que es el error que de verdad importa evitar.
 */
export function pareceClaveRastreo(token: string): boolean {
  const t = token.trim().toUpperCase();
  if (!/^[A-Z0-9]{10,30}$/.test(t)) return false;
  return /\d/.test(t);
}

// ── Segmentos etiquetados ────────────────────────────────────────────────────

/** `BCO:0014 SANTANDER` → código 014 + nombre. El banco lo escribe a 4 dígitos. */
const RE_BANCO = /^BCO[:\s]+(\d{3,4})\s*(.*)$/i;

/** `CTA/CLABE: 012180015437920135` — también `CUENTA CLABE`, `CLABE`. */
const RE_CLABE = /(?:CTA\s*\/\s*CLABE|CUENTA\s+CLABE|CLABE)[:\s]+(\d{18})/i;

/** `CONCEPTO: STRIPE` */
const RE_CONCEPTO = /^CONCEPTO[:\s]+(.+)$/i;

/** `REFERENCIA: 0693689` — sólo numérica; `=REFERENCIA` suelto no cuenta. */
const RE_REFERENCIA = /^REFERENCIA[:\s]+(\d{1,7})$/i;

/** `CLAVE DE RASTREO: XXXX` — cuando el banco la etiqueta en el texto. */
const RE_CLAVE_RASTREO = /CLAVE\s+(?:DE\s+)?RASTREO[:\s]+([A-Z0-9]{10,30})/i;

/** RFC de persona moral (12) o física (13). */
const RE_RFC = /\b([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})\b/;

/**
 * Quién es la contraparte. `DEL CLIENTE` en un depósito, `A CLIENTE` /
 * `BENEFICIARIO` en un envío. La lista crece conforme veamos estados de cuenta
 * reales de otros bancos — se prefiere no reconocer a inventar un patrón.
 */
const RE_CONTRAPARTE = /^(?:DEL?\s+CLIENTE|AL?\s+CLIENTE|BENEFICIARIO|ORDENANTE|BENEF)[:\s]+(.+)$/i;

/**
 * Sufijos de razón social. Una empresa se llama "STRIPE PAYMENTS MEXICO, S. DE
 * R.L. DE C.V." — con coma adentro. Al partir por comas el nombre se parte en
 * dos, así que el pedazo que sigue se vuelve a pegar cuando es sólo el sufijo.
 */
const RE_SUFIJO_RAZON_SOCIAL =
  /^(?:S\.?\s*A\.?(?:\s*P\.?\s*I\.?)?(?:\s*DE\s*C\.?\s*V\.?)?|S\.?\s*DE\s*R\.?\s*L\.?(?:\s*DE\s*C\.?\s*V\.?)?|S\.?\s*C\.?|A\.?\s*C\.?|S\.?\s*A\.?\s*S\.?|DE\s*C\.?\s*V\.?)$/i;

/** Ruido que el banco antepone y que no es parte del nombre. */
const RE_RUIDO = /^(?:=+|-+|\.+)\s*/;

function limpiar(s: string): string {
  return s.replace(RE_RUIDO, "").replace(/\s+/g, " ").trim();
}

/**
 * Desarma la descripción de un movimiento SPEI.
 *
 * `descripcion` es la descripción legible (en Banorte, DESCRIPCIÓN DETALLADA).
 * `columnaCriptica` es la columna que el banco llena con la clave de rastreo y
 * que hasta ahora se descartaba por "ilegible" — lo es para una persona, no para
 * Banxico.
 */
export function parseSpei(descripcion: string, columnaCriptica?: string): DatosSpei {
  const out: DatosSpei = {};
  const texto = (descripcion ?? "").trim();

  // 1. Clave de rastreo: primero la columna dedicada, luego una etiqueta explícita.
  const criptica = (columnaCriptica ?? "").trim().toUpperCase();
  if (criptica && pareceClaveRastreo(criptica)) {
    out.claveRastreo = criptica;
  } else {
    const m = RE_CLAVE_RASTREO.exec(texto);
    if (m) out.claveRastreo = m[1].toUpperCase();
  }

  if (!texto) return out;

  // 2. La CLABE puede venir en cualquier segmento; se busca sobre el texto
  //    completo y se valida el dígito de control antes de aceptarla.
  const mClabe = RE_CLABE.exec(texto);
  if (mClabe && clabeValida(mClabe[1])) {
    out.contraparteClabe = mClabe[1];
    out.bancoContraparteCodigo = bancoDeClabe(mClabe[1]);
  }

  // 3. RFC, sólo si viene explícito.
  const mRfc = RE_RFC.exec(texto.toUpperCase());
  if (mRfc) out.contraparteRfc = mRfc[1];

  // 4. Segmentos etiquetados.
  const segmentos = texto.split(",").map(limpiar).filter(Boolean);

  for (let i = 0; i < segmentos.length; i++) {
    const seg = segmentos[i];

    const mBanco = RE_BANCO.exec(seg);
    if (mBanco) {
      // "0014" → "014": el banco lo escribe a 4 dígitos, la CLABE usa 3.
      out.bancoContraparteCodigo ??= mBanco[1].slice(-3);
      const nombre = mBanco[2].trim();
      if (nombre) out.bancoContraparteNombre ??= nombre;
      continue;
    }

    const mConcepto = RE_CONCEPTO.exec(seg);
    if (mConcepto) {
      out.concepto ??= mConcepto[1].trim();
      continue;
    }

    const mRef = RE_REFERENCIA.exec(seg);
    if (mRef) {
      // Sin ceros a la izquierda, pero "0" no se queda en vacío.
      out.referenciaNumerica ??= mRef[1].replace(/^0+/, "") || "0";
      continue;
    }

    const mParte = RE_CONTRAPARTE.exec(seg);
    if (mParte) {
      let nombre = mParte[1].trim();
      // Volver a pegar el sufijo que la coma partió.
      while (i + 1 < segmentos.length && RE_SUFIJO_RAZON_SOCIAL.test(segmentos[i + 1])) {
        nombre += ` ${segmentos[i + 1]}`;
        i++;
      }
      out.contraparteNombre ??= nombre.replace(/\s+/g, " ").trim();
    }
  }

  return out;
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
  // "CARGO POR COMISION CEP" y las comisiones de SPEI son cobros del banco, no
  // transferencias: no tienen comprobante propio que pedir.
  if (/COMISION|COMISIÓN|\bIVA\b/.test(d)) return false;
  return true;
}
