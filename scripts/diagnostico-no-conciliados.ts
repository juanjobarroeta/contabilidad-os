// ¿Por qué NO concilió cada movimiento pendiente? Diagnóstico de sólo lectura.
//
// «Sin conciliar» y «no conciliable» no son lo mismo, y la diferencia decide en
// qué vale la pena trabajar. Este script repite EXACTAMENTE la búsqueda del
// motor (misma ventana, misma tolerancia, mismo scorer) sin escribir nada, y
// clasifica cada pendiente por la razón real:
//
//   SIN_CANDIDATOS  no existe CFDI con ese importe en ±14 días. Ninguna mejora
//                   al motor lo concilia: o la factura no está en el sistema, o
//                   el movimiento no tiene factura (comisiones, traspasos).
//   AMBIGUO         hay empate: varios candidatos a menos de 20 puntos. Falta
//                   IDENTIDAD para desempatar (RFC, CLABE, nombre).
//   BAJO_PUNTAJE    hay un candidato claro pero no llega a 130. Casi siempre es
//                   monto+fecha sin identidad ninguna.
//
// Uso: npx tsx scripts/diagnostico-no-conciliados.ts <companyId> [desde] [hasta]
import { prisma } from "../src/lib/prisma";
import {
  AUTO_MATCH_MIN_SCORE,
  AUTO_MATCH_AMBIGUITY_GAP,
  clabesConocidasPorRfc,
  scoreCandidate,
} from "../src/lib/bancos/auto-conciliar";

const WINDOW_DAYS = 14;
const TOLERANCE = 0.01;

const fmt = (n: number) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });

type Razon = "SIN_CANDIDATOS" | "AMBIGUO" | "BAJO_PUNTAJE" | "APLICABLE";

async function main() {
  const companyId = process.argv[2];
  const desde = new Date(process.argv[3] ?? "2026-08-01");
  const hasta = new Date(process.argv[4] ?? "2026-09-01");
  if (!companyId) {
    console.error("Uso: npx tsx scripts/diagnostico-no-conciliados.ts <companyId> [desde] [hasta]");
    process.exit(1);
  }

  const pendientes = (
    await prisma.bankTransaction.findMany({
      where: { companyId, status: "UNMATCHED", fecha: { gte: desde, lt: hasta } },
      orderBy: { fecha: "asc" },
    })
  ).map((t) => ({ ...t, monto: Number(t.monto) }));

  const conteo: Record<Razon, number> = { SIN_CANDIDATOS: 0, AMBIGUO: 0, BAJO_PUNTAJE: 0, APLICABLE: 0 };
  const montos: Record<Razon, number> = { SIN_CANDIDATOS: 0, AMBIGUO: 0, BAJO_PUNTAJE: 0, APLICABLE: 0 };
  const detalle: Array<{ razon: Razon; linea: string }> = [];
  // De los que ni siquiera tienen candidato, ¿cuántos traen identidad? Es la
  // señal de si el problema es «falta la factura» o «falta el dato».
  let sinIdentidad = 0;
  let sinCandidatoConIdentidad = 0;

  for (const tx of pendientes) {
    const absAmount = Math.abs(tx.monto);
    const isCredit = tx.monto > 0;
    const tipos: ("INGRESO" | "EGRESO" | "NOMINA")[] = isCredit ? ["INGRESO"] : ["EGRESO", "NOMINA"];
    const hayIdentidad = !!(tx.contraparteRfc || tx.contraparteClabe || tx.contraparteNombre);
    if (!hayIdentidad) sinIdentidad++;

    const candidates = await prisma.invoice.findMany({
      where: {
        companyId,
        tipo: { in: tipos },
        status: "STAMPED",
        fecha: {
          gte: new Date(tx.fecha.getTime() - WINDOW_DAYS * 86400000),
          lte: new Date(tx.fecha.getTime() + WINDOW_DAYS * 86400000),
        },
        total: { gte: absAmount * (1 - TOLERANCE), lte: absAmount * (1 + TOLERANCE) },
        bankTransactions: { none: { status: "MATCHED" } },
        conciliacionDetalles: { none: {} },
      },
      include: { customer: { select: { rfc: true, razonSocial: true } } },
    });

    let razon: Razon;
    let nota = "";
    if (candidates.length === 0) {
      razon = "SIN_CANDIDATOS";
      if (hayIdentidad) sinCandidatoConIdentidad++;
    } else {
      const clabesPorRfc = tx.contraparteClabe
        ? await clabesConocidasPorRfc(companyId, tx.contraparteClabe)
        : new Set<string>();
      const senales = {
        fecha: tx.fecha,
        descripcion: tx.descripcion,
        contraparteRfc: tx.contraparteRfc,
        contraparteNombre: tx.contraparteNombre,
        contraparteClabe: tx.contraparteClabe,
      };
      const scored = candidates
        .map((inv) => {
          const rfcF = inv.customer?.rfc ?? inv.contraparteRfc ?? null;
          const nomF = inv.customer?.razonSocial ?? inv.contraparteNombre ?? null;
          return scoreCandidate(
            {
              total: Number(inv.total),
              fecha: inv.fecha,
              customerRfc: rfcF,
              customerNombre: nomF,
              serie: inv.serie,
              folio: inv.folio,
              clabesConocidas:
                rfcF && clabesPorRfc.has(rfcF) && tx.contraparteClabe ? [tx.contraparteClabe] : [],
            },
            senales,
            absAmount,
          );
        })
        .sort((a, b) => b - a);
      const best = scored[0];
      const second = scored[1] ?? null;
      if (best < AUTO_MATCH_MIN_SCORE) {
        razon = "BAJO_PUNTAJE";
        nota = `mejor=${best} (umbral ${AUTO_MATCH_MIN_SCORE}), candidatos=${candidates.length}`;
      } else if (second !== null && best - second < AUTO_MATCH_AMBIGUITY_GAP) {
        razon = "AMBIGUO";
        nota = `mejor=${best} segundo=${second}, candidatos=${candidates.length}`;
      } else {
        razon = "APLICABLE";
        nota = `mejor=${best} — DEBERÍA haber conciliado`;
      }
    }

    conteo[razon]++;
    montos[razon] += absAmount;
    detalle.push({
      razon,
      linea:
        `  ${tx.fecha.toISOString().slice(0, 10)} ${fmt(tx.monto).padStart(14)}  ` +
        `${(tx.contraparteNombre ?? "—").slice(0, 32).padEnd(32)} ${tx.descripcion.slice(0, 40).padEnd(40)} ${nota}`,
    });
  }

  const total = pendientes.length;
  console.log(`\nPendientes en el periodo: ${total}\n`);
  for (const r of ["APLICABLE", "AMBIGUO", "BAJO_PUNTAJE", "SIN_CANDIDATOS"] as Razon[]) {
    const pct = total ? Math.round((conteo[r] / total) * 100) : 0;
    console.log(`${r.padEnd(16)} ${String(conteo[r]).padStart(4)}  (${String(pct).padStart(3)}%)  ${fmt(montos[r])}`);
  }
  console.log(
    `\nsin identidad ninguna (ni RFC ni CLABE ni nombre): ${sinIdentidad}` +
      `\nsin candidato PERO con identidad: ${sinCandidatoConIdentidad}  ← la factura no está, no es culpa del motor\n`,
  );

  for (const r of ["APLICABLE", "AMBIGUO", "BAJO_PUNTAJE"] as Razon[]) {
    const filas = detalle.filter((d) => d.razon === r);
    if (!filas.length) continue;
    console.log(`── ${r} (${filas.length}) ──`);
    for (const f of filas.slice(0, 30)) console.log(f.linea);
    if (filas.length > 30) console.log(`  … y ${filas.length - 30} más`);
    console.log("");
  }

  await prisma.$disconnect();
}

main();
