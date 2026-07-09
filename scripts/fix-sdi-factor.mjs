/**
 * Repara el SDI/SBC de empleados calculado con el factor de integración
 * PRE-reforma (1.0452, vacaciones de 6 días) en vez del vigente desde la
 * reforma de vacaciones 2023 (año 1 = 12 días → 1.0493).
 *
 * Usage:
 *   set -a; . ./.env.local; set +a
 *   node scripts/fix-sdi-factor.mjs            # dry-run: lista lo que cambiaría
 *   node scripts/fix-sdi-factor.mjs --apply    # aplica los cambios
 *   node scripts/fix-sdi-factor.mjs --company <rfcEmpresa> [--apply]
 *
 * SÓLO toca empleados cuyo SDI guardado coincide (±1 centavo) con
 * salarioDiario × 1.0452 — la huella exacta del default con el bug. Un SDI
 * capturado a mano o traído del recibo (SalarioBaseCotApor) no coincide con
 * esa huella y NO se toca. El nuevo SDI se calcula con el factor real por
 * antigüedad (calcularFactorIntegracion: años cumplidos + 1 → días de
 * vacaciones de la tabla reformada). No crea ImssMovimiento: es corrección de
 * dato, no un cambio salarial real (mismo criterio que skipImssMovimiento).
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const FACTOR_VIEJO = 1.0452;

// Tabla Art. 76 LFT (reforma 2023) — espejo de src/lib/nomina/constants.ts.
const TABLA_VACACIONES = [
  { min: 1, max: 1, dias: 12 },
  { min: 2, max: 2, dias: 14 },
  { min: 3, max: 3, dias: 16 },
  { min: 4, max: 4, dias: 18 },
  { min: 5, max: 5, dias: 20 },
  { min: 6, max: 10, dias: 22 },
  { min: 11, max: 15, dias: 24 },
  { min: 16, max: 20, dias: 26 },
  { min: 21, max: 25, dias: 28 },
  { min: 26, max: 30, dias: 30 },
  { min: 31, max: 35, dias: 32 },
];

function diasVacaciones(anios) {
  if (anios < 1) return 0;
  const row = TABLA_VACACIONES.find((r) => anios >= r.min && anios <= r.max);
  if (row) return row.dias;
  return 32 + Math.floor((anios - 35) / 5) * 2;
}

function aniosAntiguedad(fechaIngreso, hoy) {
  let years = hoy.getFullYear() - fechaIngreso.getFullYear();
  const m = hoy.getMonth() - fechaIngreso.getMonth();
  if (m < 0 || (m === 0 && hoy.getDate() < fechaIngreso.getDate())) years--;
  return Math.max(0, years);
}

// Espejo de calcularFactorIntegracion (src/lib/nomina/prestaciones.ts):
// integra las prestaciones del año de servicio EN CURSO (años cumplidos + 1).
function factorIntegracion(fechaIngreso, hoy) {
  const dias = diasVacaciones(aniosAntiguedad(fechaIngreso, hoy) + 1);
  const factor = 1 + 15 / 365 + (dias * 0.25) / 365;
  return Math.round(factor * 10000) / 10000;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const companyIdx = args.indexOf("--company");
  const companyRfc = companyIdx >= 0 ? (args[companyIdx + 1] ?? "").toUpperCase().trim() : null;

  let companyFilter = {};
  if (companyRfc) {
    const company = await prisma.company.findUnique({ where: { rfc: companyRfc }, select: { id: true, razonSocial: true } });
    if (!company) {
      console.error(`❌ No hay empresa con RFC ${companyRfc}`);
      process.exit(1);
    }
    console.log(`Empresa: ${company.razonSocial} (${companyRfc})\n`);
    companyFilter = { companyId: company.id };
  }

  const empleados = await prisma.employee.findMany({
    where: companyFilter,
    select: {
      id: true,
      rfc: true,
      nombre: true,
      apellidoPaterno: true,
      salarioDiario: true,
      salarioDiarioIntegrado: true,
      fechaIngreso: true,
      company: { select: { rfc: true, razonSocial: true } },
    },
  });

  const hoy = new Date();
  const afectados = [];
  for (const e of empleados) {
    if (e.salarioDiarioIntegrado == null || e.salarioDiario == null) continue;
    const huellaBug = Math.round(e.salarioDiario * FACTOR_VIEJO * 100) / 100;
    if (Math.abs(e.salarioDiarioIntegrado - huellaBug) > 0.01) continue; // no lo puso el bug
    const nuevo = Math.round(e.salarioDiario * factorIntegracion(e.fechaIngreso, hoy) * 100) / 100;
    if (Math.abs(nuevo - e.salarioDiarioIntegrado) <= 0.01) continue; // ya coincide
    afectados.push({ ...e, nuevoSdi: nuevo });
  }

  if (afectados.length === 0) {
    console.log("No hay empleados con SDI calculado por el factor pre-reforma. Nada que hacer.");
    return;
  }

  console.log(`${apply ? "Corrigiendo" : "DRY-RUN — se corregirían"} ${afectados.length} empleado(s):\n`);
  for (const e of afectados) {
    console.log(
      `  ${e.company.rfc}  ${e.rfc}  ${e.nombre} ${e.apellidoPaterno} — ` +
        `salario $${e.salarioDiario.toFixed(2)}: SDI $${e.salarioDiarioIntegrado.toFixed(2)} → $${e.nuevoSdi.toFixed(2)}`
    );
    if (apply) {
      await prisma.employee.update({
        where: { id: e.id },
        data: { salarioDiarioIntegrado: e.nuevoSdi },
      });
    }
  }
  console.log(
    apply
      ? "\nListo. El SDI corregido aplica desde la siguiente corrida (los recibos ya timbrados no se tocan)."
      : "\nNada se cambió. Corre con --apply para aplicar."
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
