// Alertas de rentabilidad: detecta clientes "bajo agua" (costo-por-servir >
// precio) del mes anterior completo y avisa a los operadores por push. Operador-
// only por diseño — los datos de costo no se exponen a miembros del despacho.

import { prisma } from "@/lib/prisma";
import { sendPushToUser } from "@/lib/push";
import { computeRentabilidad, esBajoAgua } from "./rentabilidad";

export interface BajoAgua {
  tipo: "company" | "despacho";
  id: string;
  nombre: string;
  costoCentavos: number;
  precioCentavos: number;
}

export interface AlertaResultado {
  periodo: string;
  bajoAgua: BajoAgua[];
  operadoresNotificados: number;
}

export async function notifyRentabilidadAlertas(): Promise<AlertaResultado> {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1); // mes anterior completo
  const rent = await computeRentabilidad(prev.getFullYear(), prev.getMonth() + 1);

  const bajoAgua: BajoAgua[] = [
    ...rent.empresas
      .filter((e) => esBajoAgua(e.precioMensualCentavos, e.costoCentavos))
      .map((e) => ({ tipo: "company" as const, id: e.companyId, nombre: e.razonSocial, costoCentavos: e.costoCentavos, precioCentavos: e.precioMensualCentavos! })),
    ...rent.despachos
      .filter((d) => esBajoAgua(d.precioMensualCentavos, d.costoCentavos))
      .map((d) => ({ tipo: "despacho" as const, id: d.despachoId, nombre: d.name, costoCentavos: d.costoCentavos, precioCentavos: d.precioMensualCentavos! })),
  ];

  if (bajoAgua.length === 0) {
    return { periodo: rent.periodo, bajoAgua: [], operadoresNotificados: 0 };
  }

  const operadores = await prisma.user.findMany({ where: { esOperador: true }, select: { id: true } });
  const n = bajoAgua.length;
  let operadoresNotificados = 0;
  for (const op of operadores) {
    const r = await sendPushToUser(
      op.id,
      {
        title: `${n} cliente${n === 1 ? "" : "s"} bajo agua en ${rent.periodo}`,
        body: `El costo-por-servir superó el precio en ${n} cliente${n === 1 ? "" : "s"}. Revisa la rentabilidad.`,
        url: "/rentabilidad",
        tag: "rentabilidad-alerta",
      },
      "sistema",
    );
    if (r.sent > 0) operadoresNotificados++;
  }

  return { periodo: rent.periodo, bajoAgua, operadoresNotificados };
}
