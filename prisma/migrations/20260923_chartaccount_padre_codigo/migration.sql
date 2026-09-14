-- SubCtaDe del Anexo 24: la clave de la cuenta padre, para que la jerarquía del catálogo propio sea exacta.
ALTER TABLE "ChartAccount" ADD COLUMN "padreCodigo" TEXT;
