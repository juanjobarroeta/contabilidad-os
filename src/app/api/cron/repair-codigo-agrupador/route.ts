import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withCronLock } from "@/lib/cron-lock";
import { seedChartOfAccounts } from "@/lib/contabilidad/seed-catalog";
import { postMonth, REGENERATED_SOURCES } from "@/lib/contabilidad/posting";
import { SAT_STARTER_CATALOG } from "@/lib/contabilidad/catalog";
import { EXTRA_ACCOUNTS_FOR_CLASSIFICATION } from "@/lib/contabilidad/classify-egreso";
import { CODIGO_AGRUPADOR_OFICIAL } from "@/lib/contabilidad/codigo-agrupador";

/** Códigos que el catálogo NUEVO también usa: la fila vieja mal nombrada ocupa
 *  el código y BLOQUEA al seeder (que ancla por código) — la reparación las
 *  RENOMBRA EN SU LUGAR al nombre oficial en vez de desactivarlas. */
const CODIGOS_SEMILLA_NUEVA = new Set(
  [...SAT_STARTER_CATALOG, ...EXTRA_ACCOUNTS_FOR_CLASSIFICATION].map((a) => a.subcuenta ?? a.cuentaSAT)
);

// ─────────────────────────────────────────────────────────────────────────────
// REPARACIÓN ÚNICA: catálogos sembrados con códigos agrupadores inventados.
//
// El catálogo semilla y el clasificador de egresos asignaban códigos 601.xx
// secuenciales que NO corresponden al código agrupador oficial del Anexo 24
// (combustibles caía en 601.15 «Despensa», el IMSS patronal en 601.14
// «Destajo», el ISR retenido de nómina en 214.01 «Dividendos por pagar»).
// El código ya usa los códigos oficiales; esta ruta repara los datos:
//
//   1. Siembra las cuentas NUEVAS (seedChartOfAccounts, idempotente).
//   2. Re-apunta los asientos de fuentes PRESERVADAS (APERTURA/MANUAL/
//      satélites — postMonth no los regenera) de la cuenta vieja a la nueva.
//   3. Re-postea cada periodo con asientos (las fuentes CFDI/NOMINA/BANCO se
//      regeneran solas sobre las cuentas correctas — el diseño wipe-and-rebuild
//      es el mecanismo de reparación).
//   4. Renombra cuentas cuyo código no cambió pero cuyo nombre difería del
//      oficial, y desactiva las cuentas viejas que quedaron sin asientos.
//
// SEGURIDAD: sólo toca cuentas cuyo (código + nombre) coincide EXACTAMENTE con
// lo que nuestra semilla vieja creó — los catálogos importados de Contabilidad
// Electrónica (Syntage/XML del software anterior) y las cuentas personalizadas
// no se tocan; si una cuenta vieja conserva asientos que no pudimos mover, se
// reporta en `pendientes` para reclasificación humana.
//
// Dry-run por defecto; ?ejecutar=1 aplica. Auth: CRON_SECRET.
// La balanza de meses ya "enviados" cambia: ce-reconciliacion y el hash de
// CoeEnvio marcarán el siguiente XML como Complementaria automáticamente.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Cuenta vieja (código + nombre EXACTO de la semilla vieja) → código oficial nuevo. */
const MOVES: Array<{ code: string; oldNombre: string; newCode: string }> = [
  { code: "107.01", oldNombre: "Deudores diversos nacionales", newCode: "107.05" },
  { code: "107.05", oldNombre: "ISR pagado por terceros (retenido a favor)", newCode: "113.02" },
  { code: "107.06", oldNombre: "Préstamos otorgados a terceros", newCode: "107.03" },
  { code: "205.01", oldNombre: "Acreedores diversos nacionales", newCode: "205.02" },
  { code: "205.02", oldNombre: "Préstamos por pagar", newCode: "205.04" },
  { code: "213.01", oldNombre: "ISR por pagar", newCode: "213.03" },
  { code: "214.01", oldNombre: "ISR retenido por sueldos", newCode: "216.01" },
  { code: "214.02", oldNombre: "ISR/IVA retenido a proveedores", newCode: "216.04" },
  { code: "215.01", oldNombre: "IMSS e INFONAVIT por pagar", newCode: "211.01" },
  { code: "216.01", oldNombre: "IVA por pagar", newCode: "213.01" },
  { code: "306.01", oldNombre: "Utilidades acumuladas", newCode: "304.01" },
  { code: "402.01", oldNombre: "Otros ingresos", newCode: "403.01" },
  { code: "601.02", oldNombre: "Honorarios", newCode: "601.38" },
  { code: "601.03", oldNombre: "Rentas", newCode: "601.46" },
  { code: "601.14", oldNombre: "Cuotas IMSS patronal", newCode: "601.26" },
  { code: "601.15", oldNombre: "Aportaciones Infonavit patronal", newCode: "601.27" },
  { code: "601.15", oldNombre: "Combustibles", newCode: "601.48" },
  { code: "601.16", oldNombre: "Lubricantes", newCode: "601.48" },
  { code: "601.17", oldNombre: "Servicios notariales y bienes raíces", newCode: "601.34" },
  { code: "601.18", oldNombre: "Publicidad y marketing", newCode: "601.61" },
  { code: "601.19", oldNombre: "Servicios de software / TI", newCode: "601.32" },
  { code: "601.20", oldNombre: "Impuestos y derechos", newCode: "601.58" },
  { code: "601.20", oldNombre: "Telecomunicaciones", newCode: "601.50" },
  { code: "601.21", oldNombre: "Equipos de cómputo", newCode: "601.84" },
  { code: "601.22", oldNombre: "Fletes y transporte", newCode: "601.72" },
  { code: "601.23", oldNombre: "Hospedaje y alimentación", newCode: "601.49" },
  { code: "601.24", oldNombre: "Viajes", newCode: "601.49" },
  { code: "601.25", oldNombre: "Agua", newCode: "601.51" },
  { code: "601.26", oldNombre: "Energía y gas", newCode: "601.52" },
  { code: "601.27", oldNombre: "Mantenimiento y reparaciones", newCode: "601.56" },
  { code: "601.28", oldNombre: "Limpieza", newCode: "601.54" },
  { code: "601.29", oldNombre: "Seguros", newCode: "601.57" },
  { code: "601.30", oldNombre: "Servicios bancarios", newCode: "701.10" },
  { code: "601.31", oldNombre: "Papelería y material de oficina", newCode: "601.55" },
  { code: "601.32", oldNombre: "Alimentos", newCode: "601.84" },
  { code: "601.33", oldNombre: "Capacitación y educación", newCode: "601.62" },
  { code: "601.84", oldNombre: "Comisiones bancarias", newCode: "701.10" },
  { code: "601.99", oldNombre: "Otros gastos", newCode: "601.84" },
  { code: "603.01", oldNombre: "Gastos no deducibles", newCode: "601.83" },
  { code: "704.01", oldNombre: "Diferencias por redondeo", newCode: "701.11" },
];

/** Código sin cambio pero nombre viejo ≠ oficial: sólo renombrar. */
const RENAMES: Array<{ code: string; oldNombre: string; newNombre: string }> = [
  { code: "102.01", oldNombre: "Bancos nacionales moneda nacional", newNombre: "Bancos nacionales" },
  { code: "119.01", oldNombre: "IVA pendiente de pagar al proveedor", newNombre: "IVA pendiente de pago" },
  { code: "209.01", oldNombre: "IVA pendiente de cobrar al cliente", newNombre: "IVA trasladado no cobrado" },
  { code: "301.01", oldNombre: "Capital social fijo", newNombre: "Capital fijo" },
  { code: "305.01", oldNombre: "Resultado del ejercicio", newNombre: "Utilidad del ejercicio" },
  { code: "401.01", oldNombre: "Ventas y/o servicios gravados", newNombre: "Ventas y/o servicios gravados a la tasa general" },
  // Encabezados (nivel 2) que persisten con nombre oficial nuevo.
  { code: "118", oldNombre: "IVA acreditable pagado", newNombre: "Impuestos acreditables pagados" },
  { code: "119", oldNombre: "IVA pendiente de acreditar", newNombre: "Impuestos acreditables por pagar" },
  { code: "205", oldNombre: "Acreedores diversos", newNombre: "Acreedores diversos a corto plazo" },
  { code: "208", oldNombre: "IVA trasladado cobrado", newNombre: "Impuestos trasladados cobrados" },
  { code: "209", oldNombre: "IVA trasladado pendiente de cobro", newNombre: "Impuestos trasladados no cobrados" },
  { code: "213", oldNombre: "Impuestos sobre la renta por pagar", newNombre: "Impuestos y derechos por pagar" },
  { code: "216", oldNombre: "IVA por pagar", newNombre: "Impuestos retenidos" },
  { code: "401", oldNombre: "Ingresos por ventas y/o servicios", newNombre: "Ingresos" },
];

/** Encabezados viejos que quedan huérfanos tras los movimientos. */
const ORPHAN_HEADERS: Array<{ code: string; oldNombre: string }> = [
  { code: "214", oldNombre: "ISR retenido" },
  { code: "215", oldNombre: "Aportaciones de seguridad social" },
  { code: "306", oldNombre: "Resultados de ejercicios anteriores" },
  { code: "402", oldNombre: "Otros ingresos" },
  { code: "603", oldNombre: "Gastos no deducibles" },
  { code: "704", oldNombre: "Diferencias y redondeo" },
];

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${secret}` || req.headers.get("x-cron-secret") === secret;
}

async function findByCodeAndNombre(companyId: string, code: string, nombre: string) {
  return prisma.chartAccount.findFirst({
    where: {
      companyId,
      nombre,
      OR: [{ subcuenta: code }, { cuentaSAT: code, subcuenta: null }],
    },
  });
}

async function handle(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ejecutar = new URL(req.url).searchParams.get("ejecutar") === "1";
  const soloCompany = new URL(req.url).searchParams.get("companyId");

  const companies = await prisma.company.findMany({
    where: { isActive: true, ...(soloCompany ? { id: soloCompany } : {}) },
    select: { id: true, rfc: true, razonSocial: true },
  });

  const resultados: unknown[] = [];

  for (const company of companies) {
    const r = {
      companyId: company.id,
      rfc: company.rfc,
      cuentasViejas: 0,
      asientosPreservadosMovidos: 0,
      renombradas: 0,
      periodosReposteados: 0,
      periodosConError: [] as string[],
      desactivadas: 0,
      pendientes: [] as string[],
    };

    // Sólo empresas con catálogo sembrado.
    const tieneCatalogo = await prisma.chartAccount.count({ where: { companyId: company.id } });
    if (tieneCatalogo === 0) {
      resultados.push({ ...r, skipped: "sin catálogo" });
      continue;
    }

    if (ejecutar) await seedChartOfAccounts(company.id);

    // 0) Cuentas viejas detectadas + DESACTIVAR las de código duplicado ANTES
    //    de re-postear: mientras la fila vieja mal nombrada comparta código con
    //    la oficial (601.84 «Comisiones bancarias» vs «Otros gastos generales»),
    //    resolveAccount podría enrutar el re-posteo a la vieja. resolveAccount
    //    sólo resuelve cuentas ACTIVAS, así que desactivarla primero garantiza
    //    que todo asiento regenerado caiga en la fila oficial.
    for (const move of MOVES) {
      const vieja = await findByCodeAndNombre(company.id, move.code, move.oldNombre);
      if (!vieja) continue;
      r.cuentasViejas++;

      const sibling = await prisma.chartAccount.findFirst({
        where: { companyId: company.id, subcuenta: move.code, id: { not: vieja.id } },
        select: { id: true },
      });
      const preservados = await prisma.accountingEntry.count({
        where: { chartAccountId: vieja.id, fuente: { notIn: [...REGENERATED_SOURCES] } },
      });

      if (!sibling && CODIGOS_SEMILLA_NUEVA.has(move.code) && preservados === 0) {
        // Código REUTILIZADO sin fila oficial: la vieja ocupa el código y
        // bloqueó al seeder. Tras el re-posteo, los asientos que viven en ella
        // ya PERTENECEN al significado oficial del código (el posteo resuelve
        // por código) — renombrarla en su lugar la vuelve la fila oficial sin
        // mover un solo asiento. Sin preservados no hay ambigüedad.
        const nombreOficial = CODIGO_AGRUPADOR_OFICIAL[move.code];
        if (nombreOficial) {
          r.renombradas++;
          if (ejecutar) {
            await prisma.chartAccount.update({
              where: { id: vieja.id },
              data: { nombre: nombreOficial, isActive: true },
            });
          }
          continue;
        }
      }

      if (!ejecutar || !vieja.isActive) continue;
      // Código reutilizado CON fila oficial ya presente: desactivar la vieja
      // antes de re-postear para que resolveAccount (sólo activas) enrute a la
      // oficial. Las de código no reutilizado se desactivan al final, vacías.
      if (sibling) {
        await prisma.chartAccount.update({ where: { id: vieja.id }, data: { isActive: false } });
      }
    }

    // 1) Re-postear TODOS los meses con asientos regenerables — derivados de
    //    los propios asientos, no de AccountingPeriod.entriesCount (que puede
    //    estar desfasado y saltarse meses, como pasó en la primera corrida).
    const meses = await prisma.accountingEntry.groupBy({
      by: ["year", "month"],
      where: { companyId: company.id, fuente: { in: [...REGENERATED_SOURCES] } },
      orderBy: [{ year: "asc" }, { month: "asc" }],
    });
    const cerrados = new Set(
      (
        await prisma.accountingPeriod.findMany({
          where: { companyId: company.id, status: "CLOSED" },
          select: { year: true, month: true },
        })
      ).map((p) => `${p.year}-${p.month}`)
    );
    for (const p of meses) {
      if (p.month === 13) continue; // cierre anual: sólo asientos CIERRE
      if (cerrados.has(`${p.year}-${p.month}`)) continue;
      if (!ejecutar) { r.periodosReposteados++; continue; }
      try {
        await postMonth({ companyId: company.id, year: p.year, month: p.month });
        r.periodosReposteados++;
      } catch (e) {
        r.periodosConError.push(`${p.year}-${String(p.month).padStart(2, "0")}: ${e instanceof Error ? e.message : e}`);
      }
    }

    // 2) Mover asientos preservados (APERTURA/MANUAL/satélites) vieja → nueva.
    for (const move of MOVES) {
      const vieja = await findByCodeAndNombre(company.id, move.code, move.oldNombre);
      if (!vieja) continue;
      const preservados = await prisma.accountingEntry.count({
        where: { chartAccountId: vieja.id, fuente: { notIn: [...REGENERATED_SOURCES] } },
      });
      if (preservados === 0) continue;
      if (!ejecutar) {
        r.asientosPreservadosMovidos += preservados; // lo que se movería
        continue;
      }
      const nueva = await prisma.chartAccount.findFirst({
        where: { companyId: company.id, subcuenta: move.newCode, isActive: true },
      });
      if (!nueva) {
        r.pendientes.push(`${move.code} «${move.oldNombre}»: cuenta destino ${move.newCode} no existe`);
        continue;
      }
      const upd = await prisma.accountingEntry.updateMany({
        where: { chartAccountId: vieja.id, fuente: { notIn: [...REGENERATED_SOURCES] } },
        data: { chartAccountId: nueva.id },
      });
      r.asientosPreservadosMovidos += upd.count;
    }

    // 3) Barrido de residuos: asientos que la primera corrida re-posteó sobre
    //    la fila vieja de un código REUTILIZADO (misma subcuenta, otra fila).
    //    Son asientos con el código correcto en la fila equivocada — se
    //    re-apuntan a la fila oficial activa del MISMO código.
    for (const move of MOVES) {
      const vieja = await findByCodeAndNombre(company.id, move.code, move.oldNombre);
      if (!vieja) continue;
      const restantes = await prisma.accountingEntry.count({ where: { chartAccountId: vieja.id } });
      if (restantes === 0) continue;
      const oficialMismoCodigo = await prisma.chartAccount.findFirst({
        where: { companyId: company.id, subcuenta: move.code, isActive: true, id: { not: vieja.id } },
      });
      if (!oficialMismoCodigo) continue; // código no reutilizado — se reporta abajo
      if (ejecutar) {
        const upd = await prisma.accountingEntry.updateMany({
          where: { chartAccountId: vieja.id },
          data: { chartAccountId: oficialMismoCodigo.id },
        });
        r.asientosPreservadosMovidos += upd.count;
      } else {
        r.asientosPreservadosMovidos += restantes;
      }
    }

    // 4) Renombrar cuentas con código correcto y nombre viejo.
    for (const ren of RENAMES) {
      const acc = await findByCodeAndNombre(company.id, ren.code, ren.oldNombre);
      if (!acc) continue;
      r.renombradas++;
      if (ejecutar) {
        await prisma.chartAccount.update({ where: { id: acc.id }, data: { nombre: ren.newNombre } });
      }
    }

    // 5) Desactivar cuentas viejas restantes y encabezados huérfanos; lo que
    //    conserve asientos (código NO reutilizado) se reporta para humano.
    for (const item of [...MOVES, ...ORPHAN_HEADERS]) {
      const vieja = await findByCodeAndNombre(company.id, item.code, item.oldNombre);
      if (!vieja) continue;
      // En dry-run, las filas que el paso 0 renombraría en su lugar no son
      // pendientes — quedarán como la fila oficial del código.
      if (!ejecutar && CODIGOS_SEMILLA_NUEVA.has(item.code) && CODIGO_AGRUPADOR_OFICIAL[item.code]) {
        const sibling = await prisma.chartAccount.findFirst({
          where: { companyId: company.id, subcuenta: item.code, id: { not: vieja.id } },
          select: { id: true },
        });
        const preservados = await prisma.accountingEntry.count({
          where: { chartAccountId: vieja.id, fuente: { notIn: [...REGENERATED_SOURCES] } },
        });
        if (!sibling && preservados === 0) continue;
      }
      const restantes = await prisma.accountingEntry.count({ where: { chartAccountId: vieja.id } });
      if (restantes === 0) {
        if (ejecutar && vieja.isActive) {
          await prisma.chartAccount.update({ where: { id: vieja.id }, data: { isActive: false } });
        }
        r.desactivadas++;
      } else {
        r.pendientes.push(
          `${item.code} «${item.oldNombre}»: ${restantes} asiento(s) siguen ahí — reclasificar a mano`
        );
      }
    }

    resultados.push(r);
  }

  return NextResponse.json({
    ok: true,
    modo: ejecutar ? "EJECUTADO" : "dry-run (agrega ?ejecutar=1 para aplicar)",
    empresas: companies.length,
    resultados,
  });
}

export async function POST(req: Request) {
  return withCronLock("cron:repair-codigo-agrupador", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:repair-codigo-agrupador", () => handle(req));
}
