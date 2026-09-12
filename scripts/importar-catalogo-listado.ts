// ─────────────────────────────────────────────────────────────────────────────
// Importa el «Listado de Cuentas» de la empresa a ChartAccount, con su código
// agrupador del Anexo 24.
//
// POR QUÉ IMPORTA. Mientras el catálogo propio no esté cargado, el motor postea
// a un catálogo INVENTADO —el starter de 106 cuentas que sembramos— y la
// balanza que sale de aquí no se parece a la que la empresa lleva. No es un
// problema de presentación: es que nadie puede cotejar un saldo contra su
// contabilidad, y sin eso el cierre no se puede firmar.
//
// Con el catálogo cargado, `resolverCuentaPropia` (Fase 1) invierte la relación
// y el asiento cae en LA CUENTA DE LA EMPRESA. Lo que quede ambiguo sigue
// cayendo al stub de siempre: adopción gradual, cero big-bang.
//
// Uso:
//   npx tsx scripts/importar-catalogo-listado.ts <archivo.xlsx> --rfc RFC [--aplicar]
// ─────────────────────────────────────────────────────────────────────────────

import * as XLSX from "xlsx";
import { prisma } from "../src/lib/prisma";
import {
  cuentaBancariaEnListado,
  parseListadoCuentas,
  resolverAgrupador,
  type ViaAgrupador,
} from "../src/lib/contabilidad/catalogo-listado";
import { COE_CODES } from "../src/lib/contabilidad/catalog";
import { tipoPorCodAgrup } from "../src/lib/contabilidad/ce-import";
import type { AccountType } from "@prisma/client";

/** Cuando no hay agrupador, el tipo sale de la columna Tipo del listado. */
function tipoPorColumna(naturaleza: "D" | "A", codigo: string): AccountType {
  const mayor = codigo.slice(0, 1);
  if (mayor === "1") return "ACTIVO";
  if (mayor === "2") return "PASIVO";
  if (mayor === "3") return "CAPITAL";
  if (mayor === "4") return "INGRESO";
  if (mayor === "5") return "COSTO";
  if (mayor === "6" || mayor === "7") return "GASTO";
  // Cuentas de orden: el esquema no tiene ese tipo, así que van por naturaleza.
  return naturaleza === "D" ? "ACTIVO" : "PASIVO";
}

async function main() {
  const ruta = process.argv[2];
  const i = process.argv.indexOf("--rfc");
  const rfc = i > 0 ? process.argv[i + 1] : null;
  const aplicar = process.argv.includes("--aplicar");
  if (!ruta || !rfc) throw new Error("uso: importar-catalogo-listado.ts <archivo.xlsx> --rfc RFC [--aplicar]");

  const empresa = await prisma.company.findFirst({ where: { rfc }, select: { id: true, razonSocial: true } });
  if (!empresa) throw new Error(`empresa ${rfc} no encontrada`);

  const libro = XLSX.readFile(ruta);
  const filas = XLSX.utils.sheet_to_json<unknown[]>(libro.Sheets[libro.SheetNames[0]], { header: 1, blankrows: true, raw: true });
  const cuentas = parseListadoCuentas(filas);

  console.log(`${empresa.razonSocial} (${rfc})`);
  console.log(`${cuentas.length} cuentas en el listado`);
  console.log(aplicar ? "\nMODO: APLICAR\n" : "\nMODO: dry-run (no escribe nada)\n");

  const porVia = new Map<ViaAgrupador, number>();
  const sinResolver: string[] = [];
  const resueltas = cuentas.map((c) => {
    const r = resolverAgrupador(c);
    porVia.set(r.via, (porVia.get(r.via) ?? 0) + 1);
    if (!r.codAgrup && sinResolver.length < 40) {
      sinResolver.push(`   ${c.codigo}  ${c.nombre.slice(0, 34).padEnd(36)} «${c.agrupador.slice(0, 40)}» — ${r.via}`);
    }
    return { ...c, ...r };
  });

  console.log("cómo se resolvió el agrupador:");
  for (const [via, n] of [...porVia].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(5)}  ${via}`);
  const conCodigo = resueltas.filter((r) => r.codAgrup).length;
  console.log(`\n   con agrupador: ${conCodigo} de ${cuentas.length} (${((conCodigo / cuentas.length) * 100).toFixed(1)} %)`);
  if (sinResolver.length) {
    console.log("\nsin agrupador (se quedan como están; el contador decide):");
    console.log(sinResolver.join("\n"));
  }

  // ── Escritura ────────────────────────────────────────────────────────────
  // El código propio de la empresa ES la identidad de la cuenta, igual que en
  // la importación de CE: sin punto va entero en `cuentaSAT`.
  let creadas = 0, actualizadas = 0;
  if (aplicar) {
    // Una lectura y escrituras por lote. Fila por fila son 2,340 idas y
    // vueltas a la base: contra Postgres remoto eso no termina, y a media
    // corrida deja el catálogo cargado a medias.
    const existentes = new Map(
      (
        await prisma.chartAccount.findMany({
          where: { companyId: empresa.id, subcuenta: null },
          select: { id: true, cuentaSAT: true, nombre: true, tipo: true, nivel: true, naturaleza: true, codAgrup: true, isActive: true },
        })
      ).map((a) => [a.cuentaSAT, a]),
    );

    const nuevas: Array<{ companyId: string; cuentaSAT: string; subcuenta: null } & Record<string, unknown>> = [];
    const cambios: Array<{ id: string; data: Record<string, unknown> }> = [];
    for (const c of resueltas) {
      const datos = {
        nombre: c.nombre,
        tipo: c.codAgrup ? tipoPorCodAgrup(c.codAgrup) : tipoPorColumna(c.naturaleza, c.codigo),
        nivel: c.nivel,
        naturaleza: c.naturaleza,
        isActive: true,
        // Sin código no se borra el que ya hubiera: un listado incompleto no
        // debe desmapear una cuenta que alguien ya resolvió.
        ...(c.codAgrup ? { codAgrup: c.codAgrup } : {}),
      };
      const prev = existentes.get(c.codigo);
      if (!prev) {
        nuevas.push({ companyId: empresa.id, cuentaSAT: c.codigo, subcuenta: null, ...datos });
        continue;
      }
      // Sólo se escribe lo que de verdad cambia: re-correr no debe tocar filas.
      const distinto = Object.entries(datos).some(([k, v]) => (prev as Record<string, unknown>)[k] !== v);
      if (distinto) cambios.push({ id: prev.id, data: datos });
    }

    for (let i = 0; i < nuevas.length; i += 500) {
      await prisma.chartAccount.createMany({ data: nuevas.slice(i, i + 500) as never, skipDuplicates: true });
    }
    creadas = nuevas.length;
    for (const ch of cambios) {
      await prisma.chartAccount.update({ where: { id: ch.id }, data: ch.data });
      actualizadas++;
    }
    console.log(`\n  ESCRITAS: ${creadas} creadas · ${actualizadas} actualizadas · ${resueltas.length - creadas - actualizadas} sin cambio`);
  }

  // ── Las cuentas bancarias, a la cuenta contable que les toca ──────────────
  // Si `BankAccount.chartAccountId` está vacío, el cierre se INVENTA una
  // subcuenta («102.01.01 Bancos nacionales — BBVA 9012») y el saldo de bancos
  // acaba en una cuenta que su contabilidad no conoce. El listado nombra las
  // suyas con el número dentro, así que se empatan por ahí.
  console.log("\ncuentas bancarias:");
  const bancos = await prisma.bankAccount.findMany({
    where: { companyId: empresa.id },
    select: { id: true, nombre: true, numeroCuenta: true, chartAccountId: true },
  });
  for (const b of bancos) {
    const destino = b.numeroCuenta ? cuentaBancariaEnListado(b.numeroCuenta, resueltas) : null;
    if (!destino) {
      console.log(`   ? ${b.nombre.padEnd(14)} ${String(b.numeroCuenta ?? "—").padEnd(14)} sin cuenta que la nombre — la tiene que elegir una persona`);
      continue;
    }
    const cta = await prisma.chartAccount.findFirst({
      where: { companyId: empresa.id, cuentaSAT: destino.codigo, subcuenta: null },
      select: { id: true },
    });
    if (!cta) { console.log(`   ? ${b.nombre.padEnd(14)} ${destino.codigo} no está en la base todavía`); continue; }
    if (b.chartAccountId === cta.id) { console.log(`   = ${b.nombre.padEnd(14)} ya apunta a ${destino.codigo} ${destino.nombre}`); continue; }
    console.log(`   → ${b.nombre.padEnd(14)} ${String(b.numeroCuenta).padEnd(14)} → ${destino.codigo}  ${destino.nombre}`);
    if (aplicar) await prisma.bankAccount.update({ where: { id: b.id }, data: { chartAccountId: cta.id } });
  }

  // ── Qué va a pasar con las cuentas que el motor usa ───────────────────────
  // Lo único que de verdad importa: de las 42 cuentas del motor, ¿cuántas van a
  // caer en una cuenta de la empresa y cuántas seguirán en el stub?
  console.log("\ncuentas del motor:");
  const cuenta = { unica: 0, ambigua: 0, ninguna: 0 };
  const detalle: string[] = [];
  for (const [nombre, codigo] of Object.entries(COE_CODES)) {
    const cand = resueltas.filter((r) => r.codAgrup === codigo);
    if (cand.length === 1) { cuenta.unica++; continue; }
    if (cand.length === 0) { cuenta.ninguna++; detalle.push(`   ✗ ${codigo.padEnd(7)} ${nombre.padEnd(24)} ninguna cuenta suya lo declara`); continue; }
    cuenta.ambigua++;
    detalle.push(
      `   ⚠ ${codigo.padEnd(7)} ${nombre.padEnd(24)} ${cand.length} candidatas` +
        (cand.length <= 6 ? "\n" + cand.map((c) => `                ${c.codigo}  ${c.nombre}`).join("\n") : ""),
    );
  }
  console.log(`   resuelven solas : ${cuenta.unica}`);
  console.log(`   ambiguas        : ${cuenta.ambigua}   (necesitan que alguien elija, o resolución por contraparte)`);
  console.log(`   sin candidata   : ${cuenta.ninguna}   (siguen posteando al stub, como hoy)`);
  console.log("\n" + detalle.join("\n"));

  if (!aplicar) console.log(`\n  (dry-run — con --aplicar se escribe)`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
