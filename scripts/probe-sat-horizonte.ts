// ─────────────────────────────────────────────────────────────────────────────
// PROBE — el manifiesto: qué CFDIs existieron, cuáles tenemos, y cuánto tarda
// el SAT en entregarlos pedidos POR AÑO.
//
// Responde tres preguntas que hoy nadie ha medido, en este orden:
//
//   Fase 0 (BD, GRATIS)   ¿Qué tenemos ya, por año, y en qué forma?
//                         Separa las filas con `rawXml` (CFDI real, descarga
//                         masiva) de las que no lo tienen (folios que entraron
//                         por Syntage). Esa es la forma del archivo heredado.
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

  // ── Fase 0 ────────────────────────────────────────────────────────────────
  console.log("── Fase 0 — lo que ya tenemos (BD, gratis)");
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
      console.log(
        `\n   ${sinXml} filas sin rawXml: folios que entraron por un tercero (Syntage),\n` +
          `   no por descarga masiva. Son el archivo heredado — ver §Fase 2.`,
      );
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
