/**
 * Seed GASTOS SEMANA 1 (13-18 abril 2026) as a proper
 * ReembolsoSemanal with all 11 line items pre-categorized per the
 * mapping table reviewed with Juan.
 *
 * Source: /Users/juanjosebarroeta/Downloads/GASTOS SEMANA 1.pdf
 * Total a reembolsar a Rosy (según PDF): $95,993.66
 *   - Gastos material + indirectos: $64,293.66
 *   - Nómina semanal (7 personas):  $31,700.00
 *   + Caja a justificar siguiente:  $5,000.00 (no es gasto de esta semana)
 *
 * v1 treats nómina as a single indirecto row (NOMINA categoría).
 * Phase A-5 will split it into per-worker Rayas once we enable
 * CONSTRUCCION_CUADRILLAS on Bartiz.
 *
 * Cleanup: the stray "Gastos semana 1 (caja chica)" $3,200 placeholder
 * seeded earlier (before Reembolsos existed) gets deleted to avoid
 * double-counting.
 *
 * Idempotent: re-runs upsert the ReembolsoSemanal by (proyectoId,
 * semanaInicio). Existing gastos linked to this reembolso are re-
 * linked and re-attributed; new ones created.
 *
 * Usage:
 *   cd /Users/juanjosebarroeta/Documents/contabilidad-os
 *   set -a; . ./.env.local; set +a
 *   node scripts/seed-gastos-semana-1.mjs
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const BARTIZ_RFC = "CBA170606FQ8";
const PROYECTO_CODIGO = "OBR-HACIENDA-OVINOS";
const SEMANA_INICIO = new Date("2026-04-13T00:00:00");
const SEMANA_FIN = new Date("2026-04-18T23:59:59");

// 11 line items from the PDF. Maps the "CONCEPTO → CATEGORIA" discussion.
// puCatalogo is the Insumo.costoActual at seed time — we don't hardcode
// it, we look up from DB so the variance highlight works.
const LINES = [
  // 🟢 DIRECTO — linked to insumo
  {
    beneficiario: "Clara Hernández Gómez (espacios e ideas)",
    descripcion: "Impermeabilizante Sika — Sikatop Seal 107 (6 cubetas)",
    importe: 10308.66,
    cantidad: 6,
    unidad: "CUBETA",
    insumoCodigo: "CEMFLEX",
  },
  {
    beneficiario: "Materiales López",
    descripcion: "Arena (1 viaje ≈ 7 m³) + Cemento Tolteca 25kg",
    importe: 5500, // $2,500 cemento + $3,000 arena combinados; lo separaríamos idealmente
    cantidad: 7,
    unidad: "m3",
    insumoCodigo: "301-ARE-0101", // ARENA DE MINA — cemento no existe en catálogo, queda agregado
    notas: "Ticket combinado López: 1/2 ton cemento Tolteca + 1 viaje de arena. Cemento falta en catálogo — retro-imputar cuando exista CEM001.",
  },
  // ⚫ INDIRECTO — overhead with categoría
  {
    beneficiario: "Man Andamios",
    descripcion: "Renta andamios x 2 meses (4 pzas)",
    importe: 9600,
    indirecto: true,
    categoria: "RENTA_EQUIPO",
  },
  {
    beneficiario: "Iván Barrena Montez",
    descripcion: "Traslado camión 7m³ centro — bodega bomberos → hacienda (polines, andamios, herramienta)",
    importe: 17000,
    indirecto: true,
    categoria: "FLETE_TRANSPORTE",
  },
  {
    beneficiario: "Pemex / Combustibles",
    descripcion: "Gasolina Premium (varios tickets 14-16 abril)",
    importe: 2500,
    indirecto: true,
    categoria: "GASOLINA",
  },
  {
    beneficiario: "Proveedor varios (nota de remisión BV)",
    descripcion: "Equipo de seguridad — cascos, chalecos, botas",
    importe: 1990,
    indirecto: true,
    categoria: "EQUIPO_SEGURIDAD",
  },
  {
    beneficiario: "Construrama / Ferroelectrico La Diagonal / Abarrotes",
    descripcion: "Herramienta menor — martillo, cincel, manguera nivel, cepillos, guantes, cepillo klinte, llana truper, clavos",
    importe: 2454,
    indirecto: true,
    categoria: "HERRAMIENTA_MENOR",
  },
  {
    beneficiario: "Abarrotes Punto de Venta",
    descripcion: "Malla gallinero para rebóco",
    importe: 491,
    indirecto: true,
    categoria: "OTROS",
    notas: "Debería ser DIRECTO cuando exista insumo MALLAGN; por ahora indirecto.",
  },
  {
    beneficiario: "Varios (Jose Luis Nativitas + cuadrilla)",
    descripcion: "Viáticos semana 13-17 abril (hoteles, alimentos, transporte)",
    importe: 9450,
    indirecto: true,
    categoria: "VIATICOS",
  },
  // 🔵 NÓMINA — treated as a single INDIRECTO NOMINA line for v1.
  // v2 (Phase A-5) will split this into a RayaSemanal with 7 miembros.
  {
    beneficiario: "Nómina semanal 13-18 abril (7 trabajadores)",
    descripcion: "Sueldos + viáticos: Serafín Luna $6,550 · Daniel Cote $7,000 · Jose Luis Nativitas $7,000 · Bryan Martínez $5,000 · Julieta Santiago $2,500 · Demetrio Enríquez $5,000 · Hernán Ochoa $3,000 (total = $36,050 per recibos individuales; concentrado PDF marca $31,700 sueldo base)",
    importe: 31700,
    indirecto: true,
    categoria: "NOMINA",
    notas: "v1 como indirecto total. v2 (Phase A-5) desglosar a 7 Rayas con miembros individuales.",
  },
];

async function main() {
  console.log("\n═══ Seed GASTOS SEMANA 1 como Reembolso ═══\n");

  const company = await prisma.company.findUnique({
    where: { rfc: BARTIZ_RFC },
    select: { id: true, razonSocial: true },
  });
  if (!company) throw new Error("Bartiz not found");

  const proyecto = await prisma.proyecto.findFirst({
    where: { companyId: company.id, codigo: PROYECTO_CODIGO },
    select: { id: true, codigo: true, nombre: true },
  });
  if (!proyecto) throw new Error(`Proyecto ${PROYECTO_CODIGO} not found`);
  console.log(`✓ Proyecto: ${proyecto.codigo}`);

  const cheques = await prisma.bankAccount.findFirst({
    where: { companyId: company.id, tipo: "CHEQUES" },
    select: { id: true, nombre: true },
  });
  if (!cheques) throw new Error("No CHEQUES account on Bartiz");
  console.log(`✓ CHEQUES: ${cheques.nombre}`);

  const caja = await prisma.bankAccount.findFirst({
    where: { companyId: company.id, tipo: "CAJA" },
    select: { id: true, nombre: true, titular: true },
  });
  if (!caja) throw new Error("No CAJA account on Bartiz");
  console.log(`✓ CAJA: ${caja.nombre} (${caja.titular})`);

  // ── 1. Delete stray placeholder gasto from prior seed ────────────
  const stale = await prisma.gasto.findMany({
    where: {
      companyId: company.id,
      beneficiarioNombre: { contains: "Gastos semana 1", mode: "insensitive" },
      estado: "PENDIENTE",
      reembolsoId: null,
    },
    select: { id: true, importe: true },
  });
  for (const s of stale) {
    await prisma.gasto.delete({ where: { id: s.id } });
    console.log(`  🧹 Deleted stale placeholder gasto $${s.importe}`);
  }

  // ── 2. Upsert Reembolso header (by proyectoId + semanaInicio unique) ─
  let reembolso = await prisma.reembolsoSemanal.findFirst({
    where: { proyectoId: proyecto.id, semanaInicio: SEMANA_INICIO },
    select: { id: true, estado: true },
  });

  if (!reembolso) {
    reembolso = await prisma.reembolsoSemanal.create({
      data: {
        companyId: company.id,
        proyectoId: proyecto.id,
        bankAccountId: cheques.id,
        semanaInicio: SEMANA_INICIO,
        semanaFin: SEMANA_FIN,
        anticipoAplicado: 0, // ajustar según adelanto caja chica real
        notas: "Seed de GASTOS SEMANA 1 (13-18 abril). Ver PDF fuente. Desglose nómina a Rayas pendiente v2.",
      },
    });
    console.log(`✓ Created reembolso ${reembolso.id}`);
  } else {
    console.log(`✓ Reembolso already exists (${reembolso.estado}); will re-seed lines.`);
    if (reembolso.estado === "REEMBOLSADO") {
      console.warn(`  ⚠ Reembolso is REEMBOLSADO — not touching gastos. Delete manually to re-seed.`);
      await prisma.$disconnect();
      process.exit(0);
    }
    // Clear any existing gastos to avoid duplication (they'll be regenerated)
    const deleted = await prisma.gasto.deleteMany({
      where: { reembolsoId: reembolso.id, estado: "PENDIENTE" },
    });
    if (deleted.count > 0) console.log(`  🧹 Cleared ${deleted.count} existing pending gastos`);
  }

  // ── 3. Resolve insumos for directo lines ─────────────────────────
  const insumoByCodigo = new Map();
  for (const line of LINES) {
    if (!line.insumoCodigo || insumoByCodigo.has(line.insumoCodigo)) continue;
    const i = await prisma.insumo.findFirst({
      where: { companyId: company.id, codigo: line.insumoCodigo },
      select: { id: true, codigo: true, descripcion: true, costoActual: true, unidad: true },
    });
    if (!i) console.warn(`  ⚠ Insumo ${line.insumoCodigo} not found; line will be skipped`);
    else insumoByCodigo.set(line.insumoCodigo, i);
  }

  // ── 4. Create each line as a Gasto ────────────────────────────────
  let totalGastos = 0;
  let created = 0;
  for (const line of LINES) {
    const isDirecto = !!line.insumoCodigo;
    const insumo = isDirecto ? insumoByCodigo.get(line.insumoCodigo) : null;
    if (isDirecto && !insumo) continue;

    await prisma.gasto.create({
      data: {
        companyId: company.id,
        proyectoId: proyecto.id,
        bankAccountId: caja.id, // la mayoría vinieron de caja chica de Rosy
        reembolsoId: reembolso.id,
        beneficiarioNombre: line.beneficiario,
        descripcion: line.descripcion,
        importe: line.importe,
        cantidad: line.cantidad ?? null,
        unidad: line.unidad ?? null,
        insumoId: insumo?.id ?? null,
        indirecto: line.indirecto === true,
        categoriaIndirecto: line.indirecto ? line.categoria : null,
        notas: line.notas ?? null,
        caja: true, // todos salieron de caja chica (Rosy lo pagó en efectivo)
      },
    });
    totalGastos += line.importe;
    created++;

    const badge = isDirecto
      ? `🟢 ${insumo.codigo} (catálogo $${insumo.costoActual.toFixed(2)}/${insumo.unidad})`
      : `⚫ ${line.categoria}`;
    console.log(`  ✓ $${line.importe.toFixed(0).padStart(7)} ${badge.padEnd(45)} ${line.beneficiario.slice(0, 30)}`);
  }

  // ── 5. Refresh totals ─────────────────────────────────────────────
  const agg = await prisma.gasto.aggregate({
    where: { reembolsoId: reembolso.id, estado: { not: "RECHAZADO" } },
    _sum: { importe: true },
  });
  const tg = Math.round((agg._sum.importe ?? 0) * 100) / 100;
  await prisma.reembolsoSemanal.update({
    where: { id: reembolso.id },
    data: { totalGastos: tg, totalReembolso: tg }, // anticipo=0 por ahora
  });

  console.log(`\n─── Summary ────────────────────────`);
  console.log(`  Reembolso:      ${reembolso.id}`);
  console.log(`  Líneas:         ${created}`);
  console.log(`  Total gastos:   $${tg.toLocaleString("es-MX")}`);
  console.log(`  PDF dice:       $95,993.66 (incluye nómina $31,700)`);
  console.log(`  Difference:     $${(95993.66 - tg).toFixed(2)} ${Math.abs(95993.66 - tg) < 1 ? "✓" : "(check)"}`);
  console.log();
  console.log(`Katia: abre bartiz.vercel.app → Reembolsos → fila de esta semana`);
  console.log(`       para revisar línea por línea y luego "Reembolsar" a Rosy.`);
  console.log();
}

main()
  .catch((e) => { console.error("❌", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
