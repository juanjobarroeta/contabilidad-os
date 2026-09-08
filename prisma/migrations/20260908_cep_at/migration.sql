-- Marca de intento de consulta al CEP de Banxico (evita re-consultar lo que no existe).
ALTER TABLE "BankTransaction" ADD COLUMN "cepAt" TIMESTAMP(3);
