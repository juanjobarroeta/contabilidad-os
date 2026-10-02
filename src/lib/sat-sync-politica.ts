// ─────────────────────────────────────────────────────────────────────────────
// ¿Vale la pena volver a pedirle al SAT un mes que ya cerró?
//
// sat-sync corre cada 4 h y revisa los últimos 3 meses. Para un mes CERRADO el
// rango es siempre el mismo (del 1 al último día), y la cuota 5002 del SAT es
// vitalicia por (RFC + rango + tipo): pedir el mismo mes completo una vez al
// día la quemó en casi todas las empresas (medido 2026-10-02: 15 de 15 con
// «emitidos: 5002» en cada corrida, 1 CFDI importado en 16 h).
//
// Un mes cerrado sólo necesita DOS pasadas completas:
//   1. La primera tras el cierre (lo que faltara de los últimos días).
//   2. Una final, ≥ DIAS_PASADA_FINAL días después, para los CFDIs fechados
//      en el mes pero timbrados después (la Fecha admite hasta 72 h atrás).
// Entre una y otra, y después, sólo se verifican las solicitudes en vuelo.
// El mes EN CURSO no cambia: su rango termina «ayer» y es distinto cada día.
// ─────────────────────────────────────────────────────────────────────────────

/** Días después del cierre para la pasada final (72 h de antedatar + margen). */
export const DIAS_PASADA_FINAL = 5;

export interface SolicitudMesCerrado {
  tipo: string;
  status: string;
  errorMessage?: string | null;
  desde: Date | string | null;
  hasta: Date | string | null;
  createdAt: Date | string;
}

const DIA = 24 * 60 * 60 * 1000;

/** Fin del mes (último día 23:59:59, hora del servidor como sat-sync). */
export function finDeMes(year: number, month: number): Date {
  return new Date(year, month, 0, 23, 59, 59);
}

/** ¿El mes ya terminó (hoy es un mes posterior)? */
export function mesCerrado(year: number, month: number, hoy: Date): boolean {
  return hoy > finDeMes(year, month);
}

/** ¿Esta solicitud pidió el mes COMPLETO (no un tramo ni «del 1 a ayer»)? */
function cubreMesCompleto(s: SolicitudMesCerrado, year: number, month: number): boolean {
  if (!s.hasta) return true; // filas viejas sin rango = mes completo
  return new Date(s.hasta).getTime() >= finDeMes(year, month).getTime() - 60_000;
}

/**
 * Para un mes cerrado: ¿se manda una solicitud nueva del mes completo?
 * Cuenta sólo solicitudes que el SAT aceptó (no FAILED/EXPIRED) y exige que
 * AMBOS lados (emitidos y recibidos) tengan la pasada; si falta uno, se pide.
 */
export function pedirMesCerrado(
  year: number,
  month: number,
  solicitudes: SolicitudMesCerrado[],
  hoy: Date,
): { pedir: boolean; motivo: string } {
  const fin = finDeMes(year, month).getTime();
  const final = fin + DIAS_PASADA_FINAL * DIA;
  const validas = solicitudes.filter((s) => s.status !== "FAILED" && s.status !== "EXPIRED" && cubreMesCompleto(s, year, month));
  const lado = (tipo: string) => validas.filter((s) => s.tipo === tipo);
  for (const tipo of ["EMITIDOS", "RECIBIDOS"]) {
    // Cuota 5002 quemada para el mes completo: volver a pedirlo sólo repite el
    // rechazo. Ese lado se rellena con sat-repesca (tramos) o por UUID.
    const quemado = solicitudes.some((s) => s.tipo === tipo && s.status === "FAILED" && (s.errorMessage ?? "").includes("5002") && cubreMesCompleto(s, year, month));
    if (quemado) continue;
    const filas = lado(tipo);
    const tras = filas.filter((s) => new Date(s.createdAt).getTime() > fin);
    if (tras.length === 0) return { pedir: true, motivo: `primera pasada tras el cierre (${tipo.toLowerCase()})` };
    if (hoy.getTime() >= final && !filas.some((s) => new Date(s.createdAt).getTime() >= final)) {
      return { pedir: true, motivo: `pasada final ${DIAS_PASADA_FINAL} días después del cierre (${tipo.toLowerCase()})` };
    }
  }
  return { pedir: false, motivo: "mes cerrado ya pedido completo; sólo se verifican las solicitudes en vuelo" };
}
