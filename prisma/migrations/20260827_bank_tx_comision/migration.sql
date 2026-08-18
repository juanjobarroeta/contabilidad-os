-- La comisión pertenece a su transferencia.
--
-- El banco cobra la comisión del SPEI como movimiento APARTE pero con la misma
-- clave de rastreo del envío que la generó. Sin el vínculo, cada comisión queda
-- como un egreso suelto que alguien descarta a mano todos los meses.
--
-- NO lleva UNIQUE a propósito: una transferencia genera más de un cobro (la
-- comisión y su IVA), así que la relación es uno-a-varios.
--
-- Aditiva: nullable, sin default, sin tocar datos existentes.

ALTER TABLE "BankTransaction"
  ADD COLUMN "comisionDeId" TEXT;

ALTER TABLE "BankTransaction"
  ADD CONSTRAINT "BankTransaction_comisionDeId_fkey"
  FOREIGN KEY ("comisionDeId") REFERENCES "BankTransaction"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Prisma no crea índices de FK en PostgreSQL: sin esto, listar las comisiones
-- de una transferencia recorre la tabla entera.
CREATE INDEX "BankTransaction_comisionDeId_idx"
  ON "BankTransaction" ("comisionDeId");
