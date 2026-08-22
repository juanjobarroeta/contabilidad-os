// ─────────────────────────────────────────────────────────────────────────────
// ISAN del periodo — Impuesto Sobre Automóviles Nuevos, pago provisional.
//
// El distribuidor lo causa al enajenar automóviles NUEVOS (Art. 1 LFISAN) y lo
// entera en pagos provisionales a más tardar el día 17 del mes siguiente
// (Art. 4) — el MISMO día que el IVA y el ISR provisional. Por eso vive en la
// pantalla de impuestos junto a ellos y no en un rincón del inventario.
//
// Se calcula AL VUELO sobre las unidades vendidas del mes; no lee ni escribe
// `Vehiculo.isan`. Ese campo lo llena `vender()` cuando la venta se captura en
// la app, pero las ventas reconstruidas por el derivador desde los CFDI nunca
// pasaron por ahí y lo tienen en cero. Calcular aquí hace que el papel de
// trabajo diga la verdad sin reescribir ocho años de historia con una tarifa
// que sólo está cargada para algunos ejercicios.
//
// Base (Art. 2): precio de enajenación SIN IVA y SIN disminuir descuentos,
// rebajas o bonificaciones. Se usa `precioVenta`, que el modelo guarda sin IVA.
// Si ese precio ya viene neto de descuento, la base queda por DEBAJO de la
// legal y el impuesto sale subestimado — se advierte, no se adivina.
// ─────────────────────────────────────────────────────────────────────────────

import type { PrismaClient } from "@prisma/client";
import { calcularIsan, getTarifaIsan } from "@/lib/fiscal/isan";

type Db = Pick<PrismaClient, "vehiculo">;

export interface IsanUnidad {
  vehiculoId: string;
  vin: string;
  descripcion: string;
  fechaVenta: string;
  /** Base del Art. 2: precio de enajenación sin IVA. */
  base: number;
  impuestoTarifa: number;
  reduccionLujo: number;
  exencion: "TOTAL" | "PARCIAL" | null;
  isan: number;
  /** Lo que quedó guardado en Vehiculo.isan, para ver dónde difiere. */
  isanRegistrado: number;
}

export interface IsanPeriodo {
  periodo: string;
  year: number;
  month: number;
  /** Unidades NUEVAS enajenadas en el mes — las que causan el impuesto. */
  unidades: IsanUnidad[];
  /** Suma del ISAN a cargo del mes. */
  total: number;
  /** Desglose por tratamiento del Art. 8-II, que es lo que se discute. */
  exentasTotal: number;
  exentasParcial: number;
  gravadasCompleto: number;
  /** Base gravable sumada (sólo las que causan). */
  baseTotal: number;
  /**
   * Suma de lo que está GUARDADO en Vehiculo.isan. Cuando difiere del total
   * calculado, la diferencia es exactamente lo que el derivador nunca calculó.
   */
  totalRegistrado: number;
  /** Unidades SEMINUEVO vendidas en el mes: no causan ISAN (Art. 1). */
  seminuevosVendidos: number;
  advertencias: string[];
}

/** ISAN causado por las unidades nuevas enajenadas en el mes. */
export async function isanDelPeriodo(
  db: Db,
  companyId: string,
  year: number,
  month: number
): Promise<IsanPeriodo> {
  const desde = new Date(year, month - 1, 1);
  const hasta = new Date(year, month, 1);

  const vendidas = await db.vehiculo.findMany({
    where: {
      companyId,
      fechaVenta: { gte: desde, lt: hasta },
      estado: { in: ["VENDIDO", "ENTREGADO"] },
    },
    select: {
      id: true, vin: true, marca: true, modelo: true, anio: true, tipo: true,
      precioVenta: true, fechaVenta: true, isan: true,
    },
    orderBy: { fechaVenta: "asc" },
  });

  const nuevas = vendidas.filter((v) => v.tipo === "NUEVO");
  const seminuevosVendidos = vendidas.length - nuevas.length;

  const tarifa = getTarifaIsan(year);
  const advertencias: string[] = [];
  if (!tarifa) {
    advertencias.push(
      `No hay tarifa ISAN cargada para ${year}: el impuesto del periodo se reporta en $0 y NO debe presentarse así. La tarifa se publica en el Anexo 15 de la RMF y se captura en src/lib/fiscal/isan.ts.`
    );
  } else if (!tarifa.verificada) {
    advertencias.push(
      `La tarifa ISAN ${year} no está cotejada contra el DOF/Anexo 15 — verificarla antes de enterar. (${tarifa.fuente})`
    );
  }

  const unidades: IsanUnidad[] = [];
  let exentasTotal = 0, exentasParcial = 0, gravadasCompleto = 0;

  for (const v of nuevas) {
    const precio = v.precioVenta ?? 0;
    const r = calcularIsan(precio, year, tarifa);
    if (r.exencion === "TOTAL") exentasTotal++;
    else if (r.exencion === "PARCIAL") exentasParcial++;
    else gravadasCompleto++;

    unidades.push({
      vehiculoId: v.id,
      vin: v.vin,
      descripcion: `${v.marca} ${v.modelo} ${v.anio}`,
      fechaVenta: (v.fechaVenta ?? desde).toISOString().slice(0, 10),
      base: r.base,
      impuestoTarifa: r2(r.impuestoTarifa),
      reduccionLujo: r2(r.reduccionLujo),
      exencion: r.exencion,
      isan: r2(r.isan),
      isanRegistrado: r2(v.isan),
    });
  }

  const sinPrecio = nuevas.filter((v) => !(v.precioVenta && v.precioVenta > 0)).length;
  if (sinPrecio > 0) {
    advertencias.push(
      `${sinPrecio} unidad(es) nueva(s) del mes no tienen precio de venta capturado: causan ISAN y aquí cuentan como $0. Capturar el precio de enajenación para que el impuesto salga completo.`
    );
  }

  const total = r2(unidades.reduce((s, u) => s + u.isan, 0));
  const totalRegistrado = r2(unidades.reduce((s, u) => s + u.isanRegistrado, 0));

  // El hueco entre lo calculado y lo guardado es la venta reconstruida desde
  // el CFDI, que nunca pasó por `vender()`. Se dice con todas sus letras: es
  // impuesto causado que el sistema no traía.
  if (total - totalRegistrado > 0.5) {
    advertencias.push(
      `Hay ${money(total - totalRegistrado)} de ISAN causado que no está registrado en las unidades. Son ventas reconstruidas desde los CFDI, que no pasaron por el alta de venta de la aplicación y quedaron con ISAN en cero. La cifra de esta pantalla es la calculada, no la guardada.`
    );
  }

  return {
    periodo: `${year}-${String(month).padStart(2, "0")}`,
    year,
    month,
    unidades,
    total,
    exentasTotal,
    exentasParcial,
    gravadasCompleto,
    baseTotal: r2(unidades.filter((u) => u.isan > 0).reduce((s, u) => s + u.base, 0)),
    totalRegistrado,
    seminuevosVendidos,
    advertencias,
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) =>
  n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
