-- Precio de venta del activo al enajenarlo (sin IVA). Contra el saldo pendiente
-- actualizado sale la ganancia o la pérdida del Art. 19 LISR. Aditiva y
-- nullable: lo ya capturado no cambia, y una baja sin venta (desecho) se queda
-- en NULL, que se lee como precio cero.
ALTER TABLE "ActivoFijo" ADD COLUMN IF NOT EXISTS "precioVenta" DECIMAL(18,6);
