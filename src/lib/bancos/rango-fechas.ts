// ─────────────────────────────────────────────────────────────────────────────
// EL PERIODO DE LA LISTA DE MOVIMIENTOS: un mes (?mes=AAAA-MM) o un rango
// (?desde=AAAA-MM-DD&hasta=AAAA-MM-DD, ambos inclusivos y cualquiera de los dos
// opcional). El rango es lo que pide un «año a la fecha» o «últimos 12 meses»;
// el mes se conserva porque el selector de meses de la mesa lo usa.
//
// `fecha` se guarda como instante UTC (medianoche del día del estado de
// cuenta), así que los cortes van en UTC, igual que el filtro de mes de
// siempre. PURO.
// ─────────────────────────────────────────────────────────────────────────────

export interface RangoFechas {
  gte?: Date;
  lt?: Date;
}

const DIA = /^(\d{4})-(\d{2})-(\d{2})$/;
const MES = /^(\d{4})-(\d{2})$/;

function dia(s: string | null | undefined): Date | null {
  const m = DIA.exec((s ?? "").trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const f = new Date(Date.UTC(y, mo - 1, d));
  // 2026-02-31 no existe: Date.UTC lo rodaría a marzo sin avisar.
  return f.getUTCFullYear() === y && f.getUTCMonth() === mo - 1 && f.getUTCDate() === d ? f : null;
}

/**
 * El filtro de `fecha` para un mes o un rango. Con ambos, manda el rango.
 * `null` = sin filtro de fecha. Un rango al revés (desde > hasta) se respeta
 * tal cual —no devuelve nada— en vez de voltearse en silencio.
 */
export function rangoDeFechas(p: { mes?: string | null; desde?: string | null; hasta?: string | null }): RangoFechas | null {
  const desde = dia(p.desde);
  const hasta = dia(p.hasta);
  if (desde || hasta) {
    const r: RangoFechas = {};
    if (desde) r.gte = desde;
    if (hasta) r.lt = new Date(hasta.getTime() + 24 * 60 * 60 * 1000);
    return r;
  }
  const m = MES.exec((p.mes ?? "").trim());
  if (m) {
    const [y, mo] = [Number(m[1]), Number(m[2])];
    if (mo >= 1 && mo <= 12) return { gte: new Date(Date.UTC(y, mo - 1, 1)), lt: new Date(Date.UTC(y, mo, 1)) };
  }
  return null;
}
