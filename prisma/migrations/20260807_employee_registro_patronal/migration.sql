-- Registro patronal IMSS por empleado (empresas multi-estado tienen un
-- registro por centro de trabajo). Aditivo y nullable: null = el de la empresa.
ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "registroPatronal" TEXT;
