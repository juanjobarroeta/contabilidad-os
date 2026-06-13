import { sendPushToUser } from "./push";
import { empresasAccesiblesIds } from "./authz";
import { declaracionesFaltantesEmpresa } from "./fiscal/cobertura-declaraciones";

/**
 * Push AGREGADO de acuses faltantes para un usuario: un solo aviso que resume
 * TODAS sus empresas accesibles (operador = todos los despachos), no uno por
 * documento ni por empresa. No-op si no falta nada o si push no está configurado.
 */
export async function notifyDeclaracionesFaltantes(
  userId: string
): Promise<{ notified: number; total: number; empresas: number }> {
  const ids = await empresasAccesiblesIds(userId);
  if (ids.length === 0) return { notified: 0, total: 0, empresas: 0 };

  let total = 0;
  const empresasConFaltan = new Set<string>();
  for (const id of ids) {
    const faltan = await declaracionesFaltantesEmpresa(id);
    if (faltan.length > 0) {
      total += faltan.length;
      empresasConFaltan.add(id);
    }
  }
  if (total === 0) return { notified: 0, total: 0, empresas: 0 };

  const nEmp = empresasConFaltan.size;
  const r = await sendPushToUser(userId, {
    title: `Faltan ${total} acuse${total === 1 ? "" : "s"} por capturar`,
    body:
      `${nEmp} empresa${nEmp === 1 ? "" : "s"} con declaraciones pendientes — ` +
      `súbelas para calcular saldos a favor, coeficiente y pagos provisionales.`,
    url: "/declaraciones",
    tag: "declaraciones-nag", // colapsa avisos repetidos en uno
  }, "declaraciones");
  return { notified: r.sent, total, empresas: nEmp };
}
