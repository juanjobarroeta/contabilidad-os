/**
 * Costeo de importación — el costo ATERRIZADO de cada caja.
 *
 * Es la función que decide si el negocio gana dinero. Una cubeta de Lotus que
 * salió en $2,400 de fábrica no cuesta $2,400: cuesta eso más su parte del
 * flete transatlántico, del arancel, del DTA, del agente aduanal y de las
 * maniobras. Si el costo del inventario se queda en el valor de factura, el
 * margen que reporta el estado de resultados está inflado por todo el
 * pedimento, y el precio de venta se fija sobre un número que no existe.
 *
 * TRES REGLAS:
 *
 * 1. EL IVA DE IMPORTACIÓN NO SE PRORRATEA. Es acreditable — se recupera. Va a
 *    1118, no al costo. Prorratearlo (el error clásico del importador) infla
 *    el almacén 16 %.
 *
 * 2. CADA COSTO SE REPARTE POR SU PROPIA BASE. El flete pesa por PESO: una
 *    cubeta de 8 kg y un frasco de 200 g no pagan lo mismo de contenedor
 *    aunque cuesten parecido. El arancel y los honorarios van por VALOR. Usar
 *    una sola base para todo le carga el flete al producto caro y ligero
 *    (praliné de pistache) y se lo perdona al barato y pesado (chocolate en
 *    cubeta), que es justo al revés.
 *
 * 3. LA SUMA CUADRA AL CENTAVO. Los repartos se redondean y luego el residuo
 *    se le da a la partida más grande. Sin eso, la suma de los costos de los
 *    lotes no es igual al asiento contable y el almacén queda descuadrado por
 *    centavos que nadie encuentra después.
 */

export type ProrrateoBase = "VALOR" | "PESO" | "CANTIDAD";

export type CostoImportacion = {
  tipo: string;
  importe: number;
  prorratea: boolean;
  base: ProrrateoBase;
};

export type ItemImportacion = {
  /** Identificador para devolver el resultado (id de la partida). */
  id: string;
  cantidad: number;
  /** Precio unitario en la moneda de la factura del proveedor. */
  precioMoneda: number;
  /** Kilos por unidad. 0 si no se capturó — ver `sinPeso` abajo. */
  pesoKg: number;
};

export type ItemCosteado = {
  id: string;
  cantidad: number;
  /** cantidad × precioMoneda × tipoCambio */
  valorMxn: number;
  /** Lo que le tocó de flete, arancel, DTA, agente… */
  prorrateo: number;
  /** valorMxn + prorrateo */
  costoTotal: number;
  /** costoTotal / cantidad — lo que se guarda en el lote. */
  costoUnitario: number;
};

export type ResultadoCosteo = {
  items: ItemCosteado[];
  /** Σ items.valorMxn — la mercancía a valor de factura, en pesos. */
  valorMercancia: number;
  /** Σ costos prorrateados. */
  costosProrrateados: number;
  /** valorMercancia + costosProrrateados — lo que se carga a 1108. */
  costoMercancia: number;
  /** IVA pagado en aduana — se carga a 1118, NO al inventario. */
  ivaImportacion: number;
  /**
   * Costos con `prorratea = false` que no son IVA de importación. Hoy no
   * debería haber ninguno; se devuelven en vez de tragárselos para que la UI
   * pueda avisar en lugar de perder dinero en silencio.
   */
  noAplicados: number;
  /** Partidas sin peso capturado cuando había un costo repartido por PESO. */
  sinPeso: string[];
};

/** Redondeo a los 6 decimales de las columnas Decimal(18,6). */
function r6(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}

/**
 * Reparte `importe` entre `pesos` en proporción, garantizando que la suma de
 * las partes sea exactamente `importe`: el residuo del redondeo se lo lleva la
 * parte más grande (mayor resto — el reparto que menos distorsiona).
 */
function repartir(importe: number, pesos: number[]): number[] {
  const total = pesos.reduce((a, b) => a + b, 0);
  const n = pesos.length;
  if (n === 0) return [];

  // Sin base sobre la que repartir (todos los pesos en cero, p. ej. nadie
  // capturó el peso en kilos), se reparte en partes iguales. Es una respuesta
  // mala pero honesta; devolver ceros escondería el costo por completo.
  const base = total > 0 ? pesos : new Array(n).fill(1);
  const suma = total > 0 ? total : n;

  const partes = base.map((p) => r6((importe * p) / suma));
  const residuo = r6(importe - partes.reduce((a, b) => a + b, 0));
  if (residuo !== 0) {
    let mayor = 0;
    for (let i = 1; i < n; i++) if (base[i] > base[mayor]) mayor = i;
    partes[mayor] = r6(partes[mayor] + residuo);
  }
  return partes;
}

/**
 * Calcula el costo aterrizado de cada partida de una importación.
 *
 * `tipoCambio` es el del pedimento (DOF del día de la operación) y se congela
 * en la importación: el costo del inventario no puede moverse cada vez que se
 * mueve el dólar.
 */
export function prorratearImportacion(args: {
  items: ItemImportacion[];
  costos: CostoImportacion[];
  tipoCambio: number;
}): ResultadoCosteo {
  const { items, costos, tipoCambio } = args;

  const valores = items.map((i) => r6(i.cantidad * i.precioMoneda * tipoCambio));
  const pesos = items.map((i) => r6(i.cantidad * i.pesoKg));
  const cantidades = items.map((i) => i.cantidad);

  const prorrateos = new Array(items.length).fill(0);
  const sinPeso = new Set<string>();

  for (const c of costos) {
    if (!c.prorratea || !(c.importe > 0)) continue;

    const pesosBase =
      c.base === "PESO" ? pesos : c.base === "CANTIDAD" ? cantidades : valores;

    if (c.base === "PESO") {
      // Una partida sin peso capturado recibiría cero flete y se lo cargaría a
      // las demás. Se avisa: es un dato faltante, no un producto sin peso.
      items.forEach((it, i) => {
        if (!(pesos[i] > 0)) sinPeso.add(it.id);
      });
    }

    const partes = repartir(c.importe, pesosBase);
    partes.forEach((p, i) => {
      prorrateos[i] = r6(prorrateos[i] + p);
    });
  }

  const itemsCosteados: ItemCosteado[] = items.map((it, i) => {
    const costoTotal = r6(valores[i] + prorrateos[i]);
    return {
      id: it.id,
      cantidad: it.cantidad,
      valorMxn: valores[i],
      prorrateo: prorrateos[i],
      costoTotal,
      // Una partida con cantidad 0 no debería existir; si llega, el costo
      // unitario es 0 en vez de NaN (un NaN se guarda y rompe el almacén).
      costoUnitario: it.cantidad > 0 ? r6(costoTotal / it.cantidad) : 0,
    };
  });

  const valorMercancia = r6(valores.reduce((a, b) => a + b, 0));
  const costosProrrateados = r6(prorrateos.reduce((a, b) => a + b, 0));

  const ivaImportacion = r6(
    costos
      .filter((c) => !c.prorratea && c.tipo === "IVA_IMPORTACION")
      .reduce((a, c) => a + c.importe, 0)
  );
  const noAplicados = r6(
    costos
      .filter((c) => !c.prorratea && c.tipo !== "IVA_IMPORTACION")
      .reduce((a, c) => a + c.importe, 0)
  );

  return {
    items: itemsCosteados,
    valorMercancia,
    costosProrrateados,
    costoMercancia: r6(valorMercancia + costosProrrateados),
    ivaImportacion,
    noAplicados,
    sinPeso: [...sinPeso],
  };
}
