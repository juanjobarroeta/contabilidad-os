/**
 * ¿Los abonos etiquetados como «traspaso entre cuentas propias» lo son? SOLO LECTURA.
 *
 * Un traspaso propio no es ingreso; si la etiqueta está mal, un cobro (un
 * paciente, un cliente) se sale del ISR y del IVA sin que nadie lo vea. Para
 * cada abono etiquetado TRASPASO / INTERNAL_TRANSFER del mes busca evidencia de
 * que el dinero salió de otra cuenta de la MISMA empresa:
 *   1. un cargo espejo (mismo monto, ±3 días) en otra cuenta de la empresa;
 *   2. la CLABE o el número de cuenta de origen es de una cuenta registrada;
 *   3. el nombre de la contraparte es la propia razón social;
 *   4. la descripción dice «cuentas propias».
 * Sin ninguna, el abono queda como SOSPECHOSO, con la cuenta de origen que
 * traiga la descripción para preguntarle al cliente.
 *
 * Uso:
 *   DATABASE_URL=… npx tsx scripts/revisar-traspasos.ts --company <RFC> --ejercicio 2026 --mes 8
 */
import { prisma } from "../src/lib/prisma";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}
const fmt = (n: number) => n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const DIA = 86_400_000;
const soloDigitos = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

async function main() {
  const rfc = arg("company");
  const year = Number(arg("ejercicio"));
  const month = Number(arg("mes"));
  if (!rfc || !Number.isInteger(year) || !Number.isInteger(month)) {
    console.error("Uso: npx tsx scripts/revisar-traspasos.ts --company <RFC> --ejercicio <AAAA> --mes <M>");
    process.exit(1);
  }
  const company = await prisma.company.findFirst({ where: { rfc: rfc.toUpperCase() }, select: { id: true, razonSocial: true } });
  if (!company) throw new Error(`Empresa no encontrada: ${rfc}`);
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));

  const cuentas = await prisma.bankAccount.findMany({
    where: { companyId: company.id },
    select: { id: true, banco: true, numeroCuenta: true, clabe: true },
  });
  const propias = new Set(cuentas.flatMap((c) => [soloDigitos(c.numeroCuenta), soloDigitos(c.clabe)]).filter((d) => d.length >= 6));
  const esPropia = (d: string) => d.length >= 6 && [...propias].some((p) => p === d || p.endsWith(d) || d.endsWith(p));
  // Cuentas de los EMPLEADOS: un «traspaso» desde la cuenta de nómina de un
  // empleado no es traspaso propio, es una devolución (anticipo, préstamo,
  // nómina pagada de más) — tampoco es ingreso, pero va a otra cuenta.
  const empleados = await prisma.employee.findMany({
    where: { companyId: company.id, clabe: { not: null } },
    select: { nombre: true, clabe: true },
  });
  const empleadoDe = (d: string) =>
    d.length >= 6 ? empleados.find((e) => { const c = soloDigitos(e.clabe); return c === d || c.includes(d); }) : undefined;
  const nombreEmpresa = norm(company.razonSocial).split(" ").slice(0, 3).join(" ");
  const etiqueta = (id: string) => {
    const c = cuentas.find((x) => x.id === id);
    return c ? `${c.banco} ·${soloDigitos(c.numeroCuenta).slice(-4)}` : "?";
  };

  const abonos = await prisma.bankTransaction.findMany({
    where: { companyId: company.id, fecha: { gte: from, lt: to }, monto: { gt: 0 }, notes: { in: ["TRASPASO", "INTERNAL_TRANSFER"] } },
    select: { id: true, fecha: true, monto: true, descripcion: true, bankAccountId: true, contraparteNombre: true, contraparteClabe: true, status: true },
    orderBy: { fecha: "asc" },
  });
  // Cargos de TODAS las cuentas de la empresa alrededor del mes, para el espejo.
  const cargos = await prisma.bankTransaction.findMany({
    where: { companyId: company.id, fecha: { gte: new Date(from.getTime() - 4 * DIA), lt: new Date(to.getTime() + 4 * DIA) }, monto: { lt: 0 } },
    select: { id: true, fecha: true, monto: true, bankAccountId: true, descripcion: true },
  });
  const usados = new Set<string>();

  const ok: string[] = [];
  const sospechosos: { monto: number; linea: string }[] = [];
  for (const a of abonos) {
    const monto = Number(a.monto);
    const razones: string[] = [];
    const espejo = cargos.find(
      (c) => !usados.has(c.id) && c.bankAccountId !== a.bankAccountId && Math.abs(Math.abs(Number(c.monto)) - monto) < 0.01 && Math.abs(c.fecha.getTime() - a.fecha.getTime()) <= 3 * DIA,
    );
    if (espejo) {
      usados.add(espejo.id);
      razones.push(`cargo espejo en ${etiqueta(espejo.bankAccountId)} el ${espejo.fecha.toISOString().slice(0, 10)}`);
    }
    const origenDesc = [...a.descripcion.matchAll(/(?:CUENTA|CTA)\s*:?\s*(\d{6,18})/gi)].map((m) => m[1]);
    const origen = [soloDigitos(a.contraparteClabe), ...origenDesc].filter((d) => d.length >= 6);
    if (origen.some(esPropia)) razones.push("cuenta de origen registrada");
    if (a.contraparteNombre && norm(a.contraparteNombre).startsWith(nombreEmpresa)) razones.push("contraparte = la empresa");
    if (/CUENTAS PROPIAS/i.test(a.descripcion)) razones.push("«cuentas propias» en la descripción");

    const linea = `${fmt(monto).padStart(12)}  ${a.fecha.toISOString().slice(0, 10)} ${etiqueta(a.bankAccountId).padEnd(14)} ${(a.contraparteNombre ?? "").slice(0, 28).padEnd(28)} ${a.descripcion.replace(/\s+/g, " ").slice(0, 80)}`;
    if (razones.length) ok.push(`${linea}\n                ✓ ${razones.join(" · ")}`);
    else {
      const emp = origen.map(empleadoDe).find(Boolean);
      const nota = emp
        ? `\n                origen: ${origen.join(", ")} — cuenta de nómina de ${emp.nombre}: devolución de empleado, no traspaso propio`
        : origen.length ? `\n                origen: ${origen.join(", ")} — no es cuenta de la empresa ni de un empleado registrado` : "\n                sin cuenta de origen: identificar quién depositó";
      sospechosos.push({ monto, linea: `${linea}${nota}` });
    }
  }

  console.log(`${company.razonSocial} (${rfc}) — ${year}-${String(month).padStart(2, "0")}`);
  console.log(`Cuentas registradas: ${cuentas.map((c) => `${c.banco} ${c.numeroCuenta}${c.clabe ? ` / ${c.clabe}` : ""}`).join(" · ")}`);
  console.log(`\n── SOSPECHOSOS: etiquetados como traspaso propio sin evidencia (${sospechosos.length}, ${fmt(sospechosos.reduce((s, x) => s + x.monto, 0))})`);
  for (const s of sospechosos.sort((a, b) => b.monto - a.monto)) console.log(s.linea);
  console.log(`\n── Con evidencia de traspaso propio (${ok.length}, ${fmt(abonos.reduce((s, a) => s + Number(a.monto), 0) - sospechosos.reduce((s, x) => s + x.monto, 0))})`);
  for (const l of ok) console.log(l);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
