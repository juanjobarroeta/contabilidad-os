/**
 * POST /api/hospital/solicitudes-area/requisicionar { companyId, notas?, fechaEntrega?,
 *        lineas: [{ lineaId, cantidad, descripcion?, unidad? }],
 *        cotizaciones: [{ supplierId, tieneCredito?, diasCredito?, diasEntrega?, vigenciaHasta?, notas?,
 *                         precios: [{ lineaId, precioUnitario }] }],
 *        ganadoras?: { [lineaId]: índice de cotización } }
 *
 * Compras arma desde la bandeja UNA requisición con las cotizaciones de uno o
 * varios proveedores; cada línea gana con la más barata salvo que se elija
 * otra. Nace por autorizar (REQ-AAAA-NNNN); quien autoriza puede cambiar la
 * ganadora por línea y sale una orden por proveedor ganador.
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
  notas: z.string().trim().max(1000).nullable().optional(),
  fechaEntrega: fechaSchema.nullable().optional(),
  lineas: z
    .array(
      z.object({
        lineaId: z.string().min(1),
        cantidad: z.number().positive("La cantidad debe ser mayor a cero").max(10_000_000),
        descripcion: z.string().trim().max(300).nullable().optional(),
        unidad: z.string().trim().max(20).nullable().optional(),
      })
    )
    .min(1, "Elige al menos una línea")
    .max(200),
  cotizaciones: z
    .array(
      z.object({
        supplierId: z.string().min(1, "Elige el proveedor de cada cotización"),
        tieneCredito: z.boolean().nullable().optional(),
        diasCredito: z.number().int().min(0).max(365).nullable().optional(),
        diasEntrega: z.number().int().min(0).max(365).nullable().optional(),
        vigenciaHasta: fechaSchema.nullable().optional(),
        notas: z.string().trim().max(1000).nullable().optional(),
        precios: z.array(z.object({ lineaId: z.string().min(1), precioUnitario: z.number().min(0).max(100_000_000) })).min(1, "Cada cotización lleva al menos un precio"),
      })
    )
    .min(1, "Captura al menos una cotización")
    .max(10),
  ganadoras: z.record(z.string().min(1), z.number().int().min(0)).nullable().optional(),
});

export const POST = withHospital(async (req: Request) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Datos inválidos");
  const d = parsed.data;
  const { user } = await requireWriter(d.companyId, req);
  await requireModule(d.companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  const r = await requisicionarLineas(d.companyId, user.id, {
    ...d,
    fechaEntrega: d.fechaEntrega ? new Date(d.fechaEntrega) : null,
    cotizaciones: d.cotizaciones.map((c) => ({ ...c, vigenciaHasta: c.vigenciaHasta ? new Date(c.vigenciaHasta) : null })),
  });
  bitacora(user, req, { companyId: d.companyId, accion: "hospital.requisicion.crear", entidad: "SolicitudCompra", entidadId: r.id, detalle: { folio: r.folio, total: r.total, desde: "bandeja", cotizaciones: d.cotizaciones.length } });
  return NextResponse.json({ requisicion: r, requisiciones: [r] }, { status: 201 });
});
