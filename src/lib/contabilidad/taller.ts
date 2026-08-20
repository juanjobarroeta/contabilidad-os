import { prisma } from "../prisma";

/**
 * FASE 2d — el taller en el libro: mano de obra y refacciones a SUS cuentas.
 *
 * El motor sabía vender unidades (4101 por familia) y nada más: todo lo que
 * salía del taller caía en el fallback de ingresos. Medido en MARGOM contra la
 * balanza declarada (2023-01…2026-06): la CE reporta $37.95M en 4301 (mano de
 * obra) y $95.69M en 4401 (refacciones); lo derivado tenía CERO en ambas.
 *
 * Dos decisiones, las dos leídas de los datos del contador y no inventadas:
 *
 * 1. QUÉ CUENTA. La serie sola no basta —4401 tiene seis subcuentas activas—,
 *    así que la elige el NOMBRE del catálogo del propio contador, que es como
 *    la elegiría él: «VENTA REFACCIONES TALLER» para lo que sale de una orden,
 *    «VENTA REFACCIONES» para el mostrador. Si el nombre no desempata a una
 *    sola candidata, devuelve null y el asiento cae al fallback de siempre —
 *    adivinar una subcuenta es peor que no resolver.
 *
 * 2. CÓMO SE PARTE. Una orden factura mano de obra Y refacciones en el mismo
 *    CFDI; el contador las separa por renglón. `ServicioVenta` ya guarda ese
 *    corte (manoObra / refacciones): se usa como PROPORCIÓN y se escala al
 *    subtotal del CFDI, de modo que la suma de las piernas siempre es el
 *    subtotal exacto aunque el corte del DMS venga incompleto (en MARGOM cuadra
 *    al centavo en 16,452 de 24,042 órdenes y cubre el 80% del importe).
 *
 * Fuera de alcance por ahora: el COSTO del taller (5301/5401, $71M declarados)
 * necesita costeo de inventario de refacciones —`Refaccion.ultimoCosto` es el
 * último costo, no el del día de la venta— y las cuentas de GARANTÍAS, que
 * dependen de reconocer a la planta como contraparte.
 */
export type CuentaTaller = {
  id: string;
  cuentaSAT: string;
  nombre: string;
  /** Sólo los cargan los consumidores que arman renglones de reporte. */
  subcuenta?: string | null;
  tipo?: string;
};

export type CuentasTaller = {
  manoObra: CuentaTaller | null;
  refaccionesTaller: CuentaTaller | null;
  refaccionesMostrador: CuentaTaller | null;
};

export type PiernaTaller = { cuenta: CuentaTaller; monto: number };

const normaliza = (s: string) =>
  s.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/**
 * Única cuenta de la serie cuyo nombre contiene TODOS los términos de
 * `incluye` y NINGUNO de `excluye`. Empate o vacío → null.
 */
export function cuentaPorNombre(
  cuentas: CuentaTaller[],
  serie: string,
  incluye: string[],
  excluye: string[]
): CuentaTaller | null {
  const candidatas = cuentas.filter((c) => {
    if (!c.cuentaSAT.startsWith(serie)) return false;
    const n = normaliza(c.nombre);
    return incluye.every((t) => n.includes(t)) && !excluye.some((t) => n.includes(t));
  });
  return candidatas.length === 1 ? candidatas[0] : null;
}

const SIN_GARANTIA = ["GARANTIA"];

export function resolverCuentasTaller(cuentas: CuentaTaller[]): CuentasTaller {
  return {
    manoObra: cuentaPorNombre(cuentas, "4301", ["MANO DE OBRA", "SERVICIO"], SIN_GARANTIA),
    refaccionesTaller: cuentaPorNombre(
      cuentas,
      "4401",
      ["REFACCIONES", "TALLER"],
      [...SIN_GARANTIA, "ACCESORIOS"]
    ),
    refaccionesMostrador: cuentaPorNombre(
      cuentas,
      "4401",
      ["REFACCIONES"],
      [...SIN_GARANTIA, "TALLER", "ACCESORIOS"]
    ),
  };
}

const centavos = (n: number) => Math.round(n * 100) / 100;

/**
 * Reparte el subtotal del CFDI entre las cuentas del taller. Devuelve null
 * cuando no hay señal de taller o falta la cuenta destino: el llamador cae a
 * su cuenta de ingresos de siempre.
 *
 * La última pierna absorbe el redondeo — las piernas suman el subtotal exacto.
 */
export function repartoTaller(
  subtotal: number,
  servicio: { manoObra: number; refacciones: number } | undefined,
  tieneRefacciones: boolean,
  ctas: CuentasTaller
): PiernaTaller[] | null {
  if (servicio) {
    const suma = servicio.manoObra + servicio.refacciones;
    // Sin corte del DMS la orden es mano de obra: es lo que factura un taller
    // cuando no consumió refacciones.
    const propMo = suma > 0.005 ? servicio.manoObra / suma : 1;
    const montoMo = centavos(subtotal * propMo);
    const montoRefa = centavos(subtotal - montoMo);
    const piernas: PiernaTaller[] = [];
    if (montoMo > 0.005) {
      if (!ctas.manoObra) return null;
      piernas.push({ cuenta: ctas.manoObra, monto: montoMo });
    }
    if (montoRefa > 0.005) {
      if (!ctas.refaccionesTaller) return null;
      piernas.push({ cuenta: ctas.refaccionesTaller, monto: montoRefa });
    }
    return piernas.length > 0 ? piernas : null;
  }
  if (tieneRefacciones && subtotal > 0.005) {
    if (!ctas.refaccionesMostrador) return null;
    return [{ cuenta: ctas.refaccionesMostrador, monto: centavos(subtotal) }];
  }
  return null;
}

export interface ContextoTaller {
  ctas: CuentasTaller;
  /** Corte del DMS por CFDI (varias órdenes en una factura se suman). */
  servicios: Map<string, { manoObra: number; refacciones: number }>;
  refacciones: Set<string>;
}

const SIN_TALLER: CuentasTaller = {
  manoObra: null,
  refaccionesTaller: null,
  refaccionesMostrador: null,
};

/** Todo lo que el motor necesita del taller para un lote de CFDIs. */
export async function cargarContextoTaller(
  companyId: string,
  invoiceIds: string[]
): Promise<ContextoTaller> {
  if (invoiceIds.length === 0) {
    return { ctas: SIN_TALLER, servicios: new Map(), refacciones: new Set() };
  }
  const [cuentas, servicios, refas] = await Promise.all([
    prisma.chartAccount.findMany({
      where: {
        companyId,
        isActive: true,
        OR: [{ cuentaSAT: { startsWith: "4301" } }, { cuentaSAT: { startsWith: "4401" } }],
      },
      select: { id: true, cuentaSAT: true, nombre: true, subcuenta: true, tipo: true },
    }),
    prisma.servicioVenta.findMany({
      where: { companyId, invoiceId: { in: invoiceIds } },
      select: { invoiceId: true, manoObra: true, refacciones: true },
    }),
    prisma.refaccionMovimiento.findMany({
      where: { invoiceId: { in: invoiceIds } },
      select: { invoiceId: true },
    }),
  ]);
  const porInvoice = new Map<string, { manoObra: number; refacciones: number }>();
  for (const s of servicios) {
    if (!s.invoiceId) continue;
    const acc = porInvoice.get(s.invoiceId) ?? { manoObra: 0, refacciones: 0 };
    acc.manoObra += s.manoObra ?? 0;
    acc.refacciones += s.refacciones ?? 0;
    porInvoice.set(s.invoiceId, acc);
  }
  return {
    ctas: resolverCuentasTaller(cuentas),
    servicios: porInvoice,
    refacciones: new Set(refas.map((r) => r.invoiceId!).filter(Boolean)),
  };
}

/** Las piernas de ingreso del taller para un CFDI, o null si no es del taller. */
export function piernasIngresoTaller(
  invoiceId: string,
  subtotal: number,
  ctx: ContextoTaller
): PiernaTaller[] | null {
  return repartoTaller(subtotal, ctx.servicios.get(invoiceId), ctx.refacciones.has(invoiceId), ctx.ctas);
}
