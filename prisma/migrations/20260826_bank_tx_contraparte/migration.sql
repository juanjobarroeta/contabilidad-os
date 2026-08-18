-- Contraparte del movimiento bancario, extraída de la descripción.
--
-- El banco ya escribe estos campos etiquetados dentro de `descripcion`; hasta
-- ahora se guardaban como una sola cadena. Aditiva: todo nullable, sin default,
-- sin tocar datos existentes. El backfill los llena después leyendo las
-- descripciones que ya están guardadas.

ALTER TABLE "BankTransaction"
  ADD COLUMN "claveRastreo"      TEXT,
  ADD COLUMN "contraparteNombre" TEXT,
  ADD COLUMN "contraparteRfc"    TEXT,
  ADD COLUMN "contraparteClabe"  TEXT,
  ADD COLUMN "contraparteBanco"  TEXT,
  ADD COLUMN "conceptoPago"      TEXT,
  ADD COLUMN "lineaCaptura"      TEXT,
  -- Marca de intento del backfill: se sella aunque no se extraiga nada, o las
  -- descripciones sin contraparte (efectivo, comisiones) reentrarían en cada
  -- corrida y el barrido giraría sobre las mismas filas para siempre.
  ADD COLUMN "contraparteAt"     TIMESTAMP(3);

-- El barrido busca exactamente esto: lo que aún no se ha intentado.
CREATE INDEX "BankTransaction_contraparteAt_idx"
  ON "BankTransaction" ("contraparteAt")
  WHERE "contraparteAt" IS NULL;

-- «¿Qué movimientos son de este RFC?» — la consulta caliente del scoring, y la
-- que usa el backfill para encontrar lo que aún no tiene contraparte.
CREATE INDEX "BankTransaction_companyId_contraparteRfc_idx"
  ON "BankTransaction" ("companyId", "contraparteRfc");

-- La comisión por transferencia comparte clave de rastreo con el envío que la
-- generó: por aquí se encuentra su transferencia. También es la llave del CEP.
CREATE INDEX "BankTransaction_bankAccountId_claveRastreo_idx"
  ON "BankTransaction" ("bankAccountId", "claveRastreo");
