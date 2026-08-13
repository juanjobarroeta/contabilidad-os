import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { SyntageClient } from "@/lib/fiscal/cumplimiento/syntage/client";
import {
  descargarDocumentoCe,
  masReciente,
  periodoDe,
} from "@/lib/contabilidad/ce-import-syntage";
import {
  diagnosticoApertura,
  naturalezaPorAritmetica,
  padresDeBalanza,
  parseBalanza,
} from "@/lib/contabilidad/ce-import";
import { naturalezaPorTipo, type Naturaleza } from "@/lib/contabilidad/coe-saldos";

// ─────────────────────────────────────────────────────────────────────────────
// GET/POST /api/cron/ce-inspect?companyId=<id>[&peek=1][&balanza=1]
//
// Diagnóstico de SOLO LECTURA para la Contabilidad Electrónica vía Syntage.
// El arranque automático (`ceBootstrap` del compliance-sync) degrada en
// silencio: `importado:false` solo dice que no encontró nada importable, no
// DÓNDE se rompió la cadena. Este endpoint la desarma pieza por pieza:
//
//   • TODAS las entidades de Syntage que matchean el RFC (una empresa con más
//    de una entidad = las extracciones pueden vivir en la que NO resolvemos).
//   • Por entidad: cuántos electronic-accounting-records hay, histograma de
//     `fileType` (esperamos "CT"/"B"/"PL" — un histograma distinto delata un
//     mapeo desactualizado) y una muestra de metadatos con sus `files`.
//   • Con `peek=1`: descarga el primer archivo del registro más reciente y
//     devuelve los primeros bytes, para confirmar que el contenido es el XML
//     del SAT y no otra cosa.
//   • Con `balanza=1`: baja la ÚLTIMA balanza y devuelve un informe AGREGADO
//     (ver `informeBalanza`) para decidir con números, no con corazonadas, qué
//     hacer con las cuentas que traen saldo y no están en el catálogo.
//
// No escribe nada (ni en la BD ni en Syntage). Auth: CRON_SECRET.
//
// Sólo salen CONTEOS y códigos de cuenta: ni razones sociales de terceros ni
// importes por cuenta. Los saldos de una empresa no tienen por qué viajar en un
// diagnóstico para responder «¿cuántas cuentas se caen y por qué?».
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Json = Record<string, unknown>;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

function idDe(e: Json): string {
  if (e.id != null) return String(e.id);
  const iri = e["@id"];
  return typeof iri === "string" ? (iri.split("/").pop() ?? "") : "";
}

function filesMeta(rec: Json): Json[] {
  const files = Array.isArray(rec.files) ? (rec.files as Json[]) : [];
  return files.map((f) => ({
    type: f.type ?? null,
    mimeType: f.mimeType ?? null,
    ref: f["@id"] ?? f.id ?? null,
  }));
}

/** Naturaleza que ADIVINARÍA la regla del primer dígito del código. */
function naturalezaPorPrimerDigito(numCta: string): Naturaleza | null {
  switch (numCta.trim().charAt(0)) {
    case "1":
    case "5":
    case "6":
    case "7":
    case "8":
      return "D";
    case "2":
    case "3":
    case "4":
      return "A";
    default:
      return null;
  }
}

/**
 * Informe AGREGADO de la última balanza. Contesta tres preguntas que hoy se
 * responden a ojo, y que deciden si la apertura automática es segura:
 *
 *   1. ¿Cuántas cuentas con saldo NO están en el catálogo? (las que se caen hoy)
 *   2. ¿La aritmética de la balanza acierta la naturaleza? Se contrasta contra
 *      las cuentas que SÍ están en el catálogo, donde el SAT ya dijo cuál es —
 *      ahí hay verdad conocida. Se compara también la regla del primer dígito,
 *      para saber cuál de las dos merece confianza.
 *   3. ¿El filtro de cuentas de detalle ve la jerarquía? Hoy parte por punto, y
 *      hay empresas cuyos códigos usan guion (MARGOM: 1313 de 1419 cuentas).
 *      Si no ve los padres, postea el mayor Y sus hijas: el subárbol doble.
 *
 * No devuelve importes ni cuentas una por una: sólo conteos y unos pocos
 * códigos de ejemplo para poder rastrear un caso raro.
 */
function informeBalanza(
  xml: string,
  catalogo: Array<{ codigo: string; naturaleza: Naturaleza }>,
) {
  const bal = parseBalanza(xml);
  const conocida = new Map(catalogo.map((c) => [c.codigo, c.naturaleza]));

  // ── 1 y 2 ──────────────────────────────────────────────────────────────────
  const conSaldo = bal.cuentas.filter((c) => Math.abs(c.saldoFin) >= 0.005);

  // Verdad conocida: cuentas del catálogo. Aquí se AUDITAN los dos métodos.
  const aritmetica = { acierta: 0, falla: 0, sinOpinion: 0 };
  const primerDigito = { acierta: 0, falla: 0, sinOpinion: 0 };
  const fallasAritmetica: string[] = [];
  for (const c of bal.cuentas) {
    const real = conocida.get(c.numCta);
    if (!real) continue;
    const a = naturalezaPorAritmetica(c);
    if (a == null) aritmetica.sinOpinion++;
    else if (a === real) aritmetica.acierta++;
    else {
      aritmetica.falla++;
      if (fallasAritmetica.length < 20) fallasAritmetica.push(c.numCta);
    }
    const p = naturalezaPorPrimerDigito(c.numCta);
    if (p == null) primerDigito.sinOpinion++;
    else if (p === real) primerDigito.acierta++;
    else primerDigito.falla++;
  }

  // Cuentas huérfanas: traen saldo y el catálogo no las conoce. ¿A cuántas les
  // puede poner naturaleza la aritmética?
  const huerfanas = conSaldo.filter((c) => !conocida.has(c.numCta));
  const huerfanasPorMetodo = { aritmetica: 0, soloPrimerDigito: 0, ninguno: 0 };
  for (const c of huerfanas) {
    if (naturalezaPorAritmetica(c) != null) huerfanasPorMetodo.aritmetica++;
    else if (naturalezaPorPrimerDigito(c.numCta) != null) huerfanasPorMetodo.soloPrimerDigito++;
    else huerfanasPorMetodo.ninguno++;
  }

  // ── 3: jerarquía ───────────────────────────────────────────────────────────
  // Tres reglas candidatas, medidas sobre la MISMA balanza. La de hoy y dos
  // que podrían sustituirla; el informe dice cuál hace falta.
  const codigos = bal.cuentas.map((c) => c.numCta);

  // (a) La de HOY: parte por punto. Con códigos de guion no encuentra nada.
  const padresPorPunto = new Set<string>();
  for (const codigo of codigos) {
    const partes = codigo.split(".");
    for (let i = 1; i < partes.length; i++) padresPorPunto.add(partes.slice(0, i).join("."));
  }

  // (b) Prefijo + separador: A es padre de B si B empieza con A seguido de un
  // separador. Sirve para «102» → «102.01» sin suponer cuál es el separador.
  // NO sirve para el relleno de ceros: «1101-0101-0000» no empieza con
  // «1101-0000-0000», que es como se escribe su mayor.
  const padresPorPrefijo = new Set<string>();
  const ordenados = [...codigos].sort();
  for (const a of ordenados) {
    for (const b of ordenados) {
      if (b.length > a.length && b.startsWith(a) && /[.\-/]/.test(b.charAt(a.length))) {
        padresPorPrefijo.add(a);
        break;
      }
    }
  }

  // (c) Por grupos, ignorando el relleno de ceros. Se parte el código en grupos
  // por cualquier separador y se tiran los grupos finales que son todo ceros:
  //   1101-0101-0000 → [1101, 0101]      102.01 → [102, 01]
  //   1101-0000-0000 → [1101]            102    → [102]
  // A es padre de B si sus grupos son prefijo estricto de los de B. Así el
  // mayor se reconoce lo escriba como lo escriba la empresa.
  const gruposDe = (codigo: string): string[] => {
    const g = codigo.split(/[.\-/]/);
    while (g.length > 1 && /^0+$/.test(g[g.length - 1])) g.pop();
    return g;
  };
  const clavesPadre = new Set<string>();
  for (const codigo of codigos) {
    const g = gruposDe(codigo);
    // Cada ancestro propio de este código, por su clave de grupos.
    for (let i = 1; i < g.length; i++) clavesPadre.add(g.slice(0, i).join(" "));
  }
  // Un código de la balanza es padre si su clave de grupos aparece como
  // ancestro de algún otro.
  const padresPorGrupos = new Set(
    codigos.filter((c) => clavesPadre.has(gruposDe(c).join(" "))),
  );

  const separadores = {
    punto: codigos.filter((c) => c.includes(".")).length,
    guion: codigos.filter((c) => c.includes("-")).length,
    ninguno: codigos.filter((c) => !/[.\-/]/.test(c)).length,
  };

  return {
    periodo: { anio: bal.anio, mes: bal.mes },
    cuentas: bal.cuentas.length,
    cuentasConSaldo: conSaldo.length,
    catalogoEnBd: catalogo.length,
    separadores,
    // ¿Acierta la aritmética donde el SAT ya nos dijo la respuesta?
    auditoriaContraCatalogo: { aritmetica, primerDigito, ejemplosFallaAritmetica: fallasAritmetica },
    huerfanas: {
      total: huerfanas.length,
      porMetodo: huerfanasPorMetodo,
      ejemplos: huerfanas.slice(0, 25).map((c) => c.numCta),
    },
    jerarquia: {
      padresPorPunto: padresPorPunto.size,
      padresPorPrefijo: padresPorPrefijo.size,
      padresPorGrupos: padresPorGrupos.size,
      // Cuentas que HOY se postean como si fueran hojas y no lo son: el bug del
      // subárbol duplicado, medido con la mejor de las reglas candidatas.
      padresInvisiblesHoy: [...padresPorGrupos].filter((p) => !padresPorPunto.has(p)).length,
      ejemplosInvisibles: [...padresPorGrupos].filter((p) => !padresPorPunto.has(p)).slice(0, 15),
      // Lo que la regla de grupos ve y la de prefijo no: el relleno de ceros.
      soloGrupos: [...padresPorGrupos].filter((p) => !padresPorPrefijo.has(p)).slice(0, 15),
    },
  };
}

async function handle(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const companyId = params.get("companyId");
  const peek = params.get("peek") === "1";
  const conBalanza = params.get("balanza") === "1";
  // El desglose del descuadre de la apertura SÍ lleva importes (es todo el
  // punto: decir dónde se van los pesos). Es contabilidad agregada de la
  // propia empresa, no datos de terceros, y va detrás del mismo CRON_SECRET.
  const conApertura = params.get("apertura") === "1";
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, razonSocial: true, ceBootstrapAt: true },
  });
  if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

  try {
    const client = new SyntageClient();
    const target = company.rfc.trim().toUpperCase();
    // Mismo criterio laxo que findEntityByRfc, pero SIN quedarse con la
    // primera: aquí el punto es ver si hay más de una.
    const entidades = (await client.listEntities()).filter((e) =>
      JSON.stringify(e).toUpperCase().includes(target),
    );

    const reporte = [];
    for (const e of entidades) {
      const entityId = idDe(e);
      const [records, returns] = await Promise.all([
        client.getEntityElectronicAccounting(entityId),
        client.getEntityTaxReturns(entityId),
      ]);

      const porFileType: Record<string, number> = {};
      for (const r of records) {
        const t = String(r.fileType ?? "SIN_TIPO");
        porFileType[t] = (porFileType[t] ?? 0) + 1;
      }

      let muestraContenido: string | null = null;
      if (peek && records.length > 0) {
        const ref = filesMeta(records[0])[0]?.ref;
        if (ref) {
          try {
            muestraContenido = (await client.downloadFileText(String(ref))).slice(0, 400);
          } catch (err) {
            muestraContenido = `error al descargar: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }

      // Informe de la última balanza (sólo si se pidió y esta entidad tiene).
      let balanza: Record<string, unknown> | null = null;
      if (conBalanza) {
        const balanzas = records.filter((r) => String(r.fileType ?? "") === "B");
        if (balanzas.length === 0) {
          balanza = { error: "la entidad no tiene registros fileType=B" };
        } else {
          const rec = balanzas.reduce(masReciente);
          const doc = await descargarDocumentoCe(client, rec, "B");
          if (!doc) {
            balanza = { error: "ningún archivo del registro B resultó ser la balanza" };
          } else {
            const accounts = await prisma.chartAccount.findMany({
              where: { companyId, isActive: true },
              select: { cuentaSAT: true, subcuenta: true, tipo: true, naturaleza: true },
            });
            const catalogo = accounts.map((a) => ({
              codigo: a.subcuenta ?? a.cuentaSAT,
              naturaleza: (a.naturaleza as Naturaleza | null) ?? naturalezaPorTipo(a.tipo),
            }));
            balanza = {
              ...informeBalanza(doc.xml, catalogo),
              archivo: doc.nombre,
              registro: periodoDe(rec),
            };
            if (conApertura) {
              // Se reproduce EXACTAMENTE la selección de importarBalanza: misma
              // regla de jerarquía y mismo catálogo. Si aquí cuadra y allá no,
              // la diferencia está en el importador, no en los datos.
              const bal = parseBalanza(doc.xml);
              const padres = padresDeBalanza(bal.cuentas.map((c) => c.numCta));
              const nat = new Map(catalogo.map((c) => [c.codigo, c.naturaleza]));
              balanza.apertura = diagnosticoApertura({
                cuentas: bal.cuentas,
                usar: "final",
                esPadre: (c) => padres.has(c),
                enCatalogo: (c) => nat.has(c),
                naturalezaPorCodigo: (c) => nat.get(c),
              });
            }
          }
        }
      }

      reporte.push({
        entityId,
        name: e.name ?? null,
        createdAt: e.createdAt ?? null,
        taxReturns: returns.length,
        ceRecords: records.length,
        cePorFileType: porFileType,
        ceMuestra: records.slice(0, 3).map((r) => ({
          year: r.year ?? null,
          month: r.month ?? null,
          fileType: r.fileType ?? null,
          files: filesMeta(r),
        })),
        ...(muestraContenido != null ? { muestraContenido } : {}),
        ...(balanza != null ? { balanza } : {}),
      });
    }

    return NextResponse.json({
      ok: true,
      companyId,
      rfc: company.rfc,
      razonSocial: company.razonSocial,
      ceBootstrapAt: company.ceBootstrapAt,
      entidadesEncontradas: reporte.length,
      entidades: reporte,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
