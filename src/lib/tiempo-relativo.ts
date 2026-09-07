// ─────────────────────────────────────────────────────────────────────────────
// «hace 6038 min» no lo lee nadie. Esto lo dice en la unidad que se entiende.
// PURA — se prueba sin reloj: el ahora entra como argumento.
// ─────────────────────────────────────────────────────────────────────────────

const MIN = 60_000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;

/** «hace un momento» · «hace 40 min» · «hace 3 h» · «hace 4 días» · «hace 2 meses». */
export function haceCuanto(fecha: Date | string | number, ahora: Date | number = Date.now()): string {
  const t = typeof fecha === "object" ? fecha.getTime() : new Date(fecha).getTime();
  const now = typeof ahora === "object" ? ahora.getTime() : ahora;
  if (!Number.isFinite(t)) return "";
  const ms = Math.max(0, now - t);
  if (ms < 2 * MIN) return "hace un momento";
  if (ms < HORA) return `hace ${Math.round(ms / MIN)} min`;
  if (ms < DIA) {
    const h = Math.round(ms / HORA);
    return `hace ${h} h`;
  }
  const d = Math.round(ms / DIA);
  if (d < 31) return `hace ${d} ${d === 1 ? "día" : "días"}`;
  const meses = Math.round(d / 30);
  if (meses < 12) return `hace ${meses} ${meses === 1 ? "mes" : "meses"}`;
  const anios = Math.round(d / 365);
  return `hace ${anios} ${anios === 1 ? "año" : "años"}`;
}
