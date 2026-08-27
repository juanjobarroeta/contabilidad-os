import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";
import { parseFechaCorte } from "@/lib/purificadora/cortes";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const entregaInclude = {
  ruta: { select: { id: true, nombre: true } },
  customer: { select: { id: true, razonSocial: true } },
  sucursal: { select: { id: true, nombre: true } },
} as const;

// GET /api/purificadora/entregas?companyId=xxx&fecha=YYYY-MM-DD[&estado=]
//
// Entregas en ruta del día + resumen listo para volcarse al corte:
//   casasPorRuta — efectivo / transferencia (incluye tarjeta: cae al banco) /
//                  garrafones por ruta
//   empresas     — garrafones agregados por cliente+sucursal
//   cortesias    — garrafones + valor de referencia
// Sólo cuentan las REGISTRADAS (pendientes de autorización).
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const fechaStr = searchParams.get("fecha");
  const fecha = fechaStr ? parseFechaCorte(fechaStr) : null;
  if (fechaStr && !fecha) return NextResponse.json({ error: "Fecha inválida" }, { status: 400 });

  const estado = searchParams.get("estado");

  const entregas = await prisma.purifEntrega.findMany({
    where: {
      companyId,
      ...(fecha ? { fecha } : {}),
      ...(estado === "REGISTRADO" || estado === "INTEGRADO" || estado === "CANCELADO"
        ? { estado }
        : {}),
    },
    include: entregaInclude,
    orderBy: { createdAt: "desc" },
    take: 300,
  });

  const pendientes = entregas.filter((e) => e.estado === "REGISTRADO");

  type CasasRuta = {
    rutaId: string | null;
    rutaNombre: string;
    efectivo: number;
    transferencia: number;
    garrafones: number;
  };
  const casasPorRuta = new Map<string, CasasRuta>();
  type EmpresaLinea = {
    customerId: string;
    customerNombre: string;
    sucursalId: string | null;
    sucursalNombre: string | null;
    garrafones: number;
    importe: number;
  };
  const empresas = new Map<string, EmpresaLinea>();
  const cortesias = { garrafones: 0, importe: 0 };

  for (const e of pendientes) {
    if (e.tipo === "CASAS") {
      const key = e.rutaId ?? "__sin__";
      let row = casasPorRuta.get(key);
      if (!row) {
        row = {
          rutaId: e.rutaId,
          rutaNombre: e.ruta?.nombre ?? "Sin ruta",
          efectivo: 0,
          transferencia: 0,
          garrafones: 0,
        };
        casasPorRuta.set(key, row);
      }
      if (e.formaPago === "EFECTIVO") row.efectivo = round2(row.efectivo + Number(e.importe));
      else row.transferencia = round2(row.transferencia + Number(e.importe)); // transferencia y tarjeta caen al banco
      row.garrafones += e.garrafones;
    } else if (e.tipo === "EMPRESA" && e.customerId) {
      const key = `${e.customerId}:${e.sucursalId ?? ""}`;
      let row = empresas.get(key);
      if (!row) {
        row = {
          customerId: e.customerId,
          customerNombre: e.customer?.razonSocial ?? "—",
          sucursalId: e.sucursalId,
          sucursalNombre: e.sucursal?.nombre ?? null,
          garrafones: 0,
          importe: 0,
        };
        empresas.set(key, row);
      }
      row.garrafones += e.garrafones;
      row.importe = round2(row.importe + Number(e.importe));
    } else if (e.tipo === "CORTESIA") {
      cortesias.garrafones += e.garrafones;
      cortesias.importe = round2(cortesias.importe + Number(e.importe));
    }
  }

  return NextResponse.json({
    entregas,
    resumen: {
      pendientes: pendientes.length,
      garrafones: pendientes.reduce((s, e) => s + e.garrafones, 0),
      casasPorRuta: [...casasPorRuta.values()],
      empresas: [...empresas.values()],
      cortesias,
    },
  });
});

const createSchema = z.object({
  companyId: z.string().min(1),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tipo: z.enum(["CASAS", "EMPRESA", "CORTESIA"]),
  rutaId: z.string().min(1).nullish(),
  customerId: z.string().min(1).nullish(),
  sucursalId: z.string().min(1).nullish(),
  garrafones: z.number().int().positive(),
  importe: z.number().min(0).optional(),
  formaPago: z.enum(["EFECTIVO", "TRANSFERENCIA", "TARJETA"]).optional(),
  notas: z.string().trim().max(300).nullish(),
});

// POST /api/purificadora/entregas — el repartidor registra una entrega.
// CASAS: garrafones + importe cobrado + forma de pago.
// EMPRESA: garrafones; el importe lo calcula el servidor al precio pactado
//          del cliente y la forma de pago SIEMPRE es crédito.
// CORTESIA: garrafones; importe de referencia = garrafones × precio de lista.
// No postea contabilidad — queda REGISTRADO hasta que el corte se confirma.
export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, tipo, rutaId, customerId, sucursalId, garrafones, notas } = parsed.data;
  const fecha = parseFechaCorte(parsed.data.fecha);
  if (!fecha) return NextResponse.json({ error: "Fecha inválida" }, { status: 400 });

  const { user: actor } = await requireWriter(companyId, req);
  await requireModule(companyId, "PURIFICADORA", req);

  if (rutaId) {
    const ruta = await prisma.purifRuta.findUnique({
      where: { id: rutaId },
      select: { companyId: true },
    });
    if (!ruta || ruta.companyId !== companyId) {
      return NextResponse.json({ error: "Ruta inválida" }, { status: 400 });
    }
  }

  let importe = 0;
  let formaPago: "EFECTIVO" | "TRANSFERENCIA" | "TARJETA" | "CREDITO" | null = null;

  if (tipo === "CASAS") {
    if (parsed.data.importe === undefined || !parsed.data.formaPago) {
      return NextResponse.json(
        { error: "Una venta a casas necesita importe y forma de pago" },
        { status: 400 }
      );
    }
    importe = round2(parsed.data.importe);
    formaPago = parsed.data.formaPago;
  } else if (tipo === "EMPRESA") {
    if (!customerId) {
      return NextResponse.json({ error: "La entrega a empresa necesita cliente" }, { status: 400 });
    }
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { companyId: true },
    });
    if (!customer || customer.companyId !== companyId) {
      return NextResponse.json({ error: "Cliente inválido" }, { status: 400 });
    }
    if (sucursalId) {
      const sucursal = await prisma.purifSucursal.findUnique({
        where: { id: sucursalId },
        select: { companyId: true, customerId: true },
      });
      if (!sucursal || sucursal.companyId !== companyId || sucursal.customerId !== customerId) {
        return NextResponse.json({ error: "Sucursal inválida" }, { status: 400 });
      }
    }
    const [clienteConfig, config] = await Promise.all([
      prisma.purifClienteConfig.findUnique({
        where: { companyId_customerId: { companyId, customerId } },
      }),
      prisma.purifConfig.findUnique({ where: { companyId } }),
    ]);
    const precio = Number(clienteConfig?.precioGarrafon ?? config?.precioGarrafon ?? 15);
    importe = round2(garrafones * precio);
    formaPago = "CREDITO";
  } else {
    // CORTESIA: valor de referencia al precio de lista (no es ingreso).
    const config = await prisma.purifConfig.findUnique({ where: { companyId } });
    importe = round2(garrafones * Number(config?.precioGarrafon ?? 15));
    formaPago = null;
  }

  const entrega = await prisma.purifEntrega.create({
    data: {
      companyId,
      fecha,
      tipo,
      rutaId: rutaId ?? null,
      customerId: tipo === "EMPRESA" ? customerId : null,
      sucursalId: tipo === "EMPRESA" ? sucursalId ?? null : null,
      garrafones,
      importe,
      formaPago,
      notas: notas ?? null,
    },
    include: entregaInclude,
  });

  registrarBitacora({
    companyId,
    userId: actor.id,
    actorEmail: actor.email,
    accion: "entrega.crear",
    entidad: "PurifEntrega",
    entidadId: entrega.id,
    detalle: { tipo, garrafones, importe, fecha: parsed.data.fecha },
  });

  return NextResponse.json(entrega, { status: 201 });
});
