-- El despacho es la cuenta del copiloto jurídico: un caso lo trabaja un equipo.
-- Hasta aquí un caso era de UNA persona y no había forma de repartir trabajo
-- sin compartir la contraseña.
--
-- El backfill deja a cada abogado que ya usaba el producto con su propio
-- despacho (él como socio) y sus casos y clientes dentro: para él no cambia
-- nada, y ya puede invitar a su equipo.

CREATE TABLE "JuridicoDespacho" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "creadoPorUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JuridicoDespacho_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JuridicoDespacho_creadoPorUserId_idx" ON "JuridicoDespacho"("creadoPorUserId");

CREATE TABLE "JuridicoMiembro" (
    "id" TEXT NOT NULL,
    "despachoId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rol" TEXT NOT NULL DEFAULT 'abogado',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JuridicoMiembro_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "JuridicoMiembro_despachoId_userId_key" ON "JuridicoMiembro"("despachoId", "userId");
CREATE INDEX "JuridicoMiembro_userId_idx" ON "JuridicoMiembro"("userId");

ALTER TABLE "JuridicoMiembro" ADD CONSTRAINT "JuridicoMiembro_despachoId_fkey" FOREIGN KEY ("despachoId") REFERENCES "JuridicoDespacho"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JuridicoMiembro" ADD CONSTRAINT "JuridicoMiembro_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Caso y cliente pertenecen al despacho (el userId se queda: es quién lo abrió).
ALTER TABLE "JuridicoAsunto" ADD COLUMN "despachoId" TEXT;
ALTER TABLE "JuridicoCliente" ADD COLUMN "despachoId" TEXT;
CREATE INDEX "JuridicoAsunto_despachoId_updatedAt_idx" ON "JuridicoAsunto"("despachoId", "updatedAt");
CREATE INDEX "JuridicoAsunto_despachoId_estado_idx" ON "JuridicoAsunto"("despachoId", "estado");
CREATE INDEX "JuridicoCliente_despachoId_nombreNormalizado_idx" ON "JuridicoCliente"("despachoId", "nombreNormalizado");
ALTER TABLE "JuridicoAsunto" ADD CONSTRAINT "JuridicoAsunto_despachoId_fkey" FOREIGN KEY ("despachoId") REFERENCES "JuridicoDespacho"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "JuridicoCliente" ADD CONSTRAINT "JuridicoCliente_despachoId_fkey" FOREIGN KEY ("despachoId") REFERENCES "JuridicoDespacho"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Backfill: un despacho por cada quien ya tiene acceso al jurídico.
INSERT INTO "JuridicoDespacho" ("id", "nombre", "creadoPorUserId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text,
       'Despacho de ' || COALESCE(NULLIF(TRIM(u."name"), ''), split_part(COALESCE(u."email", 'abogado'), '@', 1)),
       u."id", now(), now()
  FROM "User" u
 WHERE u."accesoJuridico" = true
    OR EXISTS (SELECT 1 FROM "JuridicoAsunto" a WHERE a."userId" = u."id");

INSERT INTO "JuridicoMiembro" ("id", "despachoId", "userId", "rol", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, d."id", d."creadoPorUserId", 'socio', now(), now()
  FROM "JuridicoDespacho" d;

UPDATE "JuridicoAsunto" a
   SET "despachoId" = d."id"
  FROM "JuridicoDespacho" d
 WHERE d."creadoPorUserId" = a."userId" AND a."despachoId" IS NULL;

UPDATE "JuridicoCliente" c
   SET "despachoId" = d."id"
  FROM "JuridicoDespacho" d
 WHERE d."creadoPorUserId" = c."userId" AND c."despachoId" IS NULL;
