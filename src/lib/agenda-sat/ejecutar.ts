// ─────────────────────────────────────────────────────────────────────────────
// LA AGENDA DEL SAT — lo que toca la base y el SAT.
//
// sembrar(): asegura una fila por empresa elegible, entregable y periodo
// reciente. Idempotente (createMany + skipDuplicates): correrlo cada tick es
// barato y una empresa recién elegible entra sola.
//
// revisarPendientes(): toma las filas cuya próxima revisión ya llegó, va a
// buscar cada una y deja que calendario.ts decida la siguiente. Si se volvió
// TARDE abre un pendiente en el expediente (lo ve el copiloto y la tira de
// Mi Empresa); si aparece, lo cierra solo.
//
// La BALANZA_CE no se descarga aquí: el SAT sólo la sirve por el buzón con
// navegador (ce-worker, servicio aparte con Chromium). Aquí sólo se pregunta
// «¿ya está en la base?» — la trajo el worker, Syntage o una carga manual — y
// el worker lee esta misma tabla para ir a buscar las balanzas cuya revisión
// está por llegar.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { nivelPagoEmpresas } from "@/lib/billing/pagadores";
import { planIncluyeSyntage } from "@/lib/planes";
import { anotar, resolverNota } from "@/lib/expediente/notas";
import { persistComplianceResult } from "@/lib/fiscal/cumplimiento/persist";
import { SatGoClient } from "@/lib/fiscal/cumplimiento/satgo/client";
import { SatGoComplianceProvider } from "@/lib/fiscal/cumplimiento/satgo/provider";
import { importarDeclaracionesSatGo } from "@/lib/fiscal/cumplimiento/satgo/declaraciones";
import {
  ESTADOS_ACTIVOS,
  fechaCorta,
  periodoLargo,
  periodosCerrados,
  primeraRevision,
  siguienteRevision,
  venceEntregable,
  type Dia,
  type Entregable,
  type EstadoAgenda,
  type ResultadoRevision,
} from "./calendario";

/** Cuántos periodos hacia atrás se siembran. Lo más viejo es del gap-fill histórico. */
const PERIODOS: Record<Entregable, { desde: number; n: number }> = {
  DECLARACION_MENSUAL: { desde: 1, n: 3 },
  // La balanza de M vence en M+2: la del mes pasado todavía no toca.
  BALANZA_CE: { desde: 2, n: 3 },
  CUMPLIMIENTO: { desde: 1, n: 1 },
};

const aFechaDb = (x: Dia) => new Date(Date.UTC(x.y, x.m - 1, x.d));
const deFechaDb = (x: Date): Dia => ({ y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() });

/**
 * Empresas elegibles: e.firma completa, activa, plan con automatización y pago
 * vigente — exactamente el criterio de scripts/satgo-corrida.ts y del
 * aprovisionamiento de Syntage.
 */
export async function empresasElegibles(): Promise<{ id: string; rfc: string }[]> {
  const todas = await prisma.company.findMany({
    where: { isActive: true, fielCer: { not: null }, fielKey: { not: null }, fielPassword: { not: null } },
    select: { id: true, rfc: true, tier: true },
  });
  const niveles = await nivelPagoEmpresas(todas.map((c) => c.id));
  return todas
    .filter((c) => c.rfc && planIncluyeSyntage(c.tier) && niveles.get(c.id) !== "NINGUNO")
    .map((c) => ({ id: c.id, rfc: c.rfc }));
}

/** Asegura las filas de la agenda. Devuelve cuántas nacieron. */
export async function sembrar(ahora: Date = new Date()): Promise<number> {
  const empresas = await empresasElegibles();
  // La CE no tiene obligación en el catálogo (CompanyObligation): se agenda
  // sólo a quien ya tiene balanzas en la base — sabemos que la envía y de dónde
  // sale. Sin historia, bajarla toda es el bootstrap del ce-worker, no la agenda;
  // agendarla a ciegas acusaría de «tarde» a quien no está obligado (RESICO,
  // PF por debajo del umbral).
  const conCe = new Set(
    (
      await prisma.ceBalanzaMes.groupBy({
        by: ["companyId"],
        where: { companyId: { in: empresas.map((c) => c.id) } },
      })
    ).map((g) => g.companyId),
  );
  const filas: {
    companyId: string;
    entregable: Entregable;
    periodo: string;
    vence: Date;
    proximaRevision: Date;
    motivo: string;
  }[] = [];
  for (const c of empresas) {
    for (const entregable of Object.keys(PERIODOS) as Entregable[]) {
      if (entregable === "BALANZA_CE" && !conCe.has(c.id)) continue;
      const { desde, n } = PERIODOS[entregable];
      for (const periodo of periodosCerrados(ahora, desde, n)) {
        const vence = venceEntregable(entregable, periodo, c.rfc);
        filas.push({
          companyId: c.id,
          entregable,
          periodo,
          vence: aFechaDb(vence),
          proximaRevision: primeraRevision(entregable, vence),
          motivo: "primera revisión",
        });
      }
    }
  }
  if (filas.length === 0) return 0;
  const r = await prisma.agendaSat.createMany({ data: filas, skipDuplicates: true });
  return r.count;
}

interface Fila {
  id: string;
  companyId: string;
  entregable: string;
  periodo: string;
  vence: Date;
  estado: string;
  intentos: number;
  errores: number;
  notaPendienteId: string | null;
  company: { rfc: string };
}

type Buscar = (f: Fila) => Promise<{ resultado: ResultadoRevision; detalle: string }>;

function buscadores(): Record<Entregable, Buscar> {
  const client = new SatGoClient();
  const provider = new SatGoComplianceProvider(async (id) => {
    const c = await prisma.company.findUnique({ where: { id }, select: { rfc: true } });
    if (!c?.rfc) throw new Error("La empresa no tiene RFC");
    return c.rfc;
  }, client);

  return {
    // El importador es gap-driven: si ya hay filas con PDF para el periodo
    // (de Syntage o de una corrida anterior) contesta «completo» sin llamar al SAT.
    DECLARACION_MENSUAL: async (f) => {
      const [ejercicio, mes] = f.periodo.split("-").map(Number);
      const r = await importarDeclaracionesSatGo(f.companyId, { ejercicio, mes }, { client });
      const detalle = `${r.estado}${r.error ? `: ${r.error.slice(0, 160)}` : ""}${r.creadas ? ` · ${r.creadas} filas` : ""}`;
      if (r.estado === "completo" || r.estado === "importado") return { resultado: "encontrado", detalle };
      if (r.estado === "sin_obligaciones") return { resultado: "no_aplica", detalle };
      if (r.estado === "sin_archivo") return { resultado: "no_encontrado", detalle };
      return { resultado: "error", detalle };
    },
    BALANZA_CE: async (f) => {
      const [anio, mes] = f.periodo.split("-").map(Number);
      const n = await prisma.ceBalanzaMes.count({ where: { companyId: f.companyId, anio, mes } });
      return n > 0 ? { resultado: "encontrado", detalle: `${n} cuentas en la base` } : { resultado: "no_encontrado", detalle: "sin balanza en la base" };
    },
    // Opinión 32-D y CSF del mes. La CSF no tiene «no la encontré»: si falla es error.
    CUMPLIMIENTO: async (f) => {
      const op = await provider.fetchSatOpinion(f.companyId);
      await persistComplianceResult(f.companyId, op);
      let csf = "csf ok";
      try {
        await persistComplianceResult(f.companyId, await provider.fetchCsf(f.companyId));
      } catch (e) {
        csf = `csf error: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`;
      }
      const detalle = `32-D ${op.resultado} · ${csf}`;
      if (op.resultado === "POSITIVA") return { resultado: "encontrado", detalle };
      if (op.resultado === "NEGATIVA") return { resultado: "negativa", detalle };
      return { resultado: "no_encontrado", detalle };
    },
  };
}

const TITULO: Record<Entregable, string> = {
  DECLARACION_MENSUAL: "la declaración mensual",
  BALANZA_CE: "la balanza de la contabilidad electrónica",
  CUMPLIMIENTO: "la opinión de cumplimiento",
};

/** Aplica el resultado de una revisión a su fila: próxima fecha, estado y el pendiente del expediente. */
export async function registrarResultado(
  f: Fila,
  resultado: ResultadoRevision,
  detalle: string,
  ahora: Date = new Date(),
): Promise<EstadoAgenda> {
  const entregable = f.entregable as Entregable;
  const vence = deFechaDb(f.vence);
  const d = siguienteRevision(
    { entregable, vence, estado: f.estado as EstadoAgenda, intentos: f.intentos, errores: f.errores },
    resultado,
    ahora,
  );

  let notaPendienteId = f.notaPendienteId;
  if (d.escalar && !notaPendienteId) {
    const nota = await anotar({
      companyId: f.companyId,
      autor: "motor",
      tipo: "pendiente",
      tema: entregable === "BALANZA_CE" ? "ce" : entregable === "CUMPLIMIENTO" ? "cumplimiento" : "declaraciones",
      titulo: `No encontramos en el SAT ${TITULO[entregable]} de ${periodoLargo(f.periodo)}`,
      cuerpo:
        `Vencía el ${fechaCorta(vence)} y el SAT no la tiene (${detalle}). ` +
        `Si ya se presentó, puede ser una demora del SAT: la seguimos buscando y este pendiente se cierra solo cuando aparezca. ` +
        `Si no se presentó, hay que presentarla.`,
      refs: [`AgendaSat:${f.id}`],
      datos: { entregable, periodo: f.periodo, vence: aFechaDb(vence).toISOString().slice(0, 10) },
    });
    notaPendienteId = nota.id;
  }
  if (d.desescalar && notaPendienteId) {
    await resolverNota(f.companyId, notaPendienteId, { cuando: ahora });
  }

  await prisma.agendaSat.update({
    where: { id: f.id },
    data: {
      estado: d.estado,
      proximaRevision: d.proximaRevision,
      ultimaRevision: ahora,
      intentos: d.intentos,
      errores: d.errores,
      ultimoResultado: `${resultado}: ${detalle}`.slice(0, 500),
      motivo: d.motivo,
      notaPendienteId,
      ...(d.estado === "ENCONTRADO" ? { encontradoAt: ahora } : {}),
    },
  });
  return d.estado;
}

const SELECT_FILA = {
  id: true,
  companyId: true,
  entregable: true,
  periodo: true,
  vence: true,
  estado: true,
  intentos: true,
  errores: true,
  notaPendienteId: true,
  company: { select: { rfc: true } },
} as const;

export interface ResumenAgenda {
  sembradas: number;
  procesadas: number;
  /** Filas que ya tocaban y quedaron para la siguiente corrida (señal para el ritmo del scheduler). */
  pendientes: number;
  porResultado: Record<string, number>;
  errores: string[];
}

/** Revisa lo que ya tocó. `max` acota la corrida: SatGo tarda 3–35 s por consulta. */
export async function revisarPendientes(opts: { max?: number; paralelo?: number; ahora?: Date } = {}): Promise<ResumenAgenda> {
  const ahora = opts.ahora ?? new Date();
  const max = opts.max ?? 6;
  const sembradas = await sembrar(ahora);
  const donde = { estado: { in: [...ESTADOS_ACTIVOS] as string[] }, proximaRevision: { lte: ahora } };
  const filas: Fila[] = await prisma.agendaSat.findMany({
    where: donde,
    orderBy: { proximaRevision: "asc" },
    take: max,
    select: SELECT_FILA,
  });

  const resumen: ResumenAgenda = { sembradas, procesadas: 0, pendientes: 0, porResultado: {}, errores: [] };
  if (filas.length === 0) return resumen;

  const buscar = buscadores();
  const cola = [...filas];
  await Promise.all(
    Array.from({ length: Math.max(1, opts.paralelo ?? 2) }, async () => {
      for (let f = cola.shift(); f; f = cola.shift()) {
        let resultado: ResultadoRevision;
        let detalle: string;
        try {
          ({ resultado, detalle } = await buscar[f.entregable as Entregable](f));
        } catch (e) {
          resultado = "error";
          detalle = e instanceof Error ? e.message.slice(0, 200) : String(e);
        }
        try {
          const estado = await registrarResultado(f, resultado, detalle, new Date());
          const k = `${f.entregable}:${estado}`;
          resumen.porResultado[k] = (resumen.porResultado[k] ?? 0) + 1;
          if (resultado === "error") resumen.errores.push(`${f.company.rfc} ${f.entregable} ${f.periodo}: ${detalle}`);
        } catch (e) {
          resumen.errores.push(`${f.company.rfc} ${f.entregable} ${f.periodo}: no se pudo registrar: ${e instanceof Error ? e.message : String(e)}`);
        }
        resumen.procesadas += 1;
      }
    }),
  );
  resumen.pendientes = await prisma.agendaSat.count({ where: { ...donde, proximaRevision: { lte: new Date() } } });
  return resumen;
}
