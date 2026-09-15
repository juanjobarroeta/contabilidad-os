-- Plazos procesales con su cómputo guardado.
--
-- Se guarda el rastro completo (traza) y no sólo la fecha de vencimiento,
-- porque el calendario del órgano cambia: si el juzgado suspende labores en
-- diciembre, hay que poder ver qué se calculó antes del acuerdo y recomputar.
-- Una fecha suelta no permite eso.
--
-- Nace en estado 'propuesto': el producto nunca presenta un plazo como verdad
-- hasta que un abogado lo confirma.

CREATE TABLE "JuridicoPlazo" (
    "id" TEXT NOT NULL,
    "casoId" TEXT NOT NULL,
    "creadoPorUserId" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "fundamento" TEXT,
    "ordenamiento" TEXT,
    "articulo" TEXT,
    "fuero" TEXT NOT NULL,
    "entidad" TEXT,
    "notificacion" DATE NOT NULL,
    "dias" INTEGER NOT NULL,
    "tipo" TEXT NOT NULL DEFAULT 'habiles',
    "surteEfectos" TEXT NOT NULL DEFAULT 'mismo_dia',
    "vence" DATE NOT NULL,
    "traza" JSONB NOT NULL,
    "advertencias" JSONB,
    "estado" TEXT NOT NULL DEFAULT 'propuesto',
    "confirmadoPorUserId" TEXT,
    "confirmadoAt" TIMESTAMP(3),
    "cumplidoAt" TIMESTAMP(3),
    "nota" TEXT,
    "origen" TEXT NOT NULL DEFAULT 'manual',
    "tareaId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JuridicoPlazo_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JuridicoPlazo_casoId_estado_idx" ON "JuridicoPlazo"("casoId", "estado");
CREATE INDEX "JuridicoPlazo_casoId_vence_idx" ON "JuridicoPlazo"("casoId", "vence");
CREATE INDEX "JuridicoPlazo_estado_vence_idx" ON "JuridicoPlazo"("estado", "vence");
ALTER TABLE "JuridicoPlazo" ADD CONSTRAINT "JuridicoPlazo_casoId_fkey"
    FOREIGN KEY ("casoId") REFERENCES "JuridicoAsunto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Los inhábiles que ninguna ley lista: suspensiones, vacaciones del órgano,
-- festivos locales. despachoId nulo = lo cargó el operador para todos.
CREATE TABLE "JuridicoInhabil" (
    "id" TEXT NOT NULL,
    "despachoId" TEXT,
    "fuero" TEXT,
    "entidad" TEXT,
    "fecha" DATE NOT NULL,
    "motivo" TEXT NOT NULL,
    "fuente" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JuridicoInhabil_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JuridicoInhabil_despachoId_fecha_idx" ON "JuridicoInhabil"("despachoId", "fecha");
CREATE INDEX "JuridicoInhabil_fecha_idx" ON "JuridicoInhabil"("fecha");
