-- Tabla de factores de precio de farmacia (costo × factor) y precio fijo por insumo.
ALTER TABLE "HospConfig" ADD COLUMN     "factoresPrecio" JSONB;

ALTER TABLE "HospInsumo" ADD COLUMN     "precioFijo" BOOLEAN NOT NULL DEFAULT false;
