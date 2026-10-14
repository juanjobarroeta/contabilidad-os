/**
 * POST /api/hospital/solicitudes-area/requisicionar { companyId,
 *        grupos: [{ supplierId, notas?, fechaEntrega?, lineas: [{ lineaId, cantidad, precioUnitario, descripcion?, unidad? }] }] }
 *
 * Compras arma desde la bandeja una requisición por proveedor; cada una nace
 * por autorizar (REQ-AAAA-NNNN) con sus líneas ligadas a lo que pidió el área.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, fechaSchema } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { requisicionarLineas } from "@/lib/hospital/bandeja-compras";

const schema = z.object({
  companyId: z.string().min(1),
  grupos: z
    .array(
      z.object({
        supplierId: z.string().min(1, "Elige el proveedor"),
        notas: z.string().trim().max(1000).nullable().optional(),
        fechaEntrega: fechaSchema.nullable().optional(),
        lineas: z
          .array(
            z.object({
              lineaId: z.string().min(1),
              cantidad: z.number().positive("La cantidad debe ser mayor a cero").max(10_000_000),
              precioUnitario: z.number().min(0).max(100_000_000),
              descripcion: z.string().trim().max(300).nullable().optional(),
              unidad: z.string().trim().max(20).nullable().optional(),
            })
          )
          .min(1, "Cada proveedor lleva al menos una línea"),
      })
    )
    .min(1)
    .max(20),
});

export const POST = withHospital(async (req: Request) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Datos inválidos");
  const d = parsed.data;
  const { user } = await requireWriter(d.companyId, req);
  await requireModule(d.companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  const creadas = await requisicionarLineas(
    d.companyId,
    user.id,
    d.grupos.map((g) => ({ ...g, fechaEntrega: g.fechaEntrega ? new Date(g.fechaEntrega) : null }))
  );
  for (const r of creadas) {
    bitacora(user, req, { companyId: d.companyId, accion: "hospital.requisicion.crear", entidad: "SolicitudCompra", entidadId: r.id, detalle: { folio: r.folio, total: r.total, desde: "bandeja" } });
  }
  return NextResponse.json({ requisiciones: creadas }, { status: 201 });
});
