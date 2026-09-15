-- La forma estructurada de una nota del expediente.
--
-- El resumen de la pasada del contador se guardaba sólo como texto, porque el
-- texto es lo que lee una persona. Pero el rail necesita saber qué renglón se
-- atendió y cuál se escaló, y parsear prosa para averiguarlo es justo lo que el
-- esquema de `cerrar_pasada` existe para evitar. Ahora `cuerpo` es la versión
-- legible y `datos` la que se pinta.
--
-- Aditivo y nullable: las notas ya escritas siguen valiendo, sólo que el rail
-- no puede pintar su detalle.

-- AlterTable
ALTER TABLE "ExpedienteNota" ADD COLUMN     "datos" JSONB;

