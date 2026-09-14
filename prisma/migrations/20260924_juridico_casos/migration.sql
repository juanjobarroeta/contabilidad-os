-- Fase 1 del copiloto jurídico: el CASO es el contenedor (varias
-- conversaciones, documentos, partes y tareas), el CLIENTE vive en un
-- directorio reutilizable, cada versión de un documento tiene autor y cada
-- caso lleva una bitácora que sólo se agrega.
--
-- La tabla JuridicoAsunto NO se renombra a propósito: el modelo de Prisma se
-- llama JuridicoCaso y la mapea (@@map). Renombrarla obligaría a parar el
-- producto durante el rollover, porque el contenedor viejo sigue consultando
-- el nombre viejo mientras el nuevo arranca.

-- ── Caso: estado, responsable, cliente del directorio.
ALTER TABLE "JuridicoAsunto" ADD COLUMN "clienteId" TEXT;
ALTER TABLE "JuridicoAsunto" ADD COLUMN "estado" TEXT NOT NULL DEFAULT 'abierto';
ALTER TABLE "JuridicoAsunto" ADD COLUMN "responsableUserId" TEXT;
ALTER TABLE "JuridicoAsunto" ADD COLUMN "cerradoAt" TIMESTAMP(3);

-- ── Directorio de clientes del despacho.
CREATE TABLE "JuridicoCliente" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tipoPersona" TEXT NOT NULL DEFAULT 'fisica',
    "nombre" TEXT NOT NULL,
    "nombreNormalizado" TEXT NOT NULL,
    "rfc" TEXT,
    "curp" TEXT,
    "domicilio" TEXT,
    "representante" TEXT,
    "email" TEXT,
    "telefono" TEXT,
    "notas" TEXT,
    "verificado" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JuridicoCliente_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JuridicoCliente_userId_nombreNormalizado_idx" ON "JuridicoCliente"("userId", "nombreNormalizado");
CREATE INDEX "JuridicoCliente_userId_rfc_idx" ON "JuridicoCliente"("userId", "rfc");
CREATE INDEX "JuridicoCliente_userId_updatedAt_idx" ON "JuridicoCliente"("userId", "updatedAt");

-- ── Tareas del caso.
CREATE TABLE "JuridicoTarea" (
    "id" TEXT NOT NULL,
    "casoId" TEXT NOT NULL,
    "creadaPorUserId" TEXT NOT NULL,
    "asignadoUserId" TEXT,
    "titulo" TEXT NOT NULL,
    "detalle" TEXT,
    "estado" TEXT NOT NULL DEFAULT 'por_hacer',
    "prioridad" TEXT NOT NULL DEFAULT 'normal',
    "vence" TIMESTAMP(3),
    "documentoId" TEXT,
    "origen" TEXT NOT NULL DEFAULT 'manual',
    "hechaAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JuridicoTarea_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JuridicoTarea_casoId_estado_idx" ON "JuridicoTarea"("casoId", "estado");
CREATE INDEX "JuridicoTarea_asignadoUserId_estado_vence_idx" ON "JuridicoTarea"("asignadoUserId", "estado", "vence");
CREATE INDEX "JuridicoTarea_casoId_vence_idx" ON "JuridicoTarea"("casoId", "vence");

-- ── Versiones con autor (antes: JuridicoDocumento.versiones, JSON sin autor).
CREATE TABLE "JuridicoDocumentoVersion" (
    "id" TEXT NOT NULL,
    "documentoId" TEXT NOT NULL,
    "n" INTEGER NOT NULL,
    "texto" TEXT NOT NULL,
    "plan" JSONB,
    "autorUserId" TEXT,
    "autorTipo" TEXT NOT NULL DEFAULT 'abogado',
    "autorNombre" TEXT,
    "motivo" TEXT,
    "seccionesCambiadas" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JuridicoDocumentoVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "JuridicoDocumentoVersion_documentoId_n_key" ON "JuridicoDocumentoVersion"("documentoId", "n");
CREATE INDEX "JuridicoDocumentoVersion_documentoId_createdAt_idx" ON "JuridicoDocumentoVersion"("documentoId", "createdAt");

-- ── Bitácora del caso (append-only).
CREATE TABLE "JuridicoBitacora" (
    "id" TEXT NOT NULL,
    "casoId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorTipo" TEXT NOT NULL DEFAULT 'abogado',
    "actorNombre" TEXT,
    "accion" TEXT NOT NULL,
    "entidad" TEXT,
    "entidadId" TEXT,
    "resumen" TEXT NOT NULL,
    "datos" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JuridicoBitacora_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JuridicoBitacora_casoId_createdAt_idx" ON "JuridicoBitacora"("casoId", "createdAt");
CREATE INDEX "JuridicoBitacora_casoId_entidad_entidadId_idx" ON "JuridicoBitacora"("casoId", "entidad", "entidadId");

-- ── Parte: a qué cliente del directorio corresponde.
ALTER TABLE "JuridicoParte" ADD COLUMN "clienteId" TEXT;
CREATE INDEX "JuridicoParte_clienteId_idx" ON "JuridicoParte"("clienteId");

-- ── Documento: a qué caso pertenece (se hereda de su conversación).
ALTER TABLE "JuridicoDocumento" ADD COLUMN "casoId" TEXT;
CREATE INDEX "JuridicoDocumento_casoId_createdAt_idx" ON "JuridicoDocumento"("casoId", "createdAt");

-- ── Llaves foráneas.
ALTER TABLE "JuridicoAsunto" ADD CONSTRAINT "JuridicoAsunto_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "JuridicoCliente"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "JuridicoAsunto_clienteId_idx" ON "JuridicoAsunto"("clienteId");
CREATE INDEX "JuridicoAsunto_userId_estado_idx" ON "JuridicoAsunto"("userId", "estado");
ALTER TABLE "JuridicoCliente" ADD CONSTRAINT "JuridicoCliente_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JuridicoTarea" ADD CONSTRAINT "JuridicoTarea_casoId_fkey" FOREIGN KEY ("casoId") REFERENCES "JuridicoAsunto"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JuridicoDocumentoVersion" ADD CONSTRAINT "JuridicoDocumentoVersion_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "JuridicoDocumento"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JuridicoBitacora" ADD CONSTRAINT "JuridicoBitacora_casoId_fkey" FOREIGN KEY ("casoId") REFERENCES "JuridicoAsunto"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JuridicoParte" ADD CONSTRAINT "JuridicoParte_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "JuridicoCliente"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "JuridicoDocumento" ADD CONSTRAINT "JuridicoDocumento_casoId_fkey" FOREIGN KEY ("casoId") REFERENCES "JuridicoAsunto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Backfill: cada documento hereda el caso de su conversación.
UPDATE "JuridicoDocumento" d
   SET "casoId" = c."asuntoId"
  FROM "JuridicoConversacion" c
 WHERE c."id" = d."conversacionId" AND c."asuntoId" IS NOT NULL;
