import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { linkWa, telefonoWa } from "@/lib/automotriz/whatsapp";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/automotriz/whatsapp?companyId=… — la cola de WhatsApp (fase 2b).
//
// Compone los mensajes del día SIN API de Meta: cada renglón trae el texto
// personalizado y un link wa.me listo para abrir — el asesor da clic, WhatsApp
// se abre con el mensaje escrito y él decide enviarlo. Fuentes:
//   - CRM: prospectos abiertos con seguimiento vencido y teléfono.
//   - Servicio: clientes con ≥2 servicios que llevan >6 meses sin venir.
// Cuando exista la integración con la Cloud API (fase 2c), esta misma cola se
// vuelve el feed del envío automatizado.
// ─────────────────────────────────────────────────────────────────────────────

const ABIERTOS = ["NUEVO", "CONTACTADO", "CITA", "DEMO", "NEGOCIACION"] as const;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const seisMeses = new Date();
  seisMeses.setMonth(seisMeses.getMonth() - 6);

  const [company, prospectosVencidos, serviciosPorCliente] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { razonSocial: true } }),
    prisma.prospecto.findMany({
      where: {
        companyId,
        estado: { in: [...ABIERTOS] },
        proximaAccion: { lt: new Date() },
        telefono: { not: null },
      },
      include: {
        vendedor: { select: { nombre: true, apellidoPaterno: true } },
        vehiculo: { select: { marca: true, modelo: true, anio: true } },
      },
      orderBy: { proximaAccion: "asc" },
      take: 100,
    }),
    prisma.servicioVenta.groupBy({
      by: ["clienteId"],
      where: { companyId, clienteId: { not: null } },
      _count: { _all: true },
      _max: { fecha: true },
    }),
  ]);
  const empresa = company?.razonSocial ?? "la agencia";

  const noRegresanIds = serviciosPorCliente
    .filter((c) => c._count._all >= 2 && c._max.fecha && c._max.fecha < seisMeses)
    .sort((a, b) => (b._max.fecha && a._max.fecha ? +new Date(b._max.fecha) - +new Date(a._max.fecha) : 0))
    .slice(0, 100);
  const ultimaVisita = new Map(noRegresanIds.map((c) => [c.clienteId!, c._max.fecha!]));

  const clientes = noRegresanIds.length
    ? await prisma.customer.findMany({
        where: { id: { in: noRegresanIds.map((c) => c.clienteId!) }, phone: { not: null } },
        select: { id: true, razonSocial: true, phone: true },
      })
    : [];

  const crm = prospectosVencidos.flatMap((p) => {
    const tel = telefonoWa(p.telefono!);
    if (!tel) return [];
    const vendedor = p.vendedor ? `${p.vendedor.nombre}` : null;
    const interes =
      p.interes ?? (p.vehiculo ? `${p.vehiculo.marca} ${p.vehiculo.modelo} ${p.vehiculo.anio}` : null);
    const mensaje =
      `Hola ${p.nombre.split(/\s+/)[0]}, ${vendedor ? `soy ${vendedor}, ` : ""}de ${empresa}. ` +
      (interes ? `Quedé de darte seguimiento sobre ${interes}. ` : `Quedé de darte seguimiento. `) +
      `¿Cómo vas? ¿Te gustaría que agendemos una visita?`;
    return [
      {
        tipo: "CRM" as const,
        prospectoId: p.id,
        nombre: p.nombre,
        telefono: p.telefono,
        estado: p.estado,
        vencidaDesde: p.proximaAccion,
        nota: p.proximaNota,
        mensaje,
        link: linkWa(tel, mensaje),
      },
    ];
  });

  const servicio = clientes.flatMap((c) => {
    const tel = telefonoWa(c.phone!);
    if (!tel) return [];
    const ultima = ultimaVisita.get(c.id)!;
    const meses = Math.floor((Date.now() - +new Date(ultima)) / (30.44 * 24 * 3600 * 1000));
    const mensaje =
      `Hola, le saludamos del taller de ${empresa}. Notamos que su unidad no nos visita desde hace ` +
      `${meses} meses — ¿le gustaría agendar su servicio? Con gusto le apartamos lugar esta semana.`;
    return [
      {
        tipo: "SERVICIO" as const,
        clienteId: c.id,
        nombre: c.razonSocial,
        telefono: c.phone,
        ultimaVisita: ultima,
        mensaje,
        link: linkWa(tel, mensaje),
      },
    ];
  });

  return NextResponse.json({
    crm,
    servicio,
    total: crm.length + servicio.length,
    sinTelefono: {
      crm: prospectosVencidos.length - crm.length,
      servicio: noRegresanIds.length - servicio.length,
    },
  });
});
