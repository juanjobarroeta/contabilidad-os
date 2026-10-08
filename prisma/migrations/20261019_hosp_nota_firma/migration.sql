-- Firma autógrafa digital del autor sobre la nota clínica sellada.
ALTER TABLE "HospNota" ADD COLUMN "firmaImagen" TEXT,
ADD COLUMN "firmaHash" TEXT,
ADD COLUMN "firmadaAt" TIMESTAMP(3),
ADD COLUMN "firmaIp" TEXT,
ADD COLUMN "firmaUserAgent" TEXT;
