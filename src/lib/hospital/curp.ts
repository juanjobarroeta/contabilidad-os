// ─────────────────────────────────────────────────────────────────────────────
// CURP: la llave del paciente (NOM-024-SSA3-2012, identificación mínima).
//
// Validación LOCAL: formato de 18 caracteres, fecha de nacimiento coherente,
// sexo, entidad federativa y el dígito verificador (algoritmo oficial de
// RENAPO). No consulta a RENAPO — eso es v2 — pero atrapa lo que más falla en
// captura: dígitos transpuestos, letras por números y fechas imposibles.
// ─────────────────────────────────────────────────────────────────────────────

export const ENTIDADES_CURP: Record<string, string> = {
  AS: "Aguascalientes", BC: "Baja California", BS: "Baja California Sur", CC: "Campeche",
  CL: "Coahuila", CM: "Colima", CS: "Chiapas", CH: "Chihuahua", DF: "Ciudad de México",
  DG: "Durango", GT: "Guanajuato", GR: "Guerrero", HG: "Hidalgo", JC: "Jalisco",
  MC: "México", MN: "Michoacán", MS: "Morelos", NT: "Nayarit", NL: "Nuevo León",
  OC: "Oaxaca", PL: "Puebla", QT: "Querétaro", QR: "Quintana Roo", SP: "San Luis Potosí",
  SL: "Sinaloa", SR: "Sonora", TC: "Tabasco", TS: "Tamaulipas", TL: "Tlaxcala",
  VZ: "Veracruz", YN: "Yucatán", ZS: "Zacatecas", NE: "Nacido en el extranjero",
};

const ALFABETO = "0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ";

/** Dígito verificador (posición 18) según RENAPO. */
export function digitoVerificadorCurp(curp17: string): string {
  let suma = 0;
  for (let i = 0; i < 17; i++) {
    const idx = ALFABETO.indexOf(curp17[i]);
    suma += (idx < 0 ? 0 : idx) * (18 - i);
  }
  const d = 10 - (suma % 10);
  return String(d === 10 ? 0 : d);
}

export interface ResultadoCurp {
  valida: boolean;
  curp: string;
  motivo?: string;
  /** Lo que la CURP dice del titular, para pre-llenar la ficha. */
  fechaNacimiento?: Date;
  sexo?: "FEMENINO" | "MASCULINO";
  entidad?: string;
}

/**
 * Valida la CURP y extrae fecha de nacimiento, sexo y entidad. `valida: false`
 * trae el motivo en español para enseñarlo tal cual en la captura.
 */
export function validarCurp(entrada: string | null | undefined): ResultadoCurp {
  const curp = (entrada ?? "").trim().toUpperCase();
  if (!curp) return { valida: false, curp, motivo: "La CURP está vacía." };
  if (curp.length !== 18) return { valida: false, curp, motivo: "La CURP debe tener 18 caracteres." };
  const re = /^[A-Z][AEIOUX][A-Z]{2}\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])[HM](AS|BC|BS|CC|CL|CM|CS|CH|DF|DG|GT|GR|HG|JC|MC|MN|MS|NT|NL|OC|PL|QT|QR|SP|SL|SR|TC|TS|TL|VZ|YN|ZS|NE)[B-DF-HJ-NP-TV-Z]{3}[0-9A-Z]\d$/;
  if (!re.test(curp)) return { valida: false, curp, motivo: "La CURP no tiene el formato de RENAPO (letras, fecha, sexo y entidad)." };
  const esperado = digitoVerificadorCurp(curp.slice(0, 17));
  if (curp[17] !== esperado) return { valida: false, curp, motivo: "El dígito verificador no coincide: revisa la CURP carácter por carácter." };

  // Siglo: RENAPO usa un dígito (0-9) para nacidos hasta 1999 y una letra (A-Z)
  // para nacidos desde 2000 en la posición 17.
  const aa = Number(curp.slice(4, 6));
  const siglo = /[A-Z]/.test(curp[16]) ? 2000 : 1900;
  const anio = siglo + aa;
  const mes = Number(curp.slice(6, 8));
  const dia = Number(curp.slice(8, 10));
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  if (fecha.getUTCMonth() !== mes - 1 || fecha.getUTCDate() !== dia) {
    return { valida: false, curp, motivo: "La fecha de nacimiento dentro de la CURP no existe." };
  }
  if (fecha.getTime() > Date.now()) return { valida: false, curp, motivo: "La fecha de nacimiento dentro de la CURP es futura." };

  return {
    valida: true,
    curp,
    fechaNacimiento: fecha,
    sexo: curp[10] === "H" ? "MASCULINO" : "FEMENINO",
    entidad: ENTIDADES_CURP[curp.slice(11, 13)],
  };
}
