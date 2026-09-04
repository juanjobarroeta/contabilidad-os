-- CreateEnum
CREATE TYPE "HospRecursoTipo" AS ENUM ('CAMA', 'QUIROFANO', 'CONSULTORIO', 'SALA');

-- CreateEnum
CREATE TYPE "HospArea" AS ENUM ('HOSPITALIZACION', 'URGENCIAS', 'RECUPERACION', 'TERAPIA', 'QUIROFANO', 'CONSULTA_EXTERNA', 'ENDOSCOPIA', 'IMAGEN', 'LABORATORIO', 'OTRA');

-- CreateEnum
CREATE TYPE "HospRecursoEstado" AS ENUM ('LIBRE', 'OCUPADA', 'LIMPIEZA', 'FUERA_DE_SERVICIO');

-- CreateEnum
CREATE TYPE "HospSexo" AS ENUM ('FEMENINO', 'MASCULINO', 'OTRO');

-- CreateEnum
CREATE TYPE "HospPagadorTipo" AS ENUM ('ASEGURADORA', 'EMPRESA', 'PARTICULAR', 'GOBIERNO');

-- CreateEnum
CREATE TYPE "HospCargoCategoria" AS ENUM ('HABITACION', 'QUIROFANO', 'URGENCIAS', 'ESTUDIO', 'PROCEDIMIENTO', 'HONORARIO', 'FARMACIA', 'MATERIAL', 'EQUIPO', 'OTRO');

-- CreateEnum
CREATE TYPE "HospEpisodioTipo" AS ENUM ('HOSPITALIZACION', 'AMBULATORIO', 'URGENCIAS', 'CONSULTA');

-- CreateEnum
CREATE TYPE "HospEpisodioEstado" AS ENUM ('PROGRAMADO', 'EN_VALORACION', 'PREOPERATORIO', 'EN_QUIROFANO', 'POSTOPERATORIO', 'HOSPITALIZADO', 'ALTA', 'CANCELADO');

-- CreateEnum
CREATE TYPE "HospTrasladoTipo" AS ENUM ('INGRESO', 'TRASLADO', 'ALTA');

-- CreateEnum
CREATE TYPE "HospNotaTipo" AS ENUM ('INGRESO', 'EVOLUCION', 'PREOPERATORIA', 'POSTOPERATORIA', 'ENFERMERIA', 'INDICACION', 'INTERCONSULTA', 'PROCEDIMIENTO', 'MEDICAMENTO_APLICADO', 'EGRESO');

-- CreateEnum
CREATE TYPE "HospDocumentoTipo" AS ENUM ('CONSENTIMIENTO_CIRUGIA', 'CONSENTIMIENTO_ANESTESIA', 'IDENTIFICACION', 'POLIZA', 'CARTA_AUTORIZACION', 'ESTUDIO', 'RESULTADO', 'RECETA', 'NOTA_EGRESO', 'OTRO');

-- CreateEnum
CREATE TYPE "HospDocumentoEstado" AS ENUM ('PENDIENTE', 'RECIBIDO', 'FIRMADO');

-- CreateEnum
CREATE TYPE "HospCargoOrigen" AS ENUM ('EXPEDIENTE', 'ESTANCIA', 'FARMACIA', 'COTIZACION', 'MANUAL');

-- CreateEnum
CREATE TYPE "HospCitaTipo" AS ENUM ('CIRUGIA', 'CONSULTA', 'PROCEDIMIENTO', 'ESTUDIO', 'OTRO');

-- CreateEnum
CREATE TYPE "HospCitaEstado" AS ENUM ('PROGRAMADA', 'CONFIRMADA', 'EN_CURSO', 'TERMINADA', 'CANCELADA', 'NO_ASISTIO');

-- CreateEnum
CREATE TYPE "HospCotizacionEstado" AS ENUM ('BORRADOR', 'ENVIADA', 'ACEPTADA', 'CONVERTIDA', 'VENCIDA', 'CANCELADA');

-- CreateEnum
CREATE TYPE "HospInsumoCategoria" AS ENUM ('MEDICAMENTO', 'MATERIAL_CURACION', 'SOLUCION', 'EQUIPO', 'REACTIVO', 'OTRO');

-- CreateEnum
CREATE TYPE "HospMovimientoTipo" AS ENUM ('ENTRADA_COMPRA', 'SALIDA_APLICACION', 'SALIDA_VENTA', 'AJUSTE', 'MERMA', 'CADUCIDAD', 'DEVOLUCION');

-- CreateEnum
CREATE TYPE "HospTicketPrioridad" AS ENUM ('BAJA', 'MEDIA', 'ALTA', 'URGENTE');

-- CreateEnum
CREATE TYPE "HospTicketEstado" AS ENUM ('ABIERTO', 'ASIGNADO', 'EN_PROCESO', 'CERRADO', 'CANCELADO');

-- AlterEnum
ALTER TYPE "EntrySource" ADD VALUE 'HOSPITAL';

-- AlterEnum
ALTER TYPE "ModuloApp" ADD VALUE 'HOSPITAL';

-- AlterTable
ALTER TABLE "CompanyMember" ADD COLUMN     "hospitalPaginas" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "HospConfig" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "nombreHospital" TEXT,
    "serieEpisodio" TEXT NOT NULL DEFAULT 'HOSP',
    "serieCotizacion" TEXT NOT NULL DEFAULT 'COT',
    "serieTicket" TEXT NOT NULL DEFAULT 'MANT',
    "diasAlertaCaducidad" INTEGER NOT NULL DEFAULT 90,
    "topeAutorizacion" DECIMAL(18,6),
    "ivaServicios" DECIMAL(18,6) NOT NULL DEFAULT 0.16,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HospConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospRecurso" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "tipo" "HospRecursoTipo" NOT NULL,
    "area" "HospArea" NOT NULL,
    "nombre" TEXT NOT NULL,
    "estado" "HospRecursoEstado" NOT NULL DEFAULT 'LIBRE',
    "servicioId" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HospRecurso_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospPaciente" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "nombre" TEXT NOT NULL,
    "apellidoPaterno" TEXT NOT NULL,
    "apellidoMaterno" TEXT,
    "fechaNacimiento" TIMESTAMP(3),
    "sexo" "HospSexo",
    "curp" TEXT,
    "telefono" TEXT,
    "email" TEXT,
    "domicilio" TEXT,
    "tipoSangre" TEXT,
    "alergias" TEXT,
    "antecedentes" TEXT,
    "contactoEmergenciaNombre" TEXT,
    "contactoEmergenciaTelefono" TEXT,
    "contactoEmergenciaParentesco" TEXT,
    "customerId" TEXT,
    "pagadorId" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "notas" TEXT,

    CONSTRAINT "HospPaciente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospPagador" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "nombre" TEXT NOT NULL,
    "tipo" "HospPagadorTipo" NOT NULL,
    "customerId" TEXT,
    "tabulador" TEXT,
    "deducible" DECIMAL(18,6),
    "coaseguroPct" DECIMAL(18,6),
    "plazoDias" INTEGER NOT NULL DEFAULT 0,
    "topeAutorizacion" DECIMAL(18,6),
    "vigenciaInicio" TIMESTAMP(3),
    "vigenciaFin" TIMESTAMP(3),
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "notas" TEXT,

    CONSTRAINT "HospPagador_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospServicio" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "clave" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "categoria" "HospCargoCategoria" NOT NULL,
    "unidad" TEXT NOT NULL DEFAULT 'servicio',
    "precioLista" DECIMAL(18,6) NOT NULL,
    "ivaTasa" DECIMAL(18,6),
    "claveProdServ" TEXT,
    "claveUnidad" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "HospServicio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospTarifa" (
    "id" TEXT NOT NULL,
    "servicioId" TEXT NOT NULL,
    "pagadorId" TEXT NOT NULL,
    "precio" DECIMAL(18,6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HospTarifa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospMedico" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "nombre" TEXT NOT NULL,
    "especialidad" TEXT,
    "cedula" TEXT,
    "rfc" TEXT,
    "telefono" TEXT,
    "email" TEXT,
    "supplierId" TEXT,
    "employeeId" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "HospMedico_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospEpisodio" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "folio" TEXT NOT NULL,
    "pacienteId" TEXT NOT NULL,
    "tipo" "HospEpisodioTipo" NOT NULL,
    "estado" "HospEpisodioEstado" NOT NULL DEFAULT 'PROGRAMADO',
    "fechaIngreso" TIMESTAMP(3) NOT NULL,
    "fechaAlta" TIMESTAMP(3),
    "recursoId" TEXT,
    "medicoId" TEXT,
    "pagadorId" TEXT,
    "customerId" TEXT,
    "diagnosticoCie10" TEXT,
    "diagnostico" TEXT,
    "procedimiento" TEXT,
    "motivo" TEXT,
    "autorizacionPagador" TEXT,
    "cotizacionId" TEXT,
    "notasAdmin" TEXT,
    "creadoPorUserId" TEXT,

    CONSTRAINT "HospEpisodio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospTraslado" (
    "id" TEXT NOT NULL,
    "episodioId" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tipo" "HospTrasladoTipo" NOT NULL,
    "deRecursoId" TEXT,
    "deRecursoNombre" TEXT,
    "aRecursoId" TEXT,
    "aRecursoNombre" TEXT,
    "nota" TEXT,
    "usuarioId" TEXT,
    "usuarioNombre" TEXT,

    CONSTRAINT "HospTraslado_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospNota" (
    "id" TEXT NOT NULL,
    "episodioId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tipo" "HospNotaTipo" NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "texto" TEXT NOT NULL,
    "autorUserId" TEXT,
    "autorNombre" TEXT NOT NULL,
    "medicoId" TEXT,
    "cargoId" TEXT,
    "reemplazaId" TEXT,

    CONSTRAINT "HospNota_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospSignos" (
    "id" TEXT NOT NULL,
    "episodioId" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "taSistolica" INTEGER,
    "taDiastolica" INTEGER,
    "fc" INTEGER,
    "fr" INTEGER,
    "temperatura" DECIMAL(5,2),
    "spo2" INTEGER,
    "glucosa" INTEGER,
    "peso" DECIMAL(6,2),
    "talla" DECIMAL(5,2),
    "dolor" INTEGER,
    "nota" TEXT,
    "registradoPorUserId" TEXT,
    "registradoPor" TEXT NOT NULL,

    CONSTRAINT "HospSignos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospDocumento" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "episodioId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tipo" "HospDocumentoTipo" NOT NULL,
    "nombre" TEXT NOT NULL,
    "estado" "HospDocumentoEstado" NOT NULL DEFAULT 'PENDIENTE',
    "requerido" BOOLEAN NOT NULL DEFAULT true,
    "firmadoAt" TIMESTAMP(3),
    "mime" TEXT,
    "bytes" INTEGER,
    "archivo" BYTEA,
    "subidoPorUserId" TEXT,

    CONSTRAINT "HospDocumento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospCargo" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "episodioId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "categoria" "HospCargoCategoria" NOT NULL,
    "descripcion" TEXT NOT NULL,
    "cantidad" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "precioUnitario" DECIMAL(18,6) NOT NULL,
    "ivaTasa" DECIMAL(18,6),
    "importe" DECIMAL(18,6) NOT NULL,
    "origen" "HospCargoOrigen" NOT NULL DEFAULT 'MANUAL',
    "servicioId" TEXT,
    "loteId" TEXT,
    "medicoId" TEXT,
    "invoiceId" TEXT,
    "cancelado" BOOLEAN NOT NULL DEFAULT false,
    "canceladoAt" TIMESTAMP(3),
    "motivoCancelacion" TEXT,
    "creadoPorUserId" TEXT,

    CONSTRAINT "HospCargo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospCita" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "recursoId" TEXT NOT NULL,
    "pacienteId" TEXT,
    "pacienteNombre" TEXT,
    "medicoId" TEXT,
    "episodioId" TEXT,
    "cotizacionId" TEXT,
    "tipo" "HospCitaTipo" NOT NULL,
    "titulo" TEXT NOT NULL,
    "inicio" TIMESTAMP(3) NOT NULL,
    "fin" TIMESTAMP(3) NOT NULL,
    "estado" "HospCitaEstado" NOT NULL DEFAULT 'PROGRAMADA',
    "notas" TEXT,

    CONSTRAINT "HospCita_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospCotizacion" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "folio" TEXT NOT NULL,
    "pacienteId" TEXT,
    "pacienteNombre" TEXT NOT NULL,
    "pagadorId" TEXT,
    "procedimiento" TEXT NOT NULL,
    "estado" "HospCotizacionEstado" NOT NULL DEFAULT 'BORRADOR',
    "vigenciaHasta" TIMESTAMP(3),
    "subtotal" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "iva" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "notas" TEXT,
    "creadoPorUserId" TEXT,

    CONSTRAINT "HospCotizacion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospCotizacionPartida" (
    "id" TEXT NOT NULL,
    "cotizacionId" TEXT NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "servicioId" TEXT,
    "categoria" "HospCargoCategoria" NOT NULL,
    "descripcion" TEXT NOT NULL,
    "cantidad" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "precioUnitario" DECIMAL(18,6) NOT NULL,
    "ivaTasa" DECIMAL(18,6),
    "importe" DECIMAL(18,6) NOT NULL,

    CONSTRAINT "HospCotizacionPartida_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospInsumo" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "clave" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "presentacion" TEXT,
    "unidad" TEXT NOT NULL DEFAULT 'pieza',
    "categoria" "HospInsumoCategoria" NOT NULL DEFAULT 'MEDICAMENTO',
    "controlado" BOOLEAN NOT NULL DEFAULT false,
    "minimo" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "precioVenta" DECIMAL(18,6),
    "ultimoCosto" DECIMAL(18,6),
    "ivaTasa" DECIMAL(18,6) DEFAULT 0,
    "claveProdServ" TEXT,
    "derivadoDeCfdi" BOOLEAN NOT NULL DEFAULT false,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "HospInsumo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospLote" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "insumoId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lote" TEXT NOT NULL,
    "caducidad" TIMESTAMP(3),
    "existencia" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "costoUnitario" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "recibidoAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invoiceId" TEXT,
    "supplierId" TEXT,

    CONSTRAINT "HospLote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospMovimientoInsumo" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "insumoId" TEXT NOT NULL,
    "loteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tipo" "HospMovimientoTipo" NOT NULL,
    "cantidad" DECIMAL(18,6) NOT NULL,
    "costoUnitario" DECIMAL(18,6),
    "fecha" TIMESTAMP(3) NOT NULL,
    "episodioId" TEXT,
    "cargoId" TEXT,
    "invoiceId" TEXT,
    "referencia" TEXT,
    "usuarioId" TEXT,
    "usuarioNombre" TEXT,

    CONSTRAINT "HospMovimientoInsumo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospTicket" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "folio" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "descripcion" TEXT,
    "area" "HospArea",
    "equipo" TEXT,
    "prioridad" "HospTicketPrioridad" NOT NULL DEFAULT 'MEDIA',
    "estado" "HospTicketEstado" NOT NULL DEFAULT 'ABIERTO',
    "reportadoPorUserId" TEXT,
    "reportadoPor" TEXT NOT NULL,
    "asignadoEmployeeId" TEXT,
    "asignadoA" TEXT,
    "preventivo" BOOLEAN NOT NULL DEFAULT false,
    "programadoPara" TIMESTAMP(3),
    "cerradoAt" TIMESTAMP(3),
    "resolucion" TEXT,

    CONSTRAINT "HospTicket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HospConfig_companyId_key" ON "HospConfig"("companyId");

-- CreateIndex
CREATE INDEX "HospRecurso_companyId_area_idx" ON "HospRecurso"("companyId", "area");

-- CreateIndex
CREATE UNIQUE INDEX "HospRecurso_companyId_tipo_nombre_key" ON "HospRecurso"("companyId", "tipo", "nombre");

-- CreateIndex
CREATE INDEX "HospPaciente_companyId_apellidoPaterno_nombre_idx" ON "HospPaciente"("companyId", "apellidoPaterno", "nombre");

-- CreateIndex
CREATE INDEX "HospPaciente_companyId_curp_idx" ON "HospPaciente"("companyId", "curp");

-- CreateIndex
CREATE INDEX "HospPagador_companyId_activo_idx" ON "HospPagador"("companyId", "activo");

-- CreateIndex
CREATE INDEX "HospServicio_companyId_categoria_idx" ON "HospServicio"("companyId", "categoria");

-- CreateIndex
CREATE UNIQUE INDEX "HospServicio_companyId_clave_key" ON "HospServicio"("companyId", "clave");

-- CreateIndex
CREATE UNIQUE INDEX "HospTarifa_servicioId_pagadorId_key" ON "HospTarifa"("servicioId", "pagadorId");

-- CreateIndex
CREATE INDEX "HospMedico_companyId_activo_idx" ON "HospMedico"("companyId", "activo");

-- CreateIndex
CREATE UNIQUE INDEX "HospEpisodio_cotizacionId_key" ON "HospEpisodio"("cotizacionId");

-- CreateIndex
CREATE INDEX "HospEpisodio_companyId_estado_idx" ON "HospEpisodio"("companyId", "estado");

-- CreateIndex
CREATE INDEX "HospEpisodio_companyId_fechaIngreso_idx" ON "HospEpisodio"("companyId", "fechaIngreso");

-- CreateIndex
CREATE INDEX "HospEpisodio_pacienteId_idx" ON "HospEpisodio"("pacienteId");

-- CreateIndex
CREATE INDEX "HospEpisodio_recursoId_idx" ON "HospEpisodio"("recursoId");

-- CreateIndex
CREATE UNIQUE INDEX "HospEpisodio_companyId_folio_key" ON "HospEpisodio"("companyId", "folio");

-- CreateIndex
CREATE INDEX "HospTraslado_episodioId_fecha_idx" ON "HospTraslado"("episodioId", "fecha");

-- CreateIndex
CREATE UNIQUE INDEX "HospNota_cargoId_key" ON "HospNota"("cargoId");

-- CreateIndex
CREATE UNIQUE INDEX "HospNota_reemplazaId_key" ON "HospNota"("reemplazaId");

-- CreateIndex
CREATE INDEX "HospNota_episodioId_fecha_idx" ON "HospNota"("episodioId", "fecha");

-- CreateIndex
CREATE INDEX "HospSignos_episodioId_fecha_idx" ON "HospSignos"("episodioId", "fecha");

-- CreateIndex
CREATE INDEX "HospDocumento_episodioId_idx" ON "HospDocumento"("episodioId");

-- CreateIndex
CREATE INDEX "HospDocumento_companyId_idx" ON "HospDocumento"("companyId");

-- CreateIndex
CREATE INDEX "HospCargo_episodioId_fecha_idx" ON "HospCargo"("episodioId", "fecha");

-- CreateIndex
CREATE INDEX "HospCargo_companyId_categoria_fecha_idx" ON "HospCargo"("companyId", "categoria", "fecha");

-- CreateIndex
CREATE INDEX "HospCargo_invoiceId_idx" ON "HospCargo"("invoiceId");

-- CreateIndex
CREATE INDEX "HospCita_companyId_inicio_idx" ON "HospCita"("companyId", "inicio");

-- CreateIndex
CREATE INDEX "HospCita_recursoId_inicio_idx" ON "HospCita"("recursoId", "inicio");

-- CreateIndex
CREATE INDEX "HospCotizacion_companyId_estado_idx" ON "HospCotizacion"("companyId", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "HospCotizacion_companyId_folio_key" ON "HospCotizacion"("companyId", "folio");

-- CreateIndex
CREATE INDEX "HospCotizacionPartida_cotizacionId_idx" ON "HospCotizacionPartida"("cotizacionId");

-- CreateIndex
CREATE INDEX "HospInsumo_companyId_categoria_idx" ON "HospInsumo"("companyId", "categoria");

-- CreateIndex
CREATE UNIQUE INDEX "HospInsumo_companyId_clave_key" ON "HospInsumo"("companyId", "clave");

-- CreateIndex
CREATE INDEX "HospLote_companyId_caducidad_idx" ON "HospLote"("companyId", "caducidad");

-- CreateIndex
CREATE UNIQUE INDEX "HospLote_insumoId_lote_key" ON "HospLote"("insumoId", "lote");

-- CreateIndex
CREATE UNIQUE INDEX "HospMovimientoInsumo_cargoId_key" ON "HospMovimientoInsumo"("cargoId");

-- CreateIndex
CREATE INDEX "HospMovimientoInsumo_companyId_fecha_idx" ON "HospMovimientoInsumo"("companyId", "fecha");

-- CreateIndex
CREATE INDEX "HospMovimientoInsumo_loteId_idx" ON "HospMovimientoInsumo"("loteId");

-- CreateIndex
CREATE UNIQUE INDEX "HospMovimientoInsumo_insumoId_invoiceId_tipo_key" ON "HospMovimientoInsumo"("insumoId", "invoiceId", "tipo");

-- CreateIndex
CREATE INDEX "HospTicket_companyId_estado_idx" ON "HospTicket"("companyId", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "HospTicket_companyId_folio_key" ON "HospTicket"("companyId", "folio");

-- AddForeignKey
ALTER TABLE "HospConfig" ADD CONSTRAINT "HospConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospRecurso" ADD CONSTRAINT "HospRecurso_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospRecurso" ADD CONSTRAINT "HospRecurso_servicioId_fkey" FOREIGN KEY ("servicioId") REFERENCES "HospServicio"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospPaciente" ADD CONSTRAINT "HospPaciente_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospPaciente" ADD CONSTRAINT "HospPaciente_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospPaciente" ADD CONSTRAINT "HospPaciente_pagadorId_fkey" FOREIGN KEY ("pagadorId") REFERENCES "HospPagador"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospPagador" ADD CONSTRAINT "HospPagador_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospPagador" ADD CONSTRAINT "HospPagador_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospServicio" ADD CONSTRAINT "HospServicio_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospTarifa" ADD CONSTRAINT "HospTarifa_servicioId_fkey" FOREIGN KEY ("servicioId") REFERENCES "HospServicio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospTarifa" ADD CONSTRAINT "HospTarifa_pagadorId_fkey" FOREIGN KEY ("pagadorId") REFERENCES "HospPagador"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospMedico" ADD CONSTRAINT "HospMedico_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospMedico" ADD CONSTRAINT "HospMedico_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospMedico" ADD CONSTRAINT "HospMedico_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospEpisodio" ADD CONSTRAINT "HospEpisodio_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospEpisodio" ADD CONSTRAINT "HospEpisodio_pacienteId_fkey" FOREIGN KEY ("pacienteId") REFERENCES "HospPaciente"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospEpisodio" ADD CONSTRAINT "HospEpisodio_recursoId_fkey" FOREIGN KEY ("recursoId") REFERENCES "HospRecurso"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospEpisodio" ADD CONSTRAINT "HospEpisodio_medicoId_fkey" FOREIGN KEY ("medicoId") REFERENCES "HospMedico"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospEpisodio" ADD CONSTRAINT "HospEpisodio_pagadorId_fkey" FOREIGN KEY ("pagadorId") REFERENCES "HospPagador"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospEpisodio" ADD CONSTRAINT "HospEpisodio_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospEpisodio" ADD CONSTRAINT "HospEpisodio_cotizacionId_fkey" FOREIGN KEY ("cotizacionId") REFERENCES "HospCotizacion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospTraslado" ADD CONSTRAINT "HospTraslado_episodioId_fkey" FOREIGN KEY ("episodioId") REFERENCES "HospEpisodio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospNota" ADD CONSTRAINT "HospNota_episodioId_fkey" FOREIGN KEY ("episodioId") REFERENCES "HospEpisodio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospNota" ADD CONSTRAINT "HospNota_medicoId_fkey" FOREIGN KEY ("medicoId") REFERENCES "HospMedico"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospNota" ADD CONSTRAINT "HospNota_cargoId_fkey" FOREIGN KEY ("cargoId") REFERENCES "HospCargo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospNota" ADD CONSTRAINT "HospNota_reemplazaId_fkey" FOREIGN KEY ("reemplazaId") REFERENCES "HospNota"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospSignos" ADD CONSTRAINT "HospSignos_episodioId_fkey" FOREIGN KEY ("episodioId") REFERENCES "HospEpisodio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospDocumento" ADD CONSTRAINT "HospDocumento_episodioId_fkey" FOREIGN KEY ("episodioId") REFERENCES "HospEpisodio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCargo" ADD CONSTRAINT "HospCargo_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCargo" ADD CONSTRAINT "HospCargo_episodioId_fkey" FOREIGN KEY ("episodioId") REFERENCES "HospEpisodio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCargo" ADD CONSTRAINT "HospCargo_servicioId_fkey" FOREIGN KEY ("servicioId") REFERENCES "HospServicio"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCargo" ADD CONSTRAINT "HospCargo_loteId_fkey" FOREIGN KEY ("loteId") REFERENCES "HospLote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCargo" ADD CONSTRAINT "HospCargo_medicoId_fkey" FOREIGN KEY ("medicoId") REFERENCES "HospMedico"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCargo" ADD CONSTRAINT "HospCargo_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCita" ADD CONSTRAINT "HospCita_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCita" ADD CONSTRAINT "HospCita_recursoId_fkey" FOREIGN KEY ("recursoId") REFERENCES "HospRecurso"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCita" ADD CONSTRAINT "HospCita_pacienteId_fkey" FOREIGN KEY ("pacienteId") REFERENCES "HospPaciente"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCita" ADD CONSTRAINT "HospCita_medicoId_fkey" FOREIGN KEY ("medicoId") REFERENCES "HospMedico"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCita" ADD CONSTRAINT "HospCita_episodioId_fkey" FOREIGN KEY ("episodioId") REFERENCES "HospEpisodio"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCita" ADD CONSTRAINT "HospCita_cotizacionId_fkey" FOREIGN KEY ("cotizacionId") REFERENCES "HospCotizacion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCotizacion" ADD CONSTRAINT "HospCotizacion_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCotizacion" ADD CONSTRAINT "HospCotizacion_pacienteId_fkey" FOREIGN KEY ("pacienteId") REFERENCES "HospPaciente"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCotizacion" ADD CONSTRAINT "HospCotizacion_pagadorId_fkey" FOREIGN KEY ("pagadorId") REFERENCES "HospPagador"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCotizacionPartida" ADD CONSTRAINT "HospCotizacionPartida_cotizacionId_fkey" FOREIGN KEY ("cotizacionId") REFERENCES "HospCotizacion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCotizacionPartida" ADD CONSTRAINT "HospCotizacionPartida_servicioId_fkey" FOREIGN KEY ("servicioId") REFERENCES "HospServicio"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospInsumo" ADD CONSTRAINT "HospInsumo_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospLote" ADD CONSTRAINT "HospLote_insumoId_fkey" FOREIGN KEY ("insumoId") REFERENCES "HospInsumo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospLote" ADD CONSTRAINT "HospLote_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospLote" ADD CONSTRAINT "HospLote_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospMovimientoInsumo" ADD CONSTRAINT "HospMovimientoInsumo_insumoId_fkey" FOREIGN KEY ("insumoId") REFERENCES "HospInsumo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospMovimientoInsumo" ADD CONSTRAINT "HospMovimientoInsumo_loteId_fkey" FOREIGN KEY ("loteId") REFERENCES "HospLote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospMovimientoInsumo" ADD CONSTRAINT "HospMovimientoInsumo_episodioId_fkey" FOREIGN KEY ("episodioId") REFERENCES "HospEpisodio"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospMovimientoInsumo" ADD CONSTRAINT "HospMovimientoInsumo_cargoId_fkey" FOREIGN KEY ("cargoId") REFERENCES "HospCargo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospMovimientoInsumo" ADD CONSTRAINT "HospMovimientoInsumo_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospTicket" ADD CONSTRAINT "HospTicket_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

