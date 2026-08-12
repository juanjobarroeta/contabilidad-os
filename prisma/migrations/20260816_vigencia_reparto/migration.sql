-- Reparto justo del barrido de vigencia (cancelaciones por UUID).
--
-- Cursor por empresa: cada corrida atiende a las de barrido más antiguo, de
-- modo que la espera de una empresa dependa del número de EMPRESAS y no del
-- tamaño total del portafolio de facturas.
ALTER TABLE "Company" ADD COLUMN "vigenciaBarridoAt" TIMESTAMP(3);

-- Selección por empresa ordenada por antigüedad de verificación: sin este
-- índice, elegir las facturas pendientes de una empresa recorre su archivo
-- completo (y a escala eso es un scan por corrida y por empresa).
CREATE INDEX "Invoice_companyId_vigenciaCheckedAt_idx"
  ON "Invoice" ("companyId", "vigenciaCheckedAt");

-- Orden de rotación entre empresas (nulls primero: nunca barridas al frente).
CREATE INDEX "Company_vigenciaBarridoAt_idx" ON "Company" ("vigenciaBarridoAt");
