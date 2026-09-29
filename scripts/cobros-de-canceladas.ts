/**
 * Cobros y pagos bancarios que siguen CONCILIADOS contra facturas CANCELADAS.
 * SOLO LECTURA.
 *
 * El estado de cuenta de clientes y proveedores ya excluye las facturas
 * canceladas (status STAMPED / not CANCELLED). Pero cancelar sólo cambia
 * `Invoice.status`: el movimiento bancario queda MATCHED contra la factura
 * muerta, y como el estado de cuenta trae los cobros POR FACTURA, ese dinero
 * desaparece del estado de cuenta — el cliente pagó y su saldo no lo refleja,
 * y el depósito tampoco vuelve a la mesa para ligarse a la factura que la
 * sustituyó. Esto mide cuánto hay y, cuando existe, cuál es la sustituta.
 *
 * Uso:
 *   DATABASE_URL=… npx tsx scripts/cobros-de-canceladas.ts [--company <RFC>] [--top 20]
 */
import { prisma } from "../src/lib/prisma";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}
const fmt = (n: number) => n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const rfc = arg("company")?.toUpperCase() ?? null;
  const top = Number(arg("top") ?? 20);
  const company = rfc ? await prisma.company.findFirst({ where: { rfc }, select: { id: true } }) : null;
  if (rfc && !company) throw new Error(`Empresa no encontrada: ${rfc}`);
  const porEmpresa = company ? { companyId: company.id } : {};

  const [directos, detalles] = await Promise.all([
    prisma.bankTransaction.findMany({
      where: { ...porEmpresa, status: "MATCHED", invoice: { status: "CANCELLED" } },
      select: {
        id: true, fecha: true, monto: true, descripcion: true, companyId: true,
        invoice: { select: { id: true, uuid: true, fecha: true, total: true, tipo: true, canceladaAt: true, customer: { select: { rfc: true, razonSocial: true } } } },
      },
    }),
    prisma.conciliacionDetalle.findMany({
      where: { invoice: { status: "CANCELLED", ...porEmpresa }, bankTransaction: { status: "MATCHED", invoiceId: null } },
      select: {
        montoAsignado: true,
        bankTransaction: { select: { id: true, fecha: true, monto: true, descripcion: true, companyId: true } },
        invoice: { select: { id: true, uuid: true, fecha: true, total: true, tipo: true, canceladaAt: true, customer: { select: { rfc: true, razonSocial: true } } } },
      },
    }),
  ]);

  type Fila = { companyId: string; monto: number; txFecha: Date; desc: string; inv: (typeof directos)[number]["invoice"] & object };
  const filas: Fila[] = [
    ...directos.filter((d) => d.invoice).map((d) => ({ companyId: d.companyId, monto: Math.abs(Number(d.monto)), txFecha: d.fecha, desc: d.descripcion, inv: d.invoice! })),
    ...detalles.map((d) => ({ companyId: d.bankTransaction.companyId, monto: Math.abs(Number(d.montoAsignado)), txFecha: d.bankTransaction.fecha, desc: d.bankTransaction.descripcion, inv: d.invoice })),
  ];

  // ¿La cancelada tiene sustituta (TipoRelacion 04 apuntando a ella)?
  const uuids = [...new Set(filas.map((f) => f.inv.uuid).filter((u): u is string => !!u))];
  const sustitutas = uuids.length
    ? await prisma.invoice.findMany({
        where: { status: "STAMPED", tipoRelacion: "04", cfdiRelacionadoUuid: { in: uuids, mode: "insensitive" } },
        select: { uuid: true, cfdiRelacionadoUuid: true, total: true },
      })
    : [];
  const sustitutaDe = new Map(sustitutas.map((s) => [(s.cfdiRelacionadoUuid ?? "").toUpperCase(), s]));

  const empresas = await prisma.company.findMany({ where: { id: { in: [...new Set(filas.map((f) => f.companyId))] } }, select: { id: true, rfc: true, razonSocial: true } });
  const nombre = new Map(empresas.map((e) => [e.id, `${e.rfc} ${e.razonSocial.slice(0, 40)}`]));

  console.log(`Movimientos bancarios conciliados contra facturas CANCELADAS: ${filas.length} por ${fmt(filas.reduce((s, f) => s + f.monto, 0))}`);
  console.log(`  con sustituta (04) a la que deberían pasar: ${filas.filter((f) => f.inv.uuid && sustitutaDe.has(f.inv.uuid.toUpperCase())).length}`);

  const grupos = new Map<string, Fila[]>();
  for (const f of filas) grupos.set(f.companyId, [...(grupos.get(f.companyId) ?? []), f]);
  for (const [cid, fs] of [...grupos].sort((a, b) => b[1].reduce((s, f) => s + f.monto, 0) - a[1].reduce((s, f) => s + f.monto, 0))) {
    const cobros = fs.filter((f) => f.inv.tipo === "INGRESO");
    const pagos = fs.filter((f) => f.inv.tipo === "EGRESO");
    console.log(`\n── ${nombre.get(cid)}: cobros ${cobros.length} por ${fmt(cobros.reduce((s, f) => s + f.monto, 0))} · pagos ${pagos.length} por ${fmt(pagos.reduce((s, f) => s + f.monto, 0))}`);
    for (const f of [...fs].sort((a, b) => b.monto - a.monto).slice(0, top)) {
      const sust = f.inv.uuid ? sustitutaDe.get(f.inv.uuid.toUpperCase()) : undefined;
      console.log(
        `   ${fmt(f.monto).padStart(12)}  mov ${f.txFecha.toISOString().slice(0, 10)} · ${f.inv.tipo === "INGRESO" ? "cobro" : "pago"} de ${(f.inv.uuid ?? "").slice(0, 8)} ` +
          `(${f.inv.fecha.toISOString().slice(0, 10)}, ${f.inv.customer?.rfc ?? "?"}) cancelada ${f.inv.canceladaAt?.toISOString().slice(0, 10) ?? "?"}` +
          `${sust ? ` → sustituta ${(sust.uuid ?? "").slice(0, 8)}` : " · sin sustituta"}`,
      );
    }
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
