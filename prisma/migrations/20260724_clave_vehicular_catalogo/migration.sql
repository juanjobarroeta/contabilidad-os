-- CreateTable
CREATE TABLE "ClaveVehicularCatalogo" (
    "clave" TEXT NOT NULL,
    "empresa" TEXT NOT NULL,
    "modelo" TEXT NOT NULL,
    "version" TEXT,
    "fuente" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClaveVehicularCatalogo_pkey" PRIMARY KEY ("clave")
);

