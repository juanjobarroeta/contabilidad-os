/**
 * POST   /api/salameria/importaciones/[id]/costos
 * DELETE /api/salameria/importaciones/[id]/costos?costoId=...
 *
 * Los gastos del pedimento, que se capturan conforme llegan las facturas del
 * agente aduanal (rara vez todas juntas).
 *
 * `prorratea` y `base` traen el default correcto según el tipo para que nadie
 * tenga que acordarse: el IVA de importación NUNCA prorratea (es acreditable),
 * el flete se reparte por PESO y el resto por VALOR. Se pueden pisar, pero el
 * default es el que no pierde dinero.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";

const TIPOS = [
  "FLETE_INTERNACIONAL",
  "SEGURO",
  "ARANCEL",
  "DTA",
  "IVA_IMPORTACION",
  "AGENTE_ADUANAL",
  "MANIOBRAS",
  "ALMACENAJE",
  "FLETE_NACIONAL",
  "OTRO",
] as const;

type Tipo = (typeof TIPOS)[number];

/** El default correcto por tipo de costo. */
function defaults(tipo: Tipo): { prorratea: boolean; base: "VALOR" | "PESO" | "CANTIDAD" } {
  // El IVA pagado en aduana se acredita: es un activo (1118), no costo.
  if (tipo === "IVA_IMPORTACION") return { prorratea: false, base: "VALOR" };
  // Lo que se paga por mover volumen se reparte por peso.
  if (tipo === "FLETE_INTERNACIONAL" || tipo === "FLETE_NACIONAL" || tipo === "MANIOBRAS") {
    return { prorratea: true, base: "PESO" };
  }
  return { prorratea: true, base: "VALOR" };
}

const schema = z.object({
  tipo: z.enum(TIPOS),
  importe: z.number().positive(),
  descripcion: z.string().max(200).nullable().optional(),
  supplierId: z.string().nullable().optional(),
  prorratea: z.boolean().optional(),
  base: z.enum(["VALOR", "PESO", "CANTIDAD"]).optional(),
});

async function cargarImportacion(id: string) {
  const imp = await prisma.salImportacion.findUnique({
    where: { id },
    select: { id: true, companyId: true, estado: true },
  });
  if (!imp) throw new AuthzError(404, "Importación no encontrada");
  return imp;
}

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const imp = await cargarImportacion(id);
    await requireWriter(imp.companyId, req);
    await requireModule(imp.companyId, "SALAMERIA", req);

    if (imp.estado === "LIBERADA") {
      return NextResponse.json(
        {
          error:
            "La importación ya está liberada: un costo que llega tarde se captura como gasto del período, no cambia el costo de lotes ya vendidos",
        },
        { status: 409 }
      );
    }

    const d = defaults(parsed.data.tipo);
    const costo = await prisma.salImportacionCosto.create({
      data: {
        importacionId: id,
        tipo: parsed.data.tipo,
        importe: parsed.data.importe,
        descripcion: parsed.data.descripcion ?? null,
        supplierId: parsed.data.supplierId ?? null,
        prorratea: parsed.data.prorratea ?? d.prorratea,
        base: parsed.data.base ?? d.base,
      },
    });

    return NextResponse.json(costo, { status: 201 });
  }
);

export const DELETE = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const costoId = new URL(req.url).searchParams.get("costoId");
    if (!costoId) {
      return NextResponse.json({ error: "costoId requerido" }, { status: 400 });
    }

    const imp = await cargarImportacion(id);
    await requireWriter(imp.companyId, req);
    await requireModule(imp.companyId, "SALAMERIA", req);

    if (imp.estado === "LIBERADA") {
      return NextResponse.json(
        { error: "La importación ya está liberada: sus costos no se borran" },
        { status: 409 }
      );
    }

    // El where lleva importacionId para que un costoId de OTRA importación no
    // se pueda borrar pasando el id de una a la que sí se tiene acceso.
    const { count } = await prisma.salImportacionCosto.deleteMany({
      where: { id: costoId, importacionId: id },
    });
    if (count === 0) {
      return NextResponse.json({ error: "Costo no encontrado" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  }
);
