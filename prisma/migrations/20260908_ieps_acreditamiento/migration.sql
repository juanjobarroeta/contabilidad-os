-- El acreditamiento del IEPS (Art. 4º LIEPS) es una DECISIÓN del contador, no
-- un dato que se deduzca del régimen: sólo procede para ciertos incisos y para
-- quien es contribuyente del mismo bien. Nace en NULL a propósito — «sin
-- decidir» no es «no acredita», y el cierre distingue las dos cosas.
ALTER TABLE "Company" ADD COLUMN "iepsAcredita" BOOLEAN;
ALTER TABLE "Company" ADD COLUMN "iepsAcreditaAt" TIMESTAMP(3);
ALTER TABLE "Company" ADD COLUMN "iepsAcreditaPor" TEXT;
ALTER TABLE "Company" ADD COLUMN "iepsAcreditaNota" TEXT;

-- Congela con qué criterio se presentó el IEPS del periodo (desglose por tasa +
-- la decisión de acreditamiento vigente al presentar). Cambiar la decisión
-- después no puede reescribir lo ya declarado.
ALTER TABLE "TaxDeclaration" ADD COLUMN "iepsDetalle" JSONB;
