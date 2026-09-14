// Por qué no responde el modelo, y si eso amerita despertar a alguien.
//
// Saldo agotado y llave rechazada son caídas del producto: nadie puede
// trabajar hasta que un humano entre a la consola. Saturación (429/529) y un
// corte de red se resuelven solos casi siempre, así que no alertan: el cron
// que corre cada pocos minutos ya volverá a intentar. Puro.

export type CausaFalloIa = "sin-credito" | "llave-rechazada" | "saturado" | "red" | "otro";

export interface FalloIa {
  causa: CausaFalloIa;
  /** true = despierta a alguien (Sentry con fingerprint propio). */
  alertar: boolean;
  detalle: string;
}

export function clasificarFalloIa(error: unknown): FalloIa {
  const crudo = error instanceof Error ? error.message : typeof error === "string" ? error : "Error desconocido";
  const detalle = crudo.slice(0, 200);
  const t = crudo.toLowerCase();
  if (t.includes("credit balance")) return { causa: "sin-credito", alertar: true, detalle };
  if (/^401\b/.test(crudo) || t.includes("authentication_error") || t.includes("invalid x-api-key") || t.includes("permission_error")) {
    return { causa: "llave-rechazada", alertar: true, detalle };
  }
  if (/^(429|529|503)\b/.test(crudo) || t.includes("rate_limit_error") || t.includes("overloaded_error")) return { causa: "saturado", alertar: false, detalle };
  if (t.includes("econnreset") || t.includes("etimedout") || t.includes("fetch failed") || t.includes("und_err") || t.includes("socket")) {
    return { causa: "red", alertar: false, detalle };
  }
  return { causa: "otro", alertar: true, detalle };
}
