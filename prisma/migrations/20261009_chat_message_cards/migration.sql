-- Copiloto v2: tarjetas estructuradas y botones de acción por mensaje del
-- asistente (src/lib/copiloto/tarjetas.ts). Aditiva.
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "cards" JSONB;
