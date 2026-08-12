-- Unidad del SAT en que vienen costo y precio: los lubricantes se compran por
-- tambo (208 L) y se venden por litro, así que el costo unitario de compra no
-- es comparable con la salida del kardex.
ALTER TABLE "Refaccion" ADD COLUMN IF NOT EXISTS "unidadCosto" TEXT;
ALTER TABLE "Refaccion" ADD COLUMN IF NOT EXISTS "unidadPrecio" TEXT;
