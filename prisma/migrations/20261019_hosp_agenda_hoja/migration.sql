-- Hoja de quirófano/endoscopia en la cita: anestesiólogo (con confirmación),
-- tipo de anestesia, enfermera, instrumentista, diagnóstico, estancia, cama
-- e insumos con su origen.
CREATE TYPE "HospCitaEstancia" AS ENUM ('AMBULATORIA', 'HOSPITALIZACION');

ALTER TABLE "HospCita"
  ADD COLUMN "anestesiologoId" TEXT,
  ADD COLUMN "anestesiologoConfirmado" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "tipoAnestesia" INTEGER,
  ADD COLUMN "enfermera" TEXT,
  ADD COLUMN "solicitaInstrumentista" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "instrumentista" TEXT,
  ADD COLUMN "diagnostico" TEXT,
  ADD COLUMN "estancia" "HospCitaEstancia",
  ADD COLUMN "camaId" TEXT,
  ADD COLUMN "insumos" JSONB;

ALTER TABLE "HospCita" ADD CONSTRAINT "HospCita_anestesiologoId_fkey" FOREIGN KEY ("anestesiologoId") REFERENCES "HospMedico"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HospCita" ADD CONSTRAINT "HospCita_camaId_fkey" FOREIGN KEY ("camaId") REFERENCES "HospRecurso"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Permiso nuevo AGENDA_PROGRAMAR: programar y mover citas deja de colgar de
-- CLINICA_ESCRIBIR. Para no quitarle la agenda a nadie el día del despliegue,
-- lo recibe quien hoy ya puede programar (escribe en lo clínico, ve la agenda
-- y no es de sólo lectura). Después el administrador lo recorta en Usuarios.
UPDATE "HospPuesto"
SET "permisos" = array_append("permisos", 'AGENDA_PROGRAMAR')
WHERE 'CLINICA_ESCRIBIR' = ANY("permisos")
  AND ("todasLasPaginas" OR 'agenda' = ANY("paginas"))
  AND NOT ('AGENDA_PROGRAMAR' = ANY("permisos"));

UPDATE "CompanyMember" m
SET "hospitalPermisos" = array_append(m."hospitalPermisos", 'AGENDA_PROGRAMAR')
WHERE m."role" <> 'VIEWER'
  AND 'CLINICA_ESCRIBIR' = ANY(m."hospitalPermisos")
  AND (cardinality(m."hospitalPaginas") = 0 OR 'agenda' = ANY(m."hospitalPaginas"))
  AND NOT ('AGENDA_PROGRAMAR' = ANY(m."hospitalPermisos"))
  AND (
    m."hospitalPuestoId" IS NULL
    OR EXISTS (SELECT 1 FROM "HospPuesto" p WHERE p."id" = m."hospitalPuestoId" AND 'AGENDA_PROGRAMAR' = ANY(p."permisos"))
  );
