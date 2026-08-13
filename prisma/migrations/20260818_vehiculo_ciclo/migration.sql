-- Ciclos de vida por VIN.
--
-- Una unidad física puede pasar por el piso varias veces: se compra nueva, se
-- vende, el cliente la regresa años después, se recompra usada y se vuelve a
-- vender. El unique (companyId, vin) hacía imposible representarlo: la segunda
-- compra chocaba con la unidad ya vendida, se archivaba DUPLICADA y su costo
-- caía en «Otros gastos» (94 conceptos / $29,170,088 en Margom, 2026-08).
--
-- `ciclo` es aditivo con default 1, así que las unidades existentes quedan
-- todas en el ciclo 1 sin reescribir un solo renglón, y el unique se RELAJA de
-- dos columnas a tres — ninguna fila actual puede violarlo.

-- DropIndex
DROP INDEX "Vehiculo_companyId_vin_key";

-- AlterTable
ALTER TABLE "Vehiculo" ADD COLUMN     "ciclo" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE INDEX "Vehiculo_companyId_vin_idx" ON "Vehiculo"("companyId", "vin");

-- CreateIndex
CREATE UNIQUE INDEX "Vehiculo_companyId_vin_ciclo_key" ON "Vehiculo"("companyId", "vin", "ciclo");
