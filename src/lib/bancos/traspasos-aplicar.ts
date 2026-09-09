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
  /** Resueltos porque la contraparte es la propia empresa (no necesitan espejo). */
  porRfcPropio: number;
  monto: number;
  detalle: Array<{ fecha: string; monto: number; salida: string; entrada: string }>;
}

export async function detectarTraspasosEmpresa(
  companyId: string,
  opts: { aplicar?: boolean } = {},
): Promise<ResultadoEspejos> {
  const aplicar = opts.aplicar ?? true;
  const out: ResultadoEspejos = { companyId, pares: 0, etiquetados: 0, porRfcPropio: 0, monto: 0, detalle: [] };

  // ── LA CONTRAPARTE SOMOS NOSOTROS ─────────────────────────────────────────
  // Si el RFC de la contraparte es el RFC DE LA EMPRESA, el dinero salió de una
  // cuenta nuestra y entró a otra. Eso es IDENTIDAD, no inferencia: no hace
  // falta encontrar la otra pata, y por eso resuelve justo lo que el espejo no
  // puede — que la cuenta de origen esté en un banco que no sincronizamos, o
  // que haya dos traspasos del mismo importe el mismo día (ambiguos para el
  // espejo, obvios por RFC).
  //
  // Medido: de 11 movimientos con nuestro propio RFC, 4 seguían esperando una
  // factura que no existe. Dos eran de $300,000 el mismo día —el espejo no
  // podía elegir— y dos venían de bancos sin sincronizar.
  const empresa = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true },
  });
  if (empresa?.rfc) {
    const propios = await prisma.bankTransaction.findMany({
      where: {
        companyId,
        status: "UNMATCHED",
        contraparteRfc: { equals: empresa.rfc, mode: "insensitive" },
      },
      select: { id: true, fecha: true, monto: true, descripcion: true },
    });
    for (const t of propios) {
      out.detalle.push({
        fecha: t.fecha.toISOString().slice(0, 10),
        monto: Math.abs(Number(t.monto)),
        salida: "(contraparte = la empresa)",
        entrada: t.descripcion.slice(0, 34),
      });
    }
    out.porRfcPropio = propios.length;
    out.etiquetados += propios.length;
    if (aplicar && propios.length > 0) {
      await prisma.bankTransaction.updateMany({
        where: { id: { in: propios.map((t) => t.id) }, status: "UNMATCHED" },
        data: { status: "IGNORED", notes: "INTERNAL_TRANSFER" },
      });
    }
  }

  const cuentas = await prisma.bankAccount.findMany({
    where: { companyId },
    select: { id: true },
  });
  // Con una sola cuenta no hay espejo que buscar (el RFC propio sí aplica).
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
