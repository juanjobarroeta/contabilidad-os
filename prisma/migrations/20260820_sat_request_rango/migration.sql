-- El rango exacto que se le pidió al SAT.
--
-- La cuota 5002 ("solicitudes de por vida") se cuenta por (RFC + rango + tipo).
-- Cuando un mes ya la tiene quemada, la única salida por descarga masiva es
-- pedirlo en tramos — y entonces (year, month) ya no identifica la solicitud:
-- dos tramos del mismo mes son dos filas con el mismo (year, month, tipo).
--
-- Nulo en las filas existentes: no sabemos el rango con el que se pidieron
-- (era siempre el mes completo, pero no vamos a inventar el dato).
ALTER TABLE "SatSyncRequest" ADD COLUMN "desde" TIMESTAMP(3);
ALTER TABLE "SatSyncRequest" ADD COLUMN "hasta" TIMESTAMP(3);
