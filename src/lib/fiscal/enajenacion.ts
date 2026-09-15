// ─────────────────────────────────────────────────────────────────────────────
// ENAJENACIÓN DE ACTIVO FIJO (Art. 19 LISR) — puro.
//
// Vender un activo no es sólo dejar de depreciarlo. Lo que quedó SIN DEDUCIR se
// deduce en el ejercicio de la venta, actualizado, y contra eso se compara el
// precio:
//
//   saldo pendiente actualizado = (MOI deducible − depreciación acumulada)
//                                 × INPC(mes de venta) ÷ INPC(mes de compra)
//   ganancia  = precio de venta − saldo pendiente actualizado   (si es positiva)
//   pérdida   = saldo pendiente actualizado − precio de venta   (si es positiva)
//
// La ganancia es ingreso acumulable y la pérdida, deducción autorizada. Sin
// esto, un activo vendido se quedaba con su saldo por deducir colgado para
// siempre: ni se deducía ni aparecía en ningún lado.
//
// El MOI que entra aquí es el DEDUCIBLE —ya topado para automóviles (Art.
// 36-II)—, y la depreciación acumulada es la NOMINAL, que es como se lleva el
// saldo. Sin INPC no se inventa nada: el factor queda en 1, se marca
// `sinActualizar` y quien revisa sabe que la cifra está nominal.
// ─────────────────────────────────────────────────────────────────────────────

import { factorActualizacionEnajenacion } from "./inpc";

export interface EnajenacionInput {
  /** MOI ya topado (Art. 36-II para automóviles). */
  moiDeducible: number;
  /** Depreciación nominal acumulada hasta la baja. */
  depreciacionAcumulada: number;
  fechaAdquisicion: Date;
  fechaVenta: Date;
  /** Lo que se cobró por el activo, sin IVA. 0 si se desechó. */
  precioVenta: number;
}

export interface EnajenacionResult {
  /** MOI − depreciación acumulada, en nominal. */
  saldoPendienteNominal: number;
  factorActualizacion: number;
  /** El saldo pendiente actualizado: lo deducible del ejercicio (Art. 19). */
  saldoPendienteActualizado: number;
  /** Ingreso acumulable, si el precio superó al saldo. */
  ganancia: number;
  /** Deducción autorizada, si el saldo superó al precio. */
  perdida: number;
  /** True cuando faltó INPC y la cifra quedó nominal. */
  sinActualizar: boolean;
  fundamento: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function calcularEnajenacion(input: EnajenacionInput): EnajenacionResult {
  const saldoPendienteNominal = r2(Math.max(0, input.moiDeducible - input.depreciacionAcumulada));

  const f = factorActualizacionEnajenacion({
    adqYear: input.fechaAdquisicion.getFullYear(),
    adqMonth: input.fechaAdquisicion.getMonth() + 1,
    ventaYear: input.fechaVenta.getFullYear(),
    ventaMonth: input.fechaVenta.getMonth() + 1,
  });
  const saldoPendienteActualizado = r2(saldoPendienteNominal * f.factor);

  const precio = Math.max(0, input.precioVenta);
  const diferencia = r2(precio - saldoPendienteActualizado);

  return {
    saldoPendienteNominal,
    factorActualizacion: f.factor,
    saldoPendienteActualizado,
    ganancia: diferencia > 0 ? diferencia : 0,
    perdida: diferencia < 0 ? Math.abs(diferencia) : 0,
    sinActualizar: !f.completo,
    fundamento: "Art. 19 LISR (ganancia o pérdida en enajenación de activo fijo)",
  };
}
