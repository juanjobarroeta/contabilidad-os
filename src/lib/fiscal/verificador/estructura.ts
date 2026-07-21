// ─────────────────────────────────────────────────────────────────────────────
// Validación ESTRUCTURAL de identificadores fiscales mexicanos: RFC, CURP y
// NSS. Todo offline y puro — formato + dígito verificador con los algoritmos
// oficiales — para cachar dedazos ANTES de tocar al SAT/PAC:
//
//   RFC : Anexo del RCFF — mod 11 sobre la tabla de valores del SAT
//         (0-9, A-N, &, O-Z, espacio, Ñ), pesos 13..2 con RFC ajustado a 12.
//   CURP: RENAPO — mod 10 sobre la tabla 0-9, A-N, Ñ, O-Z con pesos 18..2.
//   NSS : IMSS — algoritmo de Luhn (mod 10) sobre los 11 dígitos.
//
// Un dígito verificador válido NO garantiza que el identificador exista en el
// padrón — sólo que no es un error de captura. La existencia se verifica por
// otras vías (CFDIs timbrados, CSF, listas del SAT).
// ─────────────────────────────────────────────────────────────────────────────

export type ResultadoEstructura = {
  /** Valor normalizado (trim + MAYÚSCULAS). */
  valor: string;
  formatoValido: boolean;
  /** "no-evaluable" cuando el formato no alcanza para calcular el dígito. */
  digitoVerificador: "valido" | "invalido" | "no-evaluable";
  /** Qué falló, en lenguaje humano (null si todo bien). */
  detalle: string | null;
};

const norm = (v: string) => v.trim().toUpperCase();

// ── RFC ──────────────────────────────────────────────────────────────────────

// Tabla oficial del SAT para el dígito verificador (índice = valor del carácter).
const RFC_DICT = "0123456789ABCDEFGHIJKLMN&OPQRSTUVWXYZ Ñ";

const RFC_RE = /^([A-ZÑ&]{3}|[A-ZÑ&]{4})(\d{6})([A-Z0-9]{2})([0-9A])$/;

function fechaValida(yymmdd: string): boolean {
  const mm = Number(yymmdd.slice(2, 4));
  const dd = Number(yymmdd.slice(4, 6));
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

export function validarRfc(input: string): ResultadoEstructura & { esPersonaMoral: boolean } {
  const valor = norm(input);
  const m = RFC_RE.exec(valor);
  const esPersonaMoral = valor.length === 12;
  if (!m || (valor.length !== 12 && valor.length !== 13)) {
    return {
      valor, esPersonaMoral,
      formatoValido: false,
      digitoVerificador: "no-evaluable",
      detalle: "Formato inválido: 12 caracteres (persona moral) o 13 (persona física) — letras, fecha AAMMDD y homoclave.",
    };
  }
  if (!fechaValida(m[2])) {
    return {
      valor, esPersonaMoral,
      formatoValido: false,
      digitoVerificador: "no-evaluable",
      detalle: "La porción de fecha (AAMMDD) no es una fecha válida.",
    };
  }

  // Dígito verificador: el RFC sin su último carácter se ajusta a 12 posiciones
  // (PM de 12 → 11 caracteres + espacio a la IZQUIERDA) y se pondera 13..2.
  const cuerpo = valor.slice(0, -1).padStart(12, " ");
  let suma = 0;
  for (let i = 0; i < 12; i++) {
    const val = RFC_DICT.indexOf(cuerpo[i]);
    if (val < 0) {
      return { valor, esPersonaMoral, formatoValido: false, digitoVerificador: "no-evaluable", detalle: `Carácter no permitido: "${cuerpo[i]}".` };
    }
    suma += val * (13 - i);
  }
  const mod = suma % 11;
  const esperado = mod === 0 ? "0" : 11 - mod === 10 ? "A" : String(11 - mod);
  const ok = valor.slice(-1) === esperado;
  return {
    valor, esPersonaMoral,
    formatoValido: true,
    digitoVerificador: ok ? "valido" : "invalido",
    detalle: ok ? null : "El dígito verificador no corresponde — probable error de captura.",
  };
}

// ── CURP ─────────────────────────────────────────────────────────────────────

// Tabla de RENAPO (índice = valor; la Ñ va después de la N).
const CURP_DICT = "0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ";

const CURP_RE =
  /^[A-Z][AEIOUX][A-Z]{2}\d{6}[HM][A-Z]{2}[B-DF-HJ-NP-TV-ZÑ]{3}[0-9A-Z]\d$/;

export function validarCurp(input: string): ResultadoEstructura {
  const valor = norm(input);
  if (valor.length !== 18 || !CURP_RE.test(valor)) {
    return {
      valor,
      formatoValido: false,
      digitoVerificador: "no-evaluable",
      detalle: "Formato inválido: 18 caracteres — iniciales, fecha AAMMDD, sexo H/M, entidad, consonantes y dígito.",
    };
  }
  if (!fechaValida(valor.slice(4, 10))) {
    return { valor, formatoValido: false, digitoVerificador: "no-evaluable", detalle: "La porción de fecha (AAMMDD) no es una fecha válida." };
  }
  let suma = 0;
  for (let i = 0; i < 17; i++) {
    const val = CURP_DICT.indexOf(valor[i]);
    if (val < 0) {
      return { valor, formatoValido: false, digitoVerificador: "no-evaluable", detalle: `Carácter no permitido: "${valor[i]}".` };
    }
    suma += val * (18 - i);
  }
  const esperado = String((10 - (suma % 10)) % 10);
  const ok = valor[17] === esperado;
  return {
    valor,
    formatoValido: true,
    digitoVerificador: ok ? "valido" : "invalido",
    detalle: ok ? null : "El dígito verificador no corresponde — probable error de captura.",
  };
}

// ── NSS ──────────────────────────────────────────────────────────────────────

export function validarNss(input: string): ResultadoEstructura {
  const valor = input.replace(/[\s-]/g, "");
  if (!/^\d{11}$/.test(valor)) {
    return {
      valor,
      formatoValido: false,
      digitoVerificador: "no-evaluable",
      detalle: "Formato inválido: el NSS son 11 dígitos (subdelegación, año de alta, año de nacimiento y folio).",
    };
  }
  // Luhn estándar sobre los 11 dígitos: desde la derecha, duplicar cada segundo
  // dígito (restando 9 cuando el doble excede 9); válido si la suma es múltiplo
  // de 10.
  let suma = 0;
  for (let i = 0; i < 11; i++) {
    let d = Number(valor[10 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    suma += d;
  }
  const ok = suma % 10 === 0;
  return {
    valor,
    formatoValido: true,
    digitoVerificador: ok ? "valido" : "invalido",
    detalle: ok ? null : "El dígito verificador no corresponde — probable error de captura.",
  };
}
