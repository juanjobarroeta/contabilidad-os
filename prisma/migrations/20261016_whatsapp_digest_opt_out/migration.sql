-- Resumen matutino por WhatsApp: de opt-in (nadie lo activó) a opt-out.
ALTER TABLE "WhatsappLink" ADD COLUMN "digestOptOut" BOOLEAN NOT NULL DEFAULT false;
