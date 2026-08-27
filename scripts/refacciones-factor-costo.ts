/**
 * Backfill del FACTOR de conversión de refacciones.
 *
 * Un lubricante se COMPRA por tambo (208 L) y se VENDE por litro. El catálogo
 * guarda el costo del TAMBO, así que multiplicarlo por los litros que salen del
 * kardex infla el costo ~200 veces: en MARGOM, $3.5M de venta de refacciones se
 * volvían $85M de costo y la absorción de servicio caía a −768%.
 *
 * El tamaño del envase está en la línea del CFDI de COMPRA —«PremiumPRO API SAE
 * 5w-30*208lt (Tambo)»— pero NO en `Refaccion.descripcion`, que casi siempre
 * termina con la descripción de VENTA porque el upsert de `auto-refaccion.ts`
 * sólo escribe la descripción en el `create`, nunca en el `update`.
 *
 * Este script relee el rawXml de los CFDI de compra —no baja nada del SAT—,
 * saca el factor por número de parte y lo guarda.
 *
 * Uso (DRY-RUN por default: no escribe nada):
 *   DATABASE_URL=<url> RFC=<rfc>|COMPANY_ID=<id> npx tsx scripts/refacciones-factor-costo.ts
 *   ... APPLY=1     para escribir
 */
import { PrismaClient } from "@prisma/client";
import { extraerRefaccionesCfdi } from "../src/lib/automotriz/auto-refaccion";
import { factorDesdeTexto } from "../src/lib/automotriz/unidad-refaccion";

const prisma = new PrismaClient();
const APPLY = process.env.APPLY === "1";

async function main() {
  const companyId = process.env.COMPANY_ID ??
    (await prisma.company.findFirstOrThrow({ where: { rfc: process.env.RFC ?? "" }, select: { id: true } })).id;

  // Sólo las refacciones cuyo costo HOY no es comparable: son las únicas donde
  // el factor cambia algo. El resto ya cuadra y tocarlas sería ruido.
  const problematicas = await prisma.refaccion.findMany({
    where: {
      companyId,
      OR: [
        { AND: [{ unidadCosto: { not: null } }, { unidadPrecio: { not: null } }, { NOT: { unidadCosto: { equals: prisma.refaccion.fields.unidadPrecio } } }] },
      ],
    },
    select: { id: true, numeroParte: true, descripcion: true, ultimoCosto: true, ultimoPrecio: true, unidadCosto: true, unidadPrecio: true },
  });

  // Índice numeroParte → factor, leído de TODOS los CFDI de compra. Se queda con
  // el mayor factor visto: si una parte se compró suelta y en tambo, el tambo es
  // el que produce el costo inflado.
  const facturas = await prisma.invoice.findMany({
    where: { companyId, tipo: "EGRESO", status: { not: "CANCELLED" }, rawXml: { not: null } },
    select: { rawXml: true },
  });

  const porParte = new Map<string, { factor: number; evidencia: string }>();
  const unidadDeVenta = new Map(problematicas.map((r) => [r.numeroParte, r.unidadPrecio]));
  for (const f of facturas) {
    for (const l of extraerRefaccionesCfdi(f.rawXml!)) {
      const venta = unidadDeVenta.get(l.numeroParte);
      if (!venta) continue;
      const hit = factorDesdeTexto(l.descripcion, l.numeroParte, venta);
      if (!hit) continue;
      const prev = porParte.get(l.numeroParte);
      if (!prev || hit.factor > prev.factor) porParte.set(l.numeroParte, hit);
    }
  }

  let resueltas = 0;
  const sospechosas: string[] = [];
  console.log(`${APPLY ? "APLICANDO" : "DRY-RUN"} · ${problematicas.length} refacciones con costo no comparable · ${facturas.length} CFDI de compra leídos\n`);
  for (const r of problematicas) {
    const hit = porParte.get(r.numeroParte);
    if (!hit) continue;
    const antes = Number(r.ultimoCosto);
    const despues = Math.round((antes / hit.factor) * 100) / 100;

    // El factor tiene que producir un margen que EXISTA en el negocio. Éste es
    // el filtro que separa «arreglado» de «plausible pero falso»: un factor mal
    // leído cambia un costo absurdo —que se nota— por uno razonable que no.
    // Una refacción se vende entre 15% y 70% de margen; fuera de ahí, la
    // lectura se sospecha y se manda a revisión en vez de escribirse.
    const precio = Number(r.ultimoPrecio ?? 0);
    const margen = precio > 0 ? (precio - despues) / precio : null;
    const creible = margen != null && margen >= 0.05 && margen <= 0.80;

    const linea =
      `  ${r.numeroParte.padEnd(20)} ${(r.descripcion ?? "").slice(0, 32).padEnd(34)} ` +
      `${String(antes).padStart(9)} → ${String(despues).padStart(8)} /${r.unidadPrecio}  ` +
      `factor ${String(hit.factor).padStart(7)}  margen ${margen == null ? "  ?  " : (margen * 100).toFixed(0).padStart(4) + "%"}  «${hit.evidencia}»`;

    if (!creible) {
      sospechosas.push(linea);
      continue;
    }
    resueltas++;
    console.log(linea);
    if (APPLY) {
      // SQL directo y no `prisma.refaccion.update`: el cliente generado se
      // comparte entre worktrees, y regenerarlo desde este schema borraría del
      // cliente los campos que otra rama sí tiene. La columna existe por la
      // migración; escribirla no necesita tipos nuevos.
      await prisma.$executeRaw`UPDATE "Refaccion" SET "factorCosto" = ${hit.factor} WHERE id = ${r.id}`;
    }
  }
  if (sospechosas.length > 0) {
    console.log(`\nNO se escriben — el factor sale de la descripción pero el margen no es creíble.`);
    console.log(`Puede ser una lectura mala del texto, o un precio de venta mal capturado:`);
    for (const l of sospechosas) console.log(l);
  }
  const aMano = problematicas.length - resueltas;
  console.log(`\nescritas ${resueltas} · sospechosas ${sospechosas.length} · sin factor legible ${aMano - sospechosas.length}`);
  console.log(`quedan ${aMano} por capturar a mano.`);
  await prisma.$disconnect();
}
main();
