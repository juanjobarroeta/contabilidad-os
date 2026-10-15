-- Máximo de inventario por insumo (compras pide hasta aquí). Aditiva.
ALTER TABLE "HospInsumo" ADD COLUMN "maximo" DECIMAL(18,6);
