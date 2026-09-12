/**
 * GET /api/hospital/cotizaciones/[id]/pdf — la cotización en PDF carta, para
 *     entregarla: al paciente, a la aseguradora, al familiar que paga. Siempre
 *     attachment y sin caché, como las demás descargas del módulo. Emite el
 *     hospital (HospConfig.nombreHospital, o el nombre comercial, o la razón
 *     social) con su RFC, domicilio fiscal, CLUES y licencia sanitaria.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { incluyeCotizacion, serializarCotizacion } from "@/lib/hospital/cotizacion";
import { generarPdfCotizacion } from "@/lib/hospital/cotizacion-pdf";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const c = await prisma.hospCotizacion.findUnique({ where: { id }, include: incluyeCotizacion });
  if (!c) throw new AuthzError(404, "Cotización no encontrada");

  await requireMembership(c.companyId, undefined, req);
  await requireModule(c.companyId, "HOSPITAL", req);

  const [company, config] = await Promise.all([
    prisma.company.findUnique({ where: { id: c.companyId }, select: { razonSocial: true, nombreComercial: true, rfc: true, domicilioFiscal: true, telefono: true, email: true } }),
    prisma.hospConfig.findUnique({ where: { companyId: c.companyId }, select: { nombreHospital: true, clues: true, licenciaSanitaria: true } }),
  ]);
  if (!company) throw new AuthzError(404, "Empresa no encontrada");

  const s = serializarCotizacion(c);
  const bytes = await generarPdfCotizacion(
    {
      folio: c.folio, estado: c.estado, createdAt: c.createdAt, vigenciaHasta: c.vigenciaHasta,
      pacienteNombre: c.pacienteNombre, procedimiento: c.procedimiento, notas: c.notas,
      pagador: c.pagador ? { nombre: c.pagador.nombre, tabulador: c.pagador.tabulador } : null,
      partidas: s.partidas.map((p) => ({ descripcion: p.descripcion, categoria: p.categoria, cantidad: Number(p.cantidad), precioUnitario: Number(p.precioUnitario), ivaTasa: p.ivaTasa == null ? null : Number(p.ivaTasa), importe: Number(p.importe) })),
      subtotal: s.subtotal, iva: s.iva, total: s.total,
    },
    {
      nombre: config?.nombreHospital || company.nombreComercial || company.razonSocial,
      razonSocial: company.razonSocial, rfc: company.rfc, domicilio: company.domicilioFiscal,
      telefono: company.telefono, email: company.email,
      clues: config?.clues ?? null, licenciaSanitaria: config?.licenciaSanitaria ?? null,
    },
  );

  const nombre = `cotizacion-${c.folio.replace(/[^\w-]+/g, "_")}.pdf`;
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename="${nombre}"`,
      "Cache-Control": "private, no-store",
    },
  });
});
