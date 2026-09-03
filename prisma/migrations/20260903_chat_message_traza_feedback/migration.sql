-- Traza del turno del copiloto (tools + fundamentos recuperados) y feedback
-- del contador sobre cada respuesta. Base del eval del copiloto (Fase 0).
ALTER TABLE "ChatMessage" ADD COLUMN "meta" JSONB;
ALTER TABLE "ChatMessage" ADD COLUMN "feedback" TEXT;
ALTER TABLE "ChatMessage" ADD COLUMN "correccion" TEXT;
ALTER TABLE "ChatMessage" ADD COLUMN "feedbackAt" TIMESTAMP(3);
