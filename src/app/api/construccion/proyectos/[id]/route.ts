import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireMembership,
  requireModule,
  withAuthz,
} from "@/lib/authz";

/**
 * GET /api/construccion/proyectos/:id
 *
 * Returns a single proyecto with the relations the detalle UI needs:
 * customer, presupuestos (with partidas count), estimaciones, last 20
 * solicitudes de compra. Module-gated behind CONSTRUCCION.
 */
export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const proyecto = await prisma.proyecto.findUnique({
      where: { id },
      include: {
        customer: {
          select: { id: true, razonSocial: true, rfc: true, email: true },
        },
        presupuestos: {
          select: {
            id: true,
            nombre: true,
            version: true,
            estado: true,
            montoTotal: true,
            tipoPresupuesto: true,
            contratoOrigenId: true,
            createdAt: true,
            _count: { select: { partidas: true } },
            versiones: {
              select: { version: true, descripcion: true, snapshotTotal: true, createdAt: true },
              orderBy: { version: "desc" as const },
              take: 10,
            },
            // Include partidas with cost data for the financial summary.
            // Only returned for APROBADO/EN_EJECUCION presupuestos to keep
            // the response lean when there are many BORRADOR drafts.
            partidas: {
              select: {
                id: true,
                cantidad: true,
                precioUnitario: true,
                importe: true,
                zona: true,
                partida: true,
                contratoPartidaId: true,
                // Tree fields so the client can skip rollup branches when
                // summing / grouping (they're metadata, not line items).
                parentPartidaId: true,
                nivel: true,
                codigo: true,
                esRollup: true,
                concepto: {
                  select: {
                    codigo: true,
                    descripcion: true,
                    unidad: true,
                    apuActual: {
                      select: { costoDirecto: true, precioUnitario: true },
                    },
                  },
                },
              },
              orderBy: [{ nivel: "asc" }, { codigo: "asc" }, { orden: "asc" }],
            },
          },
          orderBy: { version: "asc" },
        },
        estimaciones: {
          select: {
            id: true,
            numero: true,
            estado: true,
            periodoInicio: true,
            periodoFin: true,
            subtotal: true,
            iva: true,
            total: true,
            invoiceId: true,
            createdAt: true,
            partidas: {
              select: {
                presupuestoPartidaId: true,
                cantidadEjecutada: true,
                cantidadAcumulada: true,
                importe: true,
              },
            },
          },
          orderBy: { numero: "desc" },
        },
        solicitudesCompra: {
          select: {
            id: true,
            folio: true,
            estado: true,
            total: true,
            createdAt: true,
            supplier: { select: { id: true, razonSocial: true } },
            partidas: {
              select: {
                id: true,
                cantidad: true,
                importe: true,
                presupuestoPartidaId: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
          take: 50,
        },
        pagos: {
          select: {
            id: true,
            tipo: true,
            monto: true,
            fecha: true,
            referencia: true,
            estimacionId: true,
          },
          orderBy: { fecha: "desc" },
        },
        unidades: {
          select: {
            id: true,
            parentId: true,
            nombre: true,
            tipo: true,
            codigo: true,
            orden: true,
            metadata: true,
          },
          orderBy: [{ parentId: "asc" }, { orden: "asc" }],
        },
        bitacora: {
          select: {
            id: true,
            fecha: true,
            texto: true,
            tipo: true,
            fotos: true,
            presupuestoPartida: {
              select: { zona: true, partida: true, concepto: { select: { codigo: true } } },
            },
          },
          orderBy: { fecha: "desc" },
          take: 10,
        },
      },
    });

    if (!proyecto) {
      throw new AuthzError(404, "Proyecto no encontrado");
    }

    // Tenant + module check against the proyecto's own company
    await requireMembership(proyecto.companyId, undefined, req);
    await requireModule(proyecto.companyId, "CONSTRUCCION");

    return NextResponse.json(proyecto);
  }
);
