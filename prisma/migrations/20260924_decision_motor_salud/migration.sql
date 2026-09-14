-- Rastro de decisión de los motores + foto diaria de salud.
--
-- DecisionMotor: el POR QUÉ de cada decisión determinista (qué candidatos hubo,
-- cuál ganó, con qué regla se descartaron los otros). Append-only. `huella`
-- deduplica las decisiones repetibles —un rechazo se vuelve a tomar idéntico en
-- cada corrida— para que la tabla no crezca escribiendo lo mismo todos los días.
--
-- SaludSnapshot: una foto por empresa y por día (`dia` es el día calendario de
-- México, texto "YYYY-MM-DD"), con las ocho dimensiones evaluadas y el diff
-- contra la foto anterior. El único índice (companyId, dia) ES el candado de
-- "una vez al día".
--
-- Ambas con FK a Company y cascada: es operación, no bitácora de seguridad.

-- CreateTable
CREATE TABLE "DecisionMotor" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entidad" TEXT NOT NULL,
    "entidadId" TEXT NOT NULL,
    "motor" TEXT NOT NULL,
    "motorVersion" TEXT NOT NULL DEFAULT '1',
    "actor" TEXT NOT NULL DEFAULT 'motor',
    "actorId" TEXT,
    "accion" TEXT NOT NULL,
    "resultado" JSONB,
    "razones" JSONB NOT NULL,
    "refs" TEXT[],
    "huella" TEXT,

    CONSTRAINT "DecisionMotor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaludSnapshot" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "dia" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "estado" TEXT NOT NULL,
    "dimensiones" JSONB NOT NULL,
    "deltas" JSONB NOT NULL,
    "requiereAtencion" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SaludSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DecisionMotor_companyId_entidad_entidadId_createdAt_idx" ON "DecisionMotor"("companyId", "entidad", "entidadId", "createdAt");

-- CreateIndex
CREATE INDEX "DecisionMotor_companyId_createdAt_idx" ON "DecisionMotor"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "DecisionMotor_companyId_entidad_huella_idx" ON "DecisionMotor"("companyId", "entidad", "huella");

-- CreateIndex
CREATE INDEX "SaludSnapshot_companyId_createdAt_idx" ON "SaludSnapshot"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "SaludSnapshot_dia_requiereAtencion_idx" ON "SaludSnapshot"("dia", "requiereAtencion");

-- CreateIndex
CREATE UNIQUE INDEX "SaludSnapshot_companyId_dia_key" ON "SaludSnapshot"("companyId", "dia");

-- AddForeignKey
ALTER TABLE "DecisionMotor" ADD CONSTRAINT "DecisionMotor_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaludSnapshot" ADD CONSTRAINT "SaludSnapshot_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

