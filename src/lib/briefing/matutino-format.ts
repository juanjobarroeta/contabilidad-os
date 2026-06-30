// ─────────────────────────────────────────────────────────────────────────────
// Composición PURA del briefing matutino (sin DB / sin NextAuth) — testeable en
// aislamiento. La capa de datos vive en `matutino.ts` (importa prisma/authz/push,
// que no cargan bajo vitest).
// ─────────────────────────────────────────────────────────────────────────────

import { getObligacionesPorRegimen, calcularVencimiento } from "@/lib/obligaciones";

/** Ventana (días) para avisar de un vencimiento próximo en el briefing. */
export const DIAS_DEADLINE_AVISO = 7;
/** Antigüedad (días) tras la que el estado de cuenta se considera vencido. */
export const DIAS_ESTADO_CUENTA_VENCIDO = 8;

export interface EmpresaBriefing {
  companyId: string;
  razonSocial: string;
  hallazgosAbiertos: number;
  hallazgosCriticos: number;
  /** Vencimiento mensual más próximo (>= hoy), o null si no aplica. */
  proxDeadline: { periodo: string; diasRestantes: number } | null;
  tieneBanco: boolean;
  /** Días desde el último movimiento bancario; null si nunca hubo / sin banco. */
  diasSinMovimiento: number | null;
}

export interface BriefingPush {
  title: string;
  body: string;
  url: string;
}

function periodoDe(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Días de `desde` a `hasta` redondeando hacia arriba (hasta − desde). */
export function diasEntre(hasta: Date, desde: Date): number {
  return Math.ceil((hasta.getTime() - desde.getTime()) / 86_400_000);
}

/**
 * Vencimiento MENSUAL más próximo (>= hoy) para un régimen. Considera el periodo
 * del mes anterior y el del mes actual (la declaración de un mes vence ~el 17 del
 * mes siguiente) y elige el más cercano que aún no pasa. PURA.
 */
export function proximoVencimientoMensual(
  regimenFiscal: string,
  hoy: Date
): { periodo: string; diasRestantes: number } | null {
  const mensuales = getObligacionesPorRegimen(regimenFiscal).filter((o) => o.periodicidad === "MENSUAL");
  if (mensuales.length === 0) return null;
  const rep = mensuales[0]; // todas las mensuales comparten día 17

  const mesAnterior = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
  const mesActual = new Date(hoy.getFullYear(), hoy.getMonth(), 1);

  const candidatos = [periodoDe(mesAnterior), periodoDe(mesActual)]
    .map((p) => ({ periodo: p, diasRestantes: diasEntre(calcularVencimiento(rep, p), hoy) }))
    .filter((c) => c.diasRestantes >= 0)
    .sort((a, b) => a.diasRestantes - b.diasRestantes);

  return candidatos.length ? candidatos[0] : null;
}

/**
 * Compone el briefing priorizado (PURA). Orden: vencimientos en ventana >
 * críticos > pendientes totales. Devuelve null cuando no hay nada accionable hoy.
 */
export function construirBriefing(empresas: ReadonlyArray<EmpresaBriefing>): BriefingPush | null {
  if (empresas.length === 0) return null;
  const multi = empresas.length > 1;

  const proximos = empresas
    .filter((e) => e.proxDeadline && e.proxDeadline.diasRestantes <= DIAS_DEADLINE_AVISO)
    .sort((a, b) => a.proxDeadline!.diasRestantes - b.proxDeadline!.diasRestantes);

  const totalHallazgos = empresas.reduce((s, e) => s + e.hallazgosAbiertos, 0);
  const totalCriticos = empresas.reduce((s, e) => s + e.hallazgosCriticos, 0);
  const conHallazgos = empresas.filter((e) => e.hallazgosAbiertos > 0).length;

  const partes: string[] = [];

  if (proximos.length > 0) {
    const d = proximos[0].proxDeadline!;
    const dias = `${d.diasRestantes} día${d.diasRestantes === 1 ? "" : "s"}`;
    partes.push(
      multi
        ? `Quedan ${dias} para las declaraciones de ${proximos.length} empresa${proximos.length === 1 ? "" : "s"} (la más próxima: ${proximos[0].razonSocial}).`
        : `Quedan ${dias} para tus declaraciones de ${d.periodo}.`
    );
  }

  if (totalCriticos > 0) {
    partes.push(`${totalCriticos} hallazgo${totalCriticos === 1 ? "" : "s"} crítico${totalCriticos === 1 ? "" : "s"} por resolver.`);
  }

  if (totalHallazgos > 0) {
    partes.push(
      multi
        ? `${totalHallazgos} pendiente${totalHallazgos === 1 ? "" : "s"} en ${conHallazgos} empresa${conHallazgos === 1 ? "" : "s"}.`
        : `${totalHallazgos} pendiente${totalHallazgos === 1 ? "" : "s"} por revisar.`
    );
  }

  if (partes.length === 0) return null;

  return {
    title: multi ? "Tu cartera hoy" : "Tu contabilidad hoy",
    body: partes.join(" "),
    url: multi ? "/despacho" : "/hallazgos",
  };
}

/** Empresas con banco y sin movimientos recientes (o nunca). PURA. */
export function empresasConEstadoCuentaVencido(
  empresas: ReadonlyArray<EmpresaBriefing>,
  umbral = DIAS_ESTADO_CUENTA_VENCIDO
): EmpresaBriefing[] {
  return empresas.filter(
    (e) => e.tieneBanco && (e.diasSinMovimiento == null || e.diasSinMovimiento >= umbral)
  );
}

/** Recordatorio (separado) para subir el estado de cuenta. PURA. null si no aplica. */
export function construirRecordatorioEstadoCuenta(
  vencidas: ReadonlyArray<EmpresaBriefing>
): BriefingPush | null {
  if (vencidas.length === 0) return null;
  const body =
    vencidas.length === 1
      ? `No tengo movimientos bancarios recientes de ${vencidas[0].razonSocial}. Súbeme el estado de cuenta para poder conciliar.`
      : `Necesito el estado de cuenta de ${vencidas.length} empresas para conciliar: ${vencidas.slice(0, 3).map((e) => e.razonSocial).join(", ")}${vencidas.length > 3 ? "…" : ""}.`;
  return { title: "Sube tu estado de cuenta", body, url: "/bancos" };
}
