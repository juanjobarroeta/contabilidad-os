// Los pagos de meses ANTERIORES a las facturas PPD que se pagan este mes: lo
// que ya tomaron del tope de su factura (ver rep-tope.ts).
import { prisma } from "@/lib/prisma";
import { REP_VIGENTE } from "./rep-vigente";
import type { LinkRep } from "./rep-tope";
import { normalizarUuid, variantesUuid } from "./uuid";

/** UUID normalizado del padre → sus links de REPs vigentes con fecha de pago antes de `antesDe`. */
export async function linksVigentesAntesDe(
  companyId: string,
  parentUuids: Iterable<string>,
  antesDe: Date,
): Promise<Map<string, LinkRep[]>> {
  const out = new Map<string, LinkRep[]>();
  const lista = variantesUuid(parentUuids);
  if (lista.length === 0) return out;
  const filas = await prisma.pagoDoctoRelacionado.findMany({
    where: { parentUuid: { in: lista }, fechaPago: { lt: antesDe }, pagoInvoice: { companyId, ...REP_VIGENTE } },
    select: { parentUuid: true, impPagado: true, ivaTrasladado: true, ivaDerivado: true },
  });
  for (const f of filas) {
    const k = normalizarUuid(f.parentUuid);
    const l = out.get(k) ?? [];
    l.push({
      impPagado: f.impPagado === null ? null : Number(f.impPagado),
      ivaTrasladado: f.ivaTrasladado === null ? null : Number(f.ivaTrasladado),
      ivaDerivado: f.ivaDerivado,
    });
    out.set(k, l);
  }
  return out;
}
