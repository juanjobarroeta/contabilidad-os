-- El expediente de la empresa: lo que un contador sabe de su cliente.
--
-- ExpedienteHecho: hechos duraderos VERSIONADOS POR VIGENCIA. Un hecho no se
-- edita: el vigente se cierra con `vigenteHasta` y se abre otro. Es la única
-- forma de contestar «¿desde cuándo tiene esa terminal?», que es la pregunta
-- que aparece en cuanto un cargo no cuadra con el contrato. `verificado` marca
-- lo que confirmó una persona: ni el motor ni el agente lo vuelven a tocar.
--
-- ExpedienteNota: la bitácora. Una nota `pendiente` con estado `abierta` es un
-- COMPROMISO, y la siguiente pasada lo lee antes que nada — es lo que evita que
-- cada corrida empiece de cero y vuelva a reportar lo que ya se decidió dejar.
--
-- Ambas con FK a Company y cascada: es operación de la empresa, no bitácora de
-- seguridad.

-- CreateTable
CREATE TABLE "ExpedienteHecho" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clave" TEXT NOT NULL,
    "valor" JSONB NOT NULL,
    "fuente" TEXT NOT NULL DEFAULT 'motor',
    "evidencia" TEXT[],
    "vigenteDesde" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vigenteHasta" TIMESTAMP(3),
    "confianza" TEXT NOT NULL DEFAULT 'media',
    "verificado" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ExpedienteHecho_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpedienteNota" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "autor" TEXT NOT NULL DEFAULT 'motor',
    "autorId" TEXT,
    "tipo" TEXT NOT NULL,
    "tema" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "cuerpo" TEXT NOT NULL,
    "refs" TEXT[],
    "estado" TEXT NOT NULL DEFAULT 'abierta',
    "resueltaAt" TIMESTAMP(3),
    "resueltaPorNotaId" TEXT,

    CONSTRAINT "ExpedienteNota_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExpedienteHecho_companyId_clave_vigenteHasta_idx" ON "ExpedienteHecho"("companyId", "clave", "vigenteHasta");

-- CreateIndex
CREATE INDEX "ExpedienteHecho_companyId_vigenteHasta_idx" ON "ExpedienteHecho"("companyId", "vigenteHasta");

-- CreateIndex
CREATE INDEX "ExpedienteNota_companyId_createdAt_idx" ON "ExpedienteNota"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "ExpedienteNota_companyId_estado_tipo_idx" ON "ExpedienteNota"("companyId", "estado", "tipo");

-- CreateIndex
CREATE INDEX "ExpedienteNota_companyId_tema_createdAt_idx" ON "ExpedienteNota"("companyId", "tema", "createdAt");

-- AddForeignKey
ALTER TABLE "ExpedienteHecho" ADD CONSTRAINT "ExpedienteHecho_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpedienteNota" ADD CONSTRAINT "ExpedienteNota_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

