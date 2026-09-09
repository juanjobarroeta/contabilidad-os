// Reclasifica cargos ya importados con las reglas corregidas.
//
// Las reglas de import sólo actúan al importar: lo que entró antes se quedó
// como estaba. Aquí se vuelven a pasar dos poblaciones:
//
//   · los que siguen UNMATCHED y ahora sí reconocemos (tasa de descuento,
//     renta de terminal, «COBRO IVA»);
//   · los MAL etiquetados: «I V A POR COMISION» se registró como GASTO
//     (PENDING_MONTHLY_CFDI) cuando es IMPUESTO ACREDITABLE. Corregirlo mueve
//     dinero de gasto a IVA por acreditar.
//
// NUNCA toca un MATCHED ni un IGNORED con otro tag puesto a mano: sólo los
// UNMATCHED y los que este mismo criterio habría clasificado distinto.
//
// Uso: npx tsx scripts/retag-cargos-terminal.ts [--aplicar]
import { prisma } from "../src/lib/prisma";
import { clasificarCargoBancario } from "../src/lib/bancos/clasificar-cargo";

const fmt = (n: number) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });

async function main() {
  const aplicar = process.argv.includes("--aplicar");

  const movs = (
    await prisma.bankTransaction.findMany({
      where: {
        OR: [
          { status: "UNMATCHED" },
          // Sólo los que el import puso como comisión: si alguien los movió a
          // mano a otra cosa, su decisión manda.
          { status: "IGNORED", notes: "PENDING_MONTHLY_CFDI" },
        ],
      },
      select: { id: true, fecha: true, monto: true, descripcion: true, status: true, notes: true },
    })
  ).map((t) => ({ ...t, monto: Number(t.monto) }));

  // Tope de importe. Esto reclasifica en bloque a partir de una expresión
  // regular; con cargos de $6 y $40 el riesgo de equivocarse es trivial, con
  // uno de $35,241.98 no. Un cargo grande que además CALZA con «comisión»
  // puede ser otra cosa («PAGO TPV COMISION» puede ser un pago AL proveedor de
  // la terminal, no su comisión), y mandarlo a gasto en automático lo
  // enterraría. Se reportan aparte para que alguien los mire.
  const TOPE_AUTOMATICO = 5000;

  const cambios: Array<{ id: string; de: string; a: string; linea: string }> = [];
  const grandes: string[] = [];
  for (const t of movs) {
    const tag = clasificarCargoBancario(t.descripcion, t.monto);
    if (!tag) continue;
    const actual = t.status === "IGNORED" ? t.notes ?? "" : "UNMATCHED";
    if (actual === tag) continue;
    if (Math.abs(t.monto) > TOPE_AUTOMATICO) {
      grandes.push(
        `${t.fecha.toISOString().slice(0, 10)} ${fmt(t.monto).padStart(13)}  ${t.descripcion.slice(0, 44).padEnd(44)} ${actual} → ${tag}?`,
      );
      continue;
    }
    cambios.push({
      id: t.id,
      de: actual,
      a: tag,
      linea: `${t.fecha.toISOString().slice(0, 10)} ${fmt(t.monto).padStart(13)}  ${t.descripcion.slice(0, 44).padEnd(44)} ${actual} → ${tag}`,
    });
  }

  const porTipo = new Map<string, { n: number; monto: number }>();
  for (const c of cambios) {
    const k = `${c.de} → ${c.a}`;
    const g = porTipo.get(k) ?? { n: 0, monto: 0 };
    g.n++;
    porTipo.set(k, g);
  }

  console.log(`\nrevisados: ${movs.length}   a reclasificar: ${cambios.length}\n`);
  for (const [k, g] of porTipo) console.log(`  ${k.padEnd(46)} ${g.n}`);
  console.log("");
  for (const c of cambios.slice(0, 30)) console.log("  " + c.linea);
  if (cambios.length > 30) console.log(`  … y ${cambios.length - 30} más`);

  if (grandes.length > 0) {
    console.log(`\nNO se tocan (más de ${fmt(TOPE_AUTOMATICO)} — decisión humana):`);
    for (const g of grandes) console.log("  " + g);
  }

  if (!aplicar) {
    console.log("\n(simulación — agrega --aplicar)");
    await prisma.$disconnect();
    return;
  }
  for (const c of cambios) {
    await prisma.bankTransaction.update({
      where: { id: c.id },
      data: { status: "IGNORED", notes: c.a },
    });
  }
  console.log(`\n✓ ${cambios.length} reclasificados`);
  await prisma.$disconnect();
}

main();
