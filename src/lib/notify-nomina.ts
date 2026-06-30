import { sendPushToUser } from "./push";
import { empresasAccesiblesIds } from "./authz";
import { prisma } from "./prisma";
import {
  nominaVenceManana,
  inferirCadenciaDesdeEmpleados,
  inferirCadenciaDesdeRuns,
  CADENCIA_LABEL,
  type CadenciaNomina,
} from "./nomina/recordatorio";

// ─────────────────────────────────────────────────────────────────────────────
// Recordatorio proactivo T-1 de nómina (push). El día ANTES de que toque pagar
// (y por ende timbrar) la nómina ordinaria, avisamos como lo haría el contador:
// "Mañana toca timbrar la nómina [semanal/quincenal] de [empresa]."
//
// El timbrado sigue siendo una acción HUMANA de un toque: el push sólo recuerda
// y abre el flujo (/nomina/detalle). Nunca dispara timbrado automático.
// ─────────────────────────────────────────────────────────────────────────────

// El flujo de timbrado vive en el workspace de nómina (botón "Timbrar todo").
const DEEP_LINK_TIMBRAR = "/nomina/detalle";

/**
 * Resuelve la cadencia efectiva de una empresa. Usa la guardada en
 * `periodicidadNomina`; si está en el default (QUINCENAL) intenta inferir una
 * mejor desde los empleados activos y, en su defecto, desde las corridas
 * ordinarias pasadas. Así las empresas existentes (sin configurar) reciben el
 * recordatorio correcto sin intervención.
 */
export async function cadenciaEfectivaEmpresa(companyId: string): Promise<CadenciaNomina> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { periodicidadNomina: true },
  });
  const guardada = (company?.periodicidadNomina ?? "QUINCENAL") as CadenciaNomina;

  // Si NO es el default, respetamos la configuración explícita.
  if (guardada !== "QUINCENAL") return guardada;

  // Default: intentar inferir desde los empleados activos (moda de su
  // periodicidad SAT de pago).
  const empleados = await prisma.employee.findMany({
    where: { companyId, isActive: true },
    select: { periodicidadPago: true },
  });
  const porEmpleados = inferirCadenciaDesdeEmpleados(empleados.map((e) => e.periodicidadPago));
  if (porEmpleados) return porEmpleados;

  // Si no hay empleados con señal, inferir desde corridas ordinarias pasadas
  // (duración del periodo "YYYY-MM-DD/YYYY-MM-DD").
  const runs = await prisma.payrollRun.findMany({
    where: { companyId, tipo: "ORDINARIA" },
    select: { periodo: true },
    orderBy: { createdAt: "desc" },
    take: 12,
  });
  const duraciones = runs
    .map((r) => {
      const [ini, fin] = r.periodo.split("/");
      const a = new Date(ini);
      const b = new Date(fin);
      if (isNaN(a.getTime()) || isNaN(b.getTime())) return NaN;
      return Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
    })
    .filter((n) => Number.isFinite(n));
  const porRuns = inferirCadenciaDesdeRuns(duraciones);
  if (porRuns) return porRuns;

  return guardada; // QUINCENAL por defecto
}

/**
 * Push AGREGADO del recordatorio T-1 para un usuario: revisa TODAS sus empresas
 * accesibles y, si alguna tiene nómina que vence mañana, envía UN solo aviso que
 * las resume. No-op si ninguna vence o si push no está configurado.
 */
export async function notifyNominaRecordatorio(
  userId: string,
  hoy: Date = new Date()
): Promise<{ notified: number; empresas: number }> {
  const ids = await empresasAccesiblesIds(userId);
  if (ids.length === 0) return { notified: 0, empresas: 0 };

  // Empresas cuya nómina vence mañana, con su cadencia.
  const debidas: Array<{ nombre: string; cadencia: CadenciaNomina }> = [];
  for (const id of ids) {
    const cadencia = await cadenciaEfectivaEmpresa(id);
    if (!nominaVenceManana(cadencia, hoy).vence) continue;
    const c = await prisma.company.findUnique({
      where: { id },
      select: { razonSocial: true, nombreComercial: true },
    });
    if (!c) continue;
    debidas.push({ nombre: c.nombreComercial || c.razonSocial, cadencia });
  }

  if (debidas.length === 0) return { notified: 0, empresas: 0 };

  let title: string;
  let body: string;
  if (debidas.length === 1) {
    const e = debidas[0];
    title = "Mañana toca timbrar la nómina";
    body = `Mañana toca timbrar la nómina ${CADENCIA_LABEL[e.cadencia]} de ${e.nombre}.`;
  } else {
    title = `Mañana toca timbrar ${debidas.length} nóminas`;
    const muestra = debidas.slice(0, 3).map((e) => e.nombre).join(", ");
    body =
      `Mañana vence la nómina de ${debidas.length} empresas` +
      (debidas.length > 3 ? ` (${muestra} y ${debidas.length - 3} más)` : ` (${muestra})`) +
      ". Revisa y timbra cada corrida.";
  }

  const r = await sendPushToUser(
    userId,
    {
      title,
      body,
      url: DEEP_LINK_TIMBRAR,
      tag: "nomina-recordatorio", // colapsa avisos repetidos del día en uno
    },
    "sistema"
  );
  return { notified: r.sent, empresas: debidas.length };
}
