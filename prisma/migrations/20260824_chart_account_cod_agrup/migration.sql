-- El CT de la empresa declara el código agrupador del SAT de CADA cuenta
-- propia (4101-0027 → "401.01"). El import lo parseaba y lo TIRABA — sólo lo
-- usaba para derivar el tipo. Persistirlo es la Fase 0 de mover el motor de
-- posteo al plan de cuentas de la empresa: la resolución invierte
-- agrupador → cuenta propia, y esa inversión sale de aquí.
ALTER TABLE "ChartAccount" ADD COLUMN "codAgrup" TEXT;
