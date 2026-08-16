-- La serie mensual de las balanzas PRESENTADAS al SAT (Anexo 24).
--
-- Hasta hoy sólo la ÚLTIMA balanza entraba al sistema, y sólo como asiento de
-- apertura: la serie histórica (42 períodos de MARGOM) vivía únicamente en
-- Syntage. Con la serie completa en tabla:
--   • los estados financieros pueden leer lo PRESENTADO (CE-first), no lo que
--     el motor de posteo deriva de los CFDIs — que cubre ~26% del movimiento
--     y usa otro plan de cuentas (agrupador vs numeración propia);
--   • el conciliador por montos puede buscar el cargo de cada unidad del
--     padrón en el Debe mensual de cada cuenta («¿a qué cuenta entró este
--     camión de $1,851,538.79?»).
--
-- esPadre marca las cuentas de mayor cuyo saldo ya suma sus hijas: sumar
-- padres e hijas duplica todo (la trampa de los $1.9 mil millones).

CREATE TABLE "CeBalanzaMes" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "anio" INTEGER NOT NULL,
    "mes" INTEGER NOT NULL,
    "numCta" TEXT NOT NULL,
    "saldoIni" DOUBLE PRECISION NOT NULL,
    "debe" DOUBLE PRECISION NOT NULL,
    "haber" DOUBLE PRECISION NOT NULL,
    "saldoFin" DOUBLE PRECISION NOT NULL,
    "esPadre" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CeBalanzaMes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CeBalanzaMes_companyId_anio_mes_numCta_key"
    ON "CeBalanzaMes"("companyId", "anio", "mes", "numCta");

CREATE INDEX "CeBalanzaMes_companyId_numCta_idx"
    ON "CeBalanzaMes"("companyId", "numCta");

ALTER TABLE "CeBalanzaMes" ADD CONSTRAINT "CeBalanzaMes_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
