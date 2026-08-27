import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { unidadVigentePorVin } from "@/lib/automotriz/unidad-vigente";
import { camposRecepcion, datosRecepcion } from "@/lib/automotriz/recepcion";
import { registrarBitacora } from "@/lib/audit";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/automotriz/citas/[id]/recibir — el puente de un tap: la unidad
// llegó, la cita se convierte en orden de servicio RECIBIDA.
//
// El body es el payload de recepción (checkup incluido); cualquier campo que
// no venga se toma de la cita — el asesor corrige en banqueta, no re-captura.
// Todo pasa en UNA transacción: crear la orden y marcar la cita RECIBIDA con
// su ordenId. El @unique de ordenId + el check de estado cierran la carrera
// del doble-recibir (el segundo tap recibe 422, no una orden duplicada).
// ─────────────────────────────────────────────────────────────────────────────

const lineaSchema = z.object({
  tipo: z.enum(["MANO_OBRA", "REFACCION"]),
  descripcion: z.string().min(1).max(300),
  cantidad: z.number().positive().default(1),
  precioUnitario: z.number().min(0).default(0),
  refaccionId: z.string().nullable().optional(),
});

const schema = z.object({
  clienteId: z.string().nullable().optional(),
  vin: z.string().max(17).nullable().optional(),
  descripcionUnidad: z.string().max(200).nullable().optional(),
  placas: z.string().max(20).nullable().optional(),
  kilometraje: z.number().int().min(0).nullable().optional(),
  fallaReportada: z.string().min(1).max(4000),
  asesorId: z.string().nullable().optional(),
  tecnicoId: z.string().nullable().optional(),
  prometidaAt: z.string().datetime().nullable().optional(),
  notas: z.string().max(4000).nullable().optional(),
  lineas: z.array(lineaSchema).max(50).optional(),
  ...camposRecepcion,
});

export const POST = withAuthz(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  const cita = await prisma.citaServicio.findUnique({ where: { id } });
  if (!cita) throw new AuthzError(404, "Cita no encontrada");
  const { user } = await requireWriter(cita.companyId, req);
  await requireModule(cita.companyId, "AUTOMOTRIZ", req);

  if ((cita.estado !== "PENDIENTE" && cita.estado !== "CONFIRMADA") || cita.ordenId) {
    return NextResponse.json({ error: `La cita ya se recibió o no está abierta (${cita.estado})` }, { status: 422 });
  }

  const clienteId = d.clienteId !== undefined ? d.clienteId : cita.customerId;
  if (clienteId) {
    const cliente = await prisma.customer.findUnique({ where: { id: clienteId }, select: { companyId: true } });
    if (!cliente || cliente.companyId !== cita.companyId) {
      return NextResponse.json({ error: "clienteId inválido" }, { status: 400 });
    }
  }
  for (const empId of [d.asesorId, d.tecnicoId]) {
    if (!empId) continue;
    const emp = await prisma.employee.findUnique({ where: { id: empId }, select: { companyId: true } });
    if (!emp || emp.companyId !== cita.companyId) {
      return NextResponse.json({ error: "asesorId/tecnicoId inválido" }, { status: 400 });
    }
  }

  const vin = (d.vin !== undefined ? d.vin : cita.vin)?.trim().toUpperCase() || null;
  let vehiculoId: string | null = cita.vehiculoId;
  if (vin && vin.length === 17) {
    const unidad = await unidadVigentePorVin(prisma, cita.companyId, vin, { id: true });
    vehiculoId = unidad?.id ?? vehiculoId;
  }

  // Cita telefónica sin expediente: el nombre/teléfono libres no se pierden —
  // viajan en las notas de la orden (clienteId queda null = Mostrador).
  let notas = d.notas ?? cita.notas ?? null;
  if (!clienteId && cita.clienteNombre) {
    const walkIn = `Cita walk-in: ${cita.clienteNombre}${cita.telefono ? ` · ${cita.telefono}` : ""}`;
    notas = notas ? `${walkIn}\n${notas}` : walkIn;
  }

  // Folio consecutivo con reintento (unique [companyId, folio]) ENVOLVIENDO la
  // transacción completa: orden y cita caen juntas o no caen.
  for (let intento = 0; ; intento++) {
    const max = await prisma.ordenServicio.aggregate({
      where: { companyId: cita.companyId },
      _max: { folio: true },
    });
    try {
      const orden = await prisma.$transaction(async (tx) => {
        const creada = await tx.ordenServicio.create({
          data: {
            companyId: cita.companyId,
            folio: (max._max.folio ?? 0) + 1,
            clienteId: clienteId ?? null,
            vehiculoId,
            vin,
            descripcionUnidad: d.descripcionUnidad ?? cita.descripcionUnidad ?? null,
            placas: (d.placas !== undefined ? d.placas : cita.placas)?.trim().toUpperCase() || null,
            kilometraje: d.kilometraje ?? null,
            fallaReportada: d.fallaReportada,
            asesorId: d.asesorId ?? null,
            tecnicoId: d.tecnicoId ?? null,
            prometidaAt: d.prometidaAt ? new Date(d.prometidaAt) : null,
            notas,
            ...datosRecepcion(d),
            lineas: d.lineas?.length
              ? {
                  create: d.lineas.map((l) => ({
                    tipo: l.tipo,
                    descripcion: l.descripcion,
                    cantidad: l.cantidad,
                    precioUnitario: l.precioUnitario,
                    refaccionId: l.refaccionId ?? null,
                  })),
                }
              : undefined,
          },
          include: {
            cliente: { select: { id: true, razonSocial: true, phone: true } },
            vehiculo: { select: { id: true, vin: true, marca: true, modelo: true, anio: true } },
            asesor: { select: { id: true, nombre: true, apellidoPaterno: true } },
            lineas: true,
          },
        });
        // Guardia de carrera DENTRO de la transacción: si otro tap ya puso
        // ordenId, count=0 y el throw revierte también la orden recién creada.
        const marcada = await tx.citaServicio.updateMany({
          where: { id, ordenId: null, estado: { in: ["PENDIENTE", "CONFIRMADA"] } },
          data: { estado: "RECIBIDA", ordenId: creada.id },
        });
        if (marcada.count === 0) throw new AuthzError(422, "La cita ya se recibió");
        return creada;
      });

      registrarBitacora({
        companyId: cita.companyId,
        userId: user.id,
        actorEmail: user.email,
        accion: "automotriz.cita.recibir",
        entidad: "CitaServicio",
        entidadId: id,
        detalle: { ordenId: orden.id, folio: orden.folio },
      });
      return NextResponse.json(orden, { status: 201 });
    } catch (e) {
      const esChoqueFolio =
        e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && intento < 3;
      if (!esChoqueFolio) throw e; // AuthzError(422) del doble-recibir incluido: withAuthz lo vuelve JSON
    }
  }
});
