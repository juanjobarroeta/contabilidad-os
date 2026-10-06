// ─────────────────────────────────────────────────────────────────────────────
// CFDIs CANCELADOS desde SatGo (`facfiel` con estatusFactura=0).
//
// Por qué existe. La descarga masiva del SAT pide los recibidos con
// DocumentStatus «active»: un CFDI que el emisor canceló antes de que lo
// bajáramos NUNCA entra, y el barrido de cancelaciones (metadata) ignora los
// UUID que no conoce. Medido el 6-oct-2026 en CENTRO: el SAT lista 179
// recibidos cancelados en 2026; teníamos 26 (11 marcados, 15 todavía
// «vigentes») y 153 jamás se descargaron. El contador necesita VER las
// canceladas aunque no entren a ningún impuesto.
//
// `facfiel` (SatGo, e.firma) devuelve por rango de fechas y estatus=0 la lista
// de cancelados con uuid, emisor, receptor, fecha, total, efecto y estatus de
// cancelación — el XML NO viene inline (es otro flujo). Por eso:
//   · si la factura existe y sigue STAMPED → se cancela igual que el barrido
//     (status CANCELLED + liberar sustituidos + revertir derivados);
//   · si no existe → se crea un Invoice CANCELLED «de listado», sin XML ni
//     conceptos, con los datos que sí trae. El motor fiscal ignora CANCELLED,
//     así que no mueve un peso; sólo se ve.
// Ventanas por semestre, hacia atrás hasta satBackfillYears / inicio de
// operaciones; las dos más recientes se vuelven a pedir en cada corrida
// (una cancelación puede llegar meses después, hasta la anual).
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { liberarSustituidosPor } from "@/lib/cfdi-sustitucion";
import { revertirDerivadosDeCancelada } from "@/lib/automotriz/revertir-cancelada";
import { fielDeEmpresa, type FielResolver, type FielSatGo } from "./fiel";
import { SatGoError } from "./client";

export type LadoCfdi = "emitidos" | "recibidos";

export interface CanceladoSatGo {
  uuid: string;
  rfcEmisor: string;
  nombreEmisor: string;
  rfcReceptor: string;
  nombreReceptor: string;
  /** ISO (como lo manda SatGo, p. ej. 2026-07-31T11:22:56). */
  fechaEmision: string;
  total: number;
  /** «Ingreso» | «Egreso» | «Pago» | «Nómina» | «Traslado» (o la letra). */
  efecto: string;
  estado: string;
  estatusCancelacion: string | null;
}

export interface Ventana { desde: string; hasta: string; clave: string }

/** Semestres «YYYY-S1/S2» del más reciente al más viejo, acotados a `anios` y al inicio de operaciones. */
export function ventanasCancelados(hoy: Date, anios: number, inicio: Date | null): Ventana[] {
  const out: Ventana[] = [];
  const pisoAnio = Math.max(hoy.getFullYear() - anios, inicio ? inicio.getFullYear() : -Infinity);
  const pisoMes = inicio && inicio.getFullYear() === pisoAnio ? inicio.getMonth() + 1 : 1;
  let y = hoy.getFullYear();
  let s = hoy.getMonth() + 1 <= 6 ? 1 : 2;
  while (y > pisoAnio || (y === pisoAnio && (s === 2 || pisoMes <= 6))) {
    const desde = `${y}-${s === 1 ? "01" : "07"}-01`;
    const finMes = s === 1 ? 6 : 12;
    const ultimo = new Date(y, finMes, 0).getDate();
    const hastaSem = `${y}-${String(finMes).padStart(2, "0")}-${ultimo}`;
    const hoyIso = hoy.toISOString().slice(0, 10);
    out.push({ desde, hasta: hastaSem > hoyIso ? hoyIso : hastaSem, clave: `${y}-S${s}` });
    if (s === 1) { s = 2; y -= 1; } else { s = 1; }
  }
  return out;
}

const num = (v: unknown): number => {
  if (typeof v === "number") return v;
  const n = Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (v == null ? "" : String(v)).trim();

/** Fila cruda de SatGo → CanceladoSatGo. */
export function normalizarCancelado(x: Record<string, unknown>): CanceladoSatGo | null {
  const uuid = str(x.uuid).toUpperCase();
  if (!/^[0-9A-F-]{36}$/.test(uuid)) return null;
  return {
    uuid,
    rfcEmisor: str(x.rfCemisor ?? x.rfcEmisor).toUpperCase(),
    nombreEmisor: str(x.razonSocialEmisor),
    rfcReceptor: str(x.rfcReceptor).toUpperCase(),
    nombreReceptor: str(x.razonSocialReceptor),
    fechaEmision: str(x.fechaEmision),
    total: num(x.total),
    efecto: str(x.efectoDelComprobante),
    estado: str(x.estadoDeComprobante),
    estatusCancelacion: str(x.estatusCancelacion) || null,
  };
}

/** Tipo/tipoSat de la app a partir del efecto y del lado. */
export function tipoDesdeEfecto(efecto: string, lado: LadoCfdi): { tipo: "INGRESO" | "EGRESO" | "PAGO" | "NOMINA" | "TRASLADO"; tipoSat: "I" | "E" | "P" | "N" | "T" } {
  const e = efecto.trim().toUpperCase();
  if (e.startsWith("P")) return { tipo: "PAGO", tipoSat: "P" };
  if (e.startsWith("N")) return { tipo: "NOMINA", tipoSat: "N" };
  if (e.startsWith("T")) return { tipo: "TRASLADO", tipoSat: "T" };
  const tipoSat = e.startsWith("E") ? "E" : "I";
  return { tipo: lado === "emitidos" ? "INGRESO" : "EGRESO", tipoSat };
}

/** Un Invoice CANCELLED «de listado» (sin XML): lo justo para verlo en Facturas → Canceladas. */
export function filaDesdeListado(c: CanceladoSatGo, lado: LadoCfdi, companyId: string) {
  const { tipo, tipoSat } = tipoDesdeEfecto(c.efecto, lado);
  const contraparte = lado === "emitidos" ? { rfc: c.rfcReceptor, nombre: c.nombreReceptor } : { rfc: c.rfcEmisor, nombre: c.nombreEmisor };
  return {
    companyId,
    uuid: c.uuid,
    tipo,
    tipoSat,
    status: "CANCELLED" as const,
    fecha: new Date(c.fechaEmision.includes("T") ? c.fechaEmision : `${c.fechaEmision}T12:00:00`),
    formaPago: "99",
    metodoPago: "PUE",
    usoCfdi: "P01",
    subtotal: c.total,
    total: c.total,
    totalImpuestos: 0,
    contraparteRfc: contraparte.rfc || null,
    contraparteNombre: contraparte.nombre || null,
    notas: `Cancelado en el SAT (${c.estatusCancelacion ?? c.estado}). Importado del listado de cancelados; se canceló antes de la descarga, así que no hay XML ni conceptos.`,
  };
}

/** Llama a facfiel con estatus cancelado para un lado y un rango de fechas. */
export async function listarCanceladosSatGo(fiel: FielSatGo, lado: LadoCfdi, desde: string, hasta: string): Promise<CanceladoSatGo[]> {
  const apiKey = (process.env.SATGO_API_KEY ?? "").trim();
  const base = (process.env.SATGO_BASE ?? "https://api.sat-go.com").replace(/\/$/, "");
  if (!apiKey) throw new SatGoError("SATGO_API_KEY no configurada", 503);
  const tokRes = await fetch(`${base}/api/Auth/token-json?api-version=1.0`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: apiKey }) });
  const tokTxt = (await tokRes.text()).trim();
  let token = tokTxt.replace(/^"|"$/g, "");
  try { const j = JSON.parse(tokTxt); token = j.tokens?.access?.value ?? j.token ?? token; } catch { /* texto */ }
  if (!tokRes.ok) throw new SatGoError(`SatGo Auth/token-json ${tokRes.status}`, tokRes.status);
  const q = new URLSearchParams({ "api-version": "2.0", tipo: lado, tipoBusqueda: "1", estatusFactura: "0", fecha_inicial: `${desde} 00:00:00`, fecha_final: `${hasta} 23:59:59`, descargaComprobantes: "false", descargaPdfs: "false" });
  const body = new FormData();
  body.append("Certificado", new Blob([new Uint8Array(fiel.cer)]), "e.cer");
  body.append("llavePrivada", new Blob([new Uint8Array(fiel.key)]), "e.key");
  body.append("Contrasena", fiel.pass);
  const res = await fetch(`${base}/api/v2/consultar/facfiel?${q}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, Rfc: fiel.rfc }, body, signal: AbortSignal.timeout(240_000) });
  const txt = await res.text();
  let j: { success?: boolean; errorMessage?: string; comprobantes?: Record<string, unknown>[]; count?: number } = {};
  try { j = JSON.parse(txt); } catch { /* no JSON */ }
  if (!res.ok || j.success === false) {
    const msg = (j.errorMessage ?? txt).slice(0, 200);
    throw new SatGoError(`SatGo facfiel ${lado} ${desde}→${hasta} ${res.status}: ${msg}`, res.status || 502, res.status >= 500 || /no disponible|intente|timeout/i.test(msg));
  }
  return (j.comprobantes ?? []).map(normalizarCancelado).filter((c): c is CanceladoSatGo => !!c);
}

export interface ResultadoVentana {
  clave: string;
  lado: LadoCfdi;
  listados: number;
  /** Existían STAMPED y se cancelaron ahora. */
  canceladas: number;
  /** Se crearon como CANCELLED de listado. */
  creadas: number;
  /** Ya estaban CANCELLED. */
  yaEstaban: number;
  error?: string;
}

/** Aplica el listado de una ventana y lado a la base. */
export async function aplicarCancelados(companyId: string, lado: LadoCfdi, lista: CanceladoSatGo[], clave: string): Promise<ResultadoVentana> {
  const r: ResultadoVentana = { clave, lado, listados: lista.length, canceladas: 0, creadas: 0, yaEstaban: 0 };
  if (lista.length === 0) return r;
  // Por UUID sin distinguir mayúsculas (el importador guarda en mayúsculas, pero hay filas viejas).
  const existentes = await prisma.invoice.findMany({
    where: { companyId, OR: lista.map((c) => ({ uuid: { equals: c.uuid, mode: "insensitive" as const } })) },
    select: { id: true, uuid: true, status: true },
  });
  const porUuid = new Map(existentes.map((e) => [e.uuid!.toUpperCase(), e]));
  const aCancelar: { id: string; uuid: string }[] = [];
  for (const c of lista) {
    const e = porUuid.get(c.uuid);
    if (!e) {
      await prisma.invoice.create({ data: filaDesdeListado(c, lado, companyId) });
      r.creadas++;
    } else if (e.status === "STAMPED") {
      aCancelar.push({ id: e.id, uuid: c.uuid });
    } else {
      r.yaEstaban++;
    }
  }
  if (aCancelar.length) {
    // Mismo camino que el barrido de cancelaciones (sat-sync.ts): status, sustituidos, derivados.
    await prisma.invoice.updateMany({ where: { id: { in: aCancelar.map((a) => a.id) } }, data: { status: "CANCELLED" } });
    await liberarSustituidosPor(prisma, companyId, aCancelar.map((a) => a.uuid));
    for (const a of aCancelar) {
      try { await revertirDerivadosDeCancelada(prisma, a.id); } catch (e) { console.warn(`[cancelados-satgo] ${companyId}: reversión de ${a.uuid} falló:`, e instanceof Error ? e.message : String(e)); }
    }
    r.canceladas = aCancelar.length;
  }
  return r;
}

export const JOB = "cancelados-satgo";
/** Ventanas más recientes que se re-piden SIEMPRE (una cancelación puede llegar meses después). */
export const VENTANAS_VIVAS = 2;

export interface ResultadoEmpresa {
  companyId: string;
  rfc: string;
  ventanas: ResultadoVentana[];
  /** Ventanas históricas que faltan después de esta corrida. */
  pendientes: number;
  completo: boolean;
}

/**
 * Corrida para una empresa: las VENTANAS_VIVAS más recientes siempre, más hasta
 * `maxHistoricas` ventanas viejas que aún no se hayan pedido (progreso en
 * BackfillProgreso.cursor = clave de la ventana más vieja ya hecha).
 */
export async function importarCanceladosSatGo(
  companyId: string,
  opts: { maxHistoricas?: number; resolveFiel?: FielResolver; hoy?: Date } = {},
): Promise<ResultadoEmpresa> {
  const hoy = opts.hoy ?? new Date();
  const c = await prisma.company.findUnique({ where: { id: companyId }, select: { rfc: true, satBackfillYears: true, fechaInicioOperaciones: true } });
  if (!c) throw new Error("Empresa no encontrada");
  const ventanas = ventanasCancelados(hoy, Math.max(1, c.satBackfillYears), c.fechaInicioOperaciones);
  const progreso = await prisma.backfillProgreso.findFirst({ where: { companyId, job: JOB }, select: { id: true, cursor: true } });
  const hechas = new Set<string>();
  if (progreso?.cursor) {
    // cursor = clave más vieja ya hecha; todo lo más reciente que ella también lo está.
    const idx = ventanas.findIndex((v) => v.clave === progreso.cursor);
    if (idx >= 0) ventanas.slice(0, idx + 1).forEach((v) => hechas.add(v.clave));
  }
  const vivas = ventanas.slice(0, VENTANAS_VIVAS);
  const historicas = ventanas.slice(VENTANAS_VIVAS).filter((v) => !hechas.has(v.clave)).slice(0, opts.maxHistoricas ?? 2);
  const fiel = await (opts.resolveFiel ?? fielDeEmpresa)(companyId);
  const out: ResultadoEmpresa = { companyId, rfc: c.rfc, ventanas: [], pendientes: 0, completo: false };
  let cursorNuevo = progreso?.cursor ?? null;
  for (const v of [...vivas, ...historicas]) {
    let ok = true;
    for (const lado of ["emitidos", "recibidos"] as LadoCfdi[]) {
      try {
        const lista = await listarCanceladosSatGo(fiel, lado, v.desde, v.hasta);
        out.ventanas.push(await aplicarCancelados(companyId, lado, lista, v.clave));
      } catch (e) {
        ok = false;
        out.ventanas.push({ clave: v.clave, lado, listados: 0, canceladas: 0, creadas: 0, yaEstaban: 0, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      }
    }
    // Avanza el cursor sólo por ventanas históricas completas (ambos lados).
    if (ok && !vivas.includes(v)) cursorNuevo = v.clave;
  }
  const restantes = ventanas.slice(VENTANAS_VIVAS).filter((v) => !hechas.has(v.clave) && !out.ventanas.some((r) => r.clave === v.clave && !r.error));
  out.pendientes = restantes.length;
  out.completo = restantes.length === 0;
  const data = { cursor: cursorNuevo, procesados: out.ventanas.reduce((a, r) => a + r.listados, 0), completadoAt: out.completo ? new Date() : null };
  if (progreso) await prisma.backfillProgreso.update({ where: { id: progreso.id }, data });
  else await prisma.backfillProgreso.create({ data: { companyId, job: JOB, ...data } });
  return out;
}
