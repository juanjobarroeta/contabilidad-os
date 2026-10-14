import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod, usuarioDe } from "@/lib/hospital/http";
import { HospitalError } from "@/lib/hospital/errores";
import { leerCodigo, normalizarGtin } from "@/lib/hospital/codigos-barras";
import { ORIGEN_HOSPITAL } from "@/lib/hospital/requisiciones";

// ─────────────────────────────────────────────────────────────────────────────
// GET  /api/hospital/farmacia/codigos?companyId=&codigo=
//   Resuelve lo que leyó el escáner: el insumo ligado (con sus lotes y las
//   líneas de orden de compra pendientes de recibir), o «desconocido». Si el
//   código es GS1, también trae lote y caducidad.
// POST /api/hospital/farmacia/codigos  { companyId, codigo, insumoId, reasignar? }
//   Liga un código a un insumo — una sola vez por código y empresa.
//
// La recepción NO vive aquí: el escáner usa el mismo POST /farmacia/lotes de
// siempre (con solicitudPartidaId cuando llega contra una orden), para que
// compra → orden → recepción → lote sigan siendo una sola cadena.
// ─────────────────────────────────────────────────────────────────────────────

const r2 = (n: number) => Math.round(n * 100) / 100;

export const GET = withHospital(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const companyId = sp.get("companyId");
  const codigo = sp.get("codigo") ?? "";
  if (!companyId) return error("companyId requerido");
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const leido = leerCodigo(codigo);
  if (!leido.gtin) {
    return NextResponse.json({ leido, insumo: null, motivo: leido.tipo === "OTRO" ? "No es un código de producto (EAN/UPC/GS1) o se leyó mal: vuelve a escanear." : "El código no trae el producto." });
  }

  const liga = await prisma.hospCodigoBarras.findUnique({
    where: { companyId_gtin: { companyId, gtin: leido.gtin } },
    select: {
      insumo: {
        select: {
          id: true, clave: true, nombre: true, presentacion: true, unidad: true, categoria: true, controlado: true,
          ultimoCosto: true, precioVenta: true, activo: true,
          lotes: {
            where: { OR: [{ existencia: { gt: 0 } }, ...(leido.lote ? [{ lote: leido.lote }] : [])] },
            select: { id: true, lote: true, almacen: true, caducidad: true, existencia: true, bloqueado: true, precioMaximoPublico: true },
            orderBy: [{ caducidad: { sort: "asc", nulls: "last" } }],
          },
        },
      },
    },
  });
  if (!liga) return NextResponse.json({ leido, insumo: null, motivo: "Código nuevo: elige una vez a qué insumo pertenece." });

  const i = liga.insumo;
  // Líneas de órdenes autorizadas de este insumo que aún esperan recepción.
  const partidas = await prisma.solicitudPartida.findMany({
    where: { hospInsumoId: i.id, solicitud: { companyId, origen: ORIGEN_HOSPITAL, estado: { in: ["APROBADA", "PAGADA"] } } },
    select: { id: true, cantidad: true, cantidadRecibida: true, solicitud: { select: { folio: true, supplierId: true, createdAt: true } } },
    orderBy: { solicitud: { createdAt: "asc" } },
    take: 20,
  });
  const pendientes = partidas
    .map((p) => ({ id: p.id, folio: p.solicitud.folio, faltan: r2(Number(p.cantidad) - Number(p.cantidadRecibida)), supplierId: p.solicitud.supplierId }))
    .filter((p) => p.faltan > 0.000001);

  return NextResponse.json({
    leido,
    insumo: {
      id: i.id, clave: i.clave, nombre: i.nombre, presentacion: i.presentacion, unidad: i.unidad, categoria: i.categoria,
      controlado: i.controlado, activo: i.activo,
      ultimoCosto: i.ultimoCosto == null ? null : Number(i.ultimoCosto),
      precioVenta: i.precioVenta == null ? null : Number(i.precioVenta),
      lotes: i.lotes.map((l) => ({
        id: l.id, lote: l.lote, almacen: l.almacen, caducidad: l.caducidad, existencia: r2(Number(l.existencia)), bloqueado: l.bloqueado,
        precioMaximoPublico: l.precioMaximoPublico == null ? null : Number(l.precioMaximoPublico),
        coincideConEscaneo: !!leido.lote && l.lote.toUpperCase() === leido.lote.toUpperCase(),
      })),
    },
    ordenesPendientes: pendientes,
  });
});

const ligarSchema = z.object({
  companyId: z.string().min(1),
  codigo: z.string().trim().min(1).max(200),
  insumoId: z.string().min(1),
  /// El código ya estaba ligado a otro insumo y se quiere mover (error de captura).
  reasignar: z.boolean().optional(),
});

export const POST = withHospital(async (req: Request) => {
  const parsed = ligarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorZod(parsed.error);
  const { companyId, codigo, insumoId, reasignar } = parsed.data;
  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);

  const gtin = leerCodigo(codigo).gtin ?? normalizarGtin(codigo);
  if (!gtin) return error("No es un código de producto válido (EAN-13, UPC-A o GTIN-14 con su dígito verificador)");
  const insumo = await prisma.hospInsumo.findFirst({ where: { id: insumoId, companyId }, select: { id: true, clave: true, nombre: true } });
  if (!insumo) throw new HospitalError(404, "Insumo no encontrado");

  const previo = await prisma.hospCodigoBarras.findUnique({
    where: { companyId_gtin: { companyId, gtin } },
    select: { id: true, insumoId: true, insumo: { select: { nombre: true } } },
  });
  if (previo && previo.insumoId !== insumoId && !reasignar) {
    throw new HospitalError(409, `Ese código ya es de «${previo.insumo.nombre}». Si se ligó mal, confirma para moverlo.`);
  }
  const nombre = usuarioDe(user).nombre;
  const fila = previo
    ? await prisma.hospCodigoBarras.update({ where: { id: previo.id }, data: { insumoId, original: codigo, creadoPorNombre: nombre } })
    : await prisma.hospCodigoBarras.create({ data: { companyId, insumoId, gtin, original: codigo, creadoPorNombre: nombre } });

  bitacora(user, req, {
    companyId,
    accion: previo ? "hospital.codigo.reasignar" : "hospital.codigo.ligar",
    entidad: "HospCodigoBarras",
    entidadId: fila.id,
    detalle: { gtin, insumoId, clave: insumo.clave, antes: previo?.insumoId ?? null },
  });
  return NextResponse.json({ codigo: { id: fila.id, gtin, insumoId }, insumo }, { status: previo ? 200 : 201 });
});
