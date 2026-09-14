import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { fechaLocalMx } from "@/lib/notificaciones";
import { pedirEstadosDeCuentaDeTerminal } from "@/lib/solicitudes/terminal";
import { cargarHechosSalud } from "./hechos";
import {
  diffSalud,
  evaluarSalud,
  peorEstado,
  rankDeltas,
  requiereAtencion,
  type DeltaSalud,
  type DimensionSalud,
} from "./evaluar";
import type { EstadoSalud } from "./claves";

// ─────────────────────────────────────────────────────────────────────────────
// LA PASADA DIARIA DE SALUD — una foto por empresa por día, y el diff.
//
// Es la pieza que hace viable atender mil empresas: código determinista mira a
// todas (barato y exhaustivo) y deja marcado cuáles cambiaron a peor o están
// bloqueadas. Sólo ésas merecen después una pasada de razonamiento. Sin este
// filtro, razonar la cartera completa todos los días cuesta lo que no vale,
// porque la mayoría de las empresas amanece igual que ayer.
//
// El candado de «una vez al día» es el propio `@@unique([companyId, dia])` con
// el DÍA CALENDARIO de México, no horas transcurridas: una corrida a las 23:50
// y otra a las 00:10 son días distintos aunque hayan pasado veinte minutos, y
// eso es lo que el contador entiende por «hoy».
// ─────────────────────────────────────────────────────────────────────────────

export interface ResultadoSaludEmpresa {
  companyId: string;
  estado: EstadoSalud;
  deltas: DeltaSalud[];
  requiereAtencion: boolean;
}

/**
 * Evalúa UNA empresa y guarda su foto del día.
 *
 * El diff se hace contra el ÚLTIMO snapshot anterior a hoy, no contra "ayer"
 * literal: si la corrida no pasó el fin de semana, comparar contra un día que
 * no existe volvería a marcar como «nuevo» todo lo que ya se sabía.
 */
export async function evaluarSaludEmpresa(companyId: string, hoy: Date): Promise<ResultadoSaludEmpresa> {
  const dia = fechaLocalMx(hoy);

  // Los motores que PIDEN corren ANTES de medir: si no, una solicitud abierta
  // hoy no aparecería en la foto de hoy y el despacho se enteraría mañana de
  // algo que el sistema ya sabía. Si falla, la salud se mide igual — quedarse
  // sin foto por no haber podido pedir sería peor que la falta del pedido.
  await pedirEstadosDeCuentaDeTerminal(companyId, hoy).catch((e) =>
    console.error("[salud] solicitudes de terminal fallaron:", companyId, e instanceof Error ? e.message : e),
  );

  const hechos = await cargarHechosSalud(companyId, hoy);
  const dimensiones = evaluarSalud(hechos, hoy);

  const previo = await prisma.saludSnapshot.findFirst({
    where: { companyId, dia: { lt: dia } },
    orderBy: { dia: "desc" },
    select: { dimensiones: true },
  });
  const prev = (previo?.dimensiones as unknown as DimensionSalud[] | null) ?? null;

  const deltas = rankDeltas(diffSalud(prev, dimensiones));
  const estado = peorEstado(dimensiones);
  const atencion = requiereAtencion(dimensiones, deltas);

  // Upsert, no create: una corrida forzada el mismo día reemplaza la foto en vez
  // de estrellarse contra el único índice, y el diff sigue mirando al día previo.
  await prisma.saludSnapshot.upsert({
    where: { companyId_dia: { companyId, dia } },
    create: {
      companyId,
      dia,
      estado,
      dimensiones: dimensiones as unknown as Prisma.InputJsonValue,
      deltas: deltas as unknown as Prisma.InputJsonValue,
      requiereAtencion: atencion,
    },
    update: {
      estado,
      dimensiones: dimensiones as unknown as Prisma.InputJsonValue,
      deltas: deltas as unknown as Prisma.InputJsonValue,
      requiereAtencion: atencion,
    },
  });

  return { companyId, estado, deltas, requiereAtencion: atencion };
}

export interface ResultadoSaludDiaria {
  dia: string;
  empresas: number;
  procesadas: number;
  omitidasHoy: number;
  requierenAtencion: number;
  errores: number;
  resultados: (ResultadoSaludEmpresa | { companyId: string; error: string })[];
}

/**
 * Corre la pasada para todas las empresas activas.
 *
 * A diferencia del pase del cierre, esto NO se filtra por plan: la salud es el
 * insumo con el que se decide a quién atender, y una empresa que no la produce
 * es una empresa invisible para el despacho.
 *
 * `max` acota la corrida al maxDuration del handler; lo que quede entra en el
 * siguiente tick, porque la puerta por día ya impide repetir lo hecho.
 */
export async function correrSaludDiaria(
  opts: { hoy?: Date; force?: boolean; companyId?: string; max?: number } = {},
): Promise<ResultadoSaludDiaria> {
  const hoy = opts.hoy ?? new Date();
  const dia = fechaLocalMx(hoy);
  const max = opts.max ?? 60;

  const todas = await prisma.company.findMany({
    where: { isActive: true, ...(opts.companyId ? { id: opts.companyId } : {}) },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  // Una sola consulta para saber quién ya tiene la foto de hoy: preguntarlo
  // empresa por empresa multiplicaría los viajes por el tamaño de la cartera.
  const hechasHoy = opts.force
    ? new Set<string>()
    : new Set(
        (
          await prisma.saludSnapshot.findMany({
            where: { dia, companyId: { in: todas.map((c) => c.id) } },
            select: { companyId: true },
          })
        ).map((s) => s.companyId),
      );

  const r: ResultadoSaludDiaria = {
    dia,
    empresas: todas.length,
    procesadas: 0,
    omitidasHoy: 0,
    requierenAtencion: 0,
    errores: 0,
    resultados: [],
  };

  for (const c of todas) {
    if (r.procesadas >= max) break;
    if (hechasHoy.has(c.id)) {
      r.omitidasHoy++;
      continue;
    }
    try {
      const res = await evaluarSaludEmpresa(c.id, hoy);
      r.procesadas++;
      if (res.requiereAtencion) r.requierenAtencion++;
      r.resultados.push(res);
    } catch (e) {
      r.errores++;
      console.error("[salud] empresa falló:", c.id, e instanceof Error ? e.message : e);
      r.resultados.push({ companyId: c.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return r;
}

/** La foto más reciente de una empresa. Es lo que lee la UI y el agente. */
export async function saludActual(companyId: string) {
  const fila = await prisma.saludSnapshot.findFirst({
    where: { companyId },
    orderBy: { dia: "desc" },
  });
  if (!fila) return null;
  return {
    dia: fila.dia,
    estado: fila.estado as EstadoSalud,
    dimensiones: fila.dimensiones as unknown as DimensionSalud[],
    deltas: fila.deltas as unknown as DeltaSalud[],
    requiereAtencion: fila.requiereAtencion,
    createdAt: fila.createdAt,
  };
}
