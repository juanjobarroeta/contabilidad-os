import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { calcularResultados } from "@/lib/automotriz/resultados";
import { SyntageClient } from "@/lib/fiscal/cumplimiento/syntage/client";
import { descargarDocumentoCe, periodoDe } from "@/lib/contabilidad/ce-import-syntage";
import { parseBalanza, padresDeBalanza } from "@/lib/contabilidad/ce-import";

// ─────────────────────────────────────────────────────────────────────────────
// GET/POST /api/cron/contraste?companyId=<id>&anio=<YYYY>
//
// ¿Cuál de los tres números es el real?
//
// El tablero dice que MARGOM pierde $34M en 2025 con utilidad BRUTA positiva de
// $158M: toda la pérdida vive debajo de la línea bruta, en una estructura de
// $192M. Eso puede ser gasto de verdad o inventario mal clasificado, y desde
// los CFDIs no se distingue — es la misma inferencia que ya falló varias veces.
//
// Hay dos fuentes que NO son inferencia, porque son lo que la empresa YA le
// dijo al SAT:
//
//   • DECLARADO — TaxDeclaration. La ANUAL trae ingresos y deducciones
//     autorizadas del ejercicio; las mensuales de ISR traen ingresos nominales
//     acumulados. Es lo que se presentó, con firma.
//   • LIBROS — la balanza de diciembre del ejercicio (Anexo 24). Sus cuentas de
//     resultado son la contabilidad del contador: 4xxx ingresos, 5xxx costos,
//     6xxx gastos. Es lo que dicen los libros, cuenta por cuenta.
//
// Este endpoint pone los tres lado a lado. Si los libros y lo declarado también
// dan pérdida, el software tiene razón y el problema es del negocio. Si no, el
// software está mal y aquí queda la diferencia, cuantificada.
//
// No escribe nada. Auth: CRON_SECRET. Sólo agregados por familia de cuenta.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Resultado del ejercicio según los LIBROS, leído de la balanza.
 *
 * Se toma el SaldoFin de las cuentas de resultado, que en la balanza de
 * diciembre es el acumulado del ejercicio. Sólo cuentas de DETALLE: la balanza
 * trae el mayor Y sus hijas, y sumar ambos duplica el subárbol (ver
 * padresDeBalanza — en MARGOM son 103 mayores).
 */
function resultadoDeBalanza(xml: string, nombrePorCodigo: Map<string, string> = new Map()) {
  const bal = parseBalanza(xml);
  const padres = padresDeBalanza(bal.cuentas.map((c) => c.numCta));
  const porFamilia = new Map<string, { cuentas: number; saldo: number }>();

  for (const c of bal.cuentas) {
    if (padres.has(c.numCta)) continue; // el mayor ya está en sus hijas
    const familia = c.numCta.trim().charAt(0);
    const acc = porFamilia.get(familia) ?? { cuentas: 0, saldo: 0 };
    acc.cuentas++;
    acc.saldo += c.saldoFin;
    porFamilia.set(familia, acc);
  }

  // La balanza trae los saldos CON SIGNO por naturaleza: las cuentas
  // acreedoras (2 pasivo, 3 capital, 4 ingresos) salen negativas y las deudoras
  // (1 activo, 5 costos, 6 gastos) positivas. Medido en AMA170817NK1 2025-12:
  //   1: +485,326,593   2: −453,437,767   3: −18,992,047
  //   4: −2,131,817,385  5: +1,932,421,872  6: +170,488,523
  //
  // La primera versión de esto restaba el costo POSITIVO de un ingreso NEGATIVO
  // y publicaba una «utilidad bruta» de −$4,064,239,257, que no es un número de
  // nada. Se toma la MAGNITUD de cada familia y el signo se pone aquí, que
  // además aguanta si otra empresa entrega la balanza sin signo.
  const mag = (d: string) => r2(Math.abs(porFamilia.get(d)?.saldo ?? 0));
  const ingresos = mag("4");
  const costos = mag("5");
  const gastos = mag("6");

  // Las cuentas de INGRESO una por una. La brecha contra el tablero es de
  // $189.2M —casi el 9% de las ventas— y saber que «faltan ingresos» no dice
  // CUÁLES. Aquí es donde se ve si lo que falta son devoluciones y descuentos
  // (contra-ingreso, que el contador netea y el tablero no), anticipos, o una
  // línea de negocio entera que el derivador no reconoce.
  //
  // Se separan las de saldo deudor: en la familia 4 un saldo del lado contrario
  // es contra-ingreso (devoluciones, descuentos, bonificaciones sobre ventas) y
  // sumarlo junto con las demás esconde justo lo que se está buscando.
  //
  // El NOMBRE es indispensable. La balanza sólo trae NumCta y saldo, así que
  // «4131-0013 = −$445,049,433» no dice NADA: no se puede saber si esa línea de
  // negocio la ve el tablero o no. El nombre vive en el catálogo, que ya está en
  // ChartAccount. Sin cruzarlo sólo quedaría adivinar qué es cada cuenta, y
  // adivinar es lo que ha fallado toda la sesión.
  //
  // Se hace igual para el 6 (gastos): la brecha de gasto son $22.1M —el 70% de
  // lo que queda tras limpiar el fan-out— y saber el total no dice QUÉ cuenta
  // sobra. `contrario` recoge las de saldo del lado opuesto al de su familia:
  // en el 4 es contra-ingreso (descuentos, devoluciones) y en el 6 sería un
  // gasto acreditado.
  const detalleFamilia = (digito: string, ladoNormal: "D" | "A") => {
    const cuentas = bal.cuentas
      .filter((c) => !padres.has(c.numCta) && c.numCta.trim().charAt(0) === digito)
      .map((c) => ({
        numCta: c.numCta,
        nombre: nombrePorCodigo.get(c.numCta) ?? null,
        saldo: r2(c.saldoFin),
      }))
      .filter((c) => Math.abs(c.saldo) >= 0.005);
    // Deudora normal (gastos) → lo contrario es saldo negativo; acreedora
    // normal (ingresos) → lo contrario es saldo positivo.
    const contrario = cuentas.filter((c) => (ladoNormal === "D" ? c.saldo < 0 : c.saldo > 0));
    return {
      cuentas: cuentas.length,
      mayores: [...cuentas].sort((a, b) => Math.abs(b.saldo) - Math.abs(a.saldo)).slice(0, 30),
      contrario: {
        cuentas: contrario.length,
        total: r2(contrario.reduce((s, c) => s + c.saldo, 0)),
        detalle: [...contrario].sort((a, b) => Math.abs(b.saldo) - Math.abs(a.saldo)).slice(0, 15),
      },
    };
  };

  const cuentasIngreso = bal.cuentas
    .filter((c) => !padres.has(c.numCta) && c.numCta.trim().charAt(0) === "4")
    .map((c) => ({
      numCta: c.numCta,
      nombre: nombrePorCodigo.get(c.numCta) ?? null,
      saldo: r2(c.saldoFin),
    }))
    .filter((c) => Math.abs(c.saldo) >= 0.005);
  const contraIngreso = cuentasIngreso.filter((c) => c.saldo > 0);

  return {
    periodo: { anio: bal.anio, mes: bal.mes },
    porFamilia: Object.fromEntries(
      [...porFamilia.entries()].sort().map(([k, v]) => [k, { cuentas: v.cuentas, saldo: r2(v.saldo) }]),
    ),
    ingresos,
    costos,
    gastos,
    utilidadBruta: r2(ingresos - costos),
    utilidadOperacion: r2(ingresos - costos - gastos),
    detalleIngresos: {
      cuentas: cuentasIngreso.length,
      // De mayor a menor por magnitud: las que mueven la aguja van arriba.
      mayores: [...cuentasIngreso].sort((a, b) => Math.abs(b.saldo) - Math.abs(a.saldo)).slice(0, 30),
      contraIngreso: {
        cuentas: contraIngreso.length,
        total: r2(contraIngreso.reduce((s, c) => s + c.saldo, 0)),
        detalle: contraIngreso.sort((a, b) => b.saldo - a.saldo).slice(0, 15),
      },
    },
    // Los 6xxx con nombre: aquí vive el 70% de la brecha que queda.
    detalleGastos: detalleFamilia("6", "D"),
  };
}

async function handle(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const companyId = params.get("companyId");
  const anio = Number(params.get("anio"));
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  if (!Number.isFinite(anio)) return NextResponse.json({ error: "anio requerido" }, { status: 400 });

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, razonSocial: true, regimenFiscal: true },
  });
  if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

  const desde = new Date(Date.UTC(anio, 0, 1));
  const hasta = new Date(Date.UTC(anio + 1, 0, 1));

  // ── 1. Lo que dice el TABLERO ──────────────────────────────────────────────
  const res = await calcularResultados(prisma, companyId, desde, hasta);
  const tablero = {
    ingreso: res.totales.ingreso,
    utilidadBruta: res.totales.utilidadBruta,
    margenBruto: res.totales.margenBruto,
    estructura: res.estructura,
    utilidadOperacion: res.totales.utilidad,
    ingresoSinCosto: res.totales.ingresoSinCosto,
  };

  // ── 2. Lo que se DECLARÓ ───────────────────────────────────────────────────
  const decls = await prisma.taxDeclaration.findMany({
    where: { companyId, periodo: { startsWith: String(anio) } },
    select: {
      tipo: true,
      periodo: true,
      status: true,
      isrIngresos: true,
      isrDeducciones: true,
      isrBaseGravable: true,
      isrPerdidaPendiente: true,
    },
    orderBy: { periodo: "asc" },
  });
  const anual = decls.find((d) => d.periodo === String(anio));
  const mensualesIsr = decls.filter((d) => d.tipo === "ISR_PROVISIONAL" && d.isrIngresos != null);
  const declarado = {
    anual: anual
      ? {
          status: anual.status,
          ingresos: anual.isrIngresos,
          deducciones: anual.isrDeducciones,
          baseGravable: anual.isrBaseGravable,
          perdidaPendiente: anual.isrPerdidaPendiente,
          utilidad:
            anual.isrIngresos != null && anual.isrDeducciones != null
              ? r2(anual.isrIngresos - anual.isrDeducciones)
              : null,
        }
      : null,
    // El ISR provisional acumula: el ingreso nominal del último mes presentado
    // ES el acumulado del ejercicio, no hay que sumarlos.
    ultimoIsrProvisional: mensualesIsr.length
      ? { periodo: mensualesIsr[mensualesIsr.length - 1].periodo, ingresosAcumulados: mensualesIsr[mensualesIsr.length - 1].isrIngresos }
      : null,
    declaracionesDelAnio: decls.length,
  };

  // ── 3. Lo que dicen los LIBROS ─────────────────────────────────────────────
  let libros: unknown = null;
  try {
    const client = new SyntageClient();
    const entity = await client.findEntityByRfc(company.rfc);
    if (!entity) {
      libros = { error: "sin entidad en Syntage para el RFC" };
    } else {
      // Catálogo de la empresa: pone NOMBRE a los códigos de la balanza.
      const cuentasBd = await prisma.chartAccount.findMany({
        where: { companyId },
        select: { cuentaSAT: true, subcuenta: true, nombre: true },
      });
      const nombrePorCodigo = new Map(
        cuentasBd.map((a) => [a.subcuenta ?? a.cuentaSAT, a.nombre]),
      );

      const records = await client.getEntityElectronicAccounting(entity.id);
      // La balanza de DICIEMBRE del ejercicio: su SaldoFin es el acumulado.
      const delAnio = records.filter((r) => String(r.fileType ?? "") === "B" && Number(r.year) === anio);
      const dic = delAnio.find((r) => Number(r.month) === 12) ?? delAnio.sort((a, b) => Number(b.month) - Number(a.month))[0];
      if (!dic) {
        libros = { error: `sin balanza de ${anio} en Syntage`, balanzasDisponibles: delAnio.length };
      } else {
        const doc = await descargarDocumentoCe(client, dic, "B");
        libros = doc
          ? { ...resultadoDeBalanza(doc.xml, nombrePorCodigo), archivo: doc.nombre, registro: periodoDe(dic) }
          : { error: "ningún archivo del registro B resultó ser la balanza" };
      }
    }
  } catch (e) {
    libros = { error: e instanceof Error ? e.message : String(e) };
  }

  // La brecha, desglosada. Sin esto hay que restar a mano y ahí es donde se
  // cuelan los errores — el primero fue mío, publicando una utilidad bruta de
  // −$4,064M por no mirar el signo.
  //
  // Medido en MARGOM 2025: los libros dan +$28,906,990 y la anual presentada
  // una base gravable de +$24,351,324, mientras el tablero muestra
  // −$34,046,291. Los libros y lo declarado coinciden en que hubo UTILIDAD; el
  // tablero es el que está mal, por $62.9M. Y el motivo no es el gasto: al
  // tablero le faltan $189.2M de INGRESO, y sólo $22.1M de la brecha vienen de
  // estructura de más.
  const L = libros as { ingresos?: number; costos?: number; gastos?: number; utilidadOperacion?: number };
  const brecha =
    typeof L?.ingresos === "number"
      ? {
          ingreso: r2(tablero.ingreso - L.ingresos),
          costo: r2(tablero.ingreso - tablero.utilidadBruta - (L.costos ?? 0)),
          gasto: r2(tablero.estructura - (L.gastos ?? 0)),
          utilidadOperacion: r2(tablero.utilidadOperacion - (L.utilidadOperacion ?? 0)),
          // Quién tiene razón, dicho sin rodeos.
          veredicto:
            (L.utilidadOperacion ?? 0) > 0 && tablero.utilidadOperacion < 0
              ? "LIBROS DAN UTILIDAD Y EL TABLERO PÉRDIDA — el tablero está mal"
              : (L.utilidadOperacion ?? 0) < 0 && tablero.utilidadOperacion < 0
                ? "los dos dan pérdida — el problema es del negocio, no del software"
                : "revisar caso por caso",
        }
      : null;

  return NextResponse.json({
    ok: true,
    companyId,
    rfc: company.rfc,
    razonSocial: company.razonSocial,
    regimenFiscal: company.regimenFiscal,
    anio,
    tablero,
    declarado,
    libros,
    brecha,
  });
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
