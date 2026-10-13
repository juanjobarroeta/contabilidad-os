// ─────────────────────────────────────────────────────────────────────────────
// Lista de precios en FORMATO ANCHO (una columna de precio por lista) → el
// tarifario: precio de lista y tabuladores de pagador, todo en una pasada.
//
// Cada columna va a un destino que elige la persona (lo sugiere
// `sugerirMapeo`): el precio de lista, el tabulador de un pagador existente, un
// pagador NUEVO que se crea al aplicar, u omitirla. El plan por columna es el
// mismo `planearImportacion` del formato largo; aplicar escribe todo en UNA
// transacción.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import { HospitalError } from "./errores";
import { ivaDefault } from "./util";
import {
  categoriaDeGrupo,
  destinoDeMapeo,
  llaveEncabezado,
  planearImportacion,
  resumirPlan,
  sugerirMapeo,
  type AliasColumna,
  type DestinoColumna,
  type FilaLista,
  type LecturaLista,
  type PlanImportacion,
} from "./tarifario-importar";

type Db = PrismaClient | Prisma.TransactionClient;
const LOTE = 200;

export interface PlanColumna {
  encabezado: string;
  destino: DestinoColumna & { nombre?: string };
  filas: FilaLista[];
  plan: PlanImportacion | null;
}

export interface PlanAncho {
  columnas: PlanColumna[];
  /** Lo que se sugirió (para prellenar la pantalla). */
  sugerencia: Record<string, string | null>;
  /** Columnas cuya sugerencia es una suposición: la pantalla pide confirmarlas. */
  porConfirmar: string[];
  pagadores: Array<{ id: string; nombre: string; tipo: string; tabulador: string | null }>;
}

/**
 * Arma el plan por columna. `mapeoCrudo` = { encabezado: "LISTA" | pagadorId |
 * "NUEVO:[TIPO:]nombre" | "OMITIR" }; sin mapeo usa la sugerencia.
 */
export async function planearAncho(
  db: Db,
  companyId: string,
  lectura: LecturaLista,
  mapeoCrudo: Record<string, unknown> | null,
): Promise<PlanAncho> {
  const pagadores = await db.hospPagador.findMany({
    where: { companyId },
    select: { id: true, nombre: true, tipo: true, tabulador: true, activo: true },
    orderBy: { nombre: "asc" },
  });
  const encabezados = lectura.columnasPrecio.map((c) => c.encabezado);
  const config = await db.hospConfig.findUnique({ where: { companyId }, select: { aliasTarifas: true } });
  const alias = (config?.aliasTarifas && typeof config.aliasTarifas === "object" && !Array.isArray(config.aliasTarifas)
    ? config.aliasTarifas
    : {}) as Record<string, AliasColumna>;
  const { mapeo: sugerencia, porConfirmar } = sugerirMapeo(encabezados, pagadores, alias);
  const mapeo = mapeoCrudo ?? sugerencia;

  const destinos = new Map<string, DestinoColumna>();
  const vistosPagador = new Set<string>();
  let listas = 0;
  for (const enc of encabezados) {
    const d = destinoDeMapeo(mapeo[enc]);
    if (d.tipo === "LISTA" && ++listas > 1) throw new HospitalError(400, "Sólo una columna puede ir al precio de lista");
    if (d.tipo === "PAGADOR") {
      if (!pagadores.some((p) => p.id === d.pagadorId)) throw new HospitalError(400, `El pagador destino de «${enc}» no es de esta empresa`);
      if (vistosPagador.has(d.pagadorId)) throw new HospitalError(400, "Dos columnas no pueden ir al mismo pagador");
      vistosPagador.add(d.pagadorId);
    }
    destinos.set(enc, d);
  }

  const idsPagador = [...vistosPagador];
  const existentes = await db.hospServicio.findMany({
    where: { companyId },
    select: {
      id: true, clave: true, nombre: true, grupo: true, precioLista: true, activo: true,
      tarifas: idsPagador.length ? { where: { pagadorId: { in: idsPagador } }, select: { pagadorId: true, precio: true } } : false,
    },
  });

  const columnas: PlanColumna[] = encabezados.map((encabezado) => {
    const destino = destinos.get(encabezado)!;
    const filas = lectura.filas.filter((f) => f.lista === encabezado);
    if (destino.tipo === "OMITIR") return { encabezado, destino, filas, plan: null };
    const pagadorId = destino.tipo === "PAGADOR" ? destino.pagadorId : null;
    const plan = planearImportacion(
      filas,
      existentes.map((s) => ({
        id: s.id, clave: s.clave, nombre: s.nombre, grupo: s.grupo, activo: s.activo, precioLista: Number(s.precioLista),
        precioPagador: pagadorId ? (() => {
          const t = (s.tarifas ?? []).find((x) => x.pagadorId === pagadorId);
          return t ? Number(t.precio) : null;
        })() : null,
      })),
      destino.tipo === "LISTA" ? "LISTA" : { pagadorId: pagadorId ?? "nuevo" },
    );
    const nombre = destino.tipo === "PAGADOR" ? pagadores.find((p) => p.id === destino.pagadorId)!.nombre : destino.tipo === "NUEVO" ? destino.nombre : undefined;
    return { encabezado, destino: { ...destino, ...(nombre ? { nombre } : {}) }, filas, plan };
  });

  return { columnas, sugerencia, porConfirmar, pagadores: pagadores.map(({ id, nombre, tipo, tabulador }) => ({ id, nombre, tipo, tabulador })) };
}

/** Lo que ve la pantalla de cada columna. */
export function resumirAncho(p: PlanAncho, muestra = 10) {
  return p.columnas.map((c) => ({
    encabezado: c.encabezado,
    destino: c.destino,
    filas: c.filas.length,
    ...(c.plan ? resumirPlan(c.plan, muestra) : { nuevos: 0, cambios: 0, iguales: 0, faltantes: 0, subidas: 0, muestraNuevos: [], muestraCambios: [], muestraFaltantes: [] }),
  }));
}

/**
 * Aplica el plan en una transacción: crea los pagadores NUEVOS (tabulador =
 * encabezado), las claves nuevas (precio de lista = el de la columna LISTA si
 * la hay, si no el de la primera columna que la cobra), actualiza el precio de
 * lista y reescribe el tabulador de cada pagador para las claves que cambian.
 */
export async function aplicarAncho(
  db: PrismaClient,
  companyId: string,
  p: PlanAncho,
  opts: { desactivarFaltantes?: boolean } = {},
): Promise<{ pagadoresCreados: number; serviciosCreados: number; listaActualizados: number; tarifasEscritas: number; desactivados: number }> {
  const config = await db.hospConfig.findUnique({ where: { companyId }, select: { ivaServicios: true } });
  const ivaServicios = config ? Number(config.ivaServicios) : null;
  const res = { pagadoresCreados: 0, serviciosCreados: 0, listaActualizados: 0, tarifasEscritas: 0, desactivados: 0 };
  const activas = p.columnas.filter((c) => c.plan);
  const colLista = activas.find((c) => c.destino.tipo === "LISTA");

  await db.$transaction(async (tx) => {
    // 1. Pagadores: los nuevos se crean; a los existentes se les anota el tabulador.
    const pagadorDe = new Map<string, string>();
    for (const c of activas) {
      if (c.destino.tipo === "NUEVO") {
        const nuevo = await tx.hospPagador.create({ data: { companyId, nombre: c.destino.nombre, tipo: c.destino.pagadorTipo, tabulador: c.encabezado }, select: { id: true } });
        pagadorDe.set(c.encabezado, nuevo.id);
        res.pagadoresCreados++;
      } else if (c.destino.tipo === "PAGADOR") {
        await tx.hospPagador.update({ where: { id: c.destino.pagadorId }, data: { tabulador: c.encabezado } });
        pagadorDe.set(c.encabezado, c.destino.pagadorId);
      }
    }

    // 2. Claves nuevas: una sola vez aunque vengan en varias columnas.
    const nuevas = new Map<string, FilaLista>();
    for (const c of [...(colLista ? [colLista] : []), ...activas.filter((x) => x !== colLista)]) {
      for (const n of c.plan!.nuevos) if (!nuevas.has(n.clave)) nuevas.set(n.clave, n);
    }
    const lista = [...nuevas.values()];
    for (let i = 0; i < lista.length; i += LOTE) {
      const r = await tx.hospServicio.createMany({
        data: lista.slice(i, i + LOTE).map((n) => {
          const categoria = categoriaDeGrupo(n.grupo);
          return { companyId, clave: n.clave, nombre: n.descripcion, grupo: n.grupo, categoria, precioLista: n.precio, ivaTasa: ivaDefault(categoria, ivaServicios) };
        }),
        skipDuplicates: true,
      });
      res.serviciosCreados += r.count;
    }

    // 3. Precio de lista.
    if (colLista) {
      for (const c of colLista.plan!.cambios) {
        await tx.hospServicio.update({
          where: { id: c.id },
          data: { precioLista: c.precio, nombre: c.descripcion, ...(c.grupo ? { grupo: c.grupo } : {}), ...(c.reactivar ? { activo: true } : {}) },
        });
        res.listaActualizados++;
      }
      if (opts.desactivarFaltantes && colLista.plan!.faltantes.length) {
        const r = await tx.hospServicio.updateMany({ where: { id: { in: colLista.plan!.faltantes.map((x) => x.id) } }, data: { activo: false } });
        res.desactivados = r.count;
      }
    }

    // Lo que se decidió de cada columna queda como alias de la empresa: la
    // siguiente lista con los mismos encabezados se mapea sola.
    const cfg = await tx.hospConfig.findUnique({ where: { companyId }, select: { aliasTarifas: true } });
    if (cfg) {
      const previo = (cfg.aliasTarifas && typeof cfg.aliasTarifas === "object" && !Array.isArray(cfg.aliasTarifas) ? cfg.aliasTarifas : {}) as Record<string, AliasColumna>;
      const nuevoAlias: Record<string, AliasColumna> = { ...previo };
      for (const [enc, pagadorId] of pagadorDe) nuevoAlias[llaveEncabezado(enc)] = { pagadorId };
      await tx.hospConfig.update({ where: { companyId }, data: { aliasTarifas: nuevoAlias as Prisma.InputJsonValue } });
    }

    // 4. Tabuladores: por pagador, se borra la tarifa de las claves que cambian y se vuelve a escribir.
    const ids = new Map((await tx.hospServicio.findMany({ where: { companyId }, select: { id: true, clave: true } })).map((s) => [s.clave.toUpperCase(), s.id]));
    for (const c of activas) {
      const pagadorId = pagadorDe.get(c.encabezado);
      if (!pagadorId) continue;
      const filas = [...c.plan!.nuevos, ...c.plan!.cambios]
        .map((x) => ({ servicioId: ids.get(x.clave), precio: x.precio }))
        .filter((x): x is { servicioId: string; precio: number } => !!x.servicioId);
      for (let i = 0; i < filas.length; i += LOTE) {
        const lote = filas.slice(i, i + LOTE);
        await tx.hospTarifa.deleteMany({ where: { pagadorId, servicioId: { in: lote.map((x) => x.servicioId) } } });
        const r = await tx.hospTarifa.createMany({ data: lote.map((x) => ({ pagadorId, servicioId: x.servicioId, precio: x.precio })) });
        res.tarifasEscritas += r.count;
      }
    }
  }, { timeout: 180_000, maxWait: 10_000 });
  return res;
}
