import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { SyntageClient, MAX_ITEMS_POR_PAGINA } from "@/lib/fiscal/cumplimiento/syntage/client";
import { recordSyntageExtraction } from "@/lib/costos/record";
import { importarCfdiXml } from "@/lib/cfdi-import";

// ─────────────────────────────────────────────────────────────────────────────
// POST/GET /api/cron/syntage-cfdis?companyId=<id>[&desde=YYYY-MM-DD][&extraer=1]
//
// ¿Qué CFDIs tiene Syntage que nosotros no?
//
// POR QUÉ EXISTE. La descarga masiva del SAT topa los CFDIs a CINCO AÑOS: lo
// anterior no se puede pedir, no es que no lo hayamos pedido. MARGOM opera
// desde 2017-08 (RFC AMA170817NK1), así que 2017–2021 es inalcanzable por
// nuestra vía. Syntage no documenta ese tope, y su extractor `invoice` acepta
// `period` explícito — es la única ruta a esos años.
//
// Confirmado en docs.syntage.com (extraction-request-examples):
//
//   { extractor: "invoice",
//     options: { period: {from,to}, issued: true, received: true, xml: true } }
//
// `issued` y `received` son banderas de la MISMA extracción, así que emitidas y
// recibidas cuestan UNA, no dos. Sin `period`, el default de Syntage arranca al
// inicio del año de hace TRES — justo el hueco que queremos cubrir.
//
// ESTO NO IMPORTA NADA TODAVÍA. Sólo compara UUIDs: lo que Syntage tiene contra
// lo que nosotros tenemos, por año. Primero el número, después el importador —
// que es la disciplina que faltó cuando perseguimos ocho meses rotos y seis no
// lo estaban.
//
// `extraer=1` dispara la extracción (CUESTA: ~$10–23 MXN según el tarifario de
// Syntage). Sin esa bandera sólo lista lo que ya esté extraído, que es gratis.
//
// UNA SOLA EMPRESA. `EMPRESAS_HABILITADAS` es una lista blanca cerrada por RFC.
// Cada extracción cuesta y esta ruta puede disparar una por empresa: sin la
// lista, un companyId equivocado gasta presupuesto en un cliente que nadie pidió
// migrar. Abrirla es un cambio de código, revisable en el diff.
//
// NO SE DUPLICAN FACTURAS, y no depende de que este código lo haga bien: el
// esquema tiene `@@unique([companyId, uuid])`, así que un folio fiscal repetido
// lo rechaza Postgres — venga del SAT, de Syntage o de dos corridas encimadas.
// Aquí además se pregunta por lote qué UUIDs ya tenemos, pero eso es para no
// gastar descargas de más, no para evitar el duplicado: el duplicado ya es
// imposible.
//
// Auth: CRON_SECRET (Bearer o x-cron-secret).
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TIME_BUDGET_MS = 200_000;
// Syntage tope 100 por página, así que 9 años son ~811 páginas. Listar es
// rápido; quien manda de verdad es TIME_BUDGET_MS, y lo que no alcance se
// retoma con `siguienteCursor`.
const MAX_PAGINAS = 900;

/**
 * SÓLO estas empresas. Lista blanca por RFC, no por id: el RFC es lo que
 * factura Syntage (un slot del plan por RFC vinculado) y es legible al revisar.
 *
 * Está cerrada a propósito. Cada extracción cuesta y esta ruta puede disparar
 * una por empresa: sin la lista, un `for` sobre todas las empresas —o un dedo
 * pegado en un companyId equivocado— gasta presupuesto en clientes que nadie
 * pidió migrar. Abrirla es un cambio de código deliberado, revisable en el
 * diff, no una variable de entorno que se toca en caliente.
 *
 * MARGOM va primero porque es el único caso con el problema que esto resuelve:
 * opera desde 2017 y la descarga masiva del SAT no llega antes de 2021.
 */
const EMPRESAS_HABILITADAS = new Set<string>(["AMA170817NK1"]);

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

/** "2017-08-01" → Date, o null si no parsea. No adivina. */
function parseFecha(raw: string | null): string | null {
  if (!raw) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw.trim()) ? raw.trim() : null;
}

interface PorAnio {
  anio: number;
  enSyntage: number;
  yaTenemos: number;
  faltan: number;
  conXml: number;
}

interface Importacion {
  intentados: number;
  importados: number;
  existentes: number;
  invalidos: number;
  sinXml: number;
  errores: number;
  primerError: string | null;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const companyId = params.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const empresa = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, razonSocial: true, fechaInicioOperaciones: true },
  });
  if (!empresa) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

  if (!EMPRESAS_HABILITADAS.has(empresa.rfc)) {
    return NextResponse.json(
      {
        error: `${empresa.rfc} no está habilitada para CFDIs de Syntage`,
        habilitadas: [...EMPRESAS_HABILITADAS],
        nota:
          "Lista blanca cerrada a propósito: cada extracción cuesta. Para habilitar otra " +
          "empresa hay que agregarla a EMPRESAS_HABILITADAS en el código y revisarlo en el PR.",
      },
      { status: 403 },
    );
  }

  // Desde: lo que pidan, o el inicio de operaciones, o 2015 (antes de eso no
  // hay CFDI 3.3 que valga la pena). NO se inventa una ventana de N años: el
  // punto de esta ruta es justamente pasarse del tope de 5 años del SAT.
  const desde =
    parseFecha(params.get("desde")) ??
    (empresa.fechaInicioOperaciones
      ? empresa.fechaInicioOperaciones.toISOString().slice(0, 10)
      : "2015-01-01");
  const hasta = parseFecha(params.get("hasta")) ?? new Date().toISOString().slice(0, 10);
  const extraer = params.get("extraer") === "1";
  // `importar=1` sí escribe: baja el XML de cada folio que nos falte y lo mete
  // por `importarCfdiXml`, el MISMO camino que la descarga masiva del SAT.
  const importar = params.get("importar") === "1";
  // Cursor por el que retomar. Nueve años no caben en una corrida, así que la
  // ruta devuelve `siguienteCursor` y el workflow la vuelve a llamar hasta null.
  // Este endpoint SÓLO acepta cursor: `page` lo rechaza con 400.
  const cursorInicial = params.get("cursor")?.trim() || undefined;
  const startedAt = Date.now();

  const client = new SyntageClient();
  const entity = await client.findEntityByRfc(empresa.rfc);
  if (!entity) {
    return NextResponse.json(
      { error: `El RFC ${empresa.rfc} no está vinculado en Syntage` },
      { status: 404 },
    );
  }
  const entityId = String((entity as Record<string, unknown>).id ?? "");

  // ── 1. La extracción (lo único que cuesta) ─────────────────────────────────
  let extraccion: { id: string; status: string } | null = null;
  if (extraer) {
    const r = await client.createExtraction({
      extractor: "invoice",
      entity: entityId,
      options: {
        period: { from: desde, to: hasta },
        issued: true,
        received: true,
        xml: true,
      },
    });
    extraccion = { id: r.id, status: r.status };
    await recordSyntageExtraction("invoice", { companyId });
    // NO se espera a que termine: una extracción de años puede tardar mucho más
    // que el presupuesto de la ruta. Se dispara y la siguiente corrida lista lo
    // que ya haya llegado — listar es gratis.
  }

  // ── 2. Lo que Syntage ya tiene, contra lo nuestro ──────────────────────────
  const porAnio = new Map<number, PorAnio>();
  let paginas = 0;
  let totalSyntage = 0;
  let truncado = false;
  // Dónde retomar. null = se acabó la colección.
  let siguienteCursor: string | null = null;
  let cursor: string | undefined = cursorInicial;
  const imp: Importacion = {
    intentados: 0,
    importados: 0,
    existentes: 0,
    invalidos: 0,
    sinXml: 0,
    errores: 0,
    primerError: null,
  };

  for (let i = 0; i < MAX_PAGINAS; i++) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      truncado = true;
      siguienteCursor = cursor ?? null;
      break;
    }
    // El cursor de ESTA página, para poder retomarla si se acaba el tiempo a
    // media importación.
    const cursorDeEstaPagina = cursor;
    const { facturas, siguienteCursor: proximo } = await client.listEntityInvoices(entityId, {
      desde,
      hasta,
      porPagina: MAX_ITEMS_POR_PAGINA,
      cursor,
    });
    paginas++;
    if (facturas.length === 0) break;
    totalSyntage += facturas.length;

    // Los UUIDs que Syntage reporta, contra los que ya guardamos. Se pregunta
    // por lote —no una consulta por factura— y sólo por uuid, que es la llave
    // con la que el import dedup.
    const uuids = facturas
      .map((f) => String((f as Record<string, unknown>).uuid ?? "").toUpperCase())
      .filter(Boolean);
    const nuestros = new Set(
      (
        await prisma.invoice.findMany({
          where: { companyId, uuid: { in: uuids } },
          select: { uuid: true },
        })
      ).map((r) => (r.uuid ?? "").toUpperCase()),
    );

    for (const f of facturas as Array<Record<string, unknown>>) {
      const uuid = String(f.uuid ?? "").toUpperCase();
      const emitido = String(f.issuedAt ?? "");
      const anio = Number(emitido.slice(0, 4));
      if (!Number.isFinite(anio) || anio < 2000) continue;
      const fila = porAnio.get(anio) ?? { anio, enSyntage: 0, yaTenemos: 0, faltan: 0, conXml: 0 };
      fila.enSyntage++;
      if (f.xml === true) fila.conXml++;
      if (uuid && nuestros.has(uuid)) fila.yaTenemos++;
      else fila.faltan++;
      porAnio.set(anio, fila);
    }

    // ── 3. Importar los que falten ───────────────────────────────────────────
    // Sólo con `importar=1`. Baja el XML de Syntage —el comprobante tal cual lo
    // timbró el SAT— y lo mete por `importarCfdiXml`, exactamente la misma
    // función que usa la descarga masiva. No hay un segundo juego de reglas.
    if (importar) {
      for (const f of facturas as Array<Record<string, unknown>>) {
        if (Date.now() - startedAt > TIME_BUDGET_MS) {
          truncado = true;
          // La MISMA página: lo ya importado vuelve como «existente», que sólo
          // cuesta una consulta por uuid — no se re-baja ningún XML.
          siguienteCursor = cursorDeEstaPagina ?? null;
          break;
        }
        const uuid = String(f.uuid ?? "").toUpperCase();
        if (!uuid || nuestros.has(uuid)) continue;
        // Sin XML no hay comprobante que guardar: el JSON parseado de Syntage
        // no es el CFDI, y guardar una factura sin su archivo original rompe
        // todo lo que re-parsea rawXml (nómina, vehículos, impuestos).
        if (f.xml !== true) {
          imp.sinXml++;
          continue;
        }
        const syntageId = String(f.id ?? "");
        if (!syntageId) {
          imp.sinXml++;
          continue;
        }
        imp.intentados++;
        try {
          const xml = await client.getInvoiceCfdiXml(syntageId);
          const r = await importarCfdiXml({
            companyId,
            rfcEmpresa: empresa.rfc,
            // Syntage devuelve emitidas y recibidas en la MISMA colección, así
            // que el lado lo decide el RFC del emisor contra el nuestro.
            tipo: null,
            rawUuid: uuid,
            xmlContent: xml,
            origen: "Syntage",
          });
          if (r.resultado === "importado") imp.importados++;
          else if (r.resultado === "existente") imp.existentes++;
          else imp.invalidos++;
        } catch (e) {
          imp.errores++;
          if (!imp.primerError) imp.primerError = e instanceof Error ? e.message : String(e);
        }
      }
      if (truncado) break;
    }

    if (!proximo) break;
    cursor = proximo;
    // Se acabó el presupuesto de páginas, no la colección.
    if (i === MAX_PAGINAS - 1) siguienteCursor = proximo;
  }

  const filas = [...porAnio.values()].sort((a, b) => b.anio - a.anio);
  const faltanTotal = filas.reduce((s, f) => s + f.faltan, 0);

  const resp = {
    ok: true,
    companyId,
    rfc: empresa.rfc,
    entityId,
    periodo: { desde, hasta },
    extraccion,
    porAnio: filas,
    totales: {
      enSyntage: totalSyntage,
      faltan: faltanTotal,
      conXml: filas.reduce((s, f) => s + f.conXml, 0),
    },
    importacion: importar ? imp : undefined,
    paginas,
    cursorInicial: cursorInicial ?? null,
    // null = se acabó la colección. Si trae valor, vuelve a llamar con
    // `cursor=<ese valor>` — el workflow hace ese bucle solo.
    siguienteCursor,
    truncado,
    elapsedMs: Date.now() - startedAt,
    nota:
      "Sólo esta empresa (lista blanca por RFC). Duplicados imposibles: " +
      "@@unique([companyId, uuid]) los rechaza en la base. " +
      "Esto NO importa nada: sólo compara UUIDs. `extraer=1` dispara la extracción " +
      "(cuesta ~$10–23 MXN y es UNA aunque cubra emitidas + recibidas + años). La " +
      "extracción es asíncrona: si acabas de dispararla, vuelve a correr esto sin " +
      "`extraer` en unos minutos para ver qué llegó. `faltan` es el número que decide " +
      "si vale la pena importar. Con `importar=1` sí escribe: baja el XML de cada folio " +
      "que falte y lo mete por el MISMO importador que la descarga masiva del SAT. " +
      "Si `siguienteCursor` no es null, vuelve a llamar con `cursor=<ese valor>`.",
  };

  console.log(
    "[cron/syntage-cfdis]",
    JSON.stringify({
      companyId,
      rfc: empresa.rfc,
      ...resp.totales,
      paginas,
      siguienteCursor,
      truncado,
      ...(importar ? { importados: imp.importados, errores: imp.errores } : {}),
    }),
  );
  return NextResponse.json(resp);
}

export async function POST(req: Request) {
  return withCronLock("cron:syntage-cfdis", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:syntage-cfdis", () => handle(req));
}
