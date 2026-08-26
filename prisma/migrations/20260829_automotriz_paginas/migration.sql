-- Páginas visibles del satélite automotriz por miembro (vacío = sin restricción)
ALTER TABLE "CompanyMember" ADD COLUMN "automotrizPaginas" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
