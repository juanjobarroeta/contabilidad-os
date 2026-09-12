-- Acceso al copiloto jurídico sin ser operador.
ALTER TABLE "User" ADD COLUMN "accesoJuridico" BOOLEAN NOT NULL DEFAULT false;
