-- El acuse PDF de la opinión 32-D / CSF / opinión IMSS vive en la base, como el
-- de las declaraciones (TaxDeclaration.acusePdf). Antes sólo se guardaba la
-- referencia al archivo en Syntage (acuseUrl), que muere al dejar el proveedor.
-- Aditiva y nullable: los snapshots viejos se rellenan por el sync (gap-fill).
ALTER TABLE "ComplianceSnapshot" ADD COLUMN IF NOT EXISTS "acusePdf" BYTEA;
ALTER TABLE "ComplianceSnapshot" ADD COLUMN IF NOT EXISTS "acusePdfNombre" TEXT;
