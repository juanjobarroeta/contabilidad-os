-- Solicitar una cancelación no es cancelar: un CFDI "cancelable con aceptación"
-- sigue VIGENTE en el SAT (y contando para IVA e ISR) hasta que el receptor
-- acepta o pasan 72 h. Estas dos columnas separan «lo pedimos» de «quedó
-- cancelado», y guardan lo último que el SAT dijo del proceso.
ALTER TABLE "Invoice" ADD COLUMN "cancelSolicitadaAt" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN "cancelEstadoSat" TEXT;
