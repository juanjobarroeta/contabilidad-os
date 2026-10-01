-- Puestos del hospital: roles vivos (páginas + permisos) y el puesto/ajustes de cada miembro.
CREATE TABLE "HospPuesto" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "todasLasPaginas" BOOLEAN NOT NULL DEFAULT false,
    "paginas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "permisos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HospPuesto_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HospPuesto_companyId_nombre_key" ON "HospPuesto"("companyId", "nombre");
ALTER TABLE "HospPuesto" ADD CONSTRAINT "HospPuesto_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CompanyMember" ADD COLUMN "hospitalPuestoId" TEXT;
ALTER TABLE "CompanyMember" ADD COLUMN "hospitalAjustes" JSONB;
ALTER TABLE "CompanyMember" ADD CONSTRAINT "CompanyMember_hospitalPuestoId_fkey" FOREIGN KEY ("hospitalPuestoId") REFERENCES "HospPuesto"("id") ON DELETE SET NULL ON UPDATE CASCADE;
