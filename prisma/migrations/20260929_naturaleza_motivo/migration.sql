-- Por qué la naturaleza fiscal necesita revisión, en texto. Aditiva y nullable:
-- lo ya importado se queda sin motivo y la ficha cae al aviso genérico.
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "naturalezaMotivo" TEXT;
