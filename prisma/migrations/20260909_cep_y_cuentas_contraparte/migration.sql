-- CEP de Banxico guardado como comprobante, y directorio CLABE → contraparte.
--
-- El CEP se consultaba, se le sacaban RFC/nombre/concepto y el XML firmado se
-- tiraba. Ese XML es la prueba de materialidad de un pago; ahora se conserva.
--
-- CuentaContraparte reemplaza el escaneo en vivo de `clabesConocidasPorRfc`
-- por un directorio consultable y corregible: una CLABE es de una sola
-- contraparte (unique por empresa), y una contraparte puede tener varias.

CREATE TABLE "CuentaContraparte" (
  "id"        TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "clabe"     TEXT NOT NULL,
  "rfc"       TEXT,
  "nombre"    TEXT,
  "banco"     TEXT,
  "origen"    TEXT NOT NULL DEFAULT 'CEP',
  CONSTRAINT "CuentaContraparte_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CuentaContraparte_companyId_clabe_key"
  ON "CuentaContraparte"("companyId", "clabe");
CREATE INDEX "CuentaContraparte_companyId_rfc_idx"
  ON "CuentaContraparte"("companyId", "rfc");

ALTER TABLE "CuentaContraparte"
  ADD CONSTRAINT "CuentaContraparte_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CepMovimiento" (
  "id"                 TEXT NOT NULL,
  "bankTransactionId"  TEXT NOT NULL,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "estado"             TEXT,
  "fechaOperacion"     TEXT,
  "concepto"           TEXT,
  "monto"              DECIMAL(18,2),
  "ordenanteNombre"    TEXT,
  "ordenanteRfc"       TEXT,
  "ordenanteCuenta"    TEXT,
  "ordenanteBanco"     TEXT,
  "beneficiarioNombre" TEXT,
  "beneficiarioRfc"    TEXT,
  "beneficiarioCuenta" TEXT,
  "beneficiarioBanco"  TEXT,
  "xml"                TEXT NOT NULL,
  CONSTRAINT "CepMovimiento_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CepMovimiento_bankTransactionId_key"
  ON "CepMovimiento"("bankTransactionId");

ALTER TABLE "CepMovimiento"
  ADD CONSTRAINT "CepMovimiento_bankTransactionId_fkey"
  FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
