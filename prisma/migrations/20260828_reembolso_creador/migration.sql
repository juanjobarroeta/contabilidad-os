-- Dueño de cada caja chica / reembolso semanal (User id, sin FK — patrón
-- aprobadaPorId): quien la abre es el único, además de los admins, que puede
-- editarla y subirle gastos. Aditivo: filas históricas quedan NULL (sólo
-- admins escriben en ellas, como hasta ahora).
ALTER TABLE "ReembolsoSemanal" ADD COLUMN "creadaPorId" TEXT;
