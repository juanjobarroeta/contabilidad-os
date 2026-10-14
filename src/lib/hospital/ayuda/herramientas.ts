// ─────────────────────────────────────────────────────────────────────────────
// Lo que la mascota de ayuda puede CONSULTAR (sólo lectura) para contestar
// con datos: inventario (existencia, lotes, caducidad, precio), proveedores,
// clientes y compras por proveedor en un periodo.
//
// Cada herramienta pide las mismas páginas que su pantalla
// (enforceHospitalAccess): si el usuario no las ve, la herramienta contesta
// qué le falta y la mascota se lo explica. Las definiciones son siempre las
// mismas (el prompt se cachea igual para todos). Nada de pacientes: el
// inventario, los proveedores y las compras no los traen.
// ─────────────────────────────────────────────────────────────────────────────

import type Anthropic from "@anthropic-ai/sdk";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { ORIGEN_HOSPITAL } from "../requisiciones";

const r2 = (n: number) => Math.round(n * 100) / 100;
const DIA = 86_400_000;
const fecha = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/** Páginas que abren cada herramienta (vacío en el perfil = ve todas). */
export const PAGINAS_HERRAMIENTA: Record<string, string[]> = {
  consultar_inventario: ["farmacia", "episodios", "compras", "requisiciones", "tesoreria"],
  insumos_por_caducar: ["farmacia", "episodios", "compras", "requisiciones", "tesoreria"],
  buscar_proveedores: ["proveedores", "compras", "requisiciones", "tesoreria", "medicos"],
  buscar_clientes: ["clientes", "cuentas", "facturacion", "caja"],
  compras_por_proveedor: ["compras", "requisiciones", "tesoreria", "proveedores", "contabilidad"],
};

export function puedeUsarHerramienta(paginas: string[], nombre: string): boolean {
  if (paginas.length === 0) return true;
  return (PAGINAS_HERRAMIENTA[nombre] ?? []).some((p) => paginas.includes(p));
}

export const HERRAMIENTAS: Anthropic.Tool[] = [
  {
    name: "consultar_inventario",
    description:
      "Busca medicamentos e insumos del inventario de farmacia por nombre, clave o sustancia activa. Devuelve existencia total, mínimo, precio de venta, último costo, unidad y sus lotes (lote, caducidad, existencia, proveedor). Úsala para «¿hay existencia de…?», «¿cuándo caduca…?», «¿a cuánto lo vendemos?».",
    input_schema: {
      type: "object",
      properties: {
        texto: { type: "string", description: "Nombre, clave o sustancia activa (p. ej. «ondansetron», «MSI0091»)." },
      },
      required: ["texto"],
    },
  },
  {
    name: "insumos_por_caducar",
    description: "Lista los lotes con existencia que caducan dentro de N días (o ya caducados), del más próximo al más lejano.",
    input_schema: {
      type: "object",
      properties: { dias: { type: "integer", description: "Ventana en días (default 90, máximo 365)." } },
      required: [],
    },
  },
  {
    name: "buscar_proveedores",
    description: "Busca proveedores del padrón por razón social o RFC. Devuelve RFC, correo, condiciones de crédito y cuántas requisiciones tienen.",
    input_schema: {
      type: "object",
      properties: { texto: { type: "string", description: "Razón social o RFC (parcial)." } },
      required: ["texto"],
    },
  },
  {
    name: "buscar_clientes",
    description: "Busca clientes (a quien el hospital factura) por razón social o RFC. Devuelve RFC, régimen fiscal y correo.",
    input_schema: {
      type: "object",
      properties: { texto: { type: "string", description: "Razón social o RFC (parcial)." } },
      required: ["texto"],
    },
  },
  {
    name: "compras_por_proveedor",
    description:
      "Cuánto se le compró a cada proveedor en un periodo: facturas recibidas (CFDI, total con IVA), órdenes de compra autorizadas y los insumos que entraron al inventario. Sin proveedor, trae los principales del periodo. Fechas AAAA-MM-DD.",
    input_schema: {
      type: "object",
      properties: {
        proveedor: { type: "string", description: "Razón social o RFC (parcial). Opcional." },
        desde: { type: "string", description: "AAAA-MM-DD" },
        hasta: { type: "string", description: "AAAA-MM-DD" },
      },
      required: ["desde", "hasta"],
    },
  },
];

const texto = z.object({ texto: z.string().trim().min(2).max(100) });
const caducar = z.object({ dias: z.number().int().min(0).max(365).optional() });
const compras = z.object({
  proveedor: z.string().trim().max(100).optional(),
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** Todas las palabras del texto, sin importar mayúsculas (el resto de la búsqueda la afina el modelo). */
const palabras = (t: string) => t.split(/\s+/).filter((p) => p.length >= 2).slice(0, 5);

async function consultarInventario(db: PrismaClient, companyId: string, t: string) {
  const ps = palabras(t);
  const insumos = await db.hospInsumo.findMany({
    where: {
      companyId,
      activo: true,
      OR: [
        { clave: { contains: t.trim(), mode: "insensitive" } },
        { AND: ps.map((p) => ({ nombre: { contains: p, mode: "insensitive" as const } })) },
        { sustanciaActiva: { contains: t.trim(), mode: "insensitive" } },
      ],
    },
    select: {
      id: true, clave: true, nombre: true, unidad: true, minimo: true, precioVenta: true, ultimoCosto: true, presentacion: true,
      lotes: {
        where: { existencia: { gt: 0 } },
        select: { lote: true, caducidad: true, existencia: true, bloqueado: true, supplier: { select: { razonSocial: true } } },
        orderBy: [{ caducidad: { sort: "asc", nulls: "last" } }],
        take: 8,
      },
    },
    orderBy: { nombre: "asc" },
    take: 10,
  });
  const hoy = Date.now();
  return {
    encontrados: insumos.length,
    insumos: insumos.map((i) => {
      const existencia = r2(i.lotes.reduce((s, l) => s + Number(l.existencia), 0));
      return {
        clave: i.clave,
        nombre: i.nombre,
        presentacion: i.presentacion,
        unidad: i.unidad,
        existencia,
        minimo: Number(i.minimo),
        bajoMinimo: Number(i.minimo) > 0 && existencia < Number(i.minimo),
        precioVenta: i.precioVenta == null ? null : Number(i.precioVenta),
        ultimoCosto: i.ultimoCosto == null ? null : Number(i.ultimoCosto),
        lotes: i.lotes.map((l) => ({
          lote: l.lote,
          caducidad: fecha(l.caducidad),
          caducado: !!l.caducidad && l.caducidad.getTime() < hoy,
          existencia: Number(l.existencia),
          bloqueado: l.bloqueado,
          proveedor: l.supplier?.razonSocial ?? null,
        })),
      };
    }),
  };
}

async function insumosPorCaducar(db: PrismaClient, companyId: string, dias: number) {
  const limite = new Date(Date.now() + dias * DIA);
  const lotes = await db.hospLote.findMany({
    where: { companyId, existencia: { gt: 0 }, caducidad: { not: null, lte: limite } },
    select: { lote: true, caducidad: true, existencia: true, insumo: { select: { clave: true, nombre: true, unidad: true } } },
    orderBy: { caducidad: "asc" },
    take: 40,
  });
  const hoy = Date.now();
  return {
    dias,
    lotes: lotes.map((l) => ({
      clave: l.insumo.clave,
      nombre: l.insumo.nombre,
      lote: l.lote,
      caducidad: fecha(l.caducidad),
      diasParaCaducar: l.caducidad ? Math.floor((l.caducidad.getTime() - hoy) / DIA) : null,
      existencia: Number(l.existencia),
      unidad: l.insumo.unidad,
    })),
  };
}

const porTexto = (t: string) => ({
  OR: [{ rfc: { contains: t.trim().toUpperCase() } }, { AND: palabras(t).map((p) => ({ razonSocial: { contains: p, mode: "insensitive" as const } })) }],
});

async function buscarProveedores(db: PrismaClient, companyId: string, t: string) {
  const ps = await db.supplier.findMany({
    where: { companyId, ...porTexto(t) },
    select: { razonSocial: true, rfc: true, email: true, terms: { select: { tieneCredito: true, diasCredito: true } }, _count: { select: { solicitudesCompra: true } } },
    orderBy: { razonSocial: "asc" },
    take: 10,
  });
  return {
    proveedores: ps.map((p) => ({
      razonSocial: p.razonSocial,
      rfc: p.rfc,
      correo: p.email,
      credito: p.terms?.tieneCredito ? `${p.terms.diasCredito} días` : "contado",
      requisiciones: p._count.solicitudesCompra,
    })),
  };
}

async function buscarClientes(db: PrismaClient, companyId: string, t: string) {
  const cs = await db.customer.findMany({
    where: { companyId, ...porTexto(t) },
    select: { razonSocial: true, rfc: true, regimenFiscal: true, email: true },
    orderBy: { razonSocial: "asc" },
    take: 10,
  });
  return { clientes: cs.map((c) => ({ razonSocial: c.razonSocial, rfc: c.rfc, regimenFiscal: c.regimenFiscal, correo: c.email })) };
}

async function comprasPorProveedor(db: PrismaClient, companyId: string, a: z.infer<typeof compras>) {
  const desde = new Date(`${a.desde}T00:00:00`);
  const hasta = new Date(`${a.hasta}T23:59:59.999`);
  if (!(desde <= hasta)) return { error: "El periodo está al revés: «desde» va antes de «hasta»." };
  const filtro = a.proveedor?.trim();
  const ps = filtro ? palabras(filtro) : [];
  const porNombre = (campo: string) => (filtro ? { OR: [{ [`${campo}Rfc`]: { contains: filtro.toUpperCase() } }, { AND: ps.map((p) => ({ [`${campo}Nombre`]: { contains: p, mode: "insensitive" as const } })) }] } : {});

  const [cfdis, ordenes, entradas] = await Promise.all([
    db.invoice.groupBy({
      by: ["contraparteRfc", "contraparteNombre"],
      where: { companyId, tipo: "EGRESO", status: { not: "CANCELLED" }, NOT: { tipoSat: "E" }, fecha: { gte: desde, lte: hasta }, ...porNombre("contraparte") },
      _sum: { total: true },
      _count: { _all: true },
    }),
    db.solicitudAdjudicacion.findMany({
      where: {
        companyId,
        solicitud: { origen: ORIGEN_HOSPITAL, aprobadaAt: { gte: desde, lte: hasta } },
        ...(filtro ? { supplierNombre: { contains: filtro, mode: "insensitive" as const } } : {}),
      },
      select: { supplierNombre: true, total: true },
    }),
    db.hospMovimientoInsumo.findMany({
      where: {
        companyId,
        tipo: "ENTRADA_COMPRA",
        fecha: { gte: desde, lte: hasta },
        ...(filtro ? { lote: { supplier: { OR: [{ rfc: { contains: filtro.toUpperCase() } }, { razonSocial: { contains: filtro, mode: "insensitive" as const } }] } } } : {}),
      },
      select: { cantidad: true, costoUnitario: true, insumo: { select: { clave: true, nombre: true, unidad: true } }, lote: { select: { supplier: { select: { razonSocial: true } } } } },
      take: 5000,
    }),
  ]);

  const facturas = cfdis
    .map((c) => ({ proveedor: c.contraparteNombre ?? c.contraparteRfc ?? "—", rfc: c.contraparteRfc, facturas: c._count._all, totalConIva: r2(Number(c._sum.total ?? 0)) }))
    .sort((x, y) => y.totalConIva - x.totalConIva);
  const ordenesPor = new Map<string, { proveedor: string; ordenes: number; total: number }>();
  for (const o of ordenes) {
    const g = ordenesPor.get(o.supplierNombre) ?? { proveedor: o.supplierNombre, ordenes: 0, total: 0 };
    g.ordenes++;
    g.total = r2(g.total + Number(o.total));
    ordenesPor.set(o.supplierNombre, g);
  }
  const insumos = new Map<string, { clave: string; nombre: string; unidad: string; proveedor: string | null; cantidad: number; monto: number }>();
  for (const e of entradas) {
    const k = `${e.insumo.clave}|${e.lote?.supplier?.razonSocial ?? ""}`;
    const g = insumos.get(k) ?? { clave: e.insumo.clave, nombre: e.insumo.nombre, unidad: e.insumo.unidad, proveedor: e.lote?.supplier?.razonSocial ?? null, cantidad: 0, monto: 0 };
    g.cantidad = r2(g.cantidad + Number(e.cantidad));
    g.monto = r2(g.monto + Number(e.cantidad) * Number(e.costoUnitario ?? 0));
    insumos.set(k, g);
  }
  return {
    periodo: { desde: a.desde, hasta: a.hasta },
    proveedor: filtro ?? null,
    facturasRecibidas: { porProveedor: facturas.slice(0, 15), proveedores: facturas.length, total: r2(facturas.reduce((s, f) => s + f.totalConIva, 0)) },
    ordenesAutorizadas: [...ordenesPor.values()].sort((x, y) => y.total - x.total).slice(0, 15),
    insumosRecibidos: [...insumos.values()].sort((x, y) => y.monto - x.monto).slice(0, 15),
    nota: "Facturas con IVA (CFDI recibidos, sin notas de crédito); órdenes y entradas a costo sin IVA.",
  };
}

/**
 * Ejecuta una herramienta para este usuario. Siempre devuelve un objeto
 * (también los errores y la falta de permiso, para que la mascota los explique).
 */
export async function ejecutarHerramienta(db: PrismaClient, ctx: { companyId: string; paginas: string[] }, nombre: string, input: unknown): Promise<Record<string, unknown>> {
  if (!PAGINAS_HERRAMIENTA[nombre]) return { error: `Herramienta desconocida: ${nombre}` };
  if (!puedeUsarHerramienta(ctx.paginas, nombre)) {
    return { sinPermiso: true, requiereAlgunaDe: PAGINAS_HERRAMIENTA[nombre], mensaje: "El usuario no tiene acceso a esta información; un administrador lo habilita en Usuarios." };
  }
  try {
    switch (nombre) {
      case "consultar_inventario":
        return consultarInventario(db, ctx.companyId, texto.parse(input).texto);
      case "insumos_por_caducar":
        return insumosPorCaducar(db, ctx.companyId, caducar.parse(input ?? {}).dias ?? 90);
      case "buscar_proveedores":
        return buscarProveedores(db, ctx.companyId, texto.parse(input).texto);
      case "buscar_clientes":
        return buscarClientes(db, ctx.companyId, texto.parse(input).texto);
      case "compras_por_proveedor":
        return comprasPorProveedor(db, ctx.companyId, compras.parse(input));
    }
  } catch (e) {
    if (e instanceof z.ZodError) return { error: `Parámetros inválidos: ${e.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
    throw e;
  }
  return { error: "Sin resultado" };
}
