-- Páginas visibles del satélite de construcción (bartiz) por miembro
-- (vacío = sin restricción extra: ve lo que su rol permite). Mismo patrón
-- que automotrizPaginas.
ALTER TABLE "CompanyMember" ADD COLUMN "construccionPaginas" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
