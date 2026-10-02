-- Mano de obra de construcción: trabajadores con tarifa, asistencia diaria
-- por obra y rayas calculadas desde la asistencia.
--
-- Trabajador: registro único por empresa (tarifa por día u hora).
-- Asistencia: horas de un trabajador un día en una obra (reparte el costo
-- por proyecto cuando alguien trabaja en dos obras).
-- CuadrillaMiembro.trabajadorId: liga cada miembro de cuadrilla a su
-- trabajador (null en miembros anteriores capturados sólo con nombre).
-- RayaSemanal.total: monto pagable de la raya (totalJornales + totalDestajo).
-- RayaSemanal.pagoRegistradoAt/referenciaPago: pago registrado por tesorería
-- sin crear movimiento bancario.
-- RayaDetalleMiembro.horas/horasExtra/descuento: desglose del jornal.

-- CreateEnum
CREATE TYPE "TrabajadorTipoPago" AS ENUM ('DIA', 'HORA');

-- AlterTable
ALTER TABLE "CuadrillaMiembro" ADD COLUMN     "trabajadorId" TEXT;

-- AlterTable
ALTER TABLE "RayaSemanal" ADD COLUMN     "pagoRegistradoAt" TIMESTAMP(3),
ADD COLUMN     "referenciaPago" TEXT,
ADD COLUMN     "total" DECIMAL(18,6) NOT NULL DEFAULT 0,
ADD COLUMN     "totalJornales" DECIMAL(18,6) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "RayaDetalleMiembro" ADD COLUMN     "descuento" DECIMAL(18,6) NOT NULL DEFAULT 0,
ADD COLUMN     "horas" DECIMAL(18,6) NOT NULL DEFAULT 0,
ADD COLUMN     "horasExtra" DECIMAL(18,6) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Trabajador" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "nombre" TEXT NOT NULL,
    "telefono" TEXT,
    "especialidad" TEXT,
    "tipoPago" "TrabajadorTipoPago" NOT NULL DEFAULT 'DIA',
    "tarifa" DECIMAL(18,6) NOT NULL,
    "horasJornada" DECIMAL(18,6) NOT NULL DEFAULT 8,
    "employeeId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Trabajador_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asistencia" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "trabajadorId" TEXT NOT NULL,
    "proyectoId" TEXT NOT NULL,
    "cuadrillaId" TEXT,
    "fecha" DATE NOT NULL,
    "horas" DECIMAL(18,6) NOT NULL,
    "horasExtra" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "notas" TEXT,
    "capturadaPorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asistencia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Trabajador_companyId_isActive_idx" ON "Trabajador"("companyId", "isActive");

-- CreateIndex
CREATE INDEX "Asistencia_proyectoId_fecha_idx" ON "Asistencia"("proyectoId", "fecha");

-- CreateIndex
CREATE INDEX "Asistencia_cuadrillaId_fecha_idx" ON "Asistencia"("cuadrillaId", "fecha");

-- CreateIndex
CREATE INDEX "Asistencia_companyId_fecha_idx" ON "Asistencia"("companyId", "fecha");

-- CreateIndex
CREATE UNIQUE INDEX "Asistencia_trabajadorId_proyectoId_fecha_key" ON "Asistencia"("trabajadorId", "proyectoId", "fecha");

-- CreateIndex
CREATE INDEX "CuadrillaMiembro_trabajadorId_idx" ON "CuadrillaMiembro"("trabajadorId");

-- AddForeignKey
ALTER TABLE "CuadrillaMiembro" ADD CONSTRAINT "CuadrillaMiembro_trabajadorId_fkey" FOREIGN KEY ("trabajadorId") REFERENCES "Trabajador"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trabajador" ADD CONSTRAINT "Trabajador_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trabajador" ADD CONSTRAINT "Trabajador_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asistencia" ADD CONSTRAINT "Asistencia_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asistencia" ADD CONSTRAINT "Asistencia_trabajadorId_fkey" FOREIGN KEY ("trabajadorId") REFERENCES "Trabajador"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asistencia" ADD CONSTRAINT "Asistencia_proyectoId_fkey" FOREIGN KEY ("proyectoId") REFERENCES "Proyecto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asistencia" ADD CONSTRAINT "Asistencia_cuadrillaId_fkey" FOREIGN KEY ("cuadrillaId") REFERENCES "Cuadrilla"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: las rayas existentes valen lo que valían (su destajo). Sus
-- detalles eran el reparto de ese destajo, no un pago adicional, así que
-- totalJornales se queda en 0 y el total no cambia.
UPDATE "RayaSemanal" SET "total" = "totalDestajo";
