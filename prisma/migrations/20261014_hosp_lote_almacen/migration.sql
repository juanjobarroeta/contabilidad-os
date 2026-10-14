-- HospLote: dónde está la existencia.
--
-- El hospital mueve el mismo lote entre almacenes —bodega, CEYE, consigna y
-- siete carros rojos— y el inventario físico los cuenta por separado. Sin esta
-- columna los 19 almacenes de Haltus se colapsan en un número y se pierde lo
-- único que dice si hay que surtir: una caja en el carro rojo de Quirófano no
-- es stock disponible.
--
-- Los lotes que ya existían no sabían de almacenes: quedan en GENERAL, que es
-- lo que eran de facto.
ALTER TABLE "HospLote" ADD COLUMN "almacen" TEXT NOT NULL DEFAULT 'GENERAL';

-- La identidad de un lote ahora incluye dónde está: el mismo número de lote
-- vive legítimamente en dos almacenes con existencias distintas.
DROP INDEX IF EXISTS "HospLote_insumoId_lote_key";
CREATE UNIQUE INDEX "HospLote_insumoId_lote_almacen_key" ON "HospLote"("insumoId", "lote", "almacen");

-- «¿qué hay en este almacén?» es la consulta del surtido y del conteo físico.
CREATE INDEX "HospLote_companyId_almacen_idx" ON "HospLote"("companyId", "almacen");
