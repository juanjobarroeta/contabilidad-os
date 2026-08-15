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
  /** Los que Syntage marca CANCELADO. */
  canceladas: number;
  /** Cancelados en el SAT que NOSOTROS tenemos como vivos. Cada uno es un peso
   *  contado que no debería estarlo. */
  canceladasNoRegistradas: number;
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
  // Muestra de folios que el SAT tiene por cancelados y nosotros por vivos.
  const canceladasPendientes: string[] = [];
  // La FORMA cruda del primer renglón. `conXml` se cuenta con `f.xml === true`,
  // y si ese campo resultara ser una URL o un objeto la cuenta saldría baja sin
  // avisar — que es exactamente el error que ya se cometió buscando el VIN en un
  // campo que no lo tenía. Esto deja ver el campo en vez de suponerlo.
  let muestraCruda: Record<string, unknown> | null = null;
  // UUIDs ya vistos EN ESTA CORRIDA, para detectar si las páginas se traslapan.
  //
  // Por qué: la suma de `enSyntage` de doce vueltas dio 158,100 contra una
  // colección de 109,646. Un total que se pasa del total conocido es la firma
  // del doble conteo — ya van tres hoy. La sospecha es el orden: se manda
  // `id[lt]=<id de la última fila>` sin declarar `order`, así que si la
  // colección no viene ordenada por `id` descendente, «la última fila» no es la
  // de id menor y las páginas se encabalgan en vez de embonar.
  //
  // Esto lo MIDE en vez de suponerlo: si `duplicados` sale 0 el orden está bien
  // y el exceso es otra cosa; si sale grande, es el orden.
  const vistosEnCorrida = new Set<string>();
  let duplicados = 0;
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

  /**
   * Deja constancia de un folio que EXISTE y cuyo documento no tenemos.
   *
   * No entra a `Invoice` a propósito: una factura sin XML ahí suma pesos que
   * nadie puede documentar. Aquí queda apartada, contable-mente inerte y
   * auditable — y para 2017–2021 es la única memoria posible, porque el SAT ya
   * no sirve nada de esos años.
   */
  async function anotarFaltante(
    f: Record<string, unknown>,
    uuid: string,
    motivo: "sin_xml" | "descarga_fallo" | "sin_id" | "xml_no_parseable",
  ): Promise<void> {
    const emitido = String(f.issuedAt ?? "");
    const fecha = new Date(emitido);
    if (!uuid || Number.isNaN(fecha.getTime())) return;
    const total = Number(f.total);
    try {
      await prisma.cfdiFaltante.upsert({
        where: { companyId_uuid: { companyId: companyId as string, uuid } },
        // Un reintento no crea otro renglón: sube el contador y la fecha. Si
        // antes falló la descarga y ahora resulta que no está, el motivo se
        // corrige al de hoy.
        update: { motivo, intentos: { increment: 1 }, ultimoIntento: new Date() },
        create: {
          companyId: companyId as string,
          uuid,
          fecha,
          tipoSat: f.type ? String(f.type) : null,
          total: Number.isFinite(total) ? total : null,
          estatus: f.status ? String(f.status) : null,
          origen: "Syntage",
          motivo,
        },
      });
    } catch {
      /* anotar el hueco nunca debe tumbar la importación */
    }
  }

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
    if (!muestraCruda && facturas[0]) {
      const f0 = facturas[0] as Record<string, unknown>;
      muestraCruda = {
        llaves: Object.keys(f0),
        xml: f0.xml,
        tipoDeXml: typeof f0.xml,
        status: f0.status,
        type: f0.type,
      };
    }

    // Los UUIDs que Syntage reporta, contra los que ya guardamos. Se pregunta
    // por lote —no una consulta por factura— y sólo por uuid, que es la llave
    // con la que el import dedup.
    const uuids = facturas
      .map((f) => String((f as Record<string, unknown>).uuid ?? "").toUpperCase())
      .filter(Boolean);
    // Se trae también `canceladaAt`: un CFDI que el SAT dio por cancelado y
    // nosotros seguimos contando como vivo es un peso de más en los libros, y
    // esto es la ÚNICA forma de saberlo para 2017–2021 (la descarga masiva no
    // llega, y el XML de un cancelado ya no se puede bajar — pero el estatus
    // del listado sí viene).
    const nuestrasFilas = await prisma.invoice.findMany({
      where: { companyId, uuid: { in: uuids } },
      select: { uuid: true, canceladaAt: true },
    });
    const nuestros = new Set(nuestrasFilas.map((r) => (r.uuid ?? "").toUpperCase()));
    const vivasNuestras = new Set(
      nuestrasFilas.filter((r) => r.canceladaAt == null).map((r) => (r.uuid ?? "").toUpperCase()),
    );

    for (const f of facturas as Array<Record<string, unknown>>) {
      const uuid = String(f.uuid ?? "").toUpperCase();
      const emitido = String(f.issuedAt ?? "");
      const anio = Number(emitido.slice(0, 4));
      if (!Number.isFinite(anio) || anio < 2000) continue;
      const fila =
        porAnio.get(anio) ??
        { anio, enSyntage: 0, yaTenemos: 0, faltan: 0, conXml: 0, canceladas: 0, canceladasNoRegistradas: 0 };
      if (uuid) {
        if (vistosEnCorrida.has(uuid)) duplicados++;
        else vistosEnCorrida.add(uuid);
      }
      fila.enSyntage++;
      if (f.xml === true) fila.conXml++;
      if (uuid && nuestros.has(uuid)) fila.yaTenemos++;
      else fila.faltan++;
      // El estatus viene aunque el XML ya no: un cancelado pierde el archivo
      // descargable, no el renglón.
      const cancelado = String(f.status ?? "").toUpperCase().includes("CANCEL");
      if (cancelado) {
        fila.canceladas++;
        if (uuid && vivasNuestras.has(uuid)) {
          fila.canceladasNoRegistradas++;
          if (canceladasPendientes.length < 50) canceladasPendientes.push(uuid);
        }
      }
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
        // Ya lo tenemos: se descarta sin tocar la red. Es la razón de que esto
        // cueste ~21 mil descargas y no 200 mil.
        if (!uuid || nuestros.has(uuid)) continue;

        const syntageId = String(f.id ?? "");
        if (!syntageId) {
          await anotarFaltante(f, uuid, "sin_id");
          imp.sinXml++;
          continue;
        }

        // NO se consulta la bandera `xml`. Se INTENTA bajar el archivo y el
        // resultado decide.
        //
        // Antes había aquí un `if (f.xml !== true) continue`, y era un hueco
        // callado: si la bandera significa «se pidió XML en esta extracción» y
        // no «hay XML disponible», ese `continue` dejaba fuera miles de
        // comprobantes sin que nadie se enterara. El propio listado la reportó
        // en 12,700/12,700 en una vuelta y 229/13,100 en la siguiente, y en la
        // UI los XML se ven activos en filas que la bandera daba por vacías.
        // Un hecho medido (el endpoint respondió que no) vale más que un campo
        // interpretado.
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
          if (r.resultado === "importado") {
            imp.importados++;
            // Si estaba anotado como faltante, ya no lo está.
            await prisma.cfdiFaltante
              .deleteMany({ where: { companyId, uuid } })
              .catch(() => undefined);
          } else if (r.resultado === "existente") imp.existentes++;
          else {
            // El XML SÍ se bajó y aun así no se pudo guardar: el parser no le
            // sacó folio o fecha. Se anota igual, porque un comprobante que
            // existe y no pudimos leer es tan hueco como uno que no llegó — y
            // hasta ahora se perdía en un contador sin nombre.
            //
            // Caso conocido: CFDI 3.2 (vigente hasta el 2017-11-30, que es el
            // arranque de MARGOM). Ese esquema trae los atributos en minúscula
            // —`fecha`, `total`, `subTotal`, `rfc`— y `tipoDeComprobante` con
            // palabras («ingreso») en vez de letras, así que `parseCfdiXml`,
            // que busca los capitalizados de 3.3/4.0, no encuentra nada.
            imp.invalidos++;
            await anotarFaltante(f, uuid, "xml_no_parseable");
          }
        } catch (e) {
          // 404 = el proveedor no tiene el documento. Cualquier otra cosa es un
          // fallo de descarga, que sí vale la pena reintentar después.
          const status = (e as { status?: number })?.status;
          const noEstá = status === 404 || status === 410;
          await anotarFaltante(f, uuid, noEstá ? "sin_xml" : "descarga_fallo");
          if (noEstá) imp.sinXml++;
          else {
            imp.errores++;
            if (!imp.primerError) imp.primerError = e instanceof Error ? e.message : String(e);
          }
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
      canceladas: filas.reduce((s, f) => s + f.canceladas, 0),
      canceladasNoRegistradas: filas.reduce((s, f) => s + f.canceladasNoRegistradas, 0),
      // Folios distintos contra renglones devueltos. Si no coinciden, las
      // páginas se traslapan y CUALQUIER suma de estas corridas está inflada.
      uuidsDistintos: vistosEnCorrida.size,
      duplicados,
    },
    // Folios vivos para nosotros y cancelados para el SAT. Muestra, no lista
    // completa: lo que importa aquí es si el número es cero o no.
    canceladasPendientes,
    muestraCruda,
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
      "Si `siguienteCursor` no es null, vuelve a llamar con `cursor=<ese valor>`. " +
      "`canceladasNoRegistradas` son folios que el SAT da por cancelados y nosotros " +
      "seguimos contando como vivos: el listado trae el estatus aunque el XML de un " +
      "cancelado ya no se pueda bajar, y para 2017–2021 es la única vía a ese dato.",
  };

  console.log(
    "[cron/syntage-cfdis]",
    JSON.stringify({
      companyId,
      rfc: empresa.rfc,
      ...resp.totales,
      paginas,
      siguienteCursor,
      duplicados,
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
