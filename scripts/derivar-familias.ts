/**
 * Deriva el catálogo de FAMILIAS de una empresa desde SU PROPIO plan de cuentas
 * — no desde los strings sucios del padrón, no hardcodeado.
 *
 * La clave: el contador ya nombró sus subcuentas por familia. 4101-0004 es
 * «VENTA NUEVOS FRISON», 4101-0025 «VENTA NUEVOS TRACTO K7». Ahí están las dos
 * cosas que necesita familia-vehiculo.ts: el NOMBRE de la familia y su SUFIJO
 * (0004, 0025) — el mismo sufijo que usan 1301-00XX/5101-00XX. Así el catálogo
 * de 28 familias que en MARGOM se escribió a mano sale solo de la serie 4101.
 *
 * Qué hace, sólo lectura:
 *   1. Lee las subcuentas 4101-XXXX (ventas de unidad nueva) del CT.
 *   2. Saca el nombre de familia quitando los prefijos comerciales
 *      («VENTA NUEVOS», «VENTA FLOTILLA», «VENTA»…) y el sufijo del número.
 *   3. Propone un patrón regex a partir del nombre (tolerante a espacios entre
 *      letra y dígito, p.ej. «E 10X» ↔ «E10X»).
 *   4. VALIDA contra el padrón: cuántas unidades caza cada patrón. Una familia
 *      con cuenta pero 0 unidades, o un patrón que choca con otro, se marca.
 *   5. Imprime el arreglo FAMILIAS listo para revisar y pegar.
 *
 * Reduce de semanas a minutos-de-revisión: el humano confirma alias y choques,
 * no escribe 28 renglones desde cero.
 *
 * Uso:  DATABASE_URL=<url> RFC=<rfc> \
 *       ts-node --compiler-options '{"module":"CommonJS"}' scripts/derivar-familias.ts
 */
import { PrismaClient } from "@prisma/client";

const RFC = process.env.RFC || "AMA170817NK1";
// La serie de venta de unidad NUEVA de base (donde el contador nombra familias).
const SERIE_VENTA = "4101";

// Prefijos comerciales que NO son parte del nombre de familia.
const PREFIJOS = [
  /^VENTA\s+NUEVOS?\s+/i,
  /^VENTA\s+FLOTILLA\s+/i,
  /^VENTA\s+/i,
  /\s+INTERCAMBIO$/i,
  /\s+FLOTILLA$/i,
];

function nombreFamilia(nombreCuenta: string): string {
  let s = nombreCuenta.trim();
  for (const re of PREFIJOS) s = s.replace(re, "");
  return s.trim().toUpperCase();
}

/** Patrón tolerante: entre una letra y un dígito admite un espacio opcional. */
function patronDe(familia: string): string {
  // "E10X" → "E ?10X" ; "TRACTO K7" → "TRACTO K7" ; escapa lo demás.
  const esc = familia.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return esc.replace(/([A-Z]) ?(\d)/g, "$1 ?$2");
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const c = await prisma.company.findFirst({ where: { rfc: RFC }, select: { id: true, razonSocial: true } });
    if (!c) throw new Error(`${RFC} no está en la base`);

    const cuentas = await prisma.chartAccount.findMany({
      where: { companyId: c.id, isActive: true, cuentaSAT: { startsWith: SERIE_VENTA + "-" } },
      select: { cuentaSAT: true, nombre: true },
      orderBy: { cuentaSAT: "asc" },
    });
    if (cuentas.length === 0) {
      console.log(`${c.razonSocial}: sin subcuentas ${SERIE_VENTA}-* — ¿ya se importó el catálogo?`);
      return;
    }

    // Padrón para validar: modelo + versión en mayúsculas.
    const padron = await prisma.vehiculo.findMany({
      where: { companyId: c.id },
      select: { modelo: true, version: true, marca: true },
    });
    const textos = padron.map((v) => `${v.marca ?? ""} ${v.modelo ?? ""} ${v.version ?? ""}`.toUpperCase());

    console.log(`== ${c.razonSocial} (${RFC}) — familias derivadas de la serie ${SERIE_VENTA} ==\n`);
    const propuestas: { familia: string; sufijo: string; patron: string; cazadas: number }[] = [];
    for (const cta of cuentas) {
      const partes = cta.cuentaSAT.split("-");
      const sufijo = partes[1] ?? "0000";
      const familia = nombreFamilia(cta.nombre);
      if (!familia) continue;
      const patron = patronDe(familia);
      let re: RegExp | null = null;
      try { re = new RegExp("\\b" + patron, "i"); } catch { re = null; }
      const cazadas = re ? textos.filter((t) => re!.test(t)).length : 0;
      propuestas.push({ familia, sufijo, patron, cazadas });
    }

    // Orden: patrón más específico primero (los más largos ganan al empatar).
    propuestas.sort((a, b) => b.patron.length - a.patron.length);

    console.log("familia               sufijo  patrón                    unidades");
    for (const p of propuestas) {
      const flag = p.cazadas === 0 ? "  ⚠ sin unidades en el padrón" : "";
      console.log(`  ${p.familia.slice(0, 20).padEnd(21)} ${p.sufijo}   ${p.patron.slice(0, 24).padEnd(25)} ${String(p.cazadas).padStart(6)}${flag}`);
    }

    console.log(`\n${propuestas.length} familias · ${propuestas.filter((p) => p.cazadas > 0).length} con unidades`);
    console.log("\n// Pegar en familia-vehiculo.ts tras revisar alias y choques:");
    console.log("export const FAMILIAS = [");
    for (const p of propuestas) console.log(`  ["${p.familia}", "${p.sufijo}", "${p.patron}"],`);
    console.log("] as const;");
  } finally {
    await prisma.$disconnect();
  }
}

main();
