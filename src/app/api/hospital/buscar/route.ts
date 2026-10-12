/**
 * GET /api/hospital/buscar?companyId=…&q=…
 *
 * Búsqueda transversal para la paleta del satélite (⌘K / «Buscar paciente»):
 * una petición que barre pacientes, episodios, insumos de farmacia y el
 * directorio. Se resuelve en el hub por las mismas razones que
 * automotriz/buscar — el `contains` corre en Postgres sobre la tabla entera,
 * no sobre lo que el navegador alcanzó a bajar. Cada grupo trae a lo más
 * POR_GRUPO resultados y `q` exige MIN_CONSULTA caracteres; con menos se
 * contesta vacío, no error (la paleta teclea letra por letra).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { nombrePaciente } from "@/lib/hospital/formato";

const POR_GRUPO = 6;
const MIN_CONSULTA = 2;

const r2 = (n: number) => Math.round(n * 100) / 100;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const q = searchParams.get("q")?.trim() ?? "";
  if (q.length < MIN_CONSULTA) {
    return NextResponse.json({ pacientes: [], episodios: [], insumos: [], contactos: [], facturas: [] });
  }
  const como = { contains: q, mode: "insensitive" as const };

  // Facturas: por folio («331486» o «AA-331486»), UUID (desde 8 caracteres) o
  // importe exacto («16156.61», «$16,156.61»). Sólo para quien ve facturación o
  // el directorio: la búsqueda es de la paleta, pero los CFDIs son de finanzas.
  const verFacturas = await puedeVerFacturas(companyId, req);
  const [seriePart, folioPart] = q.includes("-") ? [q.slice(0, q.lastIndexOf("-")).trim(), q.slice(q.lastIndexOf("-") + 1).trim()] : [null, q];
  const importe = /^\$?\s*[\d,]+\.\d{1,2}$/.test(q) ? Number(q.replace(/[$,\s]/g, "")) : null;
  const filtrosFactura = [
    { folio: { contains: folioPart, mode: "insensitive" as const }, ...(seriePart ? { serie: { equals: seriePart, mode: "insensitive" as const } } : {}) },
    ...(q.replace(/-/g, "").length >= 8 && /^[0-9a-f-]+$/i.test(q) ? [{ uuid: { startsWith: q, mode: "insensitive" as const } }] : []),
    ...(importe != null && Number.isFinite(importe) ? [{ total: importe }] : []),
  ];

  const [pacientes, episodios, insumos, contactos, facturas] = await Promise.all([
    prisma.hospPaciente.findMany({
      where: {
        companyId,
        OR: [
          { nombre: como },
          { apellidoPaterno: como },
          { apellidoMaterno: como },
          { curp: como },
          { telefono: como },
        ],
      },
      select: {
        id: true, nombre: true, apellidoPaterno: true, apellidoMaterno: true,
        curp: true, telefono: true, fechaNacimiento: true, activo: true,
      },
      orderBy: [{ activo: "desc" }, { apellidoPaterno: "asc" }, { nombre: "asc" }],
      take: POR_GRUPO,
    }),
    prisma.hospEpisodio.findMany({
      where: {
        companyId,
        OR: [
          { folio: como },
          { diagnostico: como },
          { procedimiento: como },
          { paciente: { OR: [{ nombre: como }, { apellidoPaterno: como }, { apellidoMaterno: como }] } },
        ],
      },
      select: {
        id: true, folio: true, estado: true, fechaIngreso: true,
        paciente: { select: { nombre: true, apellidoPaterno: true, apellidoMaterno: true } },
      },
      // Lo vivo pesa más que el histórico: quien busca un nombre casi siempre
      // busca al paciente que está en piso.
      orderBy: [{ fechaIngreso: "desc" }],
      take: POR_GRUPO,
    }),
    prisma.hospInsumo.findMany({
      where: { companyId, activo: true, OR: [{ clave: como }, { nombre: como }, { presentacion: como }] },
      select: { id: true, clave: true, nombre: true, presentacion: true, unidad: true, categoria: true, controlado: true },
      orderBy: { nombre: "asc" },
      take: POR_GRUPO,
    }),
    prisma.customer.findMany({
      where: { companyId, OR: [{ razonSocial: como }, { rfc: como }] },
      select: { id: true, razonSocial: true, rfc: true },
      orderBy: { razonSocial: "asc" },
      take: POR_GRUPO,
    }),
    verFacturas
      ? prisma.invoice.findMany({
          where: { companyId, status: { not: "DRAFT" }, OR: filtrosFactura },
          select: {
            id: true, serie: true, folio: true, uuid: true, fecha: true, total: true, tipo: true, tipoSat: true, status: true,
            customerId: true, contraparteNombre: true, customer: { select: { razonSocial: true } },
          },
          orderBy: { fecha: "desc" },
          take: POR_GRUPO,
        })
      : Promise.resolve([]),
  ]);

  // Existencia y dirección comercial sólo para los pocos que salieron.
  const [existencias, direccion] = await Promise.all([
    insumos.length
      ? prisma.hospMovimientoInsumo.groupBy({
          by: ["insumoId"],
          where: { companyId, insumoId: { in: insumos.map((i) => i.id) } },
          _sum: { cantidad: true },
        })
      : Promise.resolve([]),
    contactos.length
      ? prisma.invoice.groupBy({
          by: ["customerId", "tipo"],
          where: {
            companyId,
            customerId: { in: contactos.map((c) => c.id) },
            tipo: { in: ["INGRESO", "EGRESO"] },
            status: { not: "CANCELLED" },
          },
          _count: { _all: true },
        })
      : Promise.resolve([]),
  ]);
  const existenciaDe = new Map(existencias.map((e) => [e.insumoId, r2(Number(e._sum.cantidad ?? 0))]));
  const lados = new Map<string, { cliente: boolean; proveedor: boolean }>();
  for (const g of direccion) {
    if (!g.customerId) continue;
    const l = lados.get(g.customerId) ?? { cliente: false, proveedor: false };
    if (g.tipo === "INGRESO") l.cliente = true;
    else l.proveedor = true;
    lados.set(g.customerId, l);
  }

  return NextResponse.json({
    pacientes: pacientes.map((p) => ({
      id: p.id,
      nombre: nombrePaciente(p),
      detalle: [p.curp, p.telefono, p.activo ? null : "inactivo"].filter(Boolean).join(" · ") || "Paciente",
    })),
    episodios: episodios.map((e) => ({
      id: e.id,
      folio: e.folio,
      paciente: nombrePaciente(e.paciente),
      estado: e.estado,
      fechaIngreso: e.fechaIngreso,
    })),
    insumos: insumos.map((i) => ({
      id: i.id,
      clave: i.clave,
      nombre: i.nombre,
      existencia: existenciaDe.get(i.id) ?? 0,
      presentacion: i.presentacion,
      unidad: i.unidad,
      categoria: i.categoria,
      controlado: i.controlado,
    })),
    facturas: facturas.map((f) => ({
      id: f.id,
      folio: [f.serie, f.folio].filter(Boolean).join("-") || (f.uuid ?? "").slice(0, 8),
      uuid: f.uuid,
      fecha: f.fecha,
      total: r2(Number(f.total)),
      // Desde el lado de esta empresa: emitida (cliente) o recibida (proveedor).
      lado: f.tipo === "EGRESO" ? "PROVEEDOR" : "CLIENTE",
      tipo: f.tipoSat === "E" ? "Nota de crédito" : f.tipo === "PAGO" || f.tipoSat === "P" ? "Complemento de pago" : f.tipo === "EGRESO" ? "Factura recibida" : "Factura emitida",
      cancelada: f.status === "CANCELLED",
      contraparte: f.customer?.razonSocial ?? f.contraparteNombre ?? null,
      customerId: f.customerId,
    })),
    contactos: contactos.map((c) => ({
      id: c.id,
      razonSocial: c.razonSocial,
      rfc: c.rfc,
      esCliente: lados.get(c.id)?.cliente ?? false,
      esProveedor: lados.get(c.id)?.proveedor ?? false,
    })),
  });
});

/** ¿El miembro ve facturas? Lista vacía de páginas = ve todo (la regla del hospital). */
async function puedeVerFacturas(companyId: string, req: Request): Promise<boolean> {
  // Por usuario+empresa, no por membership.id: un acceso de despacho u operador
  // no tiene fila propia en CompanyMember (y entonces ve todo, como en el resto).
  const { user } = await requireMembership(companyId, undefined, req);
  const m = await prisma.companyMember.findUnique({ where: { userId_companyId: { userId: user.id, companyId } }, select: { hospitalPaginas: true } });
  const paginas = m?.hospitalPaginas ?? [];
  return paginas.length === 0 || ["facturacion", "clientes", "proveedores", "cuentas", "caja", "compras", "bancos"].some((p) => paginas.includes(p));
}
