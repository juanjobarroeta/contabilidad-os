/**
 * Precios: qué le cuesta ESTE producto a ESTE comprador por ESTA cantidad.
 *
 * UNA SOLA FUENTE DE VERDAD. No hay un `precio` en el producto y además unas
 * listas que lo modifican: TODO precio es un renglón de `SalPrecio`. La lista
 * marcada `publica` (el menudeo) es la base, y las de mayoreo se derivan de
 * ella por descuento o la pisan renglón por renglón. Tener el precio en dos
 * lugares es cómo un producto termina costando $499 en la tienda y $520 en el
 * mostrador sin que nadie sepa cuál está mal.
 *
 * CONSECUENCIA ACEPTADA: un producto sin renglón en la lista pública NO tiene
 * precio y no se puede vender. Es deliberado —vender a un precio inventado es
 * peor que no vender— y el panel lo saca en «Publicados sin precio».
 *
 * QUIEBRE POR VOLUMEN: gana el renglón de mayor `minimo` que la cantidad
 * alcanza. 1 pieza → el de minimo 1; 12 piezas → el de minimo 12 si existe.
 */

export type RenglonPrecio = {
  listaId: string;
  productoId: string;
  precio: number;
  minimo: number;
};

export type ListaResuelta = {
  id: string;
  descuento: number;
  publica: boolean;
};

export type PrecioResuelto = {
  /** Unitario sin IVA. */
  precio: number;
  /** Precio de lista pública, para tachar el «antes» cuando hay descuento. */
  precioLista: number | null;
  /** De dónde salió: el renglón explícito, el descuento de la lista, o nada. */
  origen: "RENGLON" | "DESCUENTO" | "PUBLICA" | "SIN_PRECIO";
  /** El quiebre por volumen que aplicó (null si fue el precio base). */
  minimoAplicado: number | null;
};

/** Redondeo a 2 decimales — un precio de venta se cobra en centavos. */
function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** El renglón de mayor `minimo` que `cantidad` alcanza, o null. */
function mejorRenglon(
  renglones: RenglonPrecio[],
  listaId: string,
  cantidad: number
): RenglonPrecio | null {
  const aplicables = renglones
    .filter((r) => r.listaId === listaId && cantidad >= r.minimo)
    .sort((a, b) => b.minimo - a.minimo);
  return aplicables[0] ?? null;
}

/**
 * Resuelve el precio de un producto.
 *
 * @param listaCliente  La lista de la cuenta que compra. null = menudeo (ve la
 *                      pública, que es lo que también ve quien no inició sesión).
 */
export function resolverPrecio(args: {
  productoId: string;
  cantidad: number;
  renglones: RenglonPrecio[];
  listaPublica: ListaResuelta | null;
  listaCliente: ListaResuelta | null;
}): PrecioResuelto {
  const { productoId, renglones, listaPublica, listaCliente } = args;
  const cantidad = args.cantidad > 0 ? args.cantidad : 1;
  const delProducto = renglones.filter((r) => r.productoId === productoId);

  const enPublica = listaPublica
    ? mejorRenglon(delProducto, listaPublica.id, cantidad)
    : null;
  const precioLista = enPublica ? r2(enPublica.precio) : null;

  // Sin lista de cliente (o siendo la misma pública): el precio es el público.
  if (!listaCliente || (listaPublica && listaCliente.id === listaPublica.id)) {
    if (!enPublica) {
      return { precio: 0, precioLista: null, origen: "SIN_PRECIO", minimoAplicado: null };
    }
    return {
      precio: precioLista!,
      precioLista,
      origen: "PUBLICA",
      minimoAplicado: enPublica.minimo > 1 ? enPublica.minimo : null,
    };
  }

  // 1. Un renglón explícito en la lista del cliente gana sobre todo.
  const explicito = mejorRenglon(delProducto, listaCliente.id, cantidad);
  if (explicito) {
    return {
      precio: r2(explicito.precio),
      precioLista,
      origen: "RENGLON",
      minimoAplicado: explicito.minimo > 1 ? explicito.minimo : null,
    };
  }

  // 2. Si no hay renglón, el descuento general de la lista sobre el público.
  if (enPublica && listaCliente.descuento > 0) {
    return {
      precio: r2(enPublica.precio * (1 - listaCliente.descuento)),
      precioLista,
      origen: "DESCUENTO",
      minimoAplicado: enPublica.minimo > 1 ? enPublica.minimo : null,
    };
  }

  // 3. Ni renglón ni descuento: paga el público.
  if (enPublica) {
    return {
      precio: precioLista!,
      precioLista,
      origen: "PUBLICA",
      minimoAplicado: enPublica.minimo > 1 ? enPublica.minimo : null,
    };
  }

  return { precio: 0, precioLista: null, origen: "SIN_PRECIO", minimoAplicado: null };
}

export type PartidaCalculada = {
  productoId: string;
  cantidad: number;
  precio: number;
  ivaTasa: number | null;
  importe: number;
  iva: number;
};

/**
 * Suma un pedido: importes por partida, IVA por partida (cada producto trae su
 * tasa — el abarrote es tasa 0 y los utensilios 16 %, en el mismo carrito) y
 * el envío.
 *
 * El IVA se calcula POR PARTIDA y luego se suma, no sobre el subtotal: aplicar
 * una tasa promedio a la suma cobra IVA de más en lo exento.
 */
export function totalesPedido(args: {
  partidas: Array<{
    productoId: string;
    cantidad: number;
    precio: number;
    ivaTasa: number | null;
  }>;
  envio?: number;
  /** IVA del envío. El flete es un servicio: gravado al 16 %. */
  ivaEnvio?: number;
  descuento?: number;
}): {
  partidas: PartidaCalculada[];
  subtotal: number;
  descuento: number;
  envio: number;
  iva: number;
  total: number;
} {
  const partidas: PartidaCalculada[] = args.partidas.map((p) => {
    const importe = r2(p.cantidad * p.precio);
    // ivaTasa null = EXENTO (no es lo mismo que tasa 0, aunque el importe
    // coincida: el exento no da derecho a acreditar y la factura lo declara
    // distinto). Los dos suman 0 aquí; la diferencia viaja en la partida.
    const iva = p.ivaTasa ? r2(importe * p.ivaTasa) : 0;
    return {
      productoId: p.productoId,
      cantidad: p.cantidad,
      precio: p.precio,
      ivaTasa: p.ivaTasa,
      importe,
      iva,
    };
  });

  const subtotal = r2(partidas.reduce((a, p) => a + p.importe, 0));
  const descuento = r2(args.descuento ?? 0);
  const envio = r2(args.envio ?? 0);
  const ivaPartidas = r2(partidas.reduce((a, p) => a + p.iva, 0));
  const ivaEnvio = envio > 0 ? r2(envio * (args.ivaEnvio ?? 0.16)) : 0;
  const iva = r2(ivaPartidas + ivaEnvio);

  return {
    partidas,
    subtotal,
    descuento,
    envio,
    iva,
    total: r2(subtotal - descuento + envio + iva),
  };
}

/**
 * Lo que se cobra de envío según la regla de la tienda: arriba del umbral la
 * tarifa preferente, abajo la normal. `recogeEnTienda` no cobra nada.
 *
 * («Envíos SÓLO $100 en compras de $3,000+» — el letrero de lasalameriadeli.com
 * es exactamente esta regla: umbral 3000, tarifa 100, base la de siempre.)
 */
export function costoEnvio(args: {
  subtotal: number;
  umbral: number;
  tarifa: number;
  tarifaBase: number;
  recogeEnTienda?: boolean;
}): number {
  if (args.recogeEnTienda) return 0;
  if (args.umbral > 0 && args.subtotal >= args.umbral) return r2(args.tarifa);
  return r2(args.tarifaBase);
}
