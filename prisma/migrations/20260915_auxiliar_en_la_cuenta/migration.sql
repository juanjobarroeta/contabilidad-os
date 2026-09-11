-- El enlace contraparte <-> auxiliar se mueve de Customer a ChartAccount.
--
-- Se puede DROPear sin rescatar nada: la columna se agrego en la migracion
-- anterior y nunca se escribio — el unico paso que la habria poblado fue un
-- dry-run, y fue ese dry-run el que encontro el defecto. Nada la lee todavia.
--
-- El defecto: un auxiliar pertenece a UNA contraparte, pero una contraparte
-- tiene tantos auxiliares como papeles juegue. En BAOBAB, SUPERAVIT
-- COMERCIALIZADORA es 2110-018 como proveedor, 2120-007 como acreedor y
-- 1170-003 como deudor. Con una sola columna en Customer cabia uno y los otros
-- dos se perdian en silencio, porque el UPDATE traia `chartAccountId IS NULL`
-- en el WHERE y simplemente no afectaba filas.

-- DropForeignKey
ALTER TABLE "Customer" DROP CONSTRAINT "Customer_chartAccountId_fkey";

-- AlterTable
ALTER TABLE "Customer" DROP COLUMN "chartAccountId";

-- AlterTable
ALTER TABLE "ChartAccount" ADD COLUMN     "customerId" TEXT;

-- AddForeignKey
ALTER TABLE "ChartAccount" ADD CONSTRAINT "ChartAccount_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

