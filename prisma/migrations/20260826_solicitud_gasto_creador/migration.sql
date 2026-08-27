-- Quién creó la requisición / capturó el gasto (User id, sin FK — mismo
-- patrón que aprobadaPorId/aprobadoPor). Destino de los push de construcción
-- ("tu requisición fue autorizada/pagada"). Aditivo: filas históricas quedan
-- en NULL y el push simplemente no tiene a quién dirigirse.
ALTER TABLE "SolicitudCompra" ADD COLUMN "creadaPorId" TEXT;
ALTER TABLE "Gasto" ADD COLUMN "creadaPorId" TEXT;
