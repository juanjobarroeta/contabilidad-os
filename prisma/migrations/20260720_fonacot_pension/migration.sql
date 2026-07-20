-- Fonacot (credito de nomina) y pension alimenticia por empleado — aditivo.
ALTER TABLE "Employee" ADD COLUMN "creditoFonacot" TEXT;
ALTER TABLE "Employee" ADD COLUMN "descuentoFonacot" DOUBLE PRECISION;
ALTER TABLE "Employee" ADD COLUMN "pensionAlimenticiaTipo" TEXT;
ALTER TABLE "Employee" ADD COLUMN "pensionAlimenticiaValor" DOUBLE PRECISION;
