-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- Extensiones requeridas. pgvector alimenta el embedding de FiscalChunk
-- (base de conocimiento fiscal). En producción ya está instalada (npm run
-- fiscal:setup); IF NOT EXISTS la hace idempotente para entornos nuevos.
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER');

-- CreateEnum
CREATE TYPE "DespachoRole" AS ENUM ('OWNER', 'ADMIN', 'ACCOUNTANT');

-- CreateEnum
CREATE TYPE "CompanyInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ModuloApp" AS ENUM ('CONTABILIDAD', 'CONSTRUCCION', 'CONSTRUCCION_CUADRILLAS', 'FLOTA', 'MARKETING', 'PADEL');

-- CreateEnum
CREATE TYPE "InvoiceType" AS ENUM ('INGRESO', 'EGRESO', 'TRASLADO', 'NOMINA', 'PAGO');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'STAMPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaxType" AS ENUM ('IVA', 'ISR', 'IEPS');

-- CreateEnum
CREATE TYPE "TaxFactor" AS ENUM ('TASA', 'CUOTA', 'EXENTO');

-- CreateEnum
CREATE TYPE "BankAccountTipo" AS ENUM ('CHEQUES', 'TARJETA_DEPARTAMENTAL', 'CAJA');

-- CreateEnum
CREATE TYPE "BankTransactionType" AS ENUM ('CREDITO', 'DEBITO');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('UNMATCHED', 'MATCHED', 'IGNORED');

-- CreateEnum
CREATE TYPE "IncidenciaTipo" AS ENUM ('FALTA', 'FALTA_JUSTIFICADA', 'INCAPACIDAD', 'PERMISO_CON_GOCE', 'PERMISO_SIN_GOCE', 'HORAS_EXTRA', 'VACACIONES', 'RETARDO', 'BONO', 'COMISION', 'DESCUENTO');

-- CreateEnum
CREATE TYPE "ImssMovimientoTipo" AS ENUM ('ALTA', 'BAJA', 'MODIFICACION_SALARIO', 'REINGRESO');

-- CreateEnum
CREATE TYPE "ImssMovimientoStatus" AS ENUM ('PENDING', 'EXPORTED', 'FILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PeriodicidadNomina" AS ENUM ('SEMANAL', 'QUINCENAL', 'MENSUAL');

-- CreateEnum
CREATE TYPE "PayrollRunType" AS ENUM ('ORDINARIA', 'EXTRAORDINARIA', 'FINIQUITO', 'AGUINALDO', 'VACACIONES', 'PTU');

-- CreateEnum
CREATE TYPE "PayrollStatus" AS ENUM ('DRAFT', 'CALCULATED', 'STAMPED', 'PAID');

-- CreateEnum
CREATE TYPE "TaxDeclarationType" AS ENUM ('IVA_MENSUAL', 'ISR_PROVISIONAL', 'RETENCIONES_ISR', 'DIOT', 'DECLARACION_ANUAL', 'CERO', 'IMSS_MENSUAL', 'IMSS_BIMESTRAL');

-- CreateEnum
CREATE TYPE "DeclarationStatus" AS ENUM ('DRAFT', 'CALCULATED', 'FILED', 'PAID');

-- CreateEnum
CREATE TYPE "AccountingPeriodStatus" AS ENUM ('DRAFT', 'POSTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SatRequestType" AS ENUM ('EMITIDOS', 'RECIBIDOS', 'METADATA_EMITIDOS', 'METADATA_RECIBIDOS');

-- CreateEnum
CREATE TYPE "SatRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'IN_PROGRESS', 'FINISHED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ACTIVO', 'PASIVO', 'CAPITAL', 'INGRESO', 'GASTO', 'COSTO');

-- CreateEnum
CREATE TYPE "EntryType" AS ENUM ('CARGO', 'ABONO');

-- CreateEnum
CREATE TYPE "EntrySource" AS ENUM ('CFDI', 'NOMINA', 'BANCO', 'MANUAL', 'CONSTRUCCION', 'FLOTA', 'PADEL', 'APERTURA', 'CIERRE');

-- CreateEnum
CREATE TYPE "ProyectoTipo" AS ENUM ('GOBIERNO', 'PRIVADO', 'MIXTO');

-- CreateEnum
CREATE TYPE "ProyectoEstado" AS ENUM ('PLANEACION', 'EN_EJECUCION', 'SUSPENDIDO', 'TERMINADO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "InsumoTipo" AS ENUM ('MATERIAL', 'MANO_OBRA', 'EQUIPO', 'HERRAMIENTA', 'BASICO');

-- CreateEnum
CREATE TYPE "TipoPresupuesto" AS ENUM ('CONTRATO', 'EJECUTADO');

-- CreateEnum
CREATE TYPE "PresupuestoEstado" AS ENUM ('BORRADOR', 'APROBADO', 'EN_EJECUCION', 'CERRADO', 'RECHAZADO');

-- CreateEnum
CREATE TYPE "EstimacionEstado" AS ENUM ('BORRADOR', 'APROBADA', 'TIMBRADA', 'PAGADA', 'CANCELADA');

-- CreateEnum
CREATE TYPE "SolicitudEstado" AS ENUM ('BORRADOR', 'PENDIENTE', 'APROBADA', 'RECHAZADA', 'PAGADA', 'CANCELADA');

-- CreateEnum
CREATE TYPE "SolicitudFormaPago" AS ENUM ('CREDITO', 'CONTADO');

-- CreateEnum
CREATE TYPE "BitacoraTipo" AS ENUM ('NOTA', 'DECISION', 'PROBLEMA', 'CLIMA', 'FOTO');

-- CreateEnum
CREATE TYPE "PagoTipo" AS ENUM ('ANTICIPO', 'ESTIMACION', 'RETENCION_LIBERADA');

-- CreateEnum
CREATE TYPE "RayaEstado" AS ENUM ('BORRADOR', 'APROBADA', 'PAGADA');

-- CreateEnum
CREATE TYPE "GastoEstado" AS ENUM ('PENDIENTE', 'APROBADO', 'PAGADO', 'RECHAZADO');

-- CreateEnum
CREATE TYPE "ReembolsoEstado" AS ENUM ('SUBMITTED', 'REVISADO', 'REEMBOLSADO', 'RECHAZADO');

-- CreateEnum
CREATE TYPE "WhatsappRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "FiscalSource" AS ENUM ('LEY', 'RMF', 'CRITERIO', 'DOF', 'REGLAMENTO', 'TESIS', 'GUIA');

-- CreateEnum
CREATE TYPE "EstadoPendiente" AS ENUM ('NUEVO', 'VISTO', 'HECHO', 'POSPUESTO');

-- CreateEnum
CREATE TYPE "ReservationEstado" AS ENUM ('PENDIENTE', 'CONFIRMADA', 'CANCELADA', 'COMPLETADA', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "ReservationCanal" AS ENUM ('APP', 'STAFF', 'PLAYTOMIC');

-- CreateEnum
CREATE TYPE "ReservationFormaPago" AS ENUM ('EFECTIVO', 'TRANSFERENCIA', 'TARJETA', 'CORTESIA', 'CUENTA');

-- CreateEnum
CREATE TYPE "ChatVisibility" AS ENUM ('PRIVATE', 'COMPANY');

-- CreateEnum
CREATE TYPE "CompanyPlan" AS ENUM ('ASISTENTE', 'AUTOMATIZADO', 'PRO', 'DESPACHO');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "esOperador" BOOLEAN NOT NULL DEFAULT false,
    "subscriptionStatus" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "trialEndsAt" TIMESTAMP(3),
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "currentPeriodEnd" TIMESTAMP(3),
    "notifPrefs" JSONB,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "despachoId" TEXT,
    "grupoId" TEXT,
    "rfc" TEXT NOT NULL,
    "razonSocial" TEXT NOT NULL,
    "regimenFiscal" TEXT NOT NULL,
    "codigoPostal" TEXT NOT NULL,
    "domicilioFiscal" TEXT,
    "nombreComercial" TEXT,
    "email" TEXT,
    "telefono" TEXT,
    "actividadEconomica" TEXT,
    "csdCer" TEXT,
    "csdKey" TEXT,
    "csdPassword" TEXT,
    "csdVigencia" TIMESTAMP(3),
    "fielCer" TEXT,
    "fielKey" TEXT,
    "fielPassword" TEXT,
    "fielVigencia" TIMESTAMP(3),
    "autoSyncEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastAutoSyncAt" TIMESTAMP(3),
    "satBackfillYears" INTEGER NOT NULL DEFAULT 5,
    "satBackfillCompletedAt" TIMESTAMP(3),
    "ceBootstrapAt" TIMESTAMP(3),
    "plan" TEXT,
    "fechaInicioOperaciones" TIMESTAMP(3),
    "facturapiOrgId" TEXT,
    "facturapiApiKey" TEXT,
    "facturapiManifiestoAckAt" TIMESTAMP(3),
    "logoUrl" TEXT,
    "coeficienteUtilidad" DOUBLE PRECISION,
    "coeficienteAnio" INTEGER,
    "perdidaFiscalPendiente" DOUBLE PRECISION,
    "perdidaFiscalAnio" INTEGER,
    "aperturaConfirmadaAt" TIMESTAMP(3),
    "aperturaConfirmadaPor" TEXT,
    "precioMensualCentavos" INTEGER,
    "tier" "CompanyPlan" NOT NULL DEFAULT 'AUTOMATIZADO',
    "plataformaActividad" TEXT,
    "registroPatronal" TEXT,
    "periodicidadNomina" "PeriodicidadNomina" NOT NULL DEFAULT 'QUINCENAL',
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyMember" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'VIEWER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "allowedModules" "ModuloApp"[] DEFAULT ARRAY[]::"ModuloApp"[],

    CONSTRAINT "CompanyMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Despacho" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "precioMensualCentavos" INTEGER,

    CONSTRAINT "Despacho_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Grupo" (
    "id" TEXT NOT NULL,
    "despachoId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Grupo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DespachoMember" (
    "id" TEXT NOT NULL,
    "despachoId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "DespachoRole" NOT NULL DEFAULT 'ACCOUNTANT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DespachoMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DespachoMemberCompany" (
    "id" TEXT NOT NULL,
    "despachoMemberId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DespachoMemberCompany_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyInvitation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "despachoId" TEXT NOT NULL,
    "invitedByUserId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'VIEWER',
    "tokenHash" TEXT NOT NULL,
    "status" "CompanyInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyModule" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "modulo" "ModuloApp" NOT NULL,
    "habilitado" BOOLEAN NOT NULL DEFAULT true,
    "habilitadoAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyModule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "rfc" TEXT NOT NULL,
    "razonSocial" TEXT NOT NULL,
    "regimenFiscal" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "domicilio" TEXT,
    "codigoPostal" TEXT,
    "facturapiId" TEXT,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "rfc" TEXT NOT NULL,
    "razonSocial" TEXT NOT NULL,
    "regimenFiscal" TEXT,
    "email" TEXT,
    "clabe" TEXT,
    "banco" TEXT,
    "cuentaBancaria" TEXT,
    "titularCuenta" TEXT,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "construccion_supplier_terms" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "tieneCredito" BOOLEAN NOT NULL DEFAULT false,
    "diasCredito" INTEGER NOT NULL DEFAULT 0,
    "limiteCredito" DECIMAL(14,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "construccion_supplier_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tipo" "InvoiceType" NOT NULL,
    "serie" TEXT,
    "folio" TEXT,
    "fecha" TIMESTAMP(3) NOT NULL,
    "formaPago" TEXT NOT NULL,
    "metodoPago" TEXT NOT NULL,
    "usoCfdi" TEXT NOT NULL,
    "moneda" TEXT NOT NULL DEFAULT 'MXN',
    "tipoCambio" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "subtotal" DOUBLE PRECISION NOT NULL,
    "descuento" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalImpuestos" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total" DOUBLE PRECISION NOT NULL,
    "notas" TEXT,
    "overrideCuenta" TEXT,
    "naturaleza" TEXT,
    "naturalezaRevision" BOOLEAN NOT NULL DEFAULT false,
    "naturalezaManual" BOOLEAN NOT NULL DEFAULT false,
    "ivaNoAcreditable" BOOLEAN NOT NULL DEFAULT false,
    "ivaNoCausado" BOOLEAN NOT NULL DEFAULT false,
    "regimenNomina" TEXT,
    "tipoNomina" TEXT,
    "isrRetenidoNomina" DOUBLE PRECISION,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "uuid" TEXT,
    "facturapiId" TEXT,
    "xmlUrl" TEXT,
    "pdfUrl" TEXT,
    "rawXml" TEXT,
    "cadenaOriginal" TEXT,
    "selloSAT" TEXT,
    "selloCFD" TEXT,
    "canceladaAt" TIMESTAMP(3),
    "cancelMotivo" TEXT,
    "cancelSustituyeUuid" TEXT,
    "origenModulo" "ModuloApp",
    "idempotencyKey" TEXT,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "construccion_cfdi_vinculo" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "estado" TEXT NOT NULL,
    "targetTipo" TEXT,
    "targetId" TEXT,
    "targetLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "construccion_cfdi_vinculo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivoFijo" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "descripcion" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "moi" DOUBLE PRECISION NOT NULL,
    "fechaAdquisicion" TIMESTAMP(3) NOT NULL,
    "fechaInicioUso" TIMESTAMP(3),
    "tasaAnual" DOUBLE PRECISION NOT NULL,
    "esAutomovil" BOOLEAN NOT NULL DEFAULT false,
    "esElectricoHibrido" BOOLEAN NOT NULL DEFAULT false,
    "fechaBaja" TIMESTAMP(3),
    "motivoBaja" TEXT,
    "autoCreado" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ActivoFijo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PagoDoctoRelacionado" (
    "id" TEXT NOT NULL,
    "pagoInvoiceId" TEXT NOT NULL,
    "parentUuid" TEXT NOT NULL,
    "impPagado" DOUBLE PRECISION,
    "numParcialidad" INTEGER,
    "impSaldoAnterior" DOUBLE PRECISION,
    "impSaldoInsoluto" DOUBLE PRECISION,
    "fechaPago" TIMESTAMP(3),
    "baseTraslado" DOUBLE PRECISION,
    "ivaTrasladado" DOUBLE PRECISION,
    "ivaDerivado" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PagoDoctoRelacionado_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IvaPeriodNotice" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "periodo" TEXT NOT NULL,
    "ivaTrasladado" DOUBLE PRECISION NOT NULL,
    "lastNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IvaPeriodNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceItem" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "cantidad" DOUBLE PRECISION NOT NULL,
    "claveUnidad" TEXT NOT NULL,
    "unidad" TEXT,
    "claveProdServ" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "valorUnitario" DOUBLE PRECISION NOT NULL,
    "importe" DOUBLE PRECISION NOT NULL,
    "descuento" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "InvoiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceTax" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "tipo" "TaxType" NOT NULL,
    "factor" "TaxFactor" NOT NULL,
    "tasa" DOUBLE PRECISION NOT NULL,
    "base" DOUBLE PRECISION,
    "importe" DOUBLE PRECISION NOT NULL,
    "retencion" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "InvoiceTax_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "banco" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "numeroCuenta" TEXT NOT NULL,
    "clabe" TEXT,
    "moneda" TEXT NOT NULL DEFAULT 'MXN',
    "tipo" "BankAccountTipo" NOT NULL DEFAULT 'CHEQUES',
    "titular" TEXT,
    "belvoAccountId" TEXT,
    "belvoLinkId" TEXT,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankTransaction" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fecha" TIMESTAMP(3) NOT NULL,
    "descripcion" TEXT NOT NULL,
    "referencia" TEXT,
    "monto" DOUBLE PRECISION NOT NULL,
    "saldo" DOUBLE PRECISION,
    "tipo" "BankTransactionType" NOT NULL,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'UNMATCHED',
    "invoiceId" TEXT,
    "supplierId" TEXT,
    "notes" TEXT,
    "taxDeclarationId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'UPLOAD',
    "belvoId" TEXT,
    "belvoCategory" TEXT,
    "externalRef" TEXT,

    CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConciliacionDetalle" (
    "id" TEXT NOT NULL,
    "bankTransactionId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "montoAsignado" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConciliacionDetalle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "nombre" TEXT NOT NULL,
    "apellidoPaterno" TEXT NOT NULL,
    "apellidoMaterno" TEXT,
    "rfc" TEXT NOT NULL,
    "curp" TEXT NOT NULL,
    "nss" TEXT NOT NULL,
    "email" TEXT,
    "fechaIngreso" TIMESTAMP(3) NOT NULL,
    "fechaBaja" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "tipoContrato" TEXT NOT NULL,
    "tipoJornada" TEXT NOT NULL,
    "tipoRegimen" TEXT NOT NULL DEFAULT '02',
    "salarioDiario" DOUBLE PRECISION NOT NULL,
    "salarioDiarioIntegrado" DOUBLE PRECISION,
    "periodicidadPago" TEXT NOT NULL,
    "numEmpleado" TEXT,
    "departamento" TEXT,
    "puesto" TEXT,
    "riesgoPuesto" TEXT NOT NULL DEFAULT '1',
    "claveEntFed" TEXT NOT NULL DEFAULT 'PUE',
    "clabe" TEXT,
    "banco" TEXT,
    "creditoInfonavit" TEXT,
    "tipoDescuentoInfonavit" TEXT,
    "descuentoInfonavit" DOUBLE PRECISION,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incidencia" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tipo" "IncidenciaTipo" NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "fechaFin" TIMESTAMP(3),
    "dias" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "horas" DOUBLE PRECISION,
    "horasTriples" DOUBLE PRECISION,
    "monto" DOUBLE PRECISION,
    "folioImss" TEXT,
    "ramoImss" TEXT,
    "notas" TEXT,
    "periodo" TEXT,

    CONSTRAINT "Incidencia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImssMovimiento" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tipo" "ImssMovimientoTipo" NOT NULL,
    "fechaMovimiento" TIMESTAMP(3) NOT NULL,
    "sbcAnterior" DOUBLE PRECISION,
    "sbcNuevo" DOUBLE PRECISION,
    "motivo" TEXT,
    "status" "ImssMovimientoStatus" NOT NULL DEFAULT 'PENDING',
    "filedAt" TIMESTAMP(3),
    "idseConfirmation" TEXT,

    CONSTRAINT "ImssMovimiento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "periodo" TEXT NOT NULL,
    "fechaPago" TIMESTAMP(3) NOT NULL,
    "tipo" "PayrollRunType" NOT NULL,
    "status" "PayrollStatus" NOT NULL DEFAULT 'DRAFT',
    "totalPercepciones" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalDeducciones" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalNeto" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "extraData" JSONB,
    "origen" TEXT NOT NULL DEFAULT 'APP',

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollItem" (
    "id" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "sueldoBase" DOUBLE PRECISION NOT NULL,
    "horasExtra" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bonosPagoFijo" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bonosPagoVar" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "vales" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "otrasPercepciones" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isrRetenido" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "imssObrero" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "imssPatronal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "infonavit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "otrasDeducc" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "aguinaldo" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "primaVacacional" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "vacaciones" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ptu" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalPercepciones" DOUBLE PRECISION NOT NULL,
    "totalDeducciones" DOUBLE PRECISION NOT NULL,
    "netoAPagar" DOUBLE PRECISION NOT NULL,
    "cfdiUuid" TEXT,
    "facturapiId" TEXT,

    CONSTRAINT "PayrollItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxDeclaration" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tipo" "TaxDeclarationType" NOT NULL,
    "periodo" TEXT NOT NULL,
    "status" "DeclarationStatus" NOT NULL DEFAULT 'DRAFT',
    "ivaTrasladadoCobrado" DOUBLE PRECISION,
    "ivaAcreditableGastado" DOUBLE PRECISION,
    "ivaSaldoFavor" DOUBLE PRECISION,
    "ivaPagar" DOUBLE PRECISION,
    "ivaSaldoFavorAnterior" DOUBLE PRECISION,
    "isrIngresos" DOUBLE PRECISION,
    "isrDeducciones" DOUBLE PRECISION,
    "isrBaseGravable" DOUBLE PRECISION,
    "isrTasa" DOUBLE PRECISION,
    "isrPagar" DOUBLE PRECISION,
    "isrCoeficienteUtilidad" DOUBLE PRECISION,
    "isrPerdidaPendiente" DOUBLE PRECISION,
    "isrSaldoFavor" DOUBLE PRECISION,
    "retencionesIsr" DOUBLE PRECISION,
    "imssCuotas" DOUBLE PRECISION,
    "diotXmlUrl" TEXT,
    "acuseUrl" TEXT,
    "lineaCaptura" TEXT,
    "fechaPresentacion" TIMESTAMP(3),
    "fechaLimitePago" TIMESTAMP(3),
    "acusePdf" BYTEA,
    "acusePdfNombre" TEXT,
    "isHistorical" BOOLEAN NOT NULL DEFAULT false,
    "acuseData" JSONB,

    CONSTRAINT "TaxDeclaration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerdidaFiscal" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "ejercicioOrigen" INTEGER NOT NULL,
    "montoOriginal" DOUBLE PRECISION NOT NULL,
    "saldoActualizado" DOUBLE PRECISION NOT NULL,
    "mesUltimaActualizacion" TEXT NOT NULL,
    "agotada" BOOLEAN NOT NULL DEFAULT false,
    "ultimoEjercicioAplicado" INTEGER,
    "origen" TEXT NOT NULL DEFAULT 'CALCULADA',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PerdidaFiscal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostEvent" (
    "id" TEXT NOT NULL,
    "despachoId" TEXT,
    "companyId" TEXT,
    "categoria" TEXT NOT NULL,
    "subtipo" TEXT NOT NULL,
    "unidades" DOUBLE PRECISION NOT NULL,
    "costoMicroUsd" INTEGER NOT NULL,
    "meta" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoeEnvio" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "tipoDoc" TEXT NOT NULL,
    "periodo" TEXT NOT NULL,
    "contenidoHash" TEXT NOT NULL,
    "tipoEnvio" TEXT NOT NULL,
    "fechaModBal" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoeEnvio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyObligation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "periodicidad" TEXT NOT NULL,
    "diaVencimiento" INTEGER NOT NULL,
    "mesVencimiento" INTEGER,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "fuente" TEXT NOT NULL DEFAULT 'REGIMEN',
    "desdeAnio" INTEGER,
    "desdeMes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyObligation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CotejoFiscal" (
    "id" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "verificado" BOOLEAN NOT NULL DEFAULT false,
    "verifiedThrough" TEXT,
    "matchedAt" TIMESTAMP(3),
    "mismatch" JSONB,
    "fuente" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CotejoFiscal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChartAccount" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cuentaSAT" TEXT NOT NULL,
    "subcuenta" TEXT,
    "nombre" TEXT NOT NULL,
    "tipo" "AccountType" NOT NULL,
    "nivel" INTEGER NOT NULL DEFAULT 1,
    "naturaleza" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ChartAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingEntry" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "chartAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fecha" TIMESTAMP(3) NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "periodId" TEXT,
    "descripcion" TEXT NOT NULL,
    "referencia" TEXT,
    "referenciaTipo" TEXT,
    "monto" DOUBLE PRECISION NOT NULL,
    "tipo" "EntryType" NOT NULL,
    "fuente" "EntrySource" NOT NULL,

    CONSTRAINT "AccountingEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingPeriod" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "AccountingPeriodStatus" NOT NULL DEFAULT 'DRAFT',
    "postedAt" TIMESTAMP(3),
    "postedById" TEXT,
    "entriesCount" INTEGER NOT NULL DEFAULT 0,
    "totalCargos" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalAbonos" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountingPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SatSyncRequest" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "tipo" "SatRequestType" NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "requestId" TEXT NOT NULL,
    "status" "SatRequestStatus" NOT NULL DEFAULT 'PENDING',
    "cfdisFound" INTEGER NOT NULL DEFAULT 0,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "lastVerifiedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SatSyncRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Proyecto" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "ubicacion" TEXT,
    "tipo" "ProyectoTipo" NOT NULL DEFAULT 'PRIVADO',
    "estado" "ProyectoEstado" NOT NULL DEFAULT 'PLANEACION',
    "numeroContrato" TEXT,
    "numeroLicitacion" TEXT,
    "modalidadContrato" TEXT,
    "dependenciaCliente" TEXT,
    "fechaInicio" TIMESTAMP(3),
    "fechaFinPlan" TIMESTAMP(3),
    "fechaFinReal" TIMESTAMP(3),
    "montoContratado" DOUBLE PRECISION,
    "anticipoPorc" DOUBLE PRECISION,
    "retencionPorc" DOUBLE PRECISION,
    "utilidadPorc" DOUBLE PRECISION DEFAULT 10,
    "aplicaIva" BOOLEAN NOT NULL DEFAULT true,
    "presupuestoSourceFile" TEXT,
    "presupuestoImportadoAt" TIMESTAMP(3),
    "viviendasObjetivo" INTEGER,
    "weekCount" INTEGER,
    "anticipoMonto" DOUBLE PRECISION,
    "anticipoFecha" TIMESTAMP(3),
    "anticipoAmortizado" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "anticipoBankTxId" TEXT,
    "anticipoInvoiceId" TEXT,

    CONSTRAINT "Proyecto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Concepto" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "codigo" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "unidad" TEXT NOT NULL,
    "categoria" TEXT,
    "apuActualId" TEXT,

    CONSTRAINT "Concepto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "APU" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "conceptoId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "costoDirecto" DOUBLE PRECISION NOT NULL,
    "indirectosPorc" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "financierosPorc" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "utilidadPorc" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cargosAdicPorc" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "precioUnitario" DOUBLE PRECISION NOT NULL,
    "rendimiento" DOUBLE PRECISION NOT NULL DEFAULT 1,

    CONSTRAINT "APU_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "APUInsumo" (
    "id" TEXT NOT NULL,
    "apuId" TEXT NOT NULL,
    "insumoId" TEXT,
    "conceptoRefId" TEXT,
    "cantidad" DOUBLE PRECISION NOT NULL,
    "costoUnitario" DOUBLE PRECISION NOT NULL,
    "importe" DOUBLE PRECISION NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "APUInsumo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Insumo" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "codigo" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "tipo" "InsumoTipo" NOT NULL,
    "unidad" TEXT NOT NULL,
    "costoActual" DOUBLE PRECISION NOT NULL,
    "monedaCosto" TEXT NOT NULL DEFAULT 'MXN',
    "salarioBase" DOUBLE PRECISION,
    "factorSalario" DOUBLE PRECISION,
    "claveProdServ" TEXT,
    "claveUnidad" TEXT,

    CONSTRAINT "Insumo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Presupuesto" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "proyectoId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "nombre" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "estado" "PresupuestoEstado" NOT NULL DEFAULT 'BORRADOR',
    "montoTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tipoPresupuesto" "TipoPresupuesto" NOT NULL DEFAULT 'CONTRATO',
    "contratoOrigenId" TEXT,

    CONSTRAINT "Presupuesto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "construccion_presupuesto_insumo" (
    "id" TEXT NOT NULL,
    "presupuestoId" TEXT NOT NULL,
    "insumoId" TEXT NOT NULL,
    "cantidad" DOUBLE PRECISION NOT NULL,
    "costoUnitario" DOUBLE PRECISION NOT NULL,
    "importe" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "construccion_presupuesto_insumo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PresupuestoPartida" (
    "id" TEXT NOT NULL,
    "presupuestoId" TEXT NOT NULL,
    "conceptoId" TEXT,
    "apuVersion" INTEGER NOT NULL DEFAULT 1,
    "cantidad" DOUBLE PRECISION,
    "precioUnitario" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "importe" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "zona" TEXT,
    "partida" TEXT,
    "notas" TEXT,
    "parentPartidaId" TEXT,
    "nivel" INTEGER NOT NULL DEFAULT 0,
    "codigo" TEXT,
    "esRollup" BOOLEAN NOT NULL DEFAULT false,
    "unidadProyectoId" TEXT,
    "contratoPartidaId" TEXT,

    CONSTRAINT "PresupuestoPartida_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Estimacion" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "proyectoId" TEXT NOT NULL,
    "presupuestoId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "numero" INTEGER NOT NULL,
    "periodoInicio" TIMESTAMP(3) NOT NULL,
    "periodoFin" TIMESTAMP(3) NOT NULL,
    "fechaCorte" TIMESTAMP(3),
    "estado" "EstimacionEstado" NOT NULL DEFAULT 'BORRADOR',
    "subtotal" DOUBLE PRECISION NOT NULL,
    "retencionGarantia" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "amortizacionAnticipo" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "iva" DOUBLE PRECISION NOT NULL,
    "total" DOUBLE PRECISION NOT NULL,
    "importeAcumulado" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pctPeriodo" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pctAcumulado" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "invoiceId" TEXT,
    "bankTransactionId" TEXT,

    CONSTRAINT "Estimacion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EstimacionPartida" (
    "id" TEXT NOT NULL,
    "estimacionId" TEXT NOT NULL,
    "presupuestoPartidaId" TEXT,
    "cantidadEjecutada" DOUBLE PRECISION,
    "cantidadAcumulada" DOUBLE PRECISION,
    "templatePartidaId" TEXT,
    "viviendasObjetivo" INTEGER,
    "viviendasAvancePeriodo" INTEGER,
    "viviendasAvanceAnterior" INTEGER,
    "viviendasAvanceAcumulado" INTEGER,
    "pctPeriodo" DOUBLE PRECISION,
    "pctAcumulado" DOUBLE PRECISION,
    "descripcionSnapshot" TEXT,
    "importeContrato" DOUBLE PRECISION,
    "importe" DOUBLE PRECISION NOT NULL,
    "unidadProyectoId" TEXT,

    CONSTRAINT "EstimacionPartida_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EstimacionTemplate" (
    "id" TEXT NOT NULL,
    "proyectoId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EstimacionTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EstimacionTemplatePartida" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "presupuestoPartidaId" TEXT NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "descripcion" TEXT NOT NULL,
    "capituloCode" TEXT NOT NULL,
    "viviendasObjetivo" INTEGER,

    CONSTRAINT "EstimacionTemplatePartida_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EstimacionCurvaCapitulo" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "capituloCode" TEXT NOT NULL,
    "descripcion" TEXT,
    "pesoPctSemanal" JSONB NOT NULL,

    CONSTRAINT "EstimacionCurvaCapitulo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarioCierreCapitulo" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "capituloCode" TEXT NOT NULL,
    "descripcion" TEXT,
    "pesoPctSemanal" JSONB NOT NULL,

    CONSTRAINT "CalendarioCierreCapitulo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnidadProyecto" (
    "id" TEXT NOT NULL,
    "proyectoId" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "nombre" TEXT NOT NULL,
    "tipo" TEXT,
    "codigo" TEXT,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,

    CONSTRAINT "UnidadProyecto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramaActividad" (
    "id" TEXT NOT NULL,
    "proyectoId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "fechaInicio" TIMESTAMP(3) NOT NULL,
    "fechaFin" TIMESTAMP(3) NOT NULL,
    "porcAvance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "parentId" TEXT,

    CONSTRAINT "ProgramaActividad_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SolicitudCompra" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "proyectoId" TEXT,
    "supplierId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "folio" TEXT NOT NULL,
    "estado" "SolicitudEstado" NOT NULL DEFAULT 'PENDIENTE',
    "total" DOUBLE PRECISION NOT NULL,
    "notas" TEXT,
    "fechaEntrega" TIMESTAMP(3),
    "formaPago" "SolicitudFormaPago",
    "aprobadaPorId" TEXT,
    "aprobadaAt" TIMESTAMP(3),
    "pagadaAt" TIMESTAMP(3),
    "bankTransactionId" TEXT,

    CONSTRAINT "SolicitudCompra_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SolicitudPartida" (
    "id" TEXT NOT NULL,
    "solicitudId" TEXT NOT NULL,
    "insumoId" TEXT,
    "descripcion" TEXT NOT NULL,
    "unidad" TEXT,
    "cantidad" DOUBLE PRECISION NOT NULL,
    "precioUnitario" DOUBLE PRECISION NOT NULL,
    "importe" DOUBLE PRECISION NOT NULL,
    "presupuestoPartidaId" TEXT,
    "cotizacionGanadoraId" TEXT,

    CONSTRAINT "SolicitudPartida_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SolicitudCompraCotizacion" (
    "id" TEXT NOT NULL,
    "solicitudId" TEXT NOT NULL,
    "supplierId" TEXT,
    "supplierNombre" TEXT NOT NULL,
    "fechaCotizacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vigenciaHasta" TIMESTAMP(3),
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "moneda" TEXT NOT NULL DEFAULT 'MXN',
    "notas" TEXT,
    "isSelected" BOOLEAN NOT NULL DEFAULT false,
    "tieneCredito" BOOLEAN NOT NULL DEFAULT false,
    "diasCredito" INTEGER,
    "diasEntrega" INTEGER,
    "archivoUrl" TEXT,
    "archivoData" TEXT,
    "archivoMime" TEXT,
    "archivoName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SolicitudCompraCotizacion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "construccion_solicitud_adjudicacion" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "solicitudId" TEXT NOT NULL,
    "cotizacionId" TEXT NOT NULL,
    "supplierId" TEXT,
    "supplierNombre" TEXT NOT NULL,
    "tieneCredito" BOOLEAN NOT NULL DEFAULT false,
    "diasCredito" INTEGER,
    "diasEntrega" INTEGER,
    "total" DOUBLE PRECISION NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'POR_PAGAR',
    "enviadaTesoreriaAt" TIMESTAMP(3),
    "pagadaAt" TIMESTAMP(3),
    "conciliadaAt" TIMESTAMP(3),
    "referenciaPago" TEXT,
    "comprobanteData" TEXT,
    "comprobanteMime" TEXT,
    "comprobanteName" TEXT,
    "bankTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "construccion_solicitud_adjudicacion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SolicitudCotizacionPartida" (
    "id" TEXT NOT NULL,
    "cotizacionId" TEXT NOT NULL,
    "solicitudPartidaId" TEXT NOT NULL,
    "precioUnitario" DOUBLE PRECISION NOT NULL,
    "importe" DOUBLE PRECISION NOT NULL,
    "tiempoEntrega" TEXT,
    "notas" TEXT,

    CONSTRAINT "SolicitudCotizacionPartida_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PresupuestoVersion" (
    "id" TEXT NOT NULL,
    "presupuestoId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "descripcion" TEXT,
    "snapshotTotal" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "PresupuestoVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BitacoraEntrada" (
    "id" TEXT NOT NULL,
    "proyectoId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "texto" TEXT NOT NULL,
    "tipo" "BitacoraTipo" NOT NULL DEFAULT 'NOTA',
    "presupuestoPartidaId" TEXT,
    "fotos" TEXT[],

    CONSTRAINT "BitacoraEntrada_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pago" (
    "id" TEXT NOT NULL,
    "proyectoId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tipo" "PagoTipo" NOT NULL,
    "monto" DOUBLE PRECISION NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "referencia" TEXT,
    "bankAccountId" TEXT,
    "bankTransactionId" TEXT,
    "estimacionId" TEXT,

    CONSTRAINT "Pago_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cuadrilla" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "proyectoId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "nombre" TEXT NOT NULL,
    "especialidad" TEXT NOT NULL,
    "jefeNombre" TEXT,
    "notas" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Cuadrilla_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CuadrillaMiembro" (
    "id" TEXT NOT NULL,
    "cuadrillaId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nombre" TEXT NOT NULL,
    "employeeId" TEXT,
    "rolEnCuadrilla" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CuadrillaMiembro_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RayaSemanal" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "proyectoId" TEXT NOT NULL,
    "cuadrillaId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "semanaInicio" TIMESTAMP(3) NOT NULL,
    "semanaFin" TIMESTAMP(3) NOT NULL,
    "estado" "RayaEstado" NOT NULL DEFAULT 'BORRADOR',
    "totalDestajo" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notas" TEXT,
    "bankTransactionId" TEXT,
    "pagadaAt" TIMESTAMP(3),

    CONSTRAINT "RayaSemanal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RayaTrabajo" (
    "id" TEXT NOT NULL,
    "rayaId" TEXT NOT NULL,
    "presupuestoPartidaId" TEXT,
    "unidadProyectoId" TEXT,
    "descripcion" TEXT NOT NULL,
    "cantidad" DOUBLE PRECISION,
    "unidad" TEXT,
    "importeDestajo" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "RayaTrabajo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RayaDetalleMiembro" (
    "id" TEXT NOT NULL,
    "rayaId" TEXT NOT NULL,
    "miembroId" TEXT NOT NULL,
    "diasTrabajados" DOUBLE PRECISION NOT NULL DEFAULT 6,
    "importe" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "RayaDetalleMiembro_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Gasto" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "proyectoId" TEXT NOT NULL,
    "bankAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "beneficiarioNombre" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "importe" DOUBLE PRECISION NOT NULL,
    "cantidad" DOUBLE PRECISION,
    "unidad" TEXT,
    "presupuestoPartidaId" TEXT,
    "insumoId" TEXT,
    "reembolsoId" TEXT,
    "comprobanteUrl" TEXT,
    "comprobanteData" TEXT,
    "comprobanteMime" TEXT,
    "comprobanteName" TEXT,
    "pagoComprobanteUrl" TEXT,
    "pagoComprobanteData" TEXT,
    "pagoComprobanteMime" TEXT,
    "pagoComprobanteName" TEXT,
    "estado" "GastoEstado" NOT NULL DEFAULT 'PENDIENTE',
    "caja" BOOLEAN NOT NULL DEFAULT false,
    "indirecto" BOOLEAN NOT NULL DEFAULT false,
    "categoriaIndirecto" TEXT,
    "bankTransactionId" TEXT,
    "pagadoAt" TIMESTAMP(3),
    "enviadaTesoreriaAt" TIMESTAMP(3),
    "aprobadoPor" TEXT,
    "aprobadoAt" TIMESTAMP(3),
    "notas" TEXT,

    CONSTRAINT "Gasto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReembolsoSemanal" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "proyectoId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "semanaInicio" TIMESTAMP(3) NOT NULL,
    "semanaFin" TIMESTAMP(3) NOT NULL,
    "estado" "ReembolsoEstado" NOT NULL DEFAULT 'SUBMITTED',
    "totalGastos" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "anticipoAplicado" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalReembolso" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bankTransactionId" TEXT,
    "reembolsadoAt" TIMESTAMP(3),
    "reembolsadoPor" TEXT,
    "notas" TEXT,

    CONSTRAINT "ReembolsoSemanal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappLink" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "codeHash" TEXT,
    "codeExpiresAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "digestOptIn" BOOLEAN NOT NULL DEFAULT false,
    "activeCompanyId" TEXT,

    CONSTRAINT "WhatsappLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappConversation" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "linkId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "pendingAction" JSONB,

    CONSTRAINT "WhatsappConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyRegimen" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "since" TIMESTAMP(3),
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CompanyRegimen_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappMessage" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "conversationId" TEXT NOT NULL,
    "role" "WhatsappRole" NOT NULL,
    "body" TEXT NOT NULL,
    "providerSid" TEXT,

    CONSTRAINT "WhatsappMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalDocument" (
    "id" TEXT NOT NULL,
    "source" "FiscalSource" NOT NULL,
    "clave" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "publicadoDof" TIMESTAMP(3),
    "vigenciaDesde" TIMESTAMP(3) NOT NULL,
    "vigenciaHasta" TIMESTAMP(3),
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FiscalDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalChunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "articulo" TEXT,
    "parte" INTEGER,
    "contexto" TEXT,
    "texto" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "vigenciaDesde" TIMESTAMP(3) NOT NULL,
    "vigenciaHasta" TIMESTAMP(3),
    "regimenes" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "FiscalChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalHallazgo" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "checkClave" TEXT NOT NULL,
    "severidad" TEXT NOT NULL,
    "mensaje" TEXT NOT NULL,
    "referencias" TEXT[],
    "sugerencia" TEXT NOT NULL,
    "fundamentoLey" TEXT NOT NULL,
    "fundamentoArticulo" TEXT NOT NULL,
    "fundamentoFraccion" TEXT,
    "estado" TEXT NOT NULL DEFAULT 'ABIERTO',
    "posponerHasta" TIMESTAMP(3),
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FiscalHallazgo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationItem" (
    "id" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "companyId" TEXT,
    "categoria" TEXT NOT NULL,
    "severidad" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "cuerpo" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "estado" "EstadoPendiente" NOT NULL DEFAULT 'NUEVO',
    "posponerHasta" TIMESTAMP(3),
    "leidoAt" TIMESTAMP(3),
    "hechoAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceSnapshot" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "resultado" TEXT NOT NULL,
    "motivos" TEXT[],
    "perfil" JSONB,
    "acuseUrl" TEXT,
    "contenidoHash" TEXT NOT NULL,
    "vigencia" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PadelClubConfig" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "playtomicTenantId" TEXT,
    "playtomicApiKey" TEXT,
    "playtomicEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastPlaytomicSyncAt" TIMESTAMP(3),
    "ivaRate" DOUBLE PRECISION NOT NULL DEFAULT 0.16,

    CONSTRAINT "PadelClubConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Court" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "nombre" TEXT NOT NULL,
    "superficie" TEXT,
    "techada" BOOLEAN NOT NULL DEFAULT false,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "playtomicResourceId" TEXT,

    CONSTRAINT "Court_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubMember" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "telefono" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "customerId" TEXT,

    CONSTRAINT "ClubMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reservation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "courtId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "inicio" TIMESTAMP(3) NOT NULL,
    "fin" TIMESTAMP(3) NOT NULL,
    "estado" "ReservationEstado" NOT NULL DEFAULT 'CONFIRMADA',
    "canal" "ReservationCanal" NOT NULL DEFAULT 'STAFF',
    "clubMemberId" TEXT,
    "bookedByUserId" TEXT,
    "clienteNombre" TEXT,
    "playtomicBookingId" TEXT,
    "precio" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pagado" BOOLEAN NOT NULL DEFAULT false,
    "formaPago" "ReservationFormaPago",
    "cobradoAt" TIMESTAMP(3),
    "bankTransactionId" TEXT,
    "recordatorioEnviadoAt" TIMESTAMP(3),
    "notas" TEXT,

    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatConversation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Nueva conversación',
    "visibility" "ChatVisibility" NOT NULL DEFAULT 'PRIVATE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "pendingAction" JSONB,

    CONSTRAINT "ChatConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "companyId" TEXT,
    "userId" TEXT,
    "actorEmail" TEXT,
    "accion" TEXT NOT NULL,
    "entidad" TEXT,
    "entidadId" TEXT,
    "detalle" JSONB,
    "ip" TEXT,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiRefreshToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "etiqueta" TEXT NOT NULL,
    "scope" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedById" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,

    CONSTRAINT "ApiRefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeCustomerId_key" ON "User"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeSubscriptionId_key" ON "User"("stripeSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "Company_rfc_key" ON "Company"("rfc");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyMember_userId_companyId_key" ON "CompanyMember"("userId", "companyId");

-- CreateIndex
CREATE INDEX "Grupo_despachoId_idx" ON "Grupo"("despachoId");

-- CreateIndex
CREATE UNIQUE INDEX "DespachoMember_userId_despachoId_key" ON "DespachoMember"("userId", "despachoId");

-- CreateIndex
CREATE UNIQUE INDEX "DespachoMember_userId_key" ON "DespachoMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DespachoMemberCompany_despachoMemberId_companyId_key" ON "DespachoMemberCompany"("despachoMemberId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyInvitation_tokenHash_key" ON "CompanyInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "CompanyInvitation_companyId_idx" ON "CompanyInvitation"("companyId");

-- CreateIndex
CREATE INDEX "CompanyInvitation_despachoId_idx" ON "CompanyInvitation"("despachoId");

-- CreateIndex
CREATE INDEX "CompanyInvitation_email_idx" ON "CompanyInvitation"("email");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyModule_companyId_modulo_key" ON "CompanyModule"("companyId", "modulo");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_companyId_rfc_key" ON "Customer"("companyId", "rfc");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_companyId_rfc_key" ON "Supplier"("companyId", "rfc");

-- CreateIndex
CREATE UNIQUE INDEX "construccion_supplier_terms_supplierId_key" ON "construccion_supplier_terms"("supplierId");

-- CreateIndex
CREATE INDEX "Invoice_companyId_fecha_idx" ON "Invoice"("companyId", "fecha");

-- CreateIndex
CREATE INDEX "Invoice_companyId_tipo_status_fecha_idx" ON "Invoice"("companyId", "tipo", "status", "fecha");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_companyId_uuid_key" ON "Invoice"("companyId", "uuid");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_companyId_idempotencyKey_key" ON "Invoice"("companyId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "construccion_cfdi_vinculo_invoiceId_key" ON "construccion_cfdi_vinculo"("invoiceId");

-- CreateIndex
CREATE INDEX "construccion_cfdi_vinculo_companyId_idx" ON "construccion_cfdi_vinculo"("companyId");

-- CreateIndex
CREATE INDEX "ActivoFijo_companyId_idx" ON "ActivoFijo"("companyId");

-- CreateIndex
CREATE INDEX "ActivoFijo_invoiceId_idx" ON "ActivoFijo"("invoiceId");

-- CreateIndex
CREATE INDEX "PagoDoctoRelacionado_parentUuid_idx" ON "PagoDoctoRelacionado"("parentUuid");

-- CreateIndex
CREATE INDEX "PagoDoctoRelacionado_fechaPago_idx" ON "PagoDoctoRelacionado"("fechaPago");

-- CreateIndex
CREATE UNIQUE INDEX "PagoDoctoRelacionado_pagoInvoiceId_parentUuid_key" ON "PagoDoctoRelacionado"("pagoInvoiceId", "parentUuid");

-- CreateIndex
CREATE UNIQUE INDEX "IvaPeriodNotice_companyId_periodo_key" ON "IvaPeriodNotice"("companyId", "periodo");

-- CreateIndex
CREATE UNIQUE INDEX "BankAccount_companyId_numeroCuenta_key" ON "BankAccount"("companyId", "numeroCuenta");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_belvoId_key" ON "BankTransaction"("belvoId");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_externalRef_key" ON "BankTransaction"("externalRef");

-- CreateIndex
CREATE INDEX "BankTransaction_bankAccountId_status_idx" ON "BankTransaction"("bankAccountId", "status");

-- CreateIndex
CREATE INDEX "BankTransaction_companyId_fecha_idx" ON "BankTransaction"("companyId", "fecha");

-- CreateIndex
CREATE INDEX "BankTransaction_taxDeclarationId_idx" ON "BankTransaction"("taxDeclarationId");

-- CreateIndex
CREATE INDEX "ConciliacionDetalle_invoiceId_idx" ON "ConciliacionDetalle"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "ConciliacionDetalle_bankTransactionId_invoiceId_key" ON "ConciliacionDetalle"("bankTransactionId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_companyId_rfc_key" ON "Employee"("companyId", "rfc");

-- CreateIndex
CREATE INDEX "Incidencia_companyId_periodo_idx" ON "Incidencia"("companyId", "periodo");

-- CreateIndex
CREATE INDEX "Incidencia_employeeId_fecha_idx" ON "Incidencia"("employeeId", "fecha");

-- CreateIndex
CREATE INDEX "ImssMovimiento_companyId_status_idx" ON "ImssMovimiento"("companyId", "status");

-- CreateIndex
CREATE INDEX "PerdidaFiscal_companyId_idx" ON "PerdidaFiscal"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PerdidaFiscal_companyId_ejercicioOrigen_key" ON "PerdidaFiscal"("companyId", "ejercicioOrigen");

-- CreateIndex
CREATE INDEX "CostEvent_companyId_occurredAt_idx" ON "CostEvent"("companyId", "occurredAt");

-- CreateIndex
CREATE INDEX "CostEvent_despachoId_occurredAt_idx" ON "CostEvent"("despachoId", "occurredAt");

-- CreateIndex
CREATE INDEX "CostEvent_occurredAt_idx" ON "CostEvent"("occurredAt");

-- CreateIndex
CREATE INDEX "CoeEnvio_companyId_idx" ON "CoeEnvio"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "CoeEnvio_companyId_tipoDoc_periodo_key" ON "CoeEnvio"("companyId", "tipoDoc", "periodo");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyObligation_companyId_tipo_key" ON "CompanyObligation"("companyId", "tipo");

-- CreateIndex
CREATE UNIQUE INDEX "CotejoFiscal_dataset_key" ON "CotejoFiscal"("dataset");

-- CreateIndex
CREATE UNIQUE INDEX "ChartAccount_companyId_cuentaSAT_subcuenta_key" ON "ChartAccount"("companyId", "cuentaSAT", "subcuenta");

-- CreateIndex
CREATE INDEX "AccountingEntry_companyId_year_month_idx" ON "AccountingEntry"("companyId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingPeriod_companyId_year_month_key" ON "AccountingPeriod"("companyId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "SatSyncRequest_requestId_key" ON "SatSyncRequest"("requestId");

-- CreateIndex
CREATE INDEX "SatSyncRequest_companyId_year_month_tipo_idx" ON "SatSyncRequest"("companyId", "year", "month", "tipo");

-- CreateIndex
CREATE INDEX "Proyecto_companyId_estado_idx" ON "Proyecto"("companyId", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "Proyecto_companyId_codigo_key" ON "Proyecto"("companyId", "codigo");

-- CreateIndex
CREATE UNIQUE INDEX "Concepto_apuActualId_key" ON "Concepto"("apuActualId");

-- CreateIndex
CREATE UNIQUE INDEX "Concepto_companyId_codigo_key" ON "Concepto"("companyId", "codigo");

-- CreateIndex
CREATE UNIQUE INDEX "APU_conceptoId_version_key" ON "APU"("conceptoId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Insumo_companyId_codigo_key" ON "Insumo"("companyId", "codigo");

-- CreateIndex
CREATE INDEX "construccion_presupuesto_insumo_presupuestoId_idx" ON "construccion_presupuesto_insumo"("presupuestoId");

-- CreateIndex
CREATE UNIQUE INDEX "construccion_presupuesto_insumo_presupuestoId_insumoId_key" ON "construccion_presupuesto_insumo"("presupuestoId", "insumoId");

-- CreateIndex
CREATE UNIQUE INDEX "Estimacion_invoiceId_key" ON "Estimacion"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "Estimacion_bankTransactionId_key" ON "Estimacion"("bankTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "Estimacion_proyectoId_numero_key" ON "Estimacion"("proyectoId", "numero");

-- CreateIndex
CREATE UNIQUE INDEX "EstimacionTemplate_proyectoId_key" ON "EstimacionTemplate"("proyectoId");

-- CreateIndex
CREATE UNIQUE INDEX "EstimacionCurvaCapitulo_templateId_capituloCode_key" ON "EstimacionCurvaCapitulo"("templateId", "capituloCode");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarioCierreCapitulo_templateId_capituloCode_key" ON "CalendarioCierreCapitulo"("templateId", "capituloCode");

-- CreateIndex
CREATE INDEX "UnidadProyecto_proyectoId_parentId_idx" ON "UnidadProyecto"("proyectoId", "parentId");

-- CreateIndex
CREATE UNIQUE INDEX "SolicitudCompra_bankTransactionId_key" ON "SolicitudCompra"("bankTransactionId");

-- CreateIndex
CREATE INDEX "SolicitudCompra_companyId_estado_idx" ON "SolicitudCompra"("companyId", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "SolicitudCompra_companyId_folio_key" ON "SolicitudCompra"("companyId", "folio");

-- CreateIndex
CREATE INDEX "SolicitudCompraCotizacion_solicitudId_isSelected_idx" ON "SolicitudCompraCotizacion"("solicitudId", "isSelected");

-- CreateIndex
CREATE UNIQUE INDEX "construccion_solicitud_adjudicacion_bankTransactionId_key" ON "construccion_solicitud_adjudicacion"("bankTransactionId");

-- CreateIndex
CREATE INDEX "construccion_solicitud_adjudicacion_solicitudId_idx" ON "construccion_solicitud_adjudicacion"("solicitudId");

-- CreateIndex
CREATE INDEX "construccion_solicitud_adjudicacion_companyId_estado_idx" ON "construccion_solicitud_adjudicacion"("companyId", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "SolicitudCotizacionPartida_cotizacionId_solicitudPartidaId_key" ON "SolicitudCotizacionPartida"("cotizacionId", "solicitudPartidaId");

-- CreateIndex
CREATE UNIQUE INDEX "PresupuestoVersion_presupuestoId_version_key" ON "PresupuestoVersion"("presupuestoId", "version");

-- CreateIndex
CREATE INDEX "BitacoraEntrada_proyectoId_fecha_idx" ON "BitacoraEntrada"("proyectoId", "fecha");

-- CreateIndex
CREATE UNIQUE INDEX "Pago_bankTransactionId_key" ON "Pago"("bankTransactionId");

-- CreateIndex
CREATE INDEX "Pago_proyectoId_idx" ON "Pago"("proyectoId");

-- CreateIndex
CREATE INDEX "Cuadrilla_companyId_isActive_idx" ON "Cuadrilla"("companyId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Cuadrilla_proyectoId_nombre_key" ON "Cuadrilla"("proyectoId", "nombre");

-- CreateIndex
CREATE INDEX "CuadrillaMiembro_cuadrillaId_isActive_idx" ON "CuadrillaMiembro"("cuadrillaId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "RayaSemanal_bankTransactionId_key" ON "RayaSemanal"("bankTransactionId");

-- CreateIndex
CREATE INDEX "RayaSemanal_proyectoId_semanaInicio_idx" ON "RayaSemanal"("proyectoId", "semanaInicio");

-- CreateIndex
CREATE INDEX "RayaSemanal_companyId_estado_idx" ON "RayaSemanal"("companyId", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "RayaSemanal_cuadrillaId_semanaInicio_key" ON "RayaSemanal"("cuadrillaId", "semanaInicio");

-- CreateIndex
CREATE INDEX "RayaTrabajo_rayaId_idx" ON "RayaTrabajo"("rayaId");

-- CreateIndex
CREATE UNIQUE INDEX "RayaDetalleMiembro_rayaId_miembroId_key" ON "RayaDetalleMiembro"("rayaId", "miembroId");

-- CreateIndex
CREATE UNIQUE INDEX "Gasto_bankTransactionId_key" ON "Gasto"("bankTransactionId");

-- CreateIndex
CREATE INDEX "Gasto_companyId_estado_idx" ON "Gasto"("companyId", "estado");

-- CreateIndex
CREATE INDEX "Gasto_proyectoId_createdAt_idx" ON "Gasto"("proyectoId", "createdAt");

-- CreateIndex
CREATE INDEX "Gasto_reembolsoId_idx" ON "Gasto"("reembolsoId");

-- CreateIndex
CREATE UNIQUE INDEX "ReembolsoSemanal_bankTransactionId_key" ON "ReembolsoSemanal"("bankTransactionId");

-- CreateIndex
CREATE INDEX "ReembolsoSemanal_companyId_estado_idx" ON "ReembolsoSemanal"("companyId", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "ReembolsoSemanal_proyectoId_semanaInicio_key" ON "ReembolsoSemanal"("proyectoId", "semanaInicio");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappLink_phoneE164_key" ON "WhatsappLink"("phoneE164");

-- CreateIndex
CREATE INDEX "WhatsappLink_userId_idx" ON "WhatsappLink"("userId");

-- CreateIndex
CREATE INDEX "WhatsappConversation_companyId_idx" ON "WhatsappConversation"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappConversation_linkId_companyId_key" ON "WhatsappConversation"("linkId", "companyId");

-- CreateIndex
CREATE INDEX "CompanyRegimen_companyId_idx" ON "CompanyRegimen"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyRegimen_companyId_code_key" ON "CompanyRegimen"("companyId", "code");

-- CreateIndex
CREATE INDEX "WhatsappMessage_conversationId_createdAt_idx" ON "WhatsappMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- CreateIndex
CREATE INDEX "FiscalDocument_source_clave_idx" ON "FiscalDocument"("source", "clave");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalDocument_clave_vigenciaDesde_key" ON "FiscalDocument"("clave", "vigenciaDesde");

-- CreateIndex
CREATE INDEX "FiscalChunk_documentId_idx" ON "FiscalChunk"("documentId");

-- CreateIndex
CREATE INDEX "FiscalHallazgo_companyId_estado_idx" ON "FiscalHallazgo"("companyId", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalHallazgo_companyId_dedupeKey_key" ON "FiscalHallazgo"("companyId", "dedupeKey");

-- CreateIndex
CREATE INDEX "NotificationItem_recipientUserId_idx" ON "NotificationItem"("recipientUserId");

-- CreateIndex
CREATE INDEX "NotificationItem_recipientUserId_estado_idx" ON "NotificationItem"("recipientUserId", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationItem_recipientUserId_dedupeKey_key" ON "NotificationItem"("recipientUserId", "dedupeKey");

-- CreateIndex
CREATE INDEX "ComplianceSnapshot_companyId_tipo_fetchedAt_idx" ON "ComplianceSnapshot"("companyId", "tipo", "fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PadelClubConfig_companyId_key" ON "PadelClubConfig"("companyId");

-- CreateIndex
CREATE INDEX "Court_companyId_activa_idx" ON "Court"("companyId", "activa");

-- CreateIndex
CREATE UNIQUE INDEX "Court_companyId_nombre_key" ON "Court"("companyId", "nombre");

-- CreateIndex
CREATE INDEX "ClubMember_companyId_activo_idx" ON "ClubMember"("companyId", "activo");

-- CreateIndex
CREATE UNIQUE INDEX "ClubMember_companyId_email_key" ON "ClubMember"("companyId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_bankTransactionId_key" ON "Reservation"("bankTransactionId");

-- CreateIndex
CREATE INDEX "Reservation_companyId_inicio_idx" ON "Reservation"("companyId", "inicio");

-- CreateIndex
CREATE INDEX "Reservation_courtId_inicio_idx" ON "Reservation"("courtId", "inicio");

-- CreateIndex
CREATE INDEX "Reservation_clubMemberId_inicio_idx" ON "Reservation"("clubMemberId", "inicio");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_companyId_playtomicBookingId_key" ON "Reservation"("companyId", "playtomicBookingId");

-- CreateIndex
CREATE INDEX "ChatConversation_companyId_visibility_updatedAt_idx" ON "ChatConversation"("companyId", "visibility", "updatedAt");

-- CreateIndex
CREATE INDEX "ChatConversation_userId_updatedAt_idx" ON "ChatConversation"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "ChatMessage_conversationId_createdAt_idx" ON "ChatMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_companyId_createdAt_idx" ON "AuditLog"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_accion_createdAt_idx" ON "AuditLog"("accion", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiRefreshToken_tokenHash_key" ON "ApiRefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ApiRefreshToken_userId_idx" ON "ApiRefreshToken"("userId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_despachoId_fkey" FOREIGN KEY ("despachoId") REFERENCES "Despacho"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_grupoId_fkey" FOREIGN KEY ("grupoId") REFERENCES "Grupo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyMember" ADD CONSTRAINT "CompanyMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyMember" ADD CONSTRAINT "CompanyMember_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grupo" ADD CONSTRAINT "Grupo_despachoId_fkey" FOREIGN KEY ("despachoId") REFERENCES "Despacho"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DespachoMember" ADD CONSTRAINT "DespachoMember_despachoId_fkey" FOREIGN KEY ("despachoId") REFERENCES "Despacho"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DespachoMember" ADD CONSTRAINT "DespachoMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DespachoMemberCompany" ADD CONSTRAINT "DespachoMemberCompany_despachoMemberId_fkey" FOREIGN KEY ("despachoMemberId") REFERENCES "DespachoMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DespachoMemberCompany" ADD CONSTRAINT "DespachoMemberCompany_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyInvitation" ADD CONSTRAINT "CompanyInvitation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyInvitation" ADD CONSTRAINT "CompanyInvitation_despachoId_fkey" FOREIGN KEY ("despachoId") REFERENCES "Despacho"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyModule" ADD CONSTRAINT "CompanyModule_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construccion_supplier_terms" ADD CONSTRAINT "construccion_supplier_terms_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construccion_cfdi_vinculo" ADD CONSTRAINT "construccion_cfdi_vinculo_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivoFijo" ADD CONSTRAINT "ActivoFijo_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivoFijo" ADD CONSTRAINT "ActivoFijo_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PagoDoctoRelacionado" ADD CONSTRAINT "PagoDoctoRelacionado_pagoInvoiceId_fkey" FOREIGN KEY ("pagoInvoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IvaPeriodNotice" ADD CONSTRAINT "IvaPeriodNotice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceTax" ADD CONSTRAINT "InvoiceTax_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_taxDeclarationId_fkey" FOREIGN KEY ("taxDeclarationId") REFERENCES "TaxDeclaration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConciliacionDetalle" ADD CONSTRAINT "ConciliacionDetalle_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConciliacionDetalle" ADD CONSTRAINT "ConciliacionDetalle_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incidencia" ADD CONSTRAINT "Incidencia_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incidencia" ADD CONSTRAINT "Incidencia_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImssMovimiento" ADD CONSTRAINT "ImssMovimiento_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImssMovimiento" ADD CONSTRAINT "ImssMovimiento_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollItem" ADD CONSTRAINT "PayrollItem_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollItem" ADD CONSTRAINT "PayrollItem_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxDeclaration" ADD CONSTRAINT "TaxDeclaration_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerdidaFiscal" ADD CONSTRAINT "PerdidaFiscal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostEvent" ADD CONSTRAINT "CostEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostEvent" ADD CONSTRAINT "CostEvent_despachoId_fkey" FOREIGN KEY ("despachoId") REFERENCES "Despacho"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoeEnvio" ADD CONSTRAINT "CoeEnvio_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyObligation" ADD CONSTRAINT "CompanyObligation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChartAccount" ADD CONSTRAINT "ChartAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingEntry" ADD CONSTRAINT "AccountingEntry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingEntry" ADD CONSTRAINT "AccountingEntry_chartAccountId_fkey" FOREIGN KEY ("chartAccountId") REFERENCES "ChartAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingEntry" ADD CONSTRAINT "AccountingEntry_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "AccountingPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingPeriod" ADD CONSTRAINT "AccountingPeriod_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SatSyncRequest" ADD CONSTRAINT "SatSyncRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proyecto" ADD CONSTRAINT "Proyecto_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proyecto" ADD CONSTRAINT "Proyecto_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Concepto" ADD CONSTRAINT "Concepto_apuActualId_fkey" FOREIGN KEY ("apuActualId") REFERENCES "APU"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Concepto" ADD CONSTRAINT "Concepto_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APU" ADD CONSTRAINT "APU_conceptoId_fkey" FOREIGN KEY ("conceptoId") REFERENCES "Concepto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APU" ADD CONSTRAINT "APU_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APUInsumo" ADD CONSTRAINT "APUInsumo_apuId_fkey" FOREIGN KEY ("apuId") REFERENCES "APU"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APUInsumo" ADD CONSTRAINT "APUInsumo_insumoId_fkey" FOREIGN KEY ("insumoId") REFERENCES "Insumo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APUInsumo" ADD CONSTRAINT "APUInsumo_conceptoRefId_fkey" FOREIGN KEY ("conceptoRefId") REFERENCES "Concepto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Insumo" ADD CONSTRAINT "Insumo_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Presupuesto" ADD CONSTRAINT "Presupuesto_contratoOrigenId_fkey" FOREIGN KEY ("contratoOrigenId") REFERENCES "Presupuesto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Presupuesto" ADD CONSTRAINT "Presupuesto_proyectoId_fkey" FOREIGN KEY ("proyectoId") REFERENCES "Proyecto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Presupuesto" ADD CONSTRAINT "Presupuesto_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construccion_presupuesto_insumo" ADD CONSTRAINT "construccion_presupuesto_insumo_presupuestoId_fkey" FOREIGN KEY ("presupuestoId") REFERENCES "Presupuesto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construccion_presupuesto_insumo" ADD CONSTRAINT "construccion_presupuesto_insumo_insumoId_fkey" FOREIGN KEY ("insumoId") REFERENCES "Insumo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PresupuestoPartida" ADD CONSTRAINT "PresupuestoPartida_parentPartidaId_fkey" FOREIGN KEY ("parentPartidaId") REFERENCES "PresupuestoPartida"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PresupuestoPartida" ADD CONSTRAINT "PresupuestoPartida_unidadProyectoId_fkey" FOREIGN KEY ("unidadProyectoId") REFERENCES "UnidadProyecto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PresupuestoPartida" ADD CONSTRAINT "PresupuestoPartida_contratoPartidaId_fkey" FOREIGN KEY ("contratoPartidaId") REFERENCES "PresupuestoPartida"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PresupuestoPartida" ADD CONSTRAINT "PresupuestoPartida_presupuestoId_fkey" FOREIGN KEY ("presupuestoId") REFERENCES "Presupuesto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PresupuestoPartida" ADD CONSTRAINT "PresupuestoPartida_conceptoId_fkey" FOREIGN KEY ("conceptoId") REFERENCES "Concepto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Estimacion" ADD CONSTRAINT "Estimacion_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Estimacion" ADD CONSTRAINT "Estimacion_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Estimacion" ADD CONSTRAINT "Estimacion_proyectoId_fkey" FOREIGN KEY ("proyectoId") REFERENCES "Proyecto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Estimacion" ADD CONSTRAINT "Estimacion_presupuestoId_fkey" FOREIGN KEY ("presupuestoId") REFERENCES "Presupuesto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Estimacion" ADD CONSTRAINT "Estimacion_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimacionPartida" ADD CONSTRAINT "EstimacionPartida_estimacionId_fkey" FOREIGN KEY ("estimacionId") REFERENCES "Estimacion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimacionPartida" ADD CONSTRAINT "EstimacionPartida_presupuestoPartidaId_fkey" FOREIGN KEY ("presupuestoPartidaId") REFERENCES "PresupuestoPartida"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimacionPartida" ADD CONSTRAINT "EstimacionPartida_templatePartidaId_fkey" FOREIGN KEY ("templatePartidaId") REFERENCES "EstimacionTemplatePartida"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimacionPartida" ADD CONSTRAINT "EstimacionPartida_unidadProyectoId_fkey" FOREIGN KEY ("unidadProyectoId") REFERENCES "UnidadProyecto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimacionTemplate" ADD CONSTRAINT "EstimacionTemplate_proyectoId_fkey" FOREIGN KEY ("proyectoId") REFERENCES "Proyecto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimacionTemplate" ADD CONSTRAINT "EstimacionTemplate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimacionTemplatePartida" ADD CONSTRAINT "EstimacionTemplatePartida_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EstimacionTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimacionTemplatePartida" ADD CONSTRAINT "EstimacionTemplatePartida_presupuestoPartidaId_fkey" FOREIGN KEY ("presupuestoPartidaId") REFERENCES "PresupuestoPartida"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimacionCurvaCapitulo" ADD CONSTRAINT "EstimacionCurvaCapitulo_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EstimacionTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarioCierreCapitulo" ADD CONSTRAINT "CalendarioCierreCapitulo_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EstimacionTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnidadProyecto" ADD CONSTRAINT "UnidadProyecto_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "UnidadProyecto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnidadProyecto" ADD CONSTRAINT "UnidadProyecto_proyectoId_fkey" FOREIGN KEY ("proyectoId") REFERENCES "Proyecto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramaActividad" ADD CONSTRAINT "ProgramaActividad_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ProgramaActividad"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramaActividad" ADD CONSTRAINT "ProgramaActividad_proyectoId_fkey" FOREIGN KEY ("proyectoId") REFERENCES "Proyecto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolicitudCompra" ADD CONSTRAINT "SolicitudCompra_proyectoId_fkey" FOREIGN KEY ("proyectoId") REFERENCES "Proyecto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolicitudCompra" ADD CONSTRAINT "SolicitudCompra_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolicitudCompra" ADD CONSTRAINT "SolicitudCompra_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolicitudCompra" ADD CONSTRAINT "SolicitudCompra_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolicitudPartida" ADD CONSTRAINT "SolicitudPartida_presupuestoPartidaId_fkey" FOREIGN KEY ("presupuestoPartidaId") REFERENCES "PresupuestoPartida"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolicitudPartida" ADD CONSTRAINT "SolicitudPartida_cotizacionGanadoraId_fkey" FOREIGN KEY ("cotizacionGanadoraId") REFERENCES "SolicitudCompraCotizacion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolicitudPartida" ADD CONSTRAINT "SolicitudPartida_solicitudId_fkey" FOREIGN KEY ("solicitudId") REFERENCES "SolicitudCompra"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolicitudPartida" ADD CONSTRAINT "SolicitudPartida_insumoId_fkey" FOREIGN KEY ("insumoId") REFERENCES "Insumo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolicitudCompraCotizacion" ADD CONSTRAINT "SolicitudCompraCotizacion_solicitudId_fkey" FOREIGN KEY ("solicitudId") REFERENCES "SolicitudCompra"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolicitudCompraCotizacion" ADD CONSTRAINT "SolicitudCompraCotizacion_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construccion_solicitud_adjudicacion" ADD CONSTRAINT "construccion_solicitud_adjudicacion_solicitudId_fkey" FOREIGN KEY ("solicitudId") REFERENCES "SolicitudCompra"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construccion_solicitud_adjudicacion" ADD CONSTRAINT "construccion_solicitud_adjudicacion_cotizacionId_fkey" FOREIGN KEY ("cotizacionId") REFERENCES "SolicitudCompraCotizacion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construccion_solicitud_adjudicacion" ADD CONSTRAINT "construccion_solicitud_adjudicacion_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolicitudCotizacionPartida" ADD CONSTRAINT "SolicitudCotizacionPartida_cotizacionId_fkey" FOREIGN KEY ("cotizacionId") REFERENCES "SolicitudCompraCotizacion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolicitudCotizacionPartida" ADD CONSTRAINT "SolicitudCotizacionPartida_solicitudPartidaId_fkey" FOREIGN KEY ("solicitudPartidaId") REFERENCES "SolicitudPartida"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PresupuestoVersion" ADD CONSTRAINT "PresupuestoVersion_presupuestoId_fkey" FOREIGN KEY ("presupuestoId") REFERENCES "Presupuesto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BitacoraEntrada" ADD CONSTRAINT "BitacoraEntrada_proyectoId_fkey" FOREIGN KEY ("proyectoId") REFERENCES "Proyecto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BitacoraEntrada" ADD CONSTRAINT "BitacoraEntrada_presupuestoPartidaId_fkey" FOREIGN KEY ("presupuestoPartidaId") REFERENCES "PresupuestoPartida"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pago" ADD CONSTRAINT "Pago_proyectoId_fkey" FOREIGN KEY ("proyectoId") REFERENCES "Proyecto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pago" ADD CONSTRAINT "Pago_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cuadrilla" ADD CONSTRAINT "Cuadrilla_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cuadrilla" ADD CONSTRAINT "Cuadrilla_proyectoId_fkey" FOREIGN KEY ("proyectoId") REFERENCES "Proyecto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuadrillaMiembro" ADD CONSTRAINT "CuadrillaMiembro_cuadrillaId_fkey" FOREIGN KEY ("cuadrillaId") REFERENCES "Cuadrilla"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuadrillaMiembro" ADD CONSTRAINT "CuadrillaMiembro_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RayaSemanal" ADD CONSTRAINT "RayaSemanal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RayaSemanal" ADD CONSTRAINT "RayaSemanal_proyectoId_fkey" FOREIGN KEY ("proyectoId") REFERENCES "Proyecto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RayaSemanal" ADD CONSTRAINT "RayaSemanal_cuadrillaId_fkey" FOREIGN KEY ("cuadrillaId") REFERENCES "Cuadrilla"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RayaSemanal" ADD CONSTRAINT "RayaSemanal_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RayaTrabajo" ADD CONSTRAINT "RayaTrabajo_rayaId_fkey" FOREIGN KEY ("rayaId") REFERENCES "RayaSemanal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RayaTrabajo" ADD CONSTRAINT "RayaTrabajo_presupuestoPartidaId_fkey" FOREIGN KEY ("presupuestoPartidaId") REFERENCES "PresupuestoPartida"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RayaTrabajo" ADD CONSTRAINT "RayaTrabajo_unidadProyectoId_fkey" FOREIGN KEY ("unidadProyectoId") REFERENCES "UnidadProyecto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RayaDetalleMiembro" ADD CONSTRAINT "RayaDetalleMiembro_rayaId_fkey" FOREIGN KEY ("rayaId") REFERENCES "RayaSemanal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RayaDetalleMiembro" ADD CONSTRAINT "RayaDetalleMiembro_miembroId_fkey" FOREIGN KEY ("miembroId") REFERENCES "CuadrillaMiembro"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gasto" ADD CONSTRAINT "Gasto_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gasto" ADD CONSTRAINT "Gasto_proyectoId_fkey" FOREIGN KEY ("proyectoId") REFERENCES "Proyecto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gasto" ADD CONSTRAINT "Gasto_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gasto" ADD CONSTRAINT "Gasto_presupuestoPartidaId_fkey" FOREIGN KEY ("presupuestoPartidaId") REFERENCES "PresupuestoPartida"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gasto" ADD CONSTRAINT "Gasto_insumoId_fkey" FOREIGN KEY ("insumoId") REFERENCES "Insumo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gasto" ADD CONSTRAINT "Gasto_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gasto" ADD CONSTRAINT "Gasto_reembolsoId_fkey" FOREIGN KEY ("reembolsoId") REFERENCES "ReembolsoSemanal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReembolsoSemanal" ADD CONSTRAINT "ReembolsoSemanal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReembolsoSemanal" ADD CONSTRAINT "ReembolsoSemanal_proyectoId_fkey" FOREIGN KEY ("proyectoId") REFERENCES "Proyecto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReembolsoSemanal" ADD CONSTRAINT "ReembolsoSemanal_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReembolsoSemanal" ADD CONSTRAINT "ReembolsoSemanal_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappLink" ADD CONSTRAINT "WhatsappLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappLink" ADD CONSTRAINT "WhatsappLink_activeCompanyId_fkey" FOREIGN KEY ("activeCompanyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappConversation" ADD CONSTRAINT "WhatsappConversation_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "WhatsappLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappConversation" ADD CONSTRAINT "WhatsappConversation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyRegimen" ADD CONSTRAINT "CompanyRegimen_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappMessage" ADD CONSTRAINT "WhatsappMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "WhatsappConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalChunk" ADD CONSTRAINT "FiscalChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "FiscalDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PadelClubConfig" ADD CONSTRAINT "PadelClubConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Court" ADD CONSTRAINT "Court_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubMember" ADD CONSTRAINT "ClubMember_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubMember" ADD CONSTRAINT "ClubMember_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_courtId_fkey" FOREIGN KEY ("courtId") REFERENCES "Court"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_clubMemberId_fkey" FOREIGN KEY ("clubMemberId") REFERENCES "ClubMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatConversation" ADD CONSTRAINT "ChatConversation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatConversation" ADD CONSTRAINT "ChatConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiRefreshToken" ADD CONSTRAINT "ApiRefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

