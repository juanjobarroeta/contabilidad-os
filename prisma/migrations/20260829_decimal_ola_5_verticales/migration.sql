-- Float → Decimal, Ola 5 (final): verticales + rezagados de Company.
-- float8 → numeric(18,6) VÍA TEXTO (lección de la Ola 1: el cast directo
-- trunca a 15 dígitos significativos). NaN/Infinity revientan el parse.
-- Un ALTER por tabla. Tras esta ola, los únicos Float que quedan en el
-- schema son no-dinero a propósito: porcentajes, rendimiento, stock, scores.

ALTER TABLE "Company"
  ALTER COLUMN "coeficienteUtilidad" TYPE numeric(18,6) USING round(("coeficienteUtilidad"::text)::numeric, 6),
  ALTER COLUMN "perdidaFiscalPendiente" TYPE numeric(18,6) USING round(("perdidaFiscalPendiente"::text)::numeric, 6);

ALTER TABLE "Proyecto"
  ALTER COLUMN "montoContratado" TYPE numeric(18,6) USING round(("montoContratado"::text)::numeric, 6),
  ALTER COLUMN "anticipoMonto" TYPE numeric(18,6) USING round(("anticipoMonto"::text)::numeric, 6),
  ALTER COLUMN "anticipoAmortizado" TYPE numeric(18,6) USING round(("anticipoAmortizado"::text)::numeric, 6);

ALTER TABLE "APU"
  ALTER COLUMN "costoDirecto" TYPE numeric(18,6) USING round(("costoDirecto"::text)::numeric, 6),
  ALTER COLUMN "precioUnitario" TYPE numeric(18,6) USING round(("precioUnitario"::text)::numeric, 6);

ALTER TABLE "APUInsumo"
  ALTER COLUMN "cantidad" TYPE numeric(18,6) USING round(("cantidad"::text)::numeric, 6),
  ALTER COLUMN "costoUnitario" TYPE numeric(18,6) USING round(("costoUnitario"::text)::numeric, 6),
  ALTER COLUMN "importe" TYPE numeric(18,6) USING round(("importe"::text)::numeric, 6);

ALTER TABLE "Insumo"
  ALTER COLUMN "costoActual" TYPE numeric(18,6) USING round(("costoActual"::text)::numeric, 6),
  ALTER COLUMN "salarioBase" TYPE numeric(18,6) USING round(("salarioBase"::text)::numeric, 6),
  ALTER COLUMN "factorSalario" TYPE numeric(18,6) USING round(("factorSalario"::text)::numeric, 6);

ALTER TABLE "Presupuesto"
  ALTER COLUMN "montoTotal" TYPE numeric(18,6) USING round(("montoTotal"::text)::numeric, 6);

ALTER TABLE "construccion_presupuesto_insumo"
  ALTER COLUMN "cantidad" TYPE numeric(18,6) USING round(("cantidad"::text)::numeric, 6),
  ALTER COLUMN "costoUnitario" TYPE numeric(18,6) USING round(("costoUnitario"::text)::numeric, 6),
  ALTER COLUMN "importe" TYPE numeric(18,6) USING round(("importe"::text)::numeric, 6);

ALTER TABLE "PresupuestoPartida"
  ALTER COLUMN "cantidad" TYPE numeric(18,6) USING round(("cantidad"::text)::numeric, 6),
  ALTER COLUMN "precioUnitario" TYPE numeric(18,6) USING round(("precioUnitario"::text)::numeric, 6),
  ALTER COLUMN "importe" TYPE numeric(18,6) USING round(("importe"::text)::numeric, 6);

ALTER TABLE "Estimacion"
  ALTER COLUMN "subtotal" TYPE numeric(18,6) USING round(("subtotal"::text)::numeric, 6),
  ALTER COLUMN "retencionGarantia" TYPE numeric(18,6) USING round(("retencionGarantia"::text)::numeric, 6),
  ALTER COLUMN "amortizacionAnticipo" TYPE numeric(18,6) USING round(("amortizacionAnticipo"::text)::numeric, 6),
  ALTER COLUMN "iva" TYPE numeric(18,6) USING round(("iva"::text)::numeric, 6),
  ALTER COLUMN "total" TYPE numeric(18,6) USING round(("total"::text)::numeric, 6),
  ALTER COLUMN "importeAcumulado" TYPE numeric(18,6) USING round(("importeAcumulado"::text)::numeric, 6);

ALTER TABLE "EstimacionPartida"
  ALTER COLUMN "cantidadEjecutada" TYPE numeric(18,6) USING round(("cantidadEjecutada"::text)::numeric, 6),
  ALTER COLUMN "cantidadAcumulada" TYPE numeric(18,6) USING round(("cantidadAcumulada"::text)::numeric, 6),
  ALTER COLUMN "importeContrato" TYPE numeric(18,6) USING round(("importeContrato"::text)::numeric, 6),
  ALTER COLUMN "importe" TYPE numeric(18,6) USING round(("importe"::text)::numeric, 6);

ALTER TABLE "SolicitudCompra"
  ALTER COLUMN "total" TYPE numeric(18,6) USING round(("total"::text)::numeric, 6);

ALTER TABLE "SolicitudPartida"
  ALTER COLUMN "cantidad" TYPE numeric(18,6) USING round(("cantidad"::text)::numeric, 6),
  ALTER COLUMN "precioUnitario" TYPE numeric(18,6) USING round(("precioUnitario"::text)::numeric, 6),
  ALTER COLUMN "importe" TYPE numeric(18,6) USING round(("importe"::text)::numeric, 6);

ALTER TABLE "SolicitudCompraCotizacion"
  ALTER COLUMN "total" TYPE numeric(18,6) USING round(("total"::text)::numeric, 6);

ALTER TABLE "construccion_solicitud_adjudicacion"
  ALTER COLUMN "total" TYPE numeric(18,6) USING round(("total"::text)::numeric, 6);

ALTER TABLE "construccion_pago_proveedor"
  ALTER COLUMN "monto" TYPE numeric(18,6) USING round(("monto"::text)::numeric, 6);

ALTER TABLE "construccion_pago_aplicacion"
  ALTER COLUMN "monto" TYPE numeric(18,6) USING round(("monto"::text)::numeric, 6);

ALTER TABLE "SolicitudCotizacionPartida"
  ALTER COLUMN "precioUnitario" TYPE numeric(18,6) USING round(("precioUnitario"::text)::numeric, 6),
  ALTER COLUMN "importe" TYPE numeric(18,6) USING round(("importe"::text)::numeric, 6);

ALTER TABLE "PresupuestoVersion"
  ALTER COLUMN "snapshotTotal" TYPE numeric(18,6) USING round(("snapshotTotal"::text)::numeric, 6);

ALTER TABLE "Pago"
  ALTER COLUMN "monto" TYPE numeric(18,6) USING round(("monto"::text)::numeric, 6);

ALTER TABLE "RayaSemanal"
  ALTER COLUMN "totalDestajo" TYPE numeric(18,6) USING round(("totalDestajo"::text)::numeric, 6);

ALTER TABLE "RayaTrabajo"
  ALTER COLUMN "cantidad" TYPE numeric(18,6) USING round(("cantidad"::text)::numeric, 6),
  ALTER COLUMN "importeDestajo" TYPE numeric(18,6) USING round(("importeDestajo"::text)::numeric, 6);

ALTER TABLE "RayaDetalleMiembro"
  ALTER COLUMN "diasTrabajados" TYPE numeric(18,6) USING round(("diasTrabajados"::text)::numeric, 6),
  ALTER COLUMN "importe" TYPE numeric(18,6) USING round(("importe"::text)::numeric, 6);

ALTER TABLE "Gasto"
  ALTER COLUMN "importe" TYPE numeric(18,6) USING round(("importe"::text)::numeric, 6),
  ALTER COLUMN "cantidad" TYPE numeric(18,6) USING round(("cantidad"::text)::numeric, 6);

ALTER TABLE "ReembolsoSemanal"
  ALTER COLUMN "totalGastos" TYPE numeric(18,6) USING round(("totalGastos"::text)::numeric, 6),
  ALTER COLUMN "anticipoAplicado" TYPE numeric(18,6) USING round(("anticipoAplicado"::text)::numeric, 6),
  ALTER COLUMN "totalReembolso" TYPE numeric(18,6) USING round(("totalReembolso"::text)::numeric, 6);

ALTER TABLE "PadelClubConfig"
  ALTER COLUMN "ivaRate" TYPE numeric(18,6) USING round(("ivaRate"::text)::numeric, 6);

ALTER TABLE "Reservation"
  ALTER COLUMN "precio" TYPE numeric(18,6) USING round(("precio"::text)::numeric, 6);

ALTER TABLE "RestauranteConfig"
  ALTER COLUMN "ivaRate" TYPE numeric(18,6) USING round(("ivaRate"::text)::numeric, 6);

ALTER TABLE "RestInsumo"
  ALTER COLUMN "costoPromedio" TYPE numeric(18,6) USING round(("costoPromedio"::text)::numeric, 6);

ALTER TABLE "RestCompra"
  ALTER COLUMN "subtotal" TYPE numeric(18,6) USING round(("subtotal"::text)::numeric, 6),
  ALTER COLUMN "iva" TYPE numeric(18,6) USING round(("iva"::text)::numeric, 6);

ALTER TABLE "RestCompraItem"
  ALTER COLUMN "cantidad" TYPE numeric(18,6) USING round(("cantidad"::text)::numeric, 6),
  ALTER COLUMN "costoUnitario" TYPE numeric(18,6) USING round(("costoUnitario"::text)::numeric, 6),
  ALTER COLUMN "importe" TYPE numeric(18,6) USING round(("importe"::text)::numeric, 6);

ALTER TABLE "RestMenuItem"
  ALTER COLUMN "precio" TYPE numeric(18,6) USING round(("precio"::text)::numeric, 6);

ALTER TABLE "RestReceta"
  ALTER COLUMN "cantidad" TYPE numeric(18,6) USING round(("cantidad"::text)::numeric, 6);

ALTER TABLE "RestOrden"
  ALTER COLUMN "subtotal" TYPE numeric(18,6) USING round(("subtotal"::text)::numeric, 6),
  ALTER COLUMN "iva" TYPE numeric(18,6) USING round(("iva"::text)::numeric, 6),
  ALTER COLUMN "total" TYPE numeric(18,6) USING round(("total"::text)::numeric, 6),
  ALTER COLUMN "propina" TYPE numeric(18,6) USING round(("propina"::text)::numeric, 6),
  ALTER COLUMN "costoTotal" TYPE numeric(18,6) USING round(("costoTotal"::text)::numeric, 6);

ALTER TABLE "RestOrdenItem"
  ALTER COLUMN "cantidad" TYPE numeric(18,6) USING round(("cantidad"::text)::numeric, 6),
  ALTER COLUMN "precioUnitario" TYPE numeric(18,6) USING round(("precioUnitario"::text)::numeric, 6),
  ALTER COLUMN "costoUnitario" TYPE numeric(18,6) USING round(("costoUnitario"::text)::numeric, 6);

ALTER TABLE "PurifConfig"
  ALTER COLUMN "precioGarrafon" TYPE numeric(18,6) USING round(("precioGarrafon"::text)::numeric, 6),
  ALTER COLUMN "ivaTasaDefault" TYPE numeric(18,6) USING round(("ivaTasaDefault"::text)::numeric, 6);

ALTER TABLE "PurifClienteConfig"
  ALTER COLUMN "precioGarrafon" TYPE numeric(18,6) USING round(("precioGarrafon"::text)::numeric, 6);

ALTER TABLE "PurifCorte"
  ALTER COLUMN "cortesiasImporte" TYPE numeric(18,6) USING round(("cortesiasImporte"::text)::numeric, 6);

ALTER TABLE "PurifCorteRuta"
  ALTER COLUMN "efectivo" TYPE numeric(18,6) USING round(("efectivo"::text)::numeric, 6),
  ALTER COLUMN "transferencia" TYPE numeric(18,6) USING round(("transferencia"::text)::numeric, 6);

ALTER TABLE "PurifTicket"
  ALTER COLUMN "total" TYPE numeric(18,6) USING round(("total"::text)::numeric, 6);

ALTER TABLE "PurifTicketItem"
  ALTER COLUMN "cantidad" TYPE numeric(18,6) USING round(("cantidad"::text)::numeric, 6),
  ALTER COLUMN "precioUnitario" TYPE numeric(18,6) USING round(("precioUnitario"::text)::numeric, 6),
  ALTER COLUMN "importe" TYPE numeric(18,6) USING round(("importe"::text)::numeric, 6);

ALTER TABLE "PurifCorteGasto"
  ALTER COLUMN "monto" TYPE numeric(18,6) USING round(("monto"::text)::numeric, 6);

ALTER TABLE "PurifProducto"
  ALTER COLUMN "precio" TYPE numeric(18,6) USING round(("precio"::text)::numeric, 6),
  ALTER COLUMN "ivaTasa" TYPE numeric(18,6) USING round(("ivaTasa"::text)::numeric, 6);

ALTER TABLE "PurifVenta"
  ALTER COLUMN "subtotal" TYPE numeric(18,6) USING round(("subtotal"::text)::numeric, 6),
  ALTER COLUMN "iva" TYPE numeric(18,6) USING round(("iva"::text)::numeric, 6),
  ALTER COLUMN "total" TYPE numeric(18,6) USING round(("total"::text)::numeric, 6);

ALTER TABLE "PurifVentaItem"
  ALTER COLUMN "cantidad" TYPE numeric(18,6) USING round(("cantidad"::text)::numeric, 6),
  ALTER COLUMN "precioUnitario" TYPE numeric(18,6) USING round(("precioUnitario"::text)::numeric, 6),
  ALTER COLUMN "importe" TYPE numeric(18,6) USING round(("importe"::text)::numeric, 6);

ALTER TABLE "PurifCompra"
  ALTER COLUMN "total" TYPE numeric(18,6) USING round(("total"::text)::numeric, 6);

ALTER TABLE "PurifEntrega"
  ALTER COLUMN "importe" TYPE numeric(18,6) USING round(("importe"::text)::numeric, 6);

ALTER TABLE "PurifCompraItem"
  ALTER COLUMN "cantidad" TYPE numeric(18,6) USING round(("cantidad"::text)::numeric, 6),
  ALTER COLUMN "precioUnitario" TYPE numeric(18,6) USING round(("precioUnitario"::text)::numeric, 6),
  ALTER COLUMN "importe" TYPE numeric(18,6) USING round(("importe"::text)::numeric, 6);

ALTER TABLE "PurifGasto"
  ALTER COLUMN "monto" TYPE numeric(18,6) USING round(("monto"::text)::numeric, 6);

ALTER TABLE "Vehiculo"
  ALTER COLUMN "costoCompra" TYPE numeric(18,6) USING round(("costoCompra"::text)::numeric, 6),
  ALTER COLUMN "planPisoTasaAnual" TYPE numeric(18,6) USING round(("planPisoTasaAnual"::text)::numeric, 6),
  ALTER COLUMN "precioLista" TYPE numeric(18,6) USING round(("precioLista"::text)::numeric, 6),
  ALTER COLUMN "precioVenta" TYPE numeric(18,6) USING round(("precioVenta"::text)::numeric, 6),
  ALTER COLUMN "isan" TYPE numeric(18,6) USING round(("isan"::text)::numeric, 6),
  ALTER COLUMN "comisionMonto" TYPE numeric(18,6) USING round(("comisionMonto"::text)::numeric, 6);

ALTER TABLE "VehiculoCosto"
  ALTER COLUMN "monto" TYPE numeric(18,6) USING round(("monto"::text)::numeric, 6);

ALTER TABLE "Refaccion"
  ALTER COLUMN "ultimoCosto" TYPE numeric(18,6) USING round(("ultimoCosto"::text)::numeric, 6),
  ALTER COLUMN "ultimoPrecio" TYPE numeric(18,6) USING round(("ultimoPrecio"::text)::numeric, 6),
  ALTER COLUMN "factorCosto" TYPE numeric(18,6) USING round(("factorCosto"::text)::numeric, 6);

ALTER TABLE "RefaccionMovimiento"
  ALTER COLUMN "cantidad" TYPE numeric(18,6) USING round(("cantidad"::text)::numeric, 6),
  ALTER COLUMN "montoUnitario" TYPE numeric(18,6) USING round(("montoUnitario"::text)::numeric, 6);

ALTER TABLE "ServicioVenta"
  ALTER COLUMN "total" TYPE numeric(18,6) USING round(("total"::text)::numeric, 6),
  ALTER COLUMN "manoObra" TYPE numeric(18,6) USING round(("manoObra"::text)::numeric, 6),
  ALTER COLUMN "refacciones" TYPE numeric(18,6) USING round(("refacciones"::text)::numeric, 6);

ALTER TABLE "OrdenServicioLinea"
  ALTER COLUMN "cantidad" TYPE numeric(18,6) USING round(("cantidad"::text)::numeric, 6),
  ALTER COLUMN "precioUnitario" TYPE numeric(18,6) USING round(("precioUnitario"::text)::numeric, 6);

ALTER TABLE "PedidoVehiculo"
  ALTER COLUMN "precio" TYPE numeric(18,6) USING round(("precio"::text)::numeric, 6),
  ALTER COLUMN "enganche" TYPE numeric(18,6) USING round(("enganche"::text)::numeric, 6),
  ALTER COLUMN "anticipoRecibido" TYPE numeric(18,6) USING round(("anticipoRecibido"::text)::numeric, 6),
  ALTER COLUMN "tomaACuentaMonto" TYPE numeric(18,6) USING round(("tomaACuentaMonto"::text)::numeric, 6);

ALTER TABLE "AutomotrizConfig"
  ALTER COLUMN "planPisoTasaAnual" TYPE numeric(18,6) USING round(("planPisoTasaAnual"::text)::numeric, 6),
  ALTER COLUMN "comisionFija" TYPE numeric(18,6) USING round(("comisionFija"::text)::numeric, 6);

ALTER TABLE "CreditoEvaluacion"
  ALTER COLUMN "limiteSugerido" TYPE numeric(18,6) USING round(("limiteSugerido"::text)::numeric, 6);
