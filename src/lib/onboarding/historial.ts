// ─────────────────────────────────────────────────────────────────────────────
// HISTORIAL DEL SAT EN EL ONBOARDING — la cuadrícula de meses de la pantalla 05.
//
// Cada celda sale de datos reales: las solicitudes de descarga masiva
// (SatSyncRequest, una por mes y tipo), las facturas que ya están en la base,
// las declaraciones presentadas y las balanzas de la contabilidad electrónica.
// Nada de temporizadores ni porcentajes inventados: si el SAT pidió esperar
// (cuota 5002) o un mes llegó vacío habiendo facturas, la celda lo dice.
//
// Puro: la ruta /api/onboarding/estado junta los datos y aquí se interpretan.
// `narrar` convierte el cambio entre dos lecturas en las frases del registro.
// ─────────────────────────────────────────────────────────────────────────────

import { esCoberturaSospechosa, periodoCerrado } from "@/lib/sat-cobertura";

export type EstadoMes =
  /** Antes del inicio de operaciones o fuera de los años pedidos. */
  | "fuera"
  /** Mes en curso: se sigue llenando solo, no se cuenta. */
  | "cur"
  /** Todavía no se pide (o sólo se pidió un tipo). */
  | "pendiente"
  /** Pedido al SAT, esperando su respuesta. */
  | "req"
  /** Emitidas y recibidas descargadas. */
  | "ok"
  /** El SAT pidió esperar: límite de solicitudes por RFC (5002). */
  | "quota"
  /** Llegó vacío (o casi) aunque el SAT dice que hay facturas. */
  | "hole"
  /** La solicitud falló o venció sin la cuota de por medio. */
  | "error";

export interface SolicitudMes {
  year: number;
  month: number;
  tipo: string;
  status: string;
  cfdisFound: number;
  errorMessage: string | null;
  desde: Date | string | null;
  hasta: Date | string | null;
  createdAt: Date | string;
}

export interface MesHistorial {
  y: number;
  /** 1-12. */
  m: number;
  estado: EstadoMes;
  /** Facturas que ya tenemos de ese mes. */
  cfdis: number;
  /** Lo que el SAT dijo tener (suma de emitidos + recibidos). */
  satDijo: number;
  /** Declaración mensual: presentada, no encontrada, o sin dato. */
  decl: "si" | "no" | null;
  /** ¿Hay balanza de la contabilidad electrónica? */
  ce: boolean;
}

const TIPOS_DESCARGA = new Set(["EMITIDOS", "RECIBIDOS"]);
const EN_VUELO = new Set(["PENDING", "ACCEPTED", "IN_PROGRESS"]);
const llave = (y: number, m: number) => `${y}-${m}`;

/** Meses del rango, del actual hacia atrás `anios` años (como sat-backfill), recortado por el inicio de operaciones. */
export function rangoMeses(hoy: Date, anios: number, inicio: Date | null): Array<{ y: number; m: number }> {
  const out: Array<{ y: number; m: number }> = [];
  const total = Math.max(1, anios) * 12;
  for (let i = 0; i < total; i++) {
    const d = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - i, 1));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    if (inicio && new Date(Date.UTC(y, m, 0, 23, 59, 59)) < inicio) break;
    out.push({ y, m });
  }
  return out;
}

/**
 * Lo que el SAT dijo tener por mes, sin contar dos veces: una fila por rango
 * pedido (la más reciente) y, si el mes se pidió en tramos, sólo los tramos.
 * Misma regla que `coberturaDe` en cron/sat-backfill.
 */
export function satDijoPorMes(solicitudes: SolicitudMes[]): Map<string, number> {
  const ultima = new Map<string, SolicitudMes>();
  for (const s of solicitudes) {
    if (s.status !== "FINISHED" || !TIPOS_DESCARGA.has(s.tipo)) continue;
    const k = `${s.year}|${s.month}|${s.tipo}|${s.desde ? String(new Date(s.desde).getTime()) : ""}|${s.hasta ? String(new Date(s.hasta).getTime()) : ""}`;
    const prev = ultima.get(k);
    if (!prev || new Date(s.createdAt) > new Date(prev.createdAt)) ultima.set(k, s);
  }
  const conTramos = new Set<string>();
  for (const s of ultima.values()) if (s.desde) conTramos.add(`${s.year}|${s.month}|${s.tipo}`);
  const out = new Map<string, number>();
  for (const s of ultima.values()) {
    const tramos = conTramos.has(`${s.year}|${s.month}|${s.tipo}`);
    if (tramos !== !!s.desde) continue;
    out.set(llave(s.year, s.month), (out.get(llave(s.year, s.month)) ?? 0) + s.cfdisFound);
  }
  return out;
}

/** Estado de un mes cerrado a partir de sus solicitudes y de lo que ya tenemos. */
export function estadoDeMes(solicitudes: SolicitudMes[], satDijo: number, tenemos: number): EstadoMes {
  const propias = solicitudes.filter((s) => TIPOS_DESCARGA.has(s.tipo));
  if (propias.length === 0) return "pendiente";
  const terminados = new Set(propias.filter((s) => s.status === "FINISHED").map((s) => s.tipo));
  if (terminados.has("EMITIDOS") && terminados.has("RECIBIDOS")) {
    return esCoberturaSospechosa({ year: 0, month: 0, satDijo, tenemos }) ? "hole" : "ok";
  }
  if (propias.some((s) => EN_VUELO.has(s.status))) return "req";
  if (propias.some((s) => (s.errorMessage ?? "").includes("5002"))) return "quota";
  if (propias.some((s) => s.status === "FAILED" || s.status === "EXPIRED")) return "error";
  return "pendiente";
}

export interface EntradaHistorial {
  hoy: Date;
  anios: number;
  inicio: Date | null;
  solicitudes: SolicitudMes[];
  /** Facturas por mes, llave `${y}-${m}`. */
  facturas: Map<string, number>;
  /** Periodos «YYYY-MM» con declaración mensual presentada. */
  declaraciones: Set<string>;
  /** Meses con balanza, llave `${y}-${m}`. */
  balanzas: Set<string>;
}

/**
 * Los meses del rango con su estado y sus dos capas (declaración y CE).
 *
 * «Declaración no encontrada» sólo se marca entre la primera y la última
 * declaración que sí bajaron: si la fuente no ha traído ninguna todavía, no
 * sabemos nada, y pintar 60 meses en ámbar sería alarmar sin motivo.
 */
export function mesesHistorial(e: EntradaHistorial): MesHistorial[] {
  const rango = rangoMeses(e.hoy, e.anios, e.inicio);
  const porMes = new Map<string, SolicitudMes[]>();
  for (const s of e.solicitudes) {
    const k = llave(s.year, s.month);
    if (!porMes.has(k)) porMes.set(k, []);
    porMes.get(k)!.push(s);
  }
  const satDijo = satDijoPorMes(e.solicitudes);
  const periodosDecl = [...e.declaraciones].sort();
  const primeraDecl = periodosDecl[0] ?? null;
  const ultimaDecl = periodosDecl[periodosDecl.length - 1] ?? null;

  return rango.map(({ y, m }) => {
    const k = llave(y, m);
    const tenemos = e.facturas.get(k) ?? 0;
    const dijo = satDijo.get(k) ?? 0;
    const cerrado = periodoCerrado({ year: y, month: m }, e.hoy);
    const periodo = `${y}-${String(m).padStart(2, "0")}`;
    let decl: MesHistorial["decl"] = null;
    if (e.declaraciones.has(periodo)) decl = "si";
    else if (cerrado && primeraDecl && ultimaDecl && periodo > primeraDecl && periodo < ultimaDecl) decl = "no";
    return {
      y,
      m,
      estado: cerrado ? estadoDeMes(porMes.get(k) ?? [], dijo, tenemos) : "cur",
      cfdis: tenemos,
      satDijo: dijo,
      decl,
      ce: e.balanzas.has(k),
    };
  });
}

export interface ResumenHistorial {
  /** Meses cerrados del rango (el actual no cuenta). */
  total: number;
  ok: number;
  declaraciones: number;
  balanzas: number;
  /** Los meses más recientes (hasta 3) ya están: se puede seguir. */
  recienteListo: boolean;
  completo: boolean;
}

export const MESES_RECIENTES = 3;

export function resumirHistorial(meses: MesHistorial[]): ResumenHistorial {
  const cerrados = meses.filter((x) => x.estado !== "cur" && x.estado !== "fuera");
  const ok = cerrados.filter((x) => x.estado === "ok").length;
  const recientes = cerrados.slice(0, MESES_RECIENTES);
  return {
    total: cerrados.length,
    ok,
    declaraciones: cerrados.filter((x) => x.decl === "si").length,
    balanzas: cerrados.filter((x) => x.ce).length,
    recienteListo: recientes.every((x) => x.estado === "ok"),
    completo: cerrados.length > 0 && ok === cerrados.length,
  };
}

/** «1.2k» para la celda; el número completo va en el título. */
export function cifraCorta(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}

// ── Registro: el cambio entre dos lecturas → frases ─────────────────────────

export const MESES_LARGOS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const fmt = (n: number) => n.toLocaleString("es-MX");

export type ClaseEvento = "normal" | "logro" | "problema";
export interface EventoHistorial {
  clave: string;
  clase: ClaseEvento;
  texto: string;
  /** El copiloto lo dice en voz alta (además de anotarlo). */
  decir?: boolean;
}

/**
 * Qué pasó entre `antes` y `ahora`. Determinista: la misma pareja de lecturas
 * da las mismas frases. `antes = null` es la primera lectura (no narra lo que
 * ya estaba, sólo resume).
 */
export function narrar(antes: MesHistorial[] | null, ahora: MesHistorial[]): EventoHistorial[] {
  const out: EventoHistorial[] = [];
  const resAhora = resumirHistorial(ahora);
  if (!antes) {
    if (resAhora.ok > 0) {
      out.push({ clave: "retomo", clase: "normal", texto: `Ya tengo ${resAhora.ok} de ${resAhora.total} meses. Sigo con el resto.` });
    } else {
      out.push({ clave: "inicio", clase: "normal", texto: "Pedí al SAT tus facturas, empezando por lo más reciente." });
    }
    return out;
  }
  const previo = new Map(antes.map((x) => [llave(x.y, x.m), x]));
  const resAntes = resumirHistorial(antes);
  // Del más antiguo al más reciente, para que el registro (que pinta arriba lo último) lea en orden.
  for (const x of [...ahora].reverse()) {
    const p = previo.get(llave(x.y, x.m));
    const nombre = `${MESES_LARGOS[x.m - 1]} ${x.y}`;
    if (x.estado !== p?.estado) {
      if (x.estado === "ok") {
        if (resAntes.ok === 0 && !out.some((e) => e.clave.startsWith("ok:"))) {
          out.push({ clave: `ok:${nombre}`, clase: "logro", texto: `Primer mes listo: ${nombre}, ${fmt(x.cfdis)} facturas.` });
        } else if (x.m === 1) {
          out.push({ clave: `anio:${x.y}`, clase: "normal", texto: `Enero ${x.y} listo.` });
        }
      } else if (x.estado === "quota") {
        out.push({
          clave: `quota:${nombre}`,
          clase: "problema",
          texto: "El SAT me pidió esperar: tiene un límite de solicitudes por RFC. No es un error; retomo en la siguiente tanda.",
          decir: true,
        });
      } else if (x.estado === "hole") {
        out.push({
          clave: `hole:${nombre}`,
          clase: "problema",
          texto: `${nombre[0].toUpperCase()}${nombre.slice(1)} llegó incompleto: el SAT dice que hay ${fmt(x.satDijo)} y tengo ${fmt(x.cfdis)}. Lo marco para volver a pedirlo en tramos más cortos.`,
          decir: true,
        });
      } else if (x.estado === "error") {
        out.push({ clave: `error:${nombre}`, clase: "problema", texto: `La solicitud de ${nombre} no salió. La vuelvo a intentar en la siguiente tanda.` });
      }
    }
    if (x.decl === "no" && p?.decl !== "no") {
      out.push({
        clave: `nodecl:${nombre}`,
        clase: "problema",
        texto: `No encontré la declaración de ${nombre}. Puede que no se presentó: te lo marco para revisarlo juntos.`,
      });
    }
  }
  if (resAhora.balanzas > 0 && resAntes.balanzas === 0) {
    out.push({ clave: "ce", clase: "normal", texto: "También tengo tu contabilidad electrónica: con ella compruebo que tus libros cuadren con lo que presentaste." });
  }
  if (resAhora.recienteListo && !resAntes.recienteListo && resAhora.total > 0) {
    out.push({ clave: "reciente", clase: "logro", texto: "Ya tengo lo reciente: con esto calculo tus impuestos del mes.", decir: true });
  }
  if (resAhora.completo && !resAntes.completo) {
    out.push({ clave: "completo", clase: "logro", texto: `Historial completo: ${resAhora.ok} meses, ${resAhora.declaraciones} declaraciones y ${resAhora.balanzas} balanzas.`, decir: true });
  }
  return out;
}

// ── Cuánto falta (estimado honesto, de datos reales) ────────────────────────
//
// El tiempo lo ponen dos cosas medibles:
//   1. Pedir: cron/sat-backfill corre cada ~10 min y pide hasta 8 meses nuevos
//      por empresa por corrida (MAX_NEW_SUBMITS_PER_COMPANY).
//   2. Esperar al SAT: lo que tardan las solicitudes en quedar FINISHED. Se
//      mide (mediana de esta empresa o, sin historia, del portafolio).
// Se expresa como RANGO, nunca como cuenta regresiva. Si el SAT pidió esperar
// (5002), se dice: eso puede añadir hasta un día y no lo controlamos.

export const MESES_POR_CORRIDA = 8;
export const MS_ENTRE_CORRIDAS = 10 * 60_000;
export const MS_RESPUESTA_SAT_DEFAULT = 30 * 60_000;

export interface Estimado {
  listo: boolean;
  minMs: number;
  maxMs: number;
}

export interface Estimacion {
  reciente: Estimado;
  completo: Estimado;
  /** El SAT pidió esperar (5002) en algún mes pendiente: puede tardar más. */
  frenadoPorSat: boolean;
}

/** Mediana de lo que tardó el SAT (de pedir a FINISHED), en ms; null sin muestras. */
export function medianaRespuestaSat(solicitudes: Array<{ status: string; createdAt: Date | string; updatedAt: Date | string }>): number | null {
  const ds = solicitudes
    .filter((s) => s.status === "FINISHED")
    .map((s) => new Date(s.updatedAt).getTime() - new Date(s.createdAt).getTime())
    .filter((d) => d > 0 && d < 7 * 24 * 3600_000)
    .sort((a, b) => a - b);
  if (ds.length < 3) return null;
  return ds[Math.floor(ds.length / 2)];
}

function rango(ms: number): Estimado {
  return { listo: false, minMs: Math.max(5 * 60_000, Math.round(ms * 0.6)), maxMs: Math.max(15 * 60_000, Math.round(ms * 1.8)) };
}

const LISTO: Estimado = { listo: true, minMs: 0, maxMs: 0 };

export function estimarTiempos(meses: MesHistorial[], respuestaSatMs: number = MS_RESPUESTA_SAT_DEFAULT): Estimacion {
  const cerrados = meses.filter((x) => x.estado !== "cur" && x.estado !== "fuera");
  const faltan = (xs: MesHistorial[]) => xs.filter((x) => x.estado !== "ok");
  // Los meses sin pedir se piden de lo reciente a lo antiguo, 8 por corrida.
  const tiempo = (xs: MesHistorial[]): number => {
    const sinPedir = xs.filter((x) => x.estado === "pendiente" || x.estado === "quota" || x.estado === "error").length;
    const corridas = Math.ceil(sinPedir / MESES_POR_CORRIDA);
    return corridas * MS_ENTRE_CORRIDAS + respuestaSatMs;
  };
  const recientes = cerrados.slice(0, MESES_RECIENTES);
  const faltanRecientes = faltan(recientes);
  const faltanTodos = faltan(cerrados);
  return {
    reciente: faltanRecientes.length === 0 ? LISTO : rango(tiempo(faltanRecientes)),
    completo: faltanTodos.length === 0 ? LISTO : rango(tiempo(faltanTodos)),
    frenadoPorSat: faltanTodos.some((x) => x.estado === "quota"),
  };
}

/** «~20 min», «30–60 min», «1–2 h», «~1 día». */
export function rangoHumano(e: Estimado): string {
  if (e.listo) return "listo";
  const fmt = (ms: number) => {
    const min = ms / 60_000;
    if (min < 60) return { n: Math.max(5, Math.round(min / 5) * 5), u: "min" };
    const h = min / 60;
    if (h < 24) return { n: Math.max(1, Math.round(h)), u: "h" };
    return { n: Math.max(1, Math.round(h / 24)), u: "día" };
  };
  const a = fmt(e.minMs);
  const b = fmt(e.maxMs);
  const plural = (x: { n: number; u: string }) => (x.u === "día" && x.n > 1 ? "días" : x.u);
  if (a.u === b.u && a.n === b.n) return `~${a.n} ${plural(a)}`;
  if (a.u === b.u) return `${a.n}–${b.n} ${plural(b)}`;
  return `${a.n} ${plural(a)} – ${b.n} ${plural(b)}`;
}
