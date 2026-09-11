// ─────────────────────────────────────────────────────────────────────────────
// Importa la conciliación de depósitos de TERMINAL desde el Excel de caja.
//
// Haltus (CPM2307076Z9) tenía 58 depósitos de terminal sin conciliar por
// $1.68M — un mes. El adquirente deposita un lote y el estado de cuenta sólo
// dice «HOSP HALTUS 09992889D»: sin el desglose, nadie puede decir qué
// facturas cubre. Caja SÍ lo sabe y lo lleva en un Excel; esto lo lee.
//
// CÓMO ESTÁ ARMADO EL ARCHIVO (verificado contra 77 depósitos de agosto 2026):
// cada renglón con COMENTARIO abre un depósito; los renglones siguientes SIN
// comentario son su desglose. La columna «DESGLOSE DE VENTAS TPV» trae la
// porción de cada factura — y cuando viene vacía con una sola factura, el
// depósito ES esa factura completa.
//
// TODO ENTRA POR ConciliacionDetalle, NUNCA por BankTransaction.invoiceId.
// Con `invoiceId` el motor asigna el movimiento COMPLETO a esa factura
// (`repartoMovimiento`), y entonces un pago parcial es inexpresable. Con
// detalles, cada porción lleva su monto: la factura queda parcialmente pagada
// y lo que sobra del depósito cae a ANTICIPOS DE CLIENTES (206.01), que es
// una obligación que envejece a la vista y no un saldo diluido.
//
// Uso:
//   npx tsx scripts/importar-conciliacion-tpv.ts <archivo.xlsx> [--rfc RFC] [--aplicar]
// ─────────────────────────────────────────────────────────────────────────────

import * as XLSX from "xlsx";
import { prisma } from "../src/lib/prisma";
import { checkInvoiceMatchGuard, mergePagosConciliados } from "../src/lib/conciliacion";

const PAT_AFILIACION = /\b(\d{7,})([CD])\b/;
/** Ventana para casar el depósito del Excel con el movimiento del banco. */
const DIAS_VENTANA = 3;

type Linea = { uuid: string; folio: string; monto: number };
type Deposito = { afiliacion: string; fecha: Date; importe: number; lineas: Linea[] };

const r2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Serial de Excel (base 1900) → Date UTC. */
function fechaDeSerial(serial: number): Date {
  return new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
}

function leerDepositos(ruta: string): Deposito[] {
  const libro = XLSX.readFile(ruta);
  const hoja = libro.Sheets[libro.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json<unknown[]>(hoja, { header: 1, blankrows: true, raw: true });

  const col = { fecha: 1, coment: 2, importe: 3, folio: 5, uuid: 6, tpv: 12 };
  const txt = (f: unknown[], i: number) => String(f?.[i] ?? "").trim();
  const num = (f: unknown[], i: number) => {
    const v = f?.[i];
    return typeof v === "number" ? v : Number.isFinite(Number(v)) && String(v).trim() !== "" ? Number(v) : null;
  };

  const deps: Deposito[] = [];
  let abierto: { coment: string; fecha: number | null; importe: number | null; lineas: Array<{ uuid: string; folio: string; tpv: number | null }> } | null = null;

  const cerrar = () => {
    if (!abierto) return;
    const m = PAT_AFILIACION.exec(abierto.coment);
    if (!m || abierto.importe == null || abierto.fecha == null) return;
    const conTpv = abierto.lineas.filter((l) => l.tpv != null && l.uuid);
    // Una sola factura y sin desglose: el depósito es esa factura completa.
    const crudas =
      conTpv.length === 0 && abierto.lineas.length === 1 && abierto.lineas[0].uuid
        ? [{ uuid: abierto.lineas[0].uuid, folio: abierto.lineas[0].folio, monto: abierto.importe }]
        : conTpv.map((l) => ({ uuid: l.uuid, folio: l.folio, monto: r2(l.tpv!) }));

    // El Excel puede repetir una factura dentro del mismo depósito (dos
    // vouchers de la misma cuenta). ConciliacionDetalle es único por
    // (movimiento, factura), así que se suman.
    const porUuid = new Map<string, Linea>();
    for (const l of crudas) {
      const k = l.uuid.toUpperCase();
      const prev = porUuid.get(k);
      if (prev) prev.monto = r2(prev.monto + l.monto);
      else porUuid.set(k, { uuid: k, folio: l.folio, monto: l.monto });
    }
    if (porUuid.size > 0) {
      deps.push({ afiliacion: m[1] + m[2], fecha: fechaDeSerial(abierto.fecha), importe: r2(abierto.importe), lineas: [...porUuid.values()] });
    }
  };

  for (const f of filas) {
    const coment = txt(f, col.coment);
    if (coment) {
      cerrar();
      abierto = { coment, fecha: num(f, col.fecha), importe: num(f, col.importe), lineas: [] };
    }
    if (!abierto) continue;
    const uuid = txt(f, col.uuid);
    if (uuid) abierto.lineas.push({ uuid, folio: txt(f, col.folio), tpv: num(f, col.tpv) });
  }
  cerrar();
  return deps;
}

async function main() {
  const ruta = process.argv[2];
  if (!ruta) throw new Error("uso: importar-conciliacion-tpv.ts <archivo.xlsx> [--rfc RFC] [--aplicar]");
  const aplicar = process.argv.includes("--aplicar");
  const i = process.argv.indexOf("--rfc");
  const rfc = i > 0 ? process.argv[i + 1] : "CPM2307076Z9";

  const empresa = await prisma.company.findFirst({ where: { rfc }, select: { id: true, razonSocial: true } });
  if (!empresa) throw new Error(`empresa ${rfc} no encontrada`);

  const deps = leerDepositos(ruta);
  console.log(`${empresa.razonSocial} (${rfc})`);
  console.log(`${deps.length} depósitos de terminal en el archivo · ${money(deps.reduce((s, d) => s + d.importe, 0))}`);
  console.log(aplicar ? "\nMODO: APLICAR\n" : "\nMODO: dry-run (no escribe nada)\n");

  const movs = await prisma.bankTransaction.findMany({
    where: { companyId: empresa.id, monto: { gt: 0 } },
    select: { id: true, fecha: true, descripcion: true, monto: true, status: true, invoiceId: true, conciliacionDetalles: { select: { id: true } } },
  });

  let listos = 0, yaEstaban = 0, sinMovimiento = 0, rechazados = 0, escritos = 0;
  let montoListo = 0, montoSobrante = 0;

  for (const d of deps) {
    const etiqueta = `${d.afiliacion} ${d.fecha.toISOString().slice(0, 10)} ${money(d.importe).padStart(12)}`;

    const cand = movs.filter(
      (m) =>
        Math.abs(Number(m.monto) - d.importe) < 0.01 &&
        m.descripcion.includes(d.afiliacion) &&
        Math.abs(m.fecha.getTime() - d.fecha.getTime()) <= DIAS_VENTANA * 86400000,
    );
    if (cand.length === 0) { sinMovimiento++; console.log(`  ✗ ${etiqueta}  sin movimiento bancario que empate`); continue; }
    const mov = cand[0];
    if (mov.status === "MATCHED" || mov.conciliacionDetalles.length > 0) { yaEstaban++; continue; }

    // Las facturas, y el guard de cada una con lo que YA tiene aplicado.
    const facturas = await prisma.invoice.findMany({
      where: { companyId: empresa.id, uuid: { in: d.lineas.map((l) => l.uuid) } },
      select: {
        id: true, uuid: true, tipo: true, status: true, metodoPago: true, total: true,
        bankTransactions: { where: { status: "MATCHED" }, select: { id: true, fecha: true, monto: true } },
        conciliacionDetalles: { select: { bankTransactionId: true, montoAsignado: true, bankTransaction: { select: { fecha: true, monto: true } } } },
      },
    });
    const porUuid = new Map(facturas.filter((f) => f.uuid).map((f) => [f.uuid!.toUpperCase(), f]));

    const problemas: string[] = [];
    const asignaciones: Array<{ invoiceId: string; montoAsignado: number }> = [];
    for (const l of d.lineas) {
      const f = porUuid.get(l.uuid.toUpperCase());
      if (!f) { problemas.push(`UUID sin factura: ${l.uuid.slice(0, 8)}`); continue; }
      if (f.status !== "STAMPED") { problemas.push(`${l.folio} no está timbrada (${f.status})`); continue; }
      if (f.tipo !== "INGRESO") { problemas.push(`${l.folio} no es de ingreso (${f.tipo})`); continue; }

      const previos = mergePagosConciliados(
        f.bankTransactions.map((t) => ({ ...t, monto: Number(t.monto) })),
        f.conciliacionDetalles.map((x) => ({
          bankTransactionId: x.bankTransactionId,
          montoAsignado: Number(x.montoAsignado),
          bankTransaction: { fecha: x.bankTransaction.fecha, monto: Number(x.bankTransaction.monto) },
        })),
      );
      const g = checkInvoiceMatchGuard(
        { metodoPago: f.metodoPago, total: Number(f.total) },
        previos,
        { id: mov.id, monto: Number(mov.monto), montoAsignado: l.monto },
      );
      if (!g.ok) { problemas.push(`${l.folio}: ${g.error}`); continue; }
      asignaciones.push({ invoiceId: f.id, montoAsignado: l.monto });
    }

    if (problemas.length > 0 || asignaciones.length === 0) {
      rechazados++;
      console.log(`  ✗ ${etiqueta}`);
      for (const p of problemas.slice(0, 3)) console.log(`      ${p.slice(0, 120)}`);
      continue;
    }

    const asignado = r2(asignaciones.reduce((s, a) => s + a.montoAsignado, 0));
    const sobrante = r2(d.importe - asignado);
    listos++;
    montoListo += asignado;
    montoSobrante += sobrante;
    const nota = sobrante > 0.005 ? `  · sobrante ${money(sobrante)} → anticipo` : "";
    console.log(`  ✓ ${etiqueta}  ${asignaciones.length} factura(s)${nota}`);

    if (aplicar) {
      // Todo-o-nada, igual que la ruta de conciliación múltiple del hub.
      await prisma.$transaction([
        prisma.conciliacionDetalle.createMany({
          data: asignaciones.map((a) => ({ bankTransactionId: mov.id, invoiceId: a.invoiceId, montoAsignado: a.montoAsignado })),
        }),
        prisma.bankTransaction.update({ where: { id: mov.id }, data: { status: "MATCHED", invoiceId: null } }),
      ]);
      escritos++;
    }
  }

  console.log(`\n── resumen ─────────────────────────────`);
  console.log(`  listos para conciliar : ${String(listos).padStart(3)}   ${money(montoListo).padStart(14)}`);
  console.log(`  sobrante a anticipos  :       ${money(montoSobrante).padStart(14)}`);
  console.log(`  ya conciliados        : ${String(yaEstaban).padStart(3)}`);
  console.log(`  sin movimiento        : ${String(sinMovimiento).padStart(3)}`);
  console.log(`  rechazados por guard  : ${String(rechazados).padStart(3)}`);
  if (aplicar) console.log(`  ESCRITOS              : ${String(escritos).padStart(3)}`);
  else console.log(`\n  (dry-run — con --aplicar se escriben)`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
