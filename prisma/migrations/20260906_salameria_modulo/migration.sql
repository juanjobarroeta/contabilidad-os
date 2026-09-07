-- CreateEnum
CREATE TYPE "SalUnidad" AS ENUM ('PZA', 'CAJA', 'KG', 'G', 'L', 'ML');

-- CreateEnum
CREATE TYPE "SalMovTipo" AS ENUM ('ENTRADA_IMPORTACION', 'ENTRADA_COMPRA', 'ENTRADA_DEVOLUCION', 'SALIDA_PEDIDO', 'SALIDA_MERMA', 'SALIDA_CADUCIDAD', 'AJUSTE');

-- CreateEnum
CREATE TYPE "SalCompraEstado" AS ENUM ('BORRADOR', 'ORDENADA', 'RECIBIDA', 'PAGADA', 'CANCELADA');

-- CreateEnum
CREATE TYPE "SalFormaPago" AS ENUM ('EFECTIVO', 'TRANSFERENCIA', 'TARJETA');

-- CreateEnum
CREATE TYPE "SalImportacionEstado" AS ENUM ('BORRADOR', 'EN_TRANSITO', 'EN_ADUANA', 'LIBERADA', 'CANCELADA');

-- CreateEnum
CREATE TYPE "SalCostoTipo" AS ENUM ('FLETE_INTERNACIONAL', 'SEGURO', 'ARANCEL', 'DTA', 'IVA_IMPORTACION', 'AGENTE_ADUANAL', 'MANIOBRAS', 'ALMACENAJE', 'FLETE_NACIONAL', 'OTRO');

-- CreateEnum
CREATE TYPE "SalProrrateoBase" AS ENUM ('VALOR', 'PESO', 'CANTIDAD');

-- CreateEnum
CREATE TYPE "SalListaTipo" AS ENUM ('MENUDEO', 'MAYOREO', 'CLIENTE');

-- CreateEnum
CREATE TYPE "SalPedidoOrigen" AS ENUM ('TIENDA', 'MOSTRADOR', 'WHATSAPP', 'TELEFONO');

-- CreateEnum
CREATE TYPE "SalPedidoEstado" AS ENUM ('CARRITO', 'PENDIENTE_PAGO', 'PAGADO', 'SURTIDO', 'ENVIADO', 'ENTREGADO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "SalPagoMetodo" AS ENUM ('TARJETA', 'TRANSFERENCIA', 'EFECTIVO', 'OXXO', 'CREDITO');

-- CreateEnum
CREATE TYPE "SalEnvioEstado" AS ENUM ('PENDIENTE', 'RECOLECTADO', 'EN_TRANSITO', 'ENTREGADO', 'INCIDENCIA');

-- AlterEnum
ALTER TYPE "EntrySource" ADD VALUE 'SALAMERIA';

-- AlterEnum
ALTER TYPE "ModuloApp" ADD VALUE 'SALAMERIA';

-- AlterTable
ALTER TABLE "CompanyMember" ADD COLUMN     "salameriaPaginas" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "SalConfig" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "seriePedido" TEXT NOT NULL DEFAULT 'PED',
    "serieCompra" TEXT NOT NULL DEFAULT 'OC',
    "serieImportacion" TEXT NOT NULL DEFAULT 'IMP',
    "ivaTasaDefault" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "diasAlertaCaducidad" INTEGER NOT NULL DEFAULT 90,
    "tiendaNombre" TEXT NOT NULL DEFAULT 'La Salamería',
    "tiendaDominio" TEXT,
    "tiendaActiva" BOOLEAN NOT NULL DEFAULT false,
    "envioUmbral" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "envioTarifa" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "envioTarifaBase" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "anticipoPreventa" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "avisoPrivacidadUrl" TEXT,

    CONSTRAINT "SalConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalProducto" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sku" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "marca" TEXT,
    "categoria" TEXT,
    "descripcion" TEXT,
    "unidad" "SalUnidad" NOT NULL DEFAULT 'PZA',
    "presentacion" TEXT,
    "piezasPorCaja" INTEGER NOT NULL DEFAULT 0,
    "pesoKg" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "claveProdServ" TEXT,
    "claveUnidad" TEXT DEFAULT 'H87',
    "ivaTasa" DECIMAL(18,6) DEFAULT 0,
    "costoPromedio" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "stock" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "stockMinimo" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "publicado" BOOLEAN NOT NULL DEFAULT false,
    "destacado" BOOLEAN NOT NULL DEFAULT false,
    "preventa" BOOLEAN NOT NULL DEFAULT false,
    "fechaLlegada" TIMESTAMP(3),
    "imagenes" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "SalProducto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalLote" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "productoId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "codigo" TEXT,
    "caducidad" TIMESTAMP(3),
    "cantidadInicial" DECIMAL(18,6) NOT NULL,
    "cantidad" DECIMAL(18,6) NOT NULL,
    "costoUnitario" DECIMAL(18,6) NOT NULL,
    "importacionId" TEXT,
    "compraId" TEXT,

    CONSTRAINT "SalLote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalMovimiento" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "productoId" TEXT NOT NULL,
    "loteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tipo" "SalMovTipo" NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cantidad" DECIMAL(18,6) NOT NULL,
    "costoUnitario" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "referencia" TEXT,
    "referenciaTipo" TEXT,
    "nota" TEXT,
    "usuarioId" TEXT,

    CONSTRAINT "SalMovimiento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalCompra" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "folio" TEXT NOT NULL,
    "supplierId" TEXT,
    "estado" "SalCompraEstado" NOT NULL DEFAULT 'ORDENADA',
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subtotal" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "iva" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "notas" TEXT,
    "recibidaAt" TIMESTAMP(3),
    "pagadaAt" TIMESTAMP(3),
    "formaPago" "SalFormaPago",
    "bankAccountId" TEXT,
    "bankTransactionId" TEXT,

    CONSTRAINT "SalCompra_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalCompraItem" (
    "id" TEXT NOT NULL,
    "compraId" TEXT NOT NULL,
    "productoId" TEXT NOT NULL,
    "cantidad" DECIMAL(18,6) NOT NULL,
    "costoUnitario" DECIMAL(18,6) NOT NULL,
    "importe" DECIMAL(18,6) NOT NULL,
    "loteCodigo" TEXT,
    "caducidad" TIMESTAMP(3),

    CONSTRAINT "SalCompraItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalImportacion" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "folio" TEXT NOT NULL,
    "estado" "SalImportacionEstado" NOT NULL DEFAULT 'EN_TRANSITO',
    "supplierId" TEXT,
    "pedimento" TEXT,
    "aduana" TEXT,
    "fechaPedimento" TIMESTAMP(3),
    "fechaLlegada" TIMESTAMP(3),
    "liberadaAt" TIMESTAMP(3),
    "moneda" TEXT NOT NULL DEFAULT 'USD',
    "tipoCambio" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "notas" TEXT,

    CONSTRAINT "SalImportacion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalImportacionItem" (
    "id" TEXT NOT NULL,
    "importacionId" TEXT NOT NULL,
    "productoId" TEXT NOT NULL,
    "cantidad" DECIMAL(18,6) NOT NULL,
    "precioMoneda" DECIMAL(18,6) NOT NULL,
    "loteCodigo" TEXT,
    "caducidad" TIMESTAMP(3),
    "costoUnitario" DECIMAL(18,6),

    CONSTRAINT "SalImportacionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalImportacionCosto" (
    "id" TEXT NOT NULL,
    "importacionId" TEXT NOT NULL,
    "tipo" "SalCostoTipo" NOT NULL,
    "descripcion" TEXT,
    "importe" DECIMAL(18,6) NOT NULL,
    "prorratea" BOOLEAN NOT NULL DEFAULT true,
    "base" "SalProrrateoBase" NOT NULL DEFAULT 'VALOR',
    "supplierId" TEXT,

    CONSTRAINT "SalImportacionCosto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalListaPrecio" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "nombre" TEXT NOT NULL,
    "tipo" "SalListaTipo" NOT NULL DEFAULT 'MAYOREO',
    "publica" BOOLEAN NOT NULL DEFAULT false,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "descuento" DECIMAL(18,6) NOT NULL DEFAULT 0,

    CONSTRAINT "SalListaPrecio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalPrecio" (
    "id" TEXT NOT NULL,
    "listaId" TEXT NOT NULL,
    "productoId" TEXT NOT NULL,
    "precio" DECIMAL(18,6) NOT NULL,
    "minimo" DECIMAL(18,6) NOT NULL DEFAULT 1,

    CONSTRAINT "SalPrecio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalCuenta" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "nombre" TEXT,
    "telefono" TEXT,
    "customerId" TEXT,
    "listaId" TEXT,
    "diasCredito" INTEGER NOT NULL DEFAULT 0,
    "limiteCredito" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "ultimoLogin" TIMESTAMP(3),

    CONSTRAINT "SalCuenta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalPedido" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "folio" TEXT NOT NULL,
    "origen" "SalPedidoOrigen" NOT NULL DEFAULT 'TIENDA',
    "estado" "SalPedidoEstado" NOT NULL DEFAULT 'CARRITO',
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cuentaId" TEXT,
    "customerId" TEXT,
    "envioNombre" TEXT,
    "envioTelefono" TEXT,
    "envioCalle" TEXT,
    "envioColonia" TEXT,
    "envioCiudad" TEXT,
    "envioEstado" TEXT,
    "envioCp" TEXT,
    "envioReferencia" TEXT,
    "recogeEnTienda" BOOLEAN NOT NULL DEFAULT false,
    "subtotal" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "descuento" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "envio" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "iva" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "pagado" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "esPreventa" BOOLEAN NOT NULL DEFAULT false,
    "notas" TEXT,
    "pagadoAt" TIMESTAMP(3),
    "surtidoAt" TIMESTAMP(3),
    "entregadoAt" TIMESTAMP(3),
    "canceladoAt" TIMESTAMP(3),
    "motivoCancelacion" TEXT,
    "invoiceId" TEXT,

    CONSTRAINT "SalPedido_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalPedidoPartida" (
    "id" TEXT NOT NULL,
    "pedidoId" TEXT NOT NULL,
    "productoId" TEXT NOT NULL,
    "cantidad" DECIMAL(18,6) NOT NULL,
    "precio" DECIMAL(18,6) NOT NULL,
    "ivaTasa" DECIMAL(18,6),
    "importe" DECIMAL(18,6) NOT NULL,
    "nombreCongelado" TEXT,
    "lotesSurtidos" JSONB,
    "costoUnitario" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "esPreventa" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SalPedidoPartida_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalPago" (
    "id" TEXT NOT NULL,
    "pedidoId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metodo" "SalPagoMetodo" NOT NULL,
    "importe" DECIMAL(18,6) NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "esAnticipo" BOOLEAN NOT NULL DEFAULT false,
    "referenciaExterna" TEXT,
    "bankTransactionId" TEXT,

    CONSTRAINT "SalPago_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalEnvio" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "pedidoId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "paqueteria" TEXT,
    "guia" TEXT,
    "estado" "SalEnvioEstado" NOT NULL DEFAULT 'PENDIENTE',
    "costo" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "enviadoAt" TIMESTAMP(3),
    "entregadoAt" TIMESTAMP(3),
    "nota" TEXT,

    CONSTRAINT "SalEnvio_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SalConfig_companyId_key" ON "SalConfig"("companyId");

-- CreateIndex
CREATE INDEX "SalProducto_companyId_activo_idx" ON "SalProducto"("companyId", "activo");

-- CreateIndex
CREATE INDEX "SalProducto_companyId_publicado_idx" ON "SalProducto"("companyId", "publicado");

-- CreateIndex
CREATE INDEX "SalProducto_companyId_categoria_idx" ON "SalProducto"("companyId", "categoria");

-- CreateIndex
CREATE UNIQUE INDEX "SalProducto_companyId_sku_key" ON "SalProducto"("companyId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "SalProducto_companyId_slug_key" ON "SalProducto"("companyId", "slug");

-- CreateIndex
CREATE INDEX "SalLote_companyId_caducidad_idx" ON "SalLote"("companyId", "caducidad");

-- CreateIndex
CREATE INDEX "SalLote_productoId_caducidad_idx" ON "SalLote"("productoId", "caducidad");

-- CreateIndex
CREATE INDEX "SalLote_companyId_productoId_idx" ON "SalLote"("companyId", "productoId");

-- CreateIndex
CREATE INDEX "SalMovimiento_companyId_fecha_idx" ON "SalMovimiento"("companyId", "fecha");

-- CreateIndex
CREATE INDEX "SalMovimiento_productoId_fecha_idx" ON "SalMovimiento"("productoId", "fecha");

-- CreateIndex
CREATE INDEX "SalMovimiento_companyId_referenciaTipo_referencia_idx" ON "SalMovimiento"("companyId", "referenciaTipo", "referencia");

-- CreateIndex
CREATE UNIQUE INDEX "SalCompra_bankTransactionId_key" ON "SalCompra"("bankTransactionId");

-- CreateIndex
CREATE INDEX "SalCompra_companyId_estado_idx" ON "SalCompra"("companyId", "estado");

-- CreateIndex
CREATE INDEX "SalCompra_companyId_fecha_idx" ON "SalCompra"("companyId", "fecha");

-- CreateIndex
CREATE UNIQUE INDEX "SalCompra_companyId_folio_key" ON "SalCompra"("companyId", "folio");

-- CreateIndex
CREATE INDEX "SalCompraItem_compraId_idx" ON "SalCompraItem"("compraId");

-- CreateIndex
CREATE INDEX "SalCompraItem_productoId_idx" ON "SalCompraItem"("productoId");

-- CreateIndex
CREATE INDEX "SalImportacion_companyId_estado_idx" ON "SalImportacion"("companyId", "estado");

-- CreateIndex
CREATE INDEX "SalImportacion_companyId_fechaLlegada_idx" ON "SalImportacion"("companyId", "fechaLlegada");

-- CreateIndex
CREATE UNIQUE INDEX "SalImportacion_companyId_folio_key" ON "SalImportacion"("companyId", "folio");

-- CreateIndex
CREATE INDEX "SalImportacionItem_importacionId_idx" ON "SalImportacionItem"("importacionId");

-- CreateIndex
CREATE INDEX "SalImportacionItem_productoId_idx" ON "SalImportacionItem"("productoId");

-- CreateIndex
CREATE INDEX "SalImportacionCosto_importacionId_idx" ON "SalImportacionCosto"("importacionId");

-- CreateIndex
CREATE INDEX "SalListaPrecio_companyId_activa_idx" ON "SalListaPrecio"("companyId", "activa");

-- CreateIndex
CREATE UNIQUE INDEX "SalListaPrecio_companyId_nombre_key" ON "SalListaPrecio"("companyId", "nombre");

-- CreateIndex
CREATE INDEX "SalPrecio_productoId_idx" ON "SalPrecio"("productoId");

-- CreateIndex
CREATE UNIQUE INDEX "SalPrecio_listaId_productoId_minimo_key" ON "SalPrecio"("listaId", "productoId", "minimo");

-- CreateIndex
CREATE INDEX "SalCuenta_companyId_activa_idx" ON "SalCuenta"("companyId", "activa");

-- CreateIndex
CREATE UNIQUE INDEX "SalCuenta_companyId_email_key" ON "SalCuenta"("companyId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "SalPedido_invoiceId_key" ON "SalPedido"("invoiceId");

-- CreateIndex
CREATE INDEX "SalPedido_companyId_estado_idx" ON "SalPedido"("companyId", "estado");

-- CreateIndex
CREATE INDEX "SalPedido_companyId_fecha_idx" ON "SalPedido"("companyId", "fecha");

-- CreateIndex
CREATE INDEX "SalPedido_cuentaId_estado_idx" ON "SalPedido"("cuentaId", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "SalPedido_companyId_folio_key" ON "SalPedido"("companyId", "folio");

-- CreateIndex
CREATE INDEX "SalPedidoPartida_pedidoId_idx" ON "SalPedidoPartida"("pedidoId");

-- CreateIndex
CREATE INDEX "SalPedidoPartida_productoId_idx" ON "SalPedidoPartida"("productoId");

-- CreateIndex
CREATE UNIQUE INDEX "SalPago_referenciaExterna_key" ON "SalPago"("referenciaExterna");

-- CreateIndex
CREATE UNIQUE INDEX "SalPago_bankTransactionId_key" ON "SalPago"("bankTransactionId");

-- CreateIndex
CREATE INDEX "SalPago_pedidoId_idx" ON "SalPago"("pedidoId");

-- CreateIndex
CREATE INDEX "SalEnvio_companyId_estado_idx" ON "SalEnvio"("companyId", "estado");

-- CreateIndex
CREATE INDEX "SalEnvio_pedidoId_idx" ON "SalEnvio"("pedidoId");

-- AddForeignKey
ALTER TABLE "SalConfig" ADD CONSTRAINT "SalConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalProducto" ADD CONSTRAINT "SalProducto_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalLote" ADD CONSTRAINT "SalLote_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalLote" ADD CONSTRAINT "SalLote_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "SalProducto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalLote" ADD CONSTRAINT "SalLote_importacionId_fkey" FOREIGN KEY ("importacionId") REFERENCES "SalImportacion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalLote" ADD CONSTRAINT "SalLote_compraId_fkey" FOREIGN KEY ("compraId") REFERENCES "SalCompra"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalMovimiento" ADD CONSTRAINT "SalMovimiento_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalMovimiento" ADD CONSTRAINT "SalMovimiento_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "SalProducto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalMovimiento" ADD CONSTRAINT "SalMovimiento_loteId_fkey" FOREIGN KEY ("loteId") REFERENCES "SalLote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalCompra" ADD CONSTRAINT "SalCompra_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalCompra" ADD CONSTRAINT "SalCompra_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalCompra" ADD CONSTRAINT "SalCompra_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalCompraItem" ADD CONSTRAINT "SalCompraItem_compraId_fkey" FOREIGN KEY ("compraId") REFERENCES "SalCompra"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalCompraItem" ADD CONSTRAINT "SalCompraItem_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "SalProducto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalImportacion" ADD CONSTRAINT "SalImportacion_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalImportacion" ADD CONSTRAINT "SalImportacion_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalImportacionItem" ADD CONSTRAINT "SalImportacionItem_importacionId_fkey" FOREIGN KEY ("importacionId") REFERENCES "SalImportacion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalImportacionItem" ADD CONSTRAINT "SalImportacionItem_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "SalProducto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalImportacionCosto" ADD CONSTRAINT "SalImportacionCosto_importacionId_fkey" FOREIGN KEY ("importacionId") REFERENCES "SalImportacion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalListaPrecio" ADD CONSTRAINT "SalListaPrecio_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalPrecio" ADD CONSTRAINT "SalPrecio_listaId_fkey" FOREIGN KEY ("listaId") REFERENCES "SalListaPrecio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalPrecio" ADD CONSTRAINT "SalPrecio_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "SalProducto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalCuenta" ADD CONSTRAINT "SalCuenta_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalCuenta" ADD CONSTRAINT "SalCuenta_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalCuenta" ADD CONSTRAINT "SalCuenta_listaId_fkey" FOREIGN KEY ("listaId") REFERENCES "SalListaPrecio"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalPedido" ADD CONSTRAINT "SalPedido_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalPedido" ADD CONSTRAINT "SalPedido_cuentaId_fkey" FOREIGN KEY ("cuentaId") REFERENCES "SalCuenta"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalPedido" ADD CONSTRAINT "SalPedido_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalPedido" ADD CONSTRAINT "SalPedido_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalPedidoPartida" ADD CONSTRAINT "SalPedidoPartida_pedidoId_fkey" FOREIGN KEY ("pedidoId") REFERENCES "SalPedido"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalPedidoPartida" ADD CONSTRAINT "SalPedidoPartida_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "SalProducto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalPago" ADD CONSTRAINT "SalPago_pedidoId_fkey" FOREIGN KEY ("pedidoId") REFERENCES "SalPedido"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalPago" ADD CONSTRAINT "SalPago_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalEnvio" ADD CONSTRAINT "SalEnvio_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalEnvio" ADD CONSTRAINT "SalEnvio_pedidoId_fkey" FOREIGN KEY ("pedidoId") REFERENCES "SalPedido"("id") ON DELETE CASCADE ON UPDATE CASCADE;

