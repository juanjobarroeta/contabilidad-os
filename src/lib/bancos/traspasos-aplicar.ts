// Detecta traspasos entre cuentas propias por espejo y los etiqueta.
//
// La decisión vive en `traspasos-espejo.ts` (pura y probada); aquí sólo se
// leen los movimientos y se escribe la etiqueta. Ambas patas quedan
// IGNORED + INTERNAL_TRANSFER, que es el tag que `postMonth` y
// `planearTraspasos` ya saben postear: sin CLABE de contraparte van a lavado,
// donde el cargo de una pata y el abono de la otra se netean a cero.
//
// NUNCA toca un movimiento que no esté UNMATCHED: lo que un humano ya
// concilió o categorizó manda sobre cualquier inferencia nuestra.
import { prisma } from "@/lib/prisma";
import { emparejarEspejos, type MovimientoEspejo } from "./traspasos-espejo";

export interface ResultadoEspejos {
  companyId: string;
  pares: number;
  /** Movimientos efectivamente etiquetados (una o ambas patas del par). */
  etiquetados: number;
  monto: number;
  detalle: Array<{ fecha: string; monto: number; salida: string; entrada: string }>;
}

export async function detectarTraspasosEmpresa(
  companyId: string,
  opts: { aplicar?: boolean } = {},
): Promise<ResultadoEspejos> {
  const aplicar = opts.aplicar ?? true;
  const out: ResultadoEspejos = { companyId, pares: 0, etiquetados: 0, monto: 0, detalle: [] };

  const cuentas = await prisma.bankAccount.findMany({
    where: { companyId },
    select: { id: true },
  });
  // Con una sola cuenta no hay traspaso interno que detectar.
  if (cuentas.length < 2) return out;

  const todos = (
    await prisma.bankTransaction.findMany({
      where: { companyId },
      select: { id: true, fecha: true, monto: true, bankAccountId: true, status: true, descripcion: true },
    })
  ).map((t) => ({ ...t, monto: Number(t.monto) }));

  const universo: MovimientoEspejo[] = todos;
  const pendientes = universo.filter((t) => t.status === "UNMATCHED");
  const pares = emparejarEspejos(pendientes, universo);
  out.pares = pares.length;
  if (pares.length === 0) return out;

  const porId = new Map(todos.map((t) => [t.id, t]));
  for (const par of pares) {
    const salida = porId.get(par.salidaId);
    const entrada = porId.get(par.entradaId);
    out.monto += par.monto;
    out.detalle.push({
      fecha: (salida?.fecha ?? entrada?.fecha ?? new Date()).toISOString().slice(0, 10),
      monto: par.monto,
      salida: salida?.descripcion.slice(0, 34) ?? "—",
      entrada: entrada?.descripcion.slice(0, 34) ?? "—",
    });

    // Sólo las patas que siguen pendientes: la otra pudo ya estar resuelta.
    const aEtiquetar = [par.salidaId, par.entradaId].filter(
      (id) => porId.get(id)?.status === "UNMATCHED",
    );
    out.etiquetados += aEtiquetar.length;
    if (!aplicar || aEtiquetar.length === 0) continue;
    await prisma.bankTransaction.updateMany({
      where: { id: { in: aEtiquetar }, status: "UNMATCHED" },
      data: { status: "IGNORED", notes: "INTERNAL_TRANSFER" },
    });
  }
  return out;
}
