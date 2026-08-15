-- Folios que EXISTEN en el SAT y de los que NO tenemos el documento.
--
-- Va en su propia tabla y NO en "Invoice" a propósito: una factura sin XML
-- metida ahí entra a los totales, al motor de posteo y a la balanza, y suma
-- pesos que nadie puede documentar.
--
-- Para 2017-2021 el SAT ya no sirve nada (la descarga masiva topa a cinco
-- años), así que un folio de ese tramo que no quede anotado desaparece en
-- silencio. El censo de Syntage trae fecha, tipo, importe y estatus aunque el
-- XML ya no se pueda bajar: es la única memoria posible.

CREATE TABLE "CfdiFaltante" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "uuid" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "tipoSat" TEXT,
    "total" DOUBLE PRECISION,
    "estatus" TEXT,
    "origen" TEXT NOT NULL DEFAULT 'Syntage',
    "motivo" TEXT NOT NULL,
    "intentos" INTEGER NOT NULL DEFAULT 1,
    "detectadoAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimoIntento" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CfdiFaltante_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CfdiFaltante_companyId_uuid_key" ON "CfdiFaltante"("companyId", "uuid");
CREATE INDEX "CfdiFaltante_companyId_motivo_idx" ON "CfdiFaltante"("companyId", "motivo");
CREATE INDEX "CfdiFaltante_companyId_fecha_idx" ON "CfdiFaltante"("companyId", "fecha");

ALTER TABLE "CfdiFaltante" ADD CONSTRAINT "CfdiFaltante_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
