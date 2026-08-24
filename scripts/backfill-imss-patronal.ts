/**
 * Calcula y puebla `PayrollItem.imssPatronal` — el COSTO PATRONAL de IMSS que
 * NUNCA aparece en el recibo del trabajador y que el import histórico dejó en $0.
 *
 * Por qué existe:
 *   El CFDI de nómina sólo trae lo que se le RETIENE al trabajador (deducción
 *   001 = seguridad social ≈ cuota obrera, ~2.4% del SBC). La cuota PATRONAL
 *   (~20%+ del SBC: EyM, IV, CEAV, guarderías, riesgo de trabajo) es costo del
 *   patrón y no viaja en ningún recibo — hay que CALCULARLA. `imssObrero` sale
 *   fiel del XML; `imssPatronal` estaba en cero para todos los recibos.
 *
 * Qué calcula (motor `calcularImss`, tasas reales de la LSS):
 *   Por cada recibo, con el SBC del empleado (salarioDiarioIntegrado, o
 *   salarioDiario, o percepción/días como último recurso), los días del período
 *   según su periodicidad, su clase de riesgo, y la UMA del EJERCICIO del recibo
 *   (no la vigente — nómina en paralelo). `imssPatronal` = patronal.total del
 *   motor (ramos IMSS + CEAV + retiro/RCV). El obrero NO se toca: el del XML manda.
 *
 * Reconciliación (dry-run): compara lo calculado contra la CE declarada —
 *   • obrero calculado vs `imssObrero` almacenado (debe cuadrar: valida el motor)
 *   • patronal calculado vs 6X-0014 «CUOTAS AL IMSS» (gasto declarado)
 *   • retiro 2% vs 6X-0012 «SAR» · y el clearing 2407-0001 para contexto
 *   El reparto fino entre 6X-0014 / 6X-0012 / RCV es decisión del contador;
 *   aquí se muestran los cortes para que se pueda afinar el mapeo de cuentas.
 *
 * Idempotente: por default sólo toca recibos con imssPatronal = 0. RESET=1
 * recalcula todos (necesario si cambian tasas/SBC).
 *
 * Uso (dry-run por default; APPLY=1 escribe):
 *   DATABASE_URL=<url> RFC=<rfc>|COMPANY_ID=<id> [APPLY=1] [RESET=1] \
 *   ts-node --compiler-options '{"module":"CommonJS"}' scripts/backfill-imss-patronal.ts
 */
import { PrismaClient } from "@prisma/client";
import { resolverEmpresa } from "./lib/empresa";
import { calcularImss } from "../src/lib/nomina/imss";
import { umaDiariaDelEjercicio } from "../src/lib/nomina/constants";

const APPLY = process.env.APPLY === "1";
const RESET = process.env.RESET === "1";
const LOTE = 2000;
// Días de cotización por periodicidad de pago (c_PeriodicidadPago del SAT).
const DIAS: Record<string, number> = { "01": 1, "02": 7, "03": 14, "04": 15, "05": 30, "06": 30, "07": 15 };
const M = (n: number) => `$${(n / 1e6).toFixed(2)}M`;

async function main() {
  const prisma = new PrismaClient();
  try {
    const empresa = await resolverEmpresa(prisma);
    const COMPANY = empresa.id;
    console.log(`Empresa: ${empresa.razonSocial ?? empresa.rfc} (${COMPANY})`);

    const emps = new Map(
      (await prisma.employee.findMany({
        where: { companyId: COMPANY },
        select: { id: true, salarioDiario: true, salarioDiarioIntegrado: true, riesgoPuesto: true, periodicidadPago: true },
      })).map((e) => [e.id, e]),
    );

    // Recibos EXTRAORDINARIOS (aguinaldo, PTU, finiquito → CFDI tipoNomina="E"):
    // NO generan días de cotización propios — su costo IMSS ya está integrado en
    // el SBC de los recibos ordinarios (aguinaldo/prima integran el SDI). Contar
    // 15 días de cuota fija por cada uno inflaría el patronal. Se ponen en 0.
    const extraordinarios = new Set(
      (await prisma.invoice.findMany({
        where: { companyId: COMPANY, tipo: "NOMINA", tipoNomina: "E" },
        select: { uuid: true },
      })).map((i) => i.uuid).filter(Boolean) as string[],
    );

    // Recibos a tocar: por default sólo los que están en 0 (idempotencia);
    // RESET=1 recalcula todos.
    const items = await prisma.payrollItem.findMany({
      where: { payrollRun: { companyId: COMPANY }, ...(RESET ? {} : { imssPatronal: 0 }) },
      select: {
        id: true, employeeId: true, sueldoBase: true, totalPercepciones: true,
        imssObrero: true, cfdiUuid: true, payrollRun: { select: { fechaPago: true } },
      },
    });
    console.log(`${items.length.toLocaleString()} recibos a calcular${RESET ? " (RESET: todos)" : " (imssPatronal=0)"}`);
    if (items.length === 0) { console.log("Nada que hacer."); return; }

    // Acumuladores por año para la reconciliación.
    type Acc = { obrero: number; patronal: number; patronalSinRetiro: number; retiro: number; storedObr: number; n: number };
    const porAnio = new Map<number, Acc>();
    const updates: { id: string; val: number }[] = [];
    let sinSdi = 0;

    for (const it of items) {
      const e = emps.get(it.employeeId);
      const anio = it.payrollRun.fechaPago.getUTCFullYear();
      const esExtra = it.cfdiUuid ? extraordinarios.has(it.cfdiUuid) : false;
      const a = porAnio.get(anio) ?? { obrero: 0, patronal: 0, patronalSinRetiro: 0, retiro: 0, storedObr: 0, n: 0 };

      // Extraordinario: 0 cotización propia (ya integrada en el SDI ordinario).
      if (esExtra) { updates.push({ id: it.id, val: 0 }); a.n++; porAnio.set(anio, a); continue; }

      const dias = DIAS[e?.periodicidadPago ?? "04"] ?? 15;
      let sdi = e?.salarioDiarioIntegrado ?? e?.salarioDiario ?? 0;
      if (!sdi || sdi <= 0) { sdi = (it.totalPercepciones || it.sueldoBase || 0) / dias; if (sdi <= 0) sinSdi++; }
      const uma = umaDiariaDelEjercicio(anio) ?? undefined;
      const r = calcularImss({
        salarioBaseCotizacion: sdi, diasPagados: dias, riesgoPuesto: e?.riesgoPuesto ?? "1",
        ejercicio: anio, umaDiaria: uma, salarioDiario: e?.salarioDiario,
      });
      updates.push({ id: it.id, val: r.patronal.total });
      a.obrero += r.obrero.total; a.patronal += r.patronal.total;
      a.patronalSinRetiro += r.patronal.total - r.patronal.retiro; a.retiro += r.patronal.retiro;
      a.storedObr += it.imssObrero || 0; a.n++;
      porAnio.set(anio, a);
    }

    // Declarado en CE, por año (leaf), para el corte de reconciliación.
    const anios = [...porAnio.keys()].sort();
    console.log(`\n== Reconciliación calculado vs CE declarada ${sinSdi ? `(⚠ ${sinSdi} sin SBC)` : ""} ==`);
    for (const anio of anios) {
      const a = porAnio.get(anio)!;
      const ce = await prisma.$queryRawUnsafe<any[]>(
        `SELECT
           SUM("haber") FILTER (WHERE "numCta" = '2407-0001-0000')::float8 ret_imss,
           SUM("debe")  FILTER (WHERE "numCta" LIKE '6%' AND "numCta" LIKE '%0014%')::float8 cuotas_imss,
           SUM("debe")  FILTER (WHERE "numCta" LIKE '6%' AND "numCta" LIKE '%0012%')::float8 sar
         FROM "CeBalanzaMes" WHERE "companyId"=$1 AND anio=$2 AND "esPadre"=false`,
        COMPANY, anio,
      );
      const c = ce[0] ?? {};
      // El corte que cuadra es el LADO IMSS completo (CUOTAS IMSS + SAR): el
      // contador reparte CEAV entre 6X-0014 y 6X-0012, así que bucket-por-bucket
      // no compara — el total sí. `imssPatronal` que se guarda = patronal.total.
      const patTotal = a.patronalSinRetiro + a.retiro;
      const ladoImss = (c.cuotas_imss || 0) + (c.sar || 0);
      const ratio = ladoImss > 0 ? patTotal / ladoImss : 0;
      console.log(`\n  ${anio} · ${a.n.toLocaleString()} recibos ordinarios`);
      console.log(`    obrero   calc ${M(a.obrero)}  vs  almacenado(XML) ${M(a.storedObr)}   ${Math.abs(a.obrero - a.storedObr) / (a.storedObr || 1) < 0.15 ? "✓ cuadra" : "⚠"}`);
      console.log(`    PATRONAL calc ${M(patTotal)}  vs  lado IMSS declarado ${M(ladoImss)} (6X-0014 ${M(c.cuotas_imss || 0)} + 6X-0012 SAR ${M(c.sar || 0)})  ${ratio ? `${ratio.toFixed(2)}×` : ""}`);
      console.log(`    [contexto] 2407-0001 «RETENCION IMSS» clearing SUA: haber ${M(c.ret_imss || 0)}`);
    }

    if (!APPLY) {
      console.log(`\n[dry-run] ${updates.length.toLocaleString()} recibos calculados. APPLY=1 para escribir imssPatronal.`);
      return;
    }

    // Escritura MASIVA: un UPDATE … FROM (VALUES …) por lote (~10 statements
    // para toda la historia) en vez de un update por fila sobre el proxy.
    let escritos = 0;
    for (let i = 0; i < updates.length; i += LOTE) {
      const lote = updates.slice(i, i + LOTE);
      const values = lote.map((u) => `('${u.id}', ${Number(u.val).toFixed(2)}::float8)`).join(",");
      await prisma.$executeRawUnsafe(
        `UPDATE "PayrollItem" AS pi SET "imssPatronal" = v.val
         FROM (VALUES ${values}) AS v(id, val) WHERE pi.id = v.id`,
      );
      escritos += lote.length;
      console.log(`  ${escritos.toLocaleString()}/${updates.length.toLocaleString()}…`);
    }
    console.log(`\n${escritos.toLocaleString()} recibos actualizados con imssPatronal.`);
  } finally {
    await prisma.$disconnect();
  }
}

main();
