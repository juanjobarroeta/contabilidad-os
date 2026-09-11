// ─────────────────────────────────────────────────────────────────────────────
// PROBE — el manifiesto: qué CFDIs existieron, cuáles tenemos, y cuánto tarda
// el SAT en entregarlos pedidos POR AÑO.
//
// Responde tres preguntas que hoy nadie ha medido, en este orden:
//
//   Fase 0 (BD, GRATIS)   ¿Qué tenemos ya, por año — y POR DÓNDE entró?
//                         Cuidado: `rawXml` NO dice la fuente. La descarga
//                         masiva y el import de Syntage escriben por la misma
//                         `importarCfdiXml`. La procedencia se infiere de los
//                         rastros: SatSyncRequest (pedimos nosotros) vs
//                         CostEvent SYNTAGE (le pagamos a un tercero). Un año
//                         con facturas y sin solicitud propia entró por fuera,
//                         y ése es el que se pierde al cancelar Syntage.
//
//   Fase 1 (SAT, CUESTA)  ¿Qué EXISTE? Metadata por AÑO completo → el manifiesto:
//                         UUID, fecha, monto, contraparte y estatus de cada CFDI
//                         que el SAT reconoce. Va del año MÁS VIEJO al más nuevo
//                         porque los viejos caen fuera de ventana y devuelven
//                         5004 (barato e informativo): así el horizonte real se
//                         mide antes de gastar en los años que sí importan.
//
//   Fase 2 (diff)         Manifiesto − lo nuestro = EXACTAMENTE qué falta bajar.
//                         Con el UUID en la mano, «backfill completo» deja de
//                         ser una corazonada y pasa a ser una lista que se agota.
//
//   Fase 3 (SAT, CUESTA)  Un año de XML, cronometrado, para comparar el tiempo
//                         de preparación contra el de metadata. Opcional.
//
// ── LO QUE ESTO CUESTA, Y NO SE RECUPERA ────────────────────────────────────
// Cada solicitud ACEPTADA quema la cuota 5002 del SAT para ese (RFC + rango +
// tipo), DE POR VIDA. Esperar no la libera. Por eso:
//
//   · DRY RUN por defecto. Sin PROBE_APLICAR=1 imprime exactamente qué pediría
//     y no toca al SAT.
//   · Cada solicitud emitida se anota en un JSONL append-only ANTES de esperar
//     respuesta, para que un crash nunca deje cuota quemada sin registro.
//   · NO escribe en `SatSyncRequest`. El bookkeeping de producción está afinado
//     para rangos mensuales (ver `coberturaDe` y las cinco trampas de
//     HANDOFF-inventario-cfdis.md); meterle rangos anuales sin la migración de
//     la Ola 1 rompería la medición de cobertura. El JSONL es el registro.
//   · Nunca pide el mismo rango dos veces en una corrida (evita el 5005).
//
// El handoff ya advierte que la cuota se gasta también FUERA de nuestro sistema
// (Syntage usa la misma FIEL): un 5002 en un año que nunca pedimos NO es un bug
// del probe, es el dato que veníamos a buscar.
//
// ── USO ─────────────────────────────────────────────────────────────────────
//   COMPANY_ID=<id> npx tsx scripts/probe-sat-horizonte.ts            # dry run
//   COMPANY_ID=<id> PROBE_APLICAR=1 npx tsx scripts/probe-sat-horizonte.ts
//
//   RFC=<rfc>              alternativa a COMPANY_ID
//   ANIOS=10               cuántos años hacia atrás sondear (default 10)
//   PROBE_XML_ANIO=2025    además, pide ese año en XML y lo cronometra (Fase 3)
//   PROBE_ESPERA_MIN=45    tope de sondeo por solicitud (default 45 min)
//   PROBE_SALIDA=<dir>     dónde dejar el reporte (default tmp/probe-sat)
// ─────────────────────────────────────────────────────────────────────────────

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DateTime,
  DateTimePeriod,
  DownloadType,
  FielRequestBuilder,
  HttpsWebClient,
  MetadataPackageReader,
  QueryParameters,
  RequestType,
  Service,
  ServiceEndpoints,
} from "@nodecfdi/sat-ws-descarga-masiva";
import { prisma } from "../src/lib/prisma";
import { getFielForCompany } from "../src/lib/sat-fiel";

// ── Config ───────────────────────────────────────────────────────────────────

const APLICAR = process.env.PROBE_APLICAR === "1";
const ANIOS = Number.parseInt(process.env.ANIOS ?? "10", 10);
const ESPERA_MAX_MS = Number.parseInt(process.env.PROBE_ESPERA_MIN ?? "45", 10) * 60_000;
const XML_ANIO = process.env.PROBE_XML_ANIO ? Number.parseInt(process.env.PROBE_XML_ANIO, 10) : null;
const SALIDA = process.env.PROBE_SALIDA ?? "tmp/probe-sat";
const SAT_TIMEOUT_MS = 120_000;

/** Espera entre sondeos: seguido al principio, más espaciado después. */
function intervaloSondeo(transcurridoMs: number): number {
  if (transcurridoMs < 2 * 60_000) return 15_000;
  if (transcurridoMs < 10 * 60_000) return 30_000;
  return 60_000;
}

const LADOS = [
  { tipo: "EMITIDOS" as const, download: "issued" as const },
  { tipo: "RECIBIDOS" as const, download: "received" as const },
];

// ── Registro append-only de cuota gastada ────────────────────────────────────

let rutaBitacora = "";

function anotar(evento: Record<string, unknown>): void {
  const linea = JSON.stringify({ ts: new Date().toISOString(), ...evento });
  if (rutaBitacora) appendFileSync(rutaBitacora, linea + "\n");
}

// ── Utilidades de fecha ──────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");

function isoLocal(d: Date): string {
  return (
    [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate())].join("-") +
    "T" +
    [pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds())].join(":")
  );
}

/**
 * Rango del año completo, con el fin recortado a AYER.
 * El SAT rechaza (código 301) cualquier rango que alcance hoy: considera los
 * CFDIs de hoy «en tránsito». Devuelve null si el año todavía no empieza.
 */
function rangoAnio(anio: number): { desde: Date; hasta: Date } | null {
  const ahora = new Date();
  const ayer = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() - 1, 23, 59, 59);
  const desde = new Date(anio, 0, 1, 0, 0, 0);
  const finAnio = new Date(anio, 11, 31, 23, 59, 59);
  const hasta = finAnio > ayer ? ayer : finAnio;
  if (hasta < desde) return null;
  return { desde, hasta };
}

// ── Tipos del reporte ────────────────────────────────────────────────────────

interface SolicitudProbe {
  anio: number;
  tipo: "EMITIDOS" | "RECIBIDOS";
  formato: "metadata" | "xml";
  desde: string;
  hasta: string;
  /** Código del SAT al emitir: 5000 aceptada · 5002 agotada · 5003 tope · 5004 vacía · 5005 duplicada. */
  codigo: number | null;
  mensaje: string;
  requestId: string | null;
  /** ms desde el submit hasta que el SAT reportó Finished. null = nunca terminó. */
  msAFinished: number | null;
  cfdisReportados: number | null;
  paquetes: number | null;
  /** ms de la descarga de todos los paquetes. */
  msDescarga: number | null;
  filasLeidas: number | null;
  error?: string;
}

interface FilaManifiesto {
  uuid: string;
  periodo: string; // YYYY-MM
  estatus: string;
  monto: number | null;
  tipo: "EMITIDOS" | "RECIBIDOS";
}

// ── Fase 0 — qué tenemos ya (BD, gratis) ─────────────────────────────────────

interface InventarioAnio {
  anio: number;
  total: number;
  conXml: number;
  sinXml: number;
  cancelados: number;
}

/**
 * ¿De dónde vino el archivo? `Invoice.rawXml` NO lo dice: la descarga masiva
 * (sat-sync.ts) y el import de Syntage (cron/syntage-cfdis) escriben por la
 * MISMA función `importarCfdiXml`, y el propio cron lo documenta («el MISMO
 * camino que la descarga masiva del SAT»). No hay columna de procedencia.
 *
 * Lo que sí distingue son los RASTROS de cada vía:
 *   · SatSyncRequest  → solicitudes NUESTRAS al SAT (por año y tipo).
 *   · CostEvent SYNTAGE → extracciones que le PAGAMOS a Syntage.
 * Un año con facturas y sin solicitud propia entró por un tercero; uno con
 * solicitud propia FINISHED se bajó aquí. No es una prueba por factura, pero
 * es la evidencia que existe — y es la que decide el riesgo de cancelar
 * Syntage (lo que sólo ellos tienen se pierde al cortar).
 */
interface ProcedenciaAnio {
  anio: number;
  solicitudesPropias: number;
  solicitudesFinished: number;
  /** Las que NO terminaron, por status: cuántas siguen en vuelo vs. cuántas murieron. */
  porStatus: Record<string, number>;
}

async function fase0Procedencia(companyId: string): Promise<{
  porAnio: ProcedenciaAnio[];
  syntage: Array<{ subtipo: string; n: number; primera: string | null; ultima: string | null }>;
}> {
  const [propias, syntage] = await Promise.all([
    prisma.$queryRaw<Array<{ anio: number; status: string; n: bigint }>>`
      SELECT "year" AS anio, "status", COUNT(*) AS n
      FROM "SatSyncRequest"
      WHERE "companyId" = ${companyId}
      GROUP BY 1, 2 ORDER BY 1, 2`,
    prisma.$queryRaw<Array<{ subtipo: string; n: bigint; primera: Date | null; ultima: Date | null }>>`
      SELECT "subtipo",
             COUNT(*)            AS n,
             MIN("occurredAt")   AS primera,
             MAX("occurredAt")   AS ultima
      FROM "CostEvent"
      WHERE "companyId" = ${companyId} AND "categoria" = 'SYNTAGE'
      GROUP BY 1 ORDER BY 1`,
  ]);
  const porAnioMap = new Map<number, ProcedenciaAnio>();
  for (const p of propias) {
    const fila = porAnioMap.get(p.anio) ?? { anio: p.anio, solicitudesPropias: 0, solicitudesFinished: 0, porStatus: {} };
    const n = Number(p.n);
    fila.solicitudesPropias += n;
    if (p.status === "FINISHED") fila.solicitudesFinished += n;
    else fila.porStatus[p.status] = (fila.porStatus[p.status] ?? 0) + n;
    porAnioMap.set(p.anio, fila);
  }
  return {
    porAnio: [...porAnioMap.values()].sort((a, b) => a.anio - b.anio),
    syntage: syntage.map((s) => ({
      subtipo: s.subtipo,
      n: Number(s.n),
      primera: s.primera ? s.primera.toISOString().slice(0, 10) : null,
      ultima: s.ultima ? s.ultima.toISOString().slice(0, 10) : null,
    })),
  };
}

// ── Censo de la cartera (BD, gratis) ─────────────────────────────────────────
//
// «¿Qué se pierde al cancelar Syntage?» es una pregunta POR EMPRESA y la
// respuesta cambia de una a otra (BAOBAB: nada, todo entró por descarga masiva
// propia; MARGOM: 2017-2021 entró por fuera). Recorrer la cartera entera son
// cuatro consultas agrupadas —no N por empresa—, así que va siempre, antes de
// la empresa del RFC, y se persiste como fila propia en AuditLog.
interface CensoEmpresa {
  rfc: string;
  razonSocial: string;
  facturas: number;
  sinXml: number;
  primerAnio: number | null;
  /** Años con facturas y SIN solicitud propia terminada: ese tramo entró por fuera. */
  aniosSinSolicitudPropia: number[];
  extraccionesSyntage: number;
  /**
   * Para los años flagueados: qué dijo el SAT cuando SÍ los pedimos (o que
   * nunca se pidieron). Distingue «ventana» (5004, vacío) de «cuota» (5002,
   * agotada): si es cuota, el tramo no está fuera de ventana — alguien lo pidió
   * antes que nosotros con la misma FIEL, y Syntage es el sospechoso obvio.
   */
  rastroSat: Array<{ anio: number; status: string; error: string | null; n: number }>;
}

async function censoCartera(): Promise<CensoEmpresa[]> {
  const [empresas, facturas, propias, syntage, rastro] = await Promise.all([
    prisma.company.findMany({
      where: { fielCer: { not: null } },
      select: { id: true, rfc: true, razonSocial: true },
      orderBy: { rfc: "asc" },
    }),
    prisma.$queryRaw<Array<{ companyId: string; anio: number; n: bigint; sin_xml: bigint }>>`
      SELECT i."companyId", EXTRACT(YEAR FROM i."fecha")::int AS anio,
             COUNT(*) AS n, COUNT(*) FILTER (WHERE i."rawXml" IS NULL) AS sin_xml
      FROM "Invoice" i
      JOIN "Company" c ON c.id = i."companyId" AND c."fielCer" IS NOT NULL
      GROUP BY 1, 2`,
    prisma.$queryRaw<Array<{ companyId: string; anio: number }>>`
      SELECT DISTINCT "companyId", "year" AS anio
      FROM "SatSyncRequest" WHERE "status" = 'FINISHED'`,
    prisma.$queryRaw<Array<{ companyId: string; n: bigint }>>`
      SELECT "companyId", COUNT(*) AS n FROM "CostEvent"
      WHERE "categoria" = 'SYNTAGE' GROUP BY 1`,
    // Todo lo que el SAT contestó por (empresa, año, status, mensaje). El
    // mensaje se recorta: lo que importa es el código (5002/5004) que va al
    // principio, no el texto entero.
    prisma.$queryRaw<Array<{ companyId: string; anio: number; status: string; error: string | null; n: bigint }>>`
      SELECT "companyId", "year" AS anio, "status", left("errorMessage", 90) AS error, COUNT(*) AS n
      FROM "SatSyncRequest"
      GROUP BY 1, 2, 3, 4`,
  ]);

  const rastroPor = new Map<string, Map<number, Array<{ status: string; error: string | null; n: number }>>>();
  for (const r of rastro) {
    if (!rastroPor.has(r.companyId)) rastroPor.set(r.companyId, new Map());
    const porAnio = rastroPor.get(r.companyId)!;
    if (!porAnio.has(r.anio)) porAnio.set(r.anio, []);
    porAnio.get(r.anio)!.push({ status: r.status, error: r.error, n: Number(r.n) });
  }

  const porEmpresa = new Map<string, { anios: Map<number, { n: number; sinXml: number }> }>();
  for (const f of facturas) {
    const e = porEmpresa.get(f.companyId) ?? { anios: new Map() };
    e.anios.set(f.anio, { n: Number(f.n), sinXml: Number(f.sin_xml) });
    porEmpresa.set(f.companyId, e);
  }
  const propiasPor = new Map<string, Set<number>>();
  for (const p of propias) {
    if (!propiasPor.has(p.companyId)) propiasPor.set(p.companyId, new Set());
    propiasPor.get(p.companyId)!.add(p.anio);
  }
  const syntagePor = new Map(syntage.map((s) => [s.companyId, Number(s.n)]));

  return empresas.map((c) => {
    const anios = porEmpresa.get(c.id)?.anios ?? new Map<number, { n: number; sinXml: number }>();
    const conFacturas = [...anios.keys()].sort();
    const conSolicitud = propiasPor.get(c.id) ?? new Set<number>();
    const flagueados = conFacturas.filter((a) => !conSolicitud.has(a));
    const rastroSat = flagueados.flatMap((anio) => {
      const filas = rastroPor.get(c.id)?.get(anio);
      // Sin filas = nunca lo pedimos nosotros. Eso también es un dato.
      if (!filas || filas.length === 0) return [{ anio, status: "NUNCA_PEDIDO", error: null, n: 0 }];
      return filas.map((f) => ({ anio, ...f }));
    });
    return {
      rfc: c.rfc,
      razonSocial: c.razonSocial,
      facturas: [...anios.values()].reduce((s, a) => s + a.n, 0),
      sinXml: [...anios.values()].reduce((s, a) => s + a.sinXml, 0),
      primerAnio: conFacturas[0] ?? null,
      aniosSinSolicitudPropia: flagueados,
      extraccionesSyntage: syntagePor.get(c.id) ?? 0,
      rastroSat,
    };
  });
}

// ── IMSS vía SatGo (sin cuota del SAT, sin e.firma) ──────────────────────────
//
// `ComplianceProvider.fetchImssOpinion` existe y la implementación de Syntage
// LANZA: «Syntage no provee la opinión de cumplimiento IMSS». SatGo sí la da,
// con sólo el RFC: `GET /api/v2/consultar/imssoc`. El primer intento (10-sep)
// llegó al IMSS y el IMSS contestó «servicio no disponible, reintente» —
// transitorio de ellos, no del código. Aquí se reintenta.
//
// Sólo corre con SATGO_API_KEY presente. No toca al SAT ni gasta cuota.
const SATGO_BASE = process.env.SATGO_BASE ?? "https://api.sat-go.com";
const SATGO_API_KEY = process.env.SATGO_API_KEY ?? "";

interface ResultadoImss {
  status: number;
  ok: boolean;
  contentType: string;
  bytes: number;
  ms: number;
  /** Primeros caracteres cuando la respuesta es texto/JSON (el mensaje del IMSS). */
  muestra: string;
  archivo: string | null;
  error?: string;
}

/** Canjea la API Key durable por el JWT (POST /api/Auth/token-json). Igual que el piloto. */
async function jwtSatGo(key: string): Promise<string> {
  const res = await fetch(`${SATGO_BASE}/api/Auth/token-json?api-version=1.0`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  const txt = (await res.text()).trim();
  if (!res.ok) throw new Error(`Auth/token-json ${res.status}: ${txt.slice(0, 160)}`);
  try {
    const j = JSON.parse(txt);
    return j.tokens?.access?.value ?? j.token ?? j.jwt ?? j.access_token ?? txt.replace(/^"|"$/g, "");
  } catch {
    return txt.replace(/^"|"$/g, "");
  }
}

async function faseImss(rfc: string, salida: string): Promise<ResultadoImss> {
  const vacio: ResultadoImss = { status: 0, ok: false, contentType: "", bytes: 0, ms: 0, muestra: "", archivo: null };
  let token: string;
  try {
    token = await jwtSatGo(SATGO_API_KEY);
  } catch (e) {
    return { ...vacio, error: `auth: ${e instanceof Error ? e.message : String(e)}` };
  }
  const t0 = Date.now();
  try {
    const res = await fetch(`${SATGO_BASE}/api/v2/consultar/imssoc?api-version=2.0`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Rfc: rfc },
    });
    const ms = Date.now() - t0;
    const contentType = res.headers.get("content-type") ?? "";
    const buf = Buffer.from(await res.arrayBuffer());
    const esTexto = /json|text/.test(contentType);
    let archivo: string | null = null;
    if (res.ok && !esTexto) {
      archivo = path.join(salida, `imss-${rfc}.${/pdf/.test(contentType) ? "pdf" : "bin"}`);
      writeFileSync(archivo, buf);
    }
    return {
      status: res.status,
      ok: res.ok,
      contentType: contentType.split(";")[0],
      bytes: buf.length,
      ms,
      muestra: esTexto ? buf.toString("utf8").slice(0, 300) : "",
      archivo,
    };
  } catch (e) {
    return { ...vacio, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

async function fase0Inventario(companyId: string): Promise<InventarioAnio[]> {
  const filas = await prisma.$queryRaw<
    Array<{ anio: number; total: bigint; con_xml: bigint; cancelados: bigint }>
  >`
    SELECT EXTRACT(YEAR FROM "fecha")::int AS anio,
           COUNT(*)                                            AS total,
           COUNT(*) FILTER (WHERE "rawXml" IS NOT NULL)        AS con_xml,
           COUNT(*) FILTER (WHERE "status" = 'CANCELLED')      AS cancelados
    FROM "Invoice"
    WHERE "companyId" = ${companyId}
    GROUP BY 1
    ORDER BY 1`;
  return filas.map((f) => ({
    anio: f.anio,
    total: Number(f.total),
    conXml: Number(f.con_xml),
    sinXml: Number(f.total) - Number(f.con_xml),
    cancelados: Number(f.cancelados),
  }));
}

// ── SAT ──────────────────────────────────────────────────────────────────────

function construirServicio(fiel: Awaited<ReturnType<typeof getFielForCompany>>): Service {
  return new Service(
    new FielRequestBuilder(fiel),
    new HttpsWebClient(undefined, undefined, SAT_TIMEOUT_MS),
    undefined,
    ServiceEndpoints.cfdi(),
  );
}

function dormir(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Emite UNA solicitud (año + lado + formato) y la sigue hasta Finished.
 * Devuelve la fila del reporte y, para metadata, los paquetes listos.
 */
async function pedirYSeguir(
  service: Service,
  anio: number,
  lado: (typeof LADOS)[number],
  formato: "metadata" | "xml",
): Promise<{ fila: SolicitudProbe; paquetes: string[] }> {
  const rango = rangoAnio(anio);
  const fila: SolicitudProbe = {
    anio,
    tipo: lado.tipo,
    formato,
    desde: rango ? isoLocal(rango.desde) : "",
    hasta: rango ? isoLocal(rango.hasta) : "",
    codigo: null,
    mensaje: "",
    requestId: null,
    msAFinished: null,
    cfdisReportados: null,
    paquetes: null,
    msDescarga: null,
    filasLeidas: null,
  };
  if (!rango) {
    fila.mensaje = "año futuro — sin días completos";
    return { fila, paquetes: [] };
  }

  const etiqueta = `${anio} ${lado.tipo} ${formato}`;

  if (!APLICAR) {
    fila.mensaje = "DRY RUN — no se emitió";
    console.log(`  [dry] pediría ${etiqueta}: ${fila.desde} → ${fila.hasta}`);
    return { fila, paquetes: [] };
  }

  const periodo = DateTimePeriod.create(new DateTime(fila.desde), new DateTime(fila.hasta));
  const t0 = Date.now();

  // Se anota ANTES de emitir: si el proceso muere entre el submit y la
  // respuesta, la cuota ya se gastó y tiene que quedar rastro.
  anotar({ evento: "submit_intento", anio, tipo: lado.tipo, formato, desde: fila.desde, hasta: fila.hasta });

  let query;
  try {
    query = await service.query(
      QueryParameters.create()
        .withPeriod(periodo)
        .withDownloadType(new DownloadType(lado.download))
        .withRequestType(new RequestType(formato)),
    );
  } catch (e) {
    fila.error = e instanceof Error ? e.message : String(e);
    anotar({ evento: "submit_error", anio, tipo: lado.tipo, formato, error: fila.error });
    console.log(`  ✗ ${etiqueta}: ${fila.error}`);
    return { fila, paquetes: [] };
  }

  fila.codigo = query.getStatus().getCode();
  fila.mensaje = query.getStatus().getMessage();
  anotar({ evento: "submit_respuesta", anio, tipo: lado.tipo, formato, codigo: fila.codigo, mensaje: fila.mensaje });

  if (!query.getStatus().isAccepted()) {
    // 5003 (tope máximo) es la señal para partir el rango; 5002 es cuota
    // agotada de por vida; 5005 es una solicitud vigente idéntica. Ninguno es
    // un fallo del probe: los tres son el dato que veníamos a medir.
    console.log(`  ✗ ${etiqueta}: código ${fila.codigo} — ${fila.mensaje}`);
    return { fila, paquetes: [] };
  }

  fila.requestId = query.getRequestId();
  anotar({ evento: "aceptada", anio, tipo: lado.tipo, formato, requestId: fila.requestId });
  console.log(`  → ${etiqueta}: aceptada (${fila.requestId}), esperando…`);

  // Sondeo hasta Finished
  for (;;) {
    const transcurrido = Date.now() - t0;
    if (transcurrido > ESPERA_MAX_MS) {
      fila.mensaje = `sin terminar tras ${Math.round(transcurrido / 60_000)} min`;
      console.log(`  … ${etiqueta}: ${fila.mensaje} — se abandona el sondeo`);
      return { fila, paquetes: [] };
    }
    await dormir(intervaloSondeo(transcurrido));

    let verify;
    try {
      verify = await service.verify(fila.requestId);
    } catch (e) {
      console.log(`  … ${etiqueta}: verify falló (${e instanceof Error ? e.message : e}), se reintenta`);
      continue;
    }
    if (!verify.getStatus().isAccepted()) {
      fila.error = `verify rechazado: ${verify.getStatus().getMessage()} (${verify.getStatus().getCode()})`;
      console.log(`  ✗ ${etiqueta}: ${fila.error}`);
      return { fila, paquetes: [] };
    }

    const codeRequest = verify.getCodeRequest().getValue();
    fila.cfdisReportados = verify.getNumberCfdis();

    if (codeRequest === 5004) {
      fila.codigo = 5004;
      fila.mensaje = "sin CFDIs en el rango";
      fila.msAFinished = Date.now() - t0;
      fila.cfdisReportados = 0;
      console.log(`  ○ ${etiqueta}: vacío (5004) en ${(fila.msAFinished / 1000).toFixed(0)}s`);
      anotar({ evento: "finished", anio, tipo: lado.tipo, formato, codigo: 5004, cfdis: 0 });
      return { fila, paquetes: [] };
    }

    const sr = verify.getStatusRequest();
    if (!sr.isTypeOf("Finished" as Parameters<typeof sr.isTypeOf>[0])) continue;

    fila.msAFinished = Date.now() - t0;
    const paquetes = verify.getPackageIds();
    fila.paquetes = paquetes.length;
    console.log(
      `  ✓ ${etiqueta}: Finished en ${(fila.msAFinished / 60_000).toFixed(1)} min — ` +
        `${fila.cfdisReportados} CFDIs en ${paquetes.length} paquete(s)`,
    );
    anotar({
      evento: "finished",
      anio, tipo: lado.tipo, formato,
      msAFinished: fila.msAFinished, cfdis: fila.cfdisReportados, paquetes: paquetes.length,
    });
    return { fila, paquetes };
  }
}

/**
 * Descarga los paquetes de metadata y devuelve las filas del manifiesto.
 * Los nombres de columna del CSV del SAT no se dan por sabidos: se DESCUBREN
 * de la primera fila y se resuelven por candidatos, y las llaves observadas se
 * guardan en el reporte.
 */
async function descargarManifiesto(
  service: Service,
  paquetes: string[],
  tipo: "EMITIDOS" | "RECIBIDOS",
  llavesVistas: Set<string>,
): Promise<{ filas: FilaManifiesto[]; ms: number }> {
  const t0 = Date.now();
  const filas: FilaManifiesto[] = [];

  const primero = (todo: Record<string, string>, candidatos: string[]): string => {
    for (const c of candidatos) if (todo[c] != null && todo[c] !== "") return todo[c];
    return "";
  };

  for (const pkgId of paquetes) {
    const dl = await service.download(pkgId);
    if (!dl.getStatus().isAccepted()) {
      console.log(`  ✗ paquete ${pkgId}: ${dl.getStatus().getMessage()}`);
      continue;
    }
    const binary = Buffer.from(dl.getPackageContent(), "base64").toString("binary");
    const reader = await MetadataPackageReader.createFromContents(binary);
    for await (const item of reader.metadata()) {
      const todo = item.all() as Record<string, string>;
      for (const k of Object.keys(todo)) llavesVistas.add(k);

      const uuid = primero(todo, ["uuid", "Uuid", "UUID"]);
      if (!uuid) continue;
      const fecha = primero(todo, ["fechaEmision", "FechaEmision", "fechaEmisión"]);
      const montoTxt = primero(todo, ["monto", "Monto", "total", "Total"]);
      const monto = montoTxt ? Number.parseFloat(montoTxt.replace(/[^0-9.\-]/g, "")) : null;

      filas.push({
        uuid: uuid.trim().toUpperCase(),
        // "2025-04-17T12:00:00" → "2025-04". Sin fecha, el CFDI queda en un
        // cubo aparte en vez de perderse en silencio.
        periodo: fecha && fecha.length >= 7 ? fecha.slice(0, 7) : "sin-fecha",
        estatus: primero(todo, ["estatus", "Estatus"]),
        monto: Number.isFinite(monto as number) ? (monto as number) : null,
        tipo,
      });
    }
  }
  return { filas, ms: Date.now() - t0 };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const companyId = process.env.COMPANY_ID;
  const rfcEnv = process.env.RFC;
  if (!companyId && !rfcEnv) {
    console.error("Falta COMPANY_ID o RFC.");
    process.exit(1);
  }

  const company = await prisma.company.findFirst({
    where: companyId ? { id: companyId } : { rfc: rfcEnv as string },
    select: { id: true, rfc: true, razonSocial: true, fielCer: true, satBackfillYears: true },
  });
  if (!company) {
    console.error("Empresa no encontrada.");
    process.exit(1);
  }
  if (!company.fielCer) {
    console.error(`${company.rfc}: sin e.firma guardada — el probe la necesita.`);
    process.exit(1);
  }

  const service = construirServicio(await getFielForCompany(company.id));

  mkdirSync(SALIDA, { recursive: true });
  const sello = new Date().toISOString().replace(/[:.]/g, "-");
  rutaBitacora = path.join(SALIDA, `${company.rfc}-${sello}.jsonl`);
  const rutaReporte = path.join(SALIDA, `${company.rfc}-${sello}.json`);

  console.log(`\n══ PROBE SAT — ${company.razonSocial} (${company.rfc})`);
  console.log(`   modo: ${APLICAR ? "APLICAR (gasta cuota 5002, irreversible)" : "DRY RUN"}`);
  console.log(`   bitácora: ${rutaBitacora}\n`);
  anotar({ evento: "inicio", rfc: company.rfc, companyId: company.id, aplicar: APLICAR, anios: ANIOS });

  // ── Censo de la cartera ───────────────────────────────────────────────────
  console.log("── Censo de la cartera — procedencia por empresa (BD, gratis)");
  const censo = await censoCartera();
  console.log("   rfc            facturas  sinXml  desde  syntage  años sin solicitud propia");
  for (const e of censo) {
    console.log(
      `   ${e.rfc.padEnd(14)} ${String(e.facturas).padStart(8)}  ${String(e.sinXml).padStart(6)}` +
        `  ${e.primerAnio ?? "—"}   ${String(e.extraccionesSyntage).padStart(6)}  ` +
        (e.aniosSinSolicitudPropia.length > 0 ? `⚠ ${e.aniosSinSolicitudPropia.join(",")}` : "—"),
    );
  }
  const enRiesgo = censo.filter((e) => e.aniosSinSolicitudPropia.length > 0);
  console.log(
    `\n   ${enRiesgo.length} de ${censo.length} empresas tienen años que entraron por fuera ` +
      `(se pierden al cancelar Syntage si el SAT ya no los sirve).`,
  );
  // ¿Ventana o cuota? Lo que el SAT contestó cuando pedimos esos años.
  for (const e of enRiesgo) {
    console.log(`\n   ${e.rfc} — qué dijo el SAT de los años flagueados:`);
    for (const r of e.rastroSat) {
      console.log(`     ${r.anio}  ${r.status.padEnd(12)} ${String(r.n).padStart(4)}  ${r.error ?? ""}`);
    }
  }
  try {
    await prisma.auditLog.create({
      data: {
        accion: "sat.probe-censo",
        entidad: "Company",
        detalle: JSON.parse(JSON.stringify({ empresas: censo, enRiesgo: enRiesgo.map((e) => e.rfc) })),
      },
    });
  } catch (e) {
    console.error("   ⚠ no se pudo persistir el censo:", e instanceof Error ? e.message : e);
  }

  // ── Fase 0 ────────────────────────────────────────────────────────────────
  console.log(`\n── Fase 0 — lo que ya tenemos de ${company.rfc} (BD, gratis)`);
  const inventario = await fase0Inventario(company.id);
  if (inventario.length === 0) {
    console.log("   (sin facturas)");
  } else {
    console.log("   año     total   con XML   sin XML   cancelados");
    for (const i of inventario) {
      console.log(
        `   ${i.anio}  ${String(i.total).padStart(7)}  ${String(i.conXml).padStart(8)}` +
          `  ${String(i.sinXml).padStart(8)}  ${String(i.cancelados).padStart(11)}`,
      );
    }
    const sinXml = inventario.reduce((s, i) => s + i.sinXml, 0);
    if (sinXml > 0) {
      console.log(`\n   ${sinXml} filas sin rawXml: folios sin el CFDI original detrás.`);
    }
  }

  // ── Procedencia ───────────────────────────────────────────────────────────
  // OJO: rawXml NO distingue la fuente (ambas vías importan por la misma
  // función). Lo que distingue son los rastros de cada una.
  const proc = await fase0Procedencia(company.id);
  console.log("\n   procedencia — solicitudes NUESTRAS al SAT (SatSyncRequest):");
  if (proc.porAnio.length === 0) {
    console.log("     ninguna. TODO el archivo entró por un tercero, no por descarga masiva propia.");
  } else {
    console.log("     año   solicitudes   FINISHED   las demás, por status");
    for (const p of proc.porAnio) {
      const resto = Object.entries(p.porStatus).map(([s, n]) => `${s}:${n}`).join(" ");
      console.log(
        `     ${p.anio}  ${String(p.solicitudesPropias).padStart(11)}  ${String(p.solicitudesFinished).padStart(8)}   ${resto}`,
      );
    }
    const conFacturas = new Set(inventario.filter((i) => i.total > 0).map((i) => i.anio));
    const conSolicitud = new Set(proc.porAnio.filter((p) => p.solicitudesFinished > 0).map((p) => p.anio));
    const soloTerceros = [...conFacturas].filter((a) => !conSolicitud.has(a)).sort();
    if (soloTerceros.length > 0) {
      console.log(
        `\n     ⚠ años CON facturas y SIN solicitud propia terminada: ${soloTerceros.join(", ")}`,
      );
      console.log("       ese tramo lo trajo un tercero — se pierde al cancelar Syntage si el SAT ya no lo sirve.");
    }
  }
  console.log("\n   procedencia — extracciones PAGADAS a Syntage (CostEvent):");
  if (proc.syntage.length === 0) {
    console.log("     ninguna. A esta empresa nunca se le pagó una extracción de Syntage.");
  } else {
    for (const s of proc.syntage) {
      console.log(`     ${s.subtipo.padEnd(38)} ${String(s.n).padStart(4)}   ${s.primera} → ${s.ultima}`);
    }
  }

  // ── Fase 1 ────────────────────────────────────────────────────────────────
  const anioActual = new Date().getFullYear();
  const anios: number[] = [];
  for (let a = anioActual - ANIOS + 1; a <= anioActual; a++) anios.push(a); // del más viejo al más nuevo

  console.log(`\n── Fase 1 — manifiesto: metadata por AÑO, ${anios[0]} → ${anios[anios.length - 1]}`);
  if (APLICAR) {
    console.log("   ⚠ cada solicitud aceptada quema la cuota 5002 de ese rango DE POR VIDA.\n");
  }

  const solicitudes: SolicitudProbe[] = [];
  const manifiesto: FilaManifiesto[] = [];
  const llavesVistas = new Set<string>();
  const pedidos = new Set<string>(); // guarda contra 5005 dentro de la corrida

  for (const anio of anios) {
    for (const lado of LADOS) {
      const llave = `${anio}|${lado.tipo}|metadata`;
      if (pedidos.has(llave)) continue;
      pedidos.add(llave);

      const { fila, paquetes } = await pedirYSeguir(service, anio, lado, "metadata");
      solicitudes.push(fila);

      if (paquetes.length > 0) {
        const { filas, ms } = await descargarManifiesto(service, paquetes, lado.tipo, llavesVistas);
        fila.msDescarga = ms;
        fila.filasLeidas = filas.length;
        manifiesto.push(...filas);
        console.log(`     ↓ ${filas.length} filas leídas en ${(ms / 1000).toFixed(0)}s`);
      }
    }
  }

  // ── Fase 2 — diff ─────────────────────────────────────────────────────────
  console.log("\n── Fase 2 — qué falta bajar");
  let faltantes: FilaManifiesto[] = [];
  if (manifiesto.length === 0) {
    console.log("   (sin manifiesto — dry run o el SAT no devolvió nada)");
  } else {
    const uuids = manifiesto.map((m) => m.uuid);
    const nuestros = await prisma.$queryRaw<Array<{ uuid: string; con_xml: boolean }>>`
      SELECT upper(uuid) AS uuid, ("rawXml" IS NOT NULL) AS con_xml
      FROM "Invoice"
      WHERE "companyId" = ${company.id} AND upper(uuid) = ANY(${uuids})`;
    const conXml = new Set(nuestros.filter((n) => n.con_xml).map((n) => n.uuid));
    faltantes = manifiesto.filter((m) => !conXml.has(m.uuid));

    const porPeriodo = new Map<string, number>();
    for (const f of faltantes) porPeriodo.set(f.periodo, (porPeriodo.get(f.periodo) ?? 0) + 1);

    console.log(`   manifiesto del SAT : ${manifiesto.length}`);
    console.log(`   ya con XML nuestro : ${conXml.size}`);
    console.log(`   FALTA bajar el XML : ${faltantes.length}`);
    if (porPeriodo.size > 0) {
      const top = [...porPeriodo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
      console.log("   periodos con más faltantes: " + top.map(([p, n]) => `${p}:${n}`).join("  "));
    }
    if (llavesVistas.size > 0) {
      console.log(`   columnas de metadata observadas: ${[...llavesVistas].join(", ")}`);
    }
  }

  // ── Fase 3 — un año de XML, cronometrado ──────────────────────────────────
  if (XML_ANIO) {
    console.log(`\n── Fase 3 — XML del año ${XML_ANIO}, cronometrado`);
    for (const lado of LADOS) {
      const { fila } = await pedirYSeguir(service, XML_ANIO, lado, "xml");
      solicitudes.push(fila);
    }
  }

  // ── IMSS vía SatGo ────────────────────────────────────────────────────────
  let imss: ResultadoImss | null = null;
  if (SATGO_API_KEY) {
    console.log("\n── IMSS — opinión de cumplimiento vía SatGo (sólo RFC, sin cuota SAT)");
    // Diagnóstico sin exponer el secreto: largo y forma. Un valor que empieza
    // por `${{` es una referencia de Railway que NO se resolvió; espacios o
    // comillas en los extremos son un paste sucio. Ambos dan «Invalid key».
    const k = SATGO_API_KEY;
    const forma =
      k.startsWith("${{") ? "REFERENCIA SIN RESOLVER" :
      k !== k.trim() ? "con espacios en los extremos" :
      /^["']|["']$/.test(k) ? "con comillas en los extremos" : "limpia";
    console.log(`   llave: ${k.length} chars, ${forma}, base ${SATGO_BASE}`);
    imss = await faseImss(company.rfc, SALIDA);
    if (imss.error) console.log(`   ✗ ${imss.error}`);
    else if (imss.ok) console.log(`   ✓ ${imss.status} ${imss.contentType} ${imss.bytes}b en ${imss.ms}ms${imss.archivo ? ` → ${path.basename(imss.archivo)}` : ""}`);
    else console.log(`   ✗ ${imss.status} ${imss.contentType} en ${imss.ms}ms`);
    if (imss.muestra) console.log(`   respuesta: ${imss.muestra}`);
  } else {
    console.log("\n── IMSS — omitido (sin SATGO_API_KEY)");
  }

  // ── Reporte ───────────────────────────────────────────────────────────────
  const reporte = {
    rfc: company.rfc,
    companyId: company.id,
    razonSocial: company.razonSocial,
    corridaEn: new Date().toISOString(),
    aplicar: APLICAR,
    aniosSondeados: anios,
    inventarioPropio: inventario,
    solicitudes,
    manifiesto: {
      filas: manifiesto.length,
      columnasObservadas: [...llavesVistas],
      porPeriodo: [...manifiesto.reduce((m, f) => m.set(f.periodo, (m.get(f.periodo) ?? 0) + 1), new Map<string, number>())]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([periodo, n]) => ({ periodo, n })),
    },
    faltantes: {
      total: faltantes.length,
      uuids: faltantes.map((f) => f.uuid),
    },
  };
  writeFileSync(rutaReporte, JSON.stringify(reporte, null, 2));

  // PERSISTIR EL HALLAZGO, no sólo imprimirlo. En Railway esto corre en un
  // contenedor de un solo tiro, y de ésos los logs salen VACÍOS (medido con
  // ce-worker; de ahí nació el panel del operador). Si el reporte vive sólo en
  // stdout y en un archivo del contenedor, la corrida se pierde — y ésta gasta
  // cuota 5002 IRREVERSIBLE, así que perderla es perder el gasto.
  //
  // Va en AuditLog: append-only, sin FK, `detalle` es «sólo metadatos, nunca
  // secretos». Se guardan agregados (tiempos, códigos, conteos por periodo),
  // NO la lista completa de UUIDs: una empresa grande la haría enorme y ése es
  // el trabajo de la tabla de manifiesto de la Ola 2, no de una bitácora.
  const faltantesPorPeriodo = [...faltantes.reduce(
    (m, f) => m.set(f.periodo, (m.get(f.periodo) ?? 0) + 1),
    new Map<string, number>(),
  )]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([periodo, n]) => ({ periodo, n }));

  try {
    await prisma.auditLog.create({
      data: {
        companyId: company.id,
        accion: "sat.probe-horizonte",
        entidad: "Company",
        entidadId: company.id,
        // Round-trip por JSON a propósito, no sólo para el tipo de Prisma:
        // garantiza que lo guardado es JSON de verdad. Las consultas crudas de
        // la Fase 0 devuelven `bigint`, que `JSON.stringify` rechaza — mejor
        // que reviente aquí, en el try, que escribir una fila corrupta.
        detalle: JSON.parse(
          JSON.stringify({
            rfc: company.rfc,
            aplicar: APLICAR,
            aniosSondeados: anios,
            inventarioPropio: inventario,
            procedencia: proc,
            solicitudes,
            manifiestoPorPeriodo: reporte.manifiesto.porPeriodo,
            columnasObservadas: reporte.manifiesto.columnasObservadas,
            faltantesTotal: faltantes.length,
            faltantesPorPeriodo,
            imss,
          }),
        ),
      },
    });
    console.log("   reporte persistido en AuditLog (accion = sat.probe-horizonte)");
  } catch (e) {
    // No se pierde la corrida por esto: el archivo y stdout siguen ahí.
    console.error("   ⚠ no se pudo persistir en AuditLog:", e instanceof Error ? e.message : e);
  }

  // ── Lo que vinimos a medir ────────────────────────────────────────────────
  console.log("\n══ RESUMEN");
  const conTiempo = solicitudes.filter((s) => s.msAFinished != null);
  if (conTiempo.length > 0) {
    const meta = conTiempo.filter((s) => s.formato === "metadata");
    const xml = conTiempo.filter((s) => s.formato === "xml");
    const prom = (xs: SolicitudProbe[]) =>
      xs.length === 0 ? null : xs.reduce((s, x) => s + (x.msAFinished as number), 0) / xs.length / 60_000;
    const peor = (xs: SolicitudProbe[]) =>
      xs.length === 0 ? null : Math.max(...xs.map((x) => x.msAFinished as number)) / 60_000;
    if (meta.length > 0)
      console.log(`   metadata/año → Finished: promedio ${prom(meta)!.toFixed(1)} min · peor ${peor(meta)!.toFixed(1)} min`);
    if (xml.length > 0)
      console.log(`   XML/año      → Finished: promedio ${prom(xml)!.toFixed(1)} min · peor ${peor(xml)!.toFixed(1)} min`);
  }

  const primerAnioConDatos = solicitudes.find((s) => (s.cfdisReportados ?? 0) > 0)?.anio ?? null;
  const vacios = solicitudes.filter((s) => s.codigo === 5004).map((s) => s.anio);
  if (primerAnioConDatos) console.log(`   horizonte real del SAT: el año más viejo con datos es ${primerAnioConDatos}`);
  if (vacios.length > 0) console.log(`   años vacíos (5004): ${[...new Set(vacios)].join(", ")}`);

  const topes = solicitudes.filter((s) => s.codigo === 5003);
  if (topes.length > 0) {
    console.log(`   ⚠ 5003 (tope máximo) en: ${topes.map((s) => `${s.anio}/${s.tipo}`).join(", ")}`);
    console.log(`     → el año NO cabe en una solicitud; hay que partirlo (partirAnio, Ola 1).`);
  } else if (APLICAR) {
    console.log(`   sin 5003: el año completo cabe en una sola solicitud.`);
  }

  const agotadas = solicitudes.filter((s) => s.codigo === 5002);
  if (agotadas.length > 0) {
    console.log(`   cuota 5002 ya agotada en: ${agotadas.map((s) => `${s.anio}/${s.tipo}`).join(", ")}`);
    console.log(`     → gastada fuera de nuestro sistema (misma FIEL en Syntage).`);
  }

  console.log(`\n   reporte:  ${rutaReporte}`);
  console.log(`   bitácora: ${rutaBitacora}\n`);
  anotar({ evento: "fin", solicitudes: solicitudes.length, manifiesto: manifiesto.length, faltantes: faltantes.length });
}

main()
  .catch((e) => {
    console.error("\n\u2717 probe abortado:", e instanceof Error ? e.message : e);
    anotar({ evento: "abortado", error: e instanceof Error ? e.message : String(e) });
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
