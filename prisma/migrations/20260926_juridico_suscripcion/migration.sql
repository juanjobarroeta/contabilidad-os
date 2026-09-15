-- La suscripción del despacho: se cobra por asiento y el despacho nace en
-- prueba. Los que ya existen quedan en prueba con 14 días desde hoy, para que
-- nadie se quede fuera por desplegar esto.
ALTER TABLE "JuridicoDespacho" ADD COLUMN "plan" TEXT NOT NULL DEFAULT 'prueba';
ALTER TABLE "JuridicoDespacho" ADD COLUMN "pruebaHasta" TIMESTAMP(3);
ALTER TABLE "JuridicoDespacho" ADD COLUMN "asientos" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "JuridicoDespacho" ADD COLUMN "stripeCustomerId" TEXT;
ALTER TABLE "JuridicoDespacho" ADD COLUMN "stripeSubscriptionId" TEXT;
ALTER TABLE "JuridicoDespacho" ADD COLUMN "periodoFin" TIMESTAMP(3);

CREATE INDEX "JuridicoDespacho_stripeSubscriptionId_idx" ON "JuridicoDespacho"("stripeSubscriptionId");
CREATE INDEX "JuridicoDespacho_plan_idx" ON "JuridicoDespacho"("plan");

UPDATE "JuridicoDespacho" SET "pruebaHasta" = now() + interval '14 days' WHERE "pruebaHasta" IS NULL;
