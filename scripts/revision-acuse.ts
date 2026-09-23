/**
 * Revisión de un mes: lo que el contador presentó (el acuse guardado) contra lo
 * que el motor calcula hoy, en los renglones de la forma del SAT. SOLO LECTURA.
 *
 * Del acuse imprime los renglones «ETIQUETA cifra» que importan para cotejar
 * (IVA a cargo/acreditable/otras a favor, ingresos y coeficiente del ISR,
 * pagos provisionales, retenciones, cantidad a pagar), marcando en qué
 * impuesto está cada uno. Del motor, las mismas cifras de computeTaxPosition,
 * con el IVA separado como lo separa la forma: lo retenido el mes anterior va
 * en «otras cantidades a favor», no en «IVA acreditable».
 *
 * Uso:
 *   DATABASE_URL=… npx tsx scripts/revision-acuse.ts --company <RFC> --ejercicio 2026 --mes 8
 */
import { prisma } from "../src/lib/prisma";
import { computeTaxPosition } from "../src/lib/impuestos";
import { textoDePdf } from "../src/lib/fiscal/fuentes/texto";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}
const fmt = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const CLAVE =
  /TOTAL DE IVA A CARGO|TOTAL DE IVA ACREDITABLE|OTRAS CANTIDADES A (FAVOR|CARGO)|SALDO A FAVOR|IMPUESTO A CARGO|CANTIDAD A PAGAR|INGRESOS NOMINALES|TOTAL DE INGRESOS|DESCUENTOS|DEVOLUCIONES|COEFICIENTE|UTILIDAD FISCAL|P[ÉE]RDIDAS? FISCAL|ISR CAUSADO|IMPUESTO CAUSADO|PAGOS PROVISIONALES|ISR RETENIDO|IVA RETENIDO|RETENCIONES/i;
const RENGLON = /^[A-ZÁÉÍÓÚÑ(][A-ZÁÉÍÓÚÑ0-9 ,.%()"«»\-–/]+ -?[\d,.]+$/;
const SECCION: [RegExp, string][] = [
  [/Impuesto al Valor Agregado\. Personas morales/i, "IVA"],
  [/ISR personas morales|Impuesto sobre la renta\. Personas morales/i, "ISR"],
  [/IVA retenciones/i, "IVA RETENCIONES"],
  [/ISR retenciones por salarios/i, "ISR SALARIOS"],
  [/ISR retenciones por asimilados/i, "ISR ASIMILADOS"],
  [/ISR retenciones por servicios profesionales/i, "ISR HONORARIOS"],
  [/ISR retenciones por arrendamiento/i, "ISR ARRENDAMIENTO"],
];

async function main() {
  const rfc = arg("company");
  const year = Number(arg("ejercicio"));
  const month = Number(arg("mes"));
  if (!rfc || !Number.isInteger(year) || !Number.isInteger(month)) {
    console.error("Uso: npx tsx scripts/revision-acuse.ts --company <RFC> --ejercicio <AAAA> --mes <M>");
    process.exit(1);
  }
  const company = await prisma.company.findFirst({ where: { rfc: rfc.toUpperCase() }, select: { id: true, razonSocial: true } });
  if (!company) throw new Error(`Empresa no encontrada: ${rfc}`);
  const periodo = `${year}-${String(month).padStart(2, "0")}`;

  // ── El acuse ───────────────────────────────────────────────────────────
  const decl = await prisma.taxDeclaration.findFirst({
    where: { companyId: company.id, periodo, acusePdf: { not: null } },
    select: { acusePdf: true, acusePdfNombre: true },
  });
  console.log(`${company.razonSocial} (${rfc}) — ${periodo}`);
  if (!decl?.acusePdf) console.log("\n(sin acuse PDF guardado)");
  else {
    const lineas = (await textoDePdf(Buffer.from(decl.acusePdf))).split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const cabecera = lineas.find((l) => /Fecha y hora de presentaci/i.test(l));
    const vence = lineas.find((l) => /Vencimiento Obligaci/i.test(l));
    console.log(`\n── ACUSE (${decl.acusePdfNombre ?? "sin nombre"})${cabecera ? ` · ${cabecera}` : ""}${vence ? ` · ${vence.replace(/.*(Vencimiento)/, "$1")}` : ""}`);
    let seccion = "";
    let ultimo = "";
    for (const l of lineas) {
      const s = SECCION.find(([re]) => re.test(l));
      if (s && s[1] !== seccion) {
        seccion = s[1];
        console.log(`\n   [${seccion}]`);
      }
      if (RENGLON.test(l) && CLAVE.test(l) && l !== ultimo) {
        console.log(`   ${l}`);
        ultimo = l;
      }
    }
  }

  // ── El motor ───────────────────────────────────────────────────────────
  const pos = await computeTaxPosition(company.id, year, month);
  const { iva, isr } = pos;
  console.log(`\n── MOTOR (computeTaxPosition, hoy)`);
  console.log(`   [IVA]  modo PUE ${iva.pue.modo} · proporción ${iva.proporcionAcreditamiento}`);
  console.log(`   IVA trasladado (a cargo)                 ${fmt(iva.trasladado)}`);
  console.log(`   IVA acreditable (renglón de la forma)    ${fmt(iva.acreditable - iva.retenidoMesAnteriorAcreditable)}`);
  console.log(`   Otras cantidades a favor (retenido mes ant.) ${fmt(iva.retenidoMesAnteriorAcreditable)}`);
  console.log(`   Notas de crédito recibidas restadas      ${fmt(iva.notasCreditoRecibidas.iva)}`);
  console.log(`   Saldo a favor anterior aplicado          ${fmt(iva.saldoFavorAplicado)}`);
  console.log(`   IVA a pagar                              ${fmt(iva.pagar)}${iva.saldoAFavor ? ` · saldo a favor ${fmt(iva.saldoAFavor)}` : ""}`);
  console.log(`   IVA retenido a proveedores (a enterar)   ${fmt(iva.retenidoAProveedores)}`);
  console.log(`   [ISR]  método ${isr.metodo}`);
  console.log(`   Ingresos del mes                         ${fmt(isr.ingresosDelMes)}`);
  console.log(`   Ingresos acumulados                      ${fmt(isr.ingresosAcumulados)}`);
  console.log(`   Coeficiente de utilidad                  ${isr.coeficiente ?? "—"} (${isr.coeficienteFuente})`);
  console.log(`   Utilidad fiscal                          ${fmt(isr.utilidadFiscal)}`);
  console.log(`   Pérdida aplicada                         ${fmt(isr.perdidaFiscalAplicada ?? null)}`);
  console.log(`   ISR del ejercicio (causado acumulado)    ${fmt(isr.isrDelEjercicio)}`);
  console.log(`   Pagos provisionales anteriores           ${fmt(isr.isrPagadoAnterior)}`);
  console.log(`   Retenciones acreditadas                  ${fmt(isr.retencionesAcreditadas)}`);
  console.log(`   ISR a pagar                              ${fmt(isr.isrPagar)}`);
  console.log(`   ISR retenido a proveedores (a enterar)   ${fmt(isr.retenidoAProveedoresEnterar)}`);
  if (pos.advertencias?.length) console.log(`   Advertencias: ${pos.advertencias.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" · ")}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
