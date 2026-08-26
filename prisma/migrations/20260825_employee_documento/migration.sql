-- Expediente documental del empleado: contrato firmado, identificación, CSF,
-- alta del IMSS — lo que una inspección de la STPS o el despacho piden en
-- papel. Bytes en la BD (bytea) por ahora, mismo patrón que los acuses de
-- declaración; el TODO de migrar a R2 es el mismo de ahí.
CREATE TABLE "EmployeeDocumento" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tipo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "archivo" BYTEA NOT NULL,
    CONSTRAINT "EmployeeDocumento_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmployeeDocumento_employeeId_idx" ON "EmployeeDocumento"("employeeId");
CREATE INDEX "EmployeeDocumento_companyId_createdAt_idx" ON "EmployeeDocumento"("companyId", "createdAt");
ALTER TABLE "EmployeeDocumento" ADD CONSTRAINT "EmployeeDocumento_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmployeeDocumento" ADD CONSTRAINT "EmployeeDocumento_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
