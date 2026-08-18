// ─────────────────────────────────────────────────────────────────────────────
// Submenús de /facturas — qué número lleva cada pestaña y con qué urgencia.
//
// El submenú de Complementos mostraba `conteos.pago`: TODOS los REP que
// existen. Eso es el archivo, y nadie entra a Facturas preguntándose cuántos
// complementos ha emitido en su vida — entra preguntando cuáles DEBE. Esa
// cifra existía (la calcula /api/facturas/complemento-pagos) pero sólo se veía
// DENTRO de la pestaña, o sea después de decidir entrar.
//
// Aquí la insignia pasa a ser trabajo pendiente, no volumen histórico, y el
// tono lleva el plazo legal: el REP vence el día 5 del mes siguiente al cobro
// (RMF 2.7.1.32), así que un vencido no puede verse igual que uno al corriente.
//
// Comprobantes SÍ conserva el total: esa pestaña es el archivo, y ahí el
// volumen es la información correcta.
// ─────────────────────────────────────────────────────────────────────────────

export type VistaFacturas = "comprobantes" | "complementos" | "prefacturas" | "recurrentes";

export type TonoSubmenu = "neutral" | "amber" | "red";

export type Submenu = {
  v: VistaFacturas;
  t: string;
  /** Número de la insignia. `null` u 0 ⇒ no se pinta. */
  n: number | null;
  tono: TonoSubmenu;
  /** Título accesible: la insignia es un número solo, el tooltip la explica. */
  hint: string;
};

export type EntradaSubmenus = {
  /** Comprobantes del periodo — volumen, no pendiente. */
  comprobantes: number | null;
  /** Prefacturas guardadas sin timbrar. */
  prefacturas: number;
  /** Series recurrentes ACTIVAS (las pausadas no cuentan como agenda viva). */
  recurrentesActivas: number;
  /** Cobros PPD sin REP; `vencidos` son los que ya pasaron el día 5. */
  repPorEmitir: { sinRep: number; vencidos: number } | null;
};

export function submenusFacturas(e: EntradaSubmenus): Submenu[] {
  const rep = e.repPorEmitir;
  const porEmitir = rep?.sinRep ?? 0;
  const vencidos = rep?.vencidos ?? 0;

  return [
    {
      v: "comprobantes",
      t: "Comprobantes",
      n: e.comprobantes ?? null,
      tono: "neutral",
      hint: "Todos tus CFDI: los que emites y los que recibes.",
    },
    {
      v: "complementos",
      t: "Complementos de pago",
      n: porEmitir || null,
      // Un vencido manda sobre el resto: ya hay incumplimiento, no un plazo por correr.
      tono: vencidos > 0 ? "red" : porEmitir > 0 ? "amber" : "neutral",
      hint: hintComplementos(porEmitir, vencidos),
    },
    {
      v: "prefacturas",
      t: "Prefacturas",
      n: e.prefacturas || null,
      // Ámbar sin rojo: una prefactura sin timbrar no incumple nada, sólo espera.
      tono: e.prefacturas > 0 ? "amber" : "neutral",
      hint:
        e.prefacturas > 0
          ? `${e.prefacturas} prefactura(s) guardadas sin timbrar.`
          : "Borradores guardados que aún no consumen timbre.",
    },
    {
      v: "recurrentes",
      t: "Recurrentes",
      n: e.recurrentesActivas || null,
      // Neutral a propósito: una serie activa es configuración que trabaja
      // sola, no un pendiente. Lo que sí pide atención son las prefacturas que
      // genera, y ésas ya se cuentan en su propia pestaña.
      tono: "neutral",
      hint:
        e.recurrentesActivas > 0
          ? `${e.recurrentesActivas} serie(s) activas generando prefacturas en su fecha.`
          : "Series que generan una prefactura sola en su fecha.",
    },
  ];
}

function hintComplementos(porEmitir: number, vencidos: number): string {
  if (porEmitir === 0) return "REP emitidos y recibidos. No tienes cobros pendientes de complemento.";
  const base = `${porEmitir} cobro(s) PPD esperan su complemento de pago`;
  return vencidos > 0
    ? `${base} — ${vencidos} ya pasaron el plazo legal (día 5 del mes siguiente).`
    : `${base}. El plazo vence el día 5 del mes siguiente al cobro.`;
}
