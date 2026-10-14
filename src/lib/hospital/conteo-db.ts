// ─────────────────────────────────────────────────────────────────────────────
// CONTEO FÍSICO CON ESCÁNER — lo que toca la base.
//
// La sesión cuenta UN almacén. Al cerrarla, cada diferencia por lote se vuelve
// un AJUSTE del kardex por el mismo camino que el ajuste manual de Farmacia
// (saldo del lote + asiento 501.08 / 704.23 si la contabilidad del hospital
// está activa). Un lote contado que el sistema no conocía se crea con lo
// contado. Las cuentas puras viven en codigos-barras.ts.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import { HospitalError } from "./errores";
import { asentarMovimientoKardex } from "./asientos";
import { ajustesDeConteo, diferenciasDeConteo } from "./codigos-barras";

type Db = PrismaClient | Prisma.TransactionClient;
const r2 = (n: number) => Math.round(n * 100) / 100;

export async function cargarConteo(db: Db, companyId: string, id: string) {
  const c = await db.hospConteo.findFirst({
    where: { id, companyId },
    include: {
      lineas: {
        orderBy: { updatedAt: "desc" },
        include: { insumo: { select: { id: true, clave: true, nombre: true, presentacion: true, unidad: true } } },
      },
    },
  });
  if (!c) throw new HospitalError(404, "Conteo no encontrado");
  return c;
}

/** El conteo con sus diferencias contra el sistema (por lote, del almacén de la sesión). */
export async function detalleConteo(db: Db, companyId: string, id: string) {
  const c = await cargarConteo(db, companyId, id);
  const insumoIds = [...new Set(c.lineas.map((l) => l.insumoId))];
  const lotes = insumoIds.length
    ? await db.hospLote.findMany({
        where: { companyId, almacen: c.almacen, insumoId: { in: insumoIds } },
        select: { id: true, insumoId: true, lote: true, existencia: true, caducidad: true, insumo: { select: { nombre: true, clave: true } } },
      })
    : [];
  const difs = diferenciasDeConteo(
    c.lineas.map((l) => ({ insumoId: l.insumoId, lote: l.lote, cantidad: Number(l.cantidad) })),
    lotes.map((l) => ({ id: l.id, insumoId: l.insumoId, lote: l.lote, existencia: Number(l.existencia) })),
  );
  const nombreDe = new Map<string, { nombre: string; clave: string }>();
  for (const l of c.lineas) nombreDe.set(l.insumoId, { nombre: l.insumo.nombre, clave: l.insumo.clave });
  return {
    id: c.id, almacen: c.almacen, estado: c.estado, notas: c.notas, createdAt: c.createdAt,
    iniciadoPorNombre: c.iniciadoPorNombre, cerradoAt: c.cerradoAt, cerradoPorNombre: c.cerradoPorNombre, faltantesEnCero: c.faltantesEnCero,
    lineas: c.lineas.map((l) => ({
      id: l.id, insumoId: l.insumoId, clave: l.insumo.clave, nombre: l.insumo.nombre, presentacion: l.insumo.presentacion, unidad: l.insumo.unidad,
      lote: l.lote, caducidad: l.caducidad, cantidad: r2(Number(l.cantidad)), escaneadoPorNombre: l.escaneadoPorNombre, updatedAt: l.updatedAt,
    })),
    diferencias: difs.map((d) => ({ ...d, ...nombreDe.get(d.insumoId) })),
    resumen: {
      lotesContados: difs.filter((d) => d.contado != null).length,
      cuadran: difs.filter((d) => d.diferencia === 0).length,
      conDiferencia: difs.filter((d) => d.diferencia != null && d.diferencia !== 0).length,
      noContados: difs.filter((d) => d.contado == null).length,
    },
  };
}

/** Registra lo contado de un lote. `modo` SUMAR (cada escaneo suma) o FIJAR (la cantidad final). */
export async function contarLinea(
  db: PrismaClient,
  args: { companyId: string; conteoId: string; insumoId: string; lote: string; caducidad: Date | null; cantidad: number; modo: "SUMAR" | "FIJAR"; usuarioNombre: string | null },
) {
  const c = await db.hospConteo.findFirst({ where: { id: args.conteoId, companyId: args.companyId }, select: { estado: true, almacen: true } });
  if (!c) throw new HospitalError(404, "Conteo no encontrado");
  if (c.estado !== "ABIERTO") throw new HospitalError(409, "El conteo ya está cerrado");
  const insumo = await db.hospInsumo.findFirst({ where: { id: args.insumoId, companyId: args.companyId }, select: { id: true } });
  if (!insumo) throw new HospitalError(404, "Insumo no encontrado");
  const lote = args.lote.trim().toUpperCase();
  const existente = await db.hospLote.findFirst({
    where: { companyId: args.companyId, insumoId: args.insumoId, almacen: c.almacen, lote: { equals: lote, mode: "insensitive" } },
    select: { id: true, lote: true },
  });
  const nombreLote = existente?.lote ?? lote;
  const previo = await db.hospConteoLinea.findUnique({
    where: { conteoId_insumoId_lote: { conteoId: args.conteoId, insumoId: args.insumoId, lote: nombreLote } },
    select: { id: true, cantidad: true },
  });
  const cantidad = args.modo === "SUMAR" && previo ? r2(Number(previo.cantidad) + args.cantidad) : args.cantidad;
  if (cantidad < 0) throw new HospitalError(400, "La cantidad contada no puede ser negativa");
  return previo
    ? db.hospConteoLinea.update({ where: { id: previo.id }, data: { cantidad, escaneadoPorNombre: args.usuarioNombre, ...(args.caducidad ? { caducidad: args.caducidad } : {}) } })
    : db.hospConteoLinea.create({
        data: { conteoId: args.conteoId, insumoId: args.insumoId, loteId: existente?.id ?? null, lote: nombreLote, caducidad: args.caducidad, cantidad, escaneadoPorNombre: args.usuarioNombre },
      });
}

/** Cierra el conteo: un AJUSTE por cada diferencia, en una transacción. */
export async function cerrarConteo(
  db: PrismaClient,
  args: { companyId: string; conteoId: string; faltantesEnCero: boolean; usuarioId: string; usuarioNombre: string | null },
) {
  return db.$transaction(async (tx) => {
    const c = await tx.hospConteo.findFirst({ where: { id: args.conteoId, companyId: args.companyId }, select: { id: true, estado: true, almacen: true } });
    if (!c) throw new HospitalError(404, "Conteo no encontrado");
    if (c.estado !== "ABIERTO") throw new HospitalError(409, "El conteo ya está cerrado");
    const detalle = await detalleConteo(tx, args.companyId, args.conteoId);
    const ajustes = ajustesDeConteo(detalle.diferencias, args.faltantesEnCero);
    const fecha = new Date();
    const hechos: { insumoId: string; lote: string; cantidad: number; movimientoId: string }[] = [];
    for (const a of ajustes) {
      const insumo = await tx.hospInsumo.findUnique({ where: { id: a.insumoId }, select: { nombre: true, ultimoCosto: true } });
      let loteId = a.loteId;
      let costo: number | null = insumo?.ultimoCosto == null ? null : Number(insumo.ultimoCosto);
      if (loteId) {
        const l = await tx.hospLote.findUnique({ where: { id: loteId }, select: { existencia: true, costoUnitario: true } });
        if (!l) continue;
        const nueva = r2(Number(l.existencia) + a.cantidad);
        if (nueva < -1e-6) throw new HospitalError(409, `El lote ${a.lote} quedaría en negativo`);
        await tx.hospLote.update({ where: { id: loteId }, data: { existencia: nueva } });
        costo = Number(l.costoUnitario) || costo;
      } else {
        const linea = detalle.lineas.find((x) => x.insumoId === a.insumoId && x.lote.toUpperCase() === a.lote.toUpperCase());
        const nuevo = await tx.hospLote.create({
          data: {
            companyId: args.companyId, insumoId: a.insumoId, lote: a.lote, almacen: c.almacen,
            caducidad: linea?.caducidad ? new Date(linea.caducidad) : null, existencia: a.cantidad, costoUnitario: costo ?? 0,
          },
        });
        loteId = nuevo.id;
      }
      const motivo = `Conteo físico ${c.almacen} (${a.cantidad > 0 ? "sobrante" : "faltante"})`;
      const mov = await tx.hospMovimientoInsumo.create({
        data: {
          companyId: args.companyId, insumoId: a.insumoId, loteId, tipo: "AJUSTE", cantidad: a.cantidad, costoUnitario: costo, fecha,
          referencia: `${motivo} · conteo ${c.id}`, usuarioId: args.usuarioId, usuarioNombre: args.usuarioNombre,
        },
      });
      await asentarMovimientoKardex(tx, { ...mov, descripcion: `${insumo?.nombre ?? a.insumoId} · lote ${a.lote} · ${motivo}` });
      hechos.push({ insumoId: a.insumoId, lote: a.lote, cantidad: a.cantidad, movimientoId: mov.id });
    }
    await tx.hospConteo.update({
      where: { id: c.id },
      data: { estado: "CERRADO", cerradoAt: fecha, cerradoPorNombre: args.usuarioNombre, faltantesEnCero: args.faltantesEnCero },
    });
    return { ajustes: hechos };
  }, { timeout: 60_000 });
}
