-- Onboarding con mascota: progreso por usuario (pantalla, empresa en alta,
-- perfil, tono y piel del copiloto) para retomar donde se quedó al recargar.
ALTER TABLE "User" ADD COLUMN "onboarding" JSONB;
