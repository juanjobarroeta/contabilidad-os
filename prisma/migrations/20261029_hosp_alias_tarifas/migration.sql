-- A qué pagador va cada columna de una lista de precios en formato ancho
-- (lib/hospital/tarifario-ancho-db). Aditiva y nullable.
ALTER TABLE "HospConfig" ADD COLUMN IF NOT EXISTS "aliasTarifas" JSONB;
