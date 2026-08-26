/**
 * Sincroniza `Employee.isActive` con la EVIDENCIA de pago (los recibos), porque
 * el flag está congelado en el momento del primer import.
 *
 * Raíz del problema: historia-import clasifica ACTIVO/BAJA sólo al CREAR al
 * empleado (`if (idPorRfc.has(rfc)) continue;` — a los existentes nunca los
 * revisita). Quien se creó cuando su historial reciente aún no se descargaba
 * quedó marcado inactivo PARA SIEMPRE aunque siga cobrando. En MARGOM: 281
 * personas con recibo en 45 días, 245 de ellas marcadas inactivas (el flag
 * decía 36 activos de un padrón de 638). Y el flag no es cosmético: el roster
 * lo usa de default y `run/prefill` FILTRA por él — el asistente de nómina
 * prellenaría 36 personas en vez de ~281.
 *
 * Regla (evidencia, no captura):
 *   • referencia = MAX(fechaPago) de la empresa — no `hoy`, para que un rezago
 *     de sincronización no marque a todos inactivos.
 *   • activo = último recibo dentro de la VENTANA (default 45 días, cubre
 *     semanal y quincenal con holgura) … SALVO baja manual POSTERIOR al último
 *     pago (esa se respeta: es un acto deliberado).
 *   • recién ingresado sin recibos (fechaIngreso dentro de la ventana) se
 *     queda activo — un alta manual nueva no debe apagarse.
 *   • al reactivar con fechaBaja vieja (recibos DESPUÉS de la baja) se limpia
 *     la fechaBaja — es un reingreso de facto.
 *   • al desactivar NO se inventa fechaBaja: la baja legal es otra cosa; el
 *     flag sólo dice «no está cobrando».
 *
 * Idempotente y re-corrible: recalcula el estado completo cada vez (sirve como
 * mantenimiento periódico mientras historia-import no re-clasifique).
 *
 * Uso (dry-run por default; APPLY=1 escribe):
 *   DATABASE_URL=<url> RFC=<rfc>|COMPANY_ID=<id> [VENTANA_DIAS=45] [APPLY=1] \
 *   ts-node --compiler-options '{"module":"CommonJS"}' scripts/sincronizar-empleados-activos.ts
 */
import { PrismaClient } from "@prisma/client";
import { resolverEmpresa } from "./lib/empresa";

const APPLY = process.env.APPLY === "1";
const VENTANA_DIAS = Number(process.env.VENTANA_DIAS || 45);
const LOTE = 1000;
const dia = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "—");

async function main() {
  const prisma = new PrismaClient();
  try {
    const empresa = await resolverEmpresa(prisma);
    const COMPANY = empresa.id;
    console.log(`Empresa: ${empresa.razonSocial ?? empresa.rfc} (${COMPANY})`);

    // Último pago por empleado, y la referencia de la empresa. Sólo pagos
    // HASTA HOY: hay CFDIs timbrados con fechaPago futura (el pre-timbrado de
    // la quincena en curso, y finiquitos fechados a fin de año) — son
    // documentos reales pero no evidencia de estar cobrando hoy; sin el
    // recorte, una corrida de diciembre movía la ventana a noviembre y
    // apagaba a toda la plantilla.
    const pagos = await prisma.$queryRawUnsafe<{ eid: string; ultimo: Date }[]>(
      `SELECT pi."employeeId" eid, MAX(r."fechaPago") ultimo
       FROM "PayrollItem" pi JOIN "PayrollRun" r ON r.id = pi."payrollRunId"
       WHERE r."companyId" = $1 AND r."fechaPago" <= NOW() GROUP BY 1`,
      COMPANY,
    );
    const ultimoPor = new Map(pagos.map((p) => [p.eid, p.ultimo]));
    const ref = pagos.reduce<Date | null>((a, p) => (!a || p.ultimo > a ? p.ultimo : a), null);
    if (!ref) { console.log("Sin recibos en la empresa — nada que sincronizar."); return; }
    const corte = new Date(ref.getTime() - VENTANA_DIAS * 86400_000);
    console.log(`Referencia: ${dia(ref)} (último pago) · ventana ${VENTANA_DIAS} días → corte ${dia(corte)}`);

    const emps = await prisma.employee.findMany({
      where: { companyId: COMPANY },
      select: { id: true, nombre: true, apellidoPaterno: true, isActive: true, fechaBaja: true, fechaIngreso: true },
    });

    const activar: typeof emps = [];
    const desactivar: typeof emps = [];
    const limpiarBaja: string[] = []; // reactivados cuyo último pago es posterior a su fechaBaja
    for (const e of emps) {
      const ultimo = ultimoPor.get(e.id) ?? null;
      const bajaManualPosterior = e.fechaBaja != null && (ultimo == null || e.fechaBaja >= ultimo);
      const reciénIngresado = ultimo == null && e.fechaIngreso >= corte;
      const debeActivo = !bajaManualPosterior && ((ultimo != null && ultimo >= corte) || reciénIngresado);
      if (debeActivo && !e.isActive) {
        activar.push(e);
        if (e.fechaBaja != null && ultimo != null && ultimo > e.fechaBaja) limpiarBaja.push(e.id);
      } else if (!debeActivo && e.isActive) {
        desactivar.push(e);
      }
    }

    const nom = (e: { nombre: string; apellidoPaterno: string | null }) =>
      `${e.nombre} ${e.apellidoPaterno ?? ""}`.trim();
    console.log(`\n${emps.length} en el padrón · flag actual: ${emps.filter((e) => e.isActive).length} activos`);
    console.log(`→ ACTIVAR ${activar.length} (cobran y estaban apagados; ${limpiarBaja.length} con fechaBaja vieja que se limpia)`);
    for (const e of activar.slice(0, 5)) console.log(`   · ${nom(e)} — último pago ${dia(ultimoPor.get(e.id))}, baja ${dia(e.fechaBaja)}`);
    console.log(`→ DESACTIVAR ${desactivar.length} (sin recibo desde el corte)`);
    for (const e of desactivar.slice(0, 5)) console.log(`   · ${nom(e)} — último pago ${dia(ultimoPor.get(e.id))}`);
    const activosFinal = emps.filter((e) => e.isActive).length + activar.length - desactivar.length;
    console.log(`Resultado: ${activosFinal} activos (la evidencia dice ~${emps.filter((e) => { const u = ultimoPor.get(e.id); return u && u >= corte; }).length} cobrando en ventana)`);

    if (!APPLY) { console.log("\n[dry-run] APPLY=1 para escribir."); return; }

    for (let i = 0; i < activar.length; i += LOTE)
      await prisma.employee.updateMany({ where: { id: { in: activar.slice(i, i + LOTE).map((e) => e.id) } }, data: { isActive: true } });
    for (let i = 0; i < limpiarBaja.length; i += LOTE)
      await prisma.employee.updateMany({ where: { id: { in: limpiarBaja.slice(i, i + LOTE) } }, data: { fechaBaja: null } });
    for (let i = 0; i < desactivar.length; i += LOTE)
      await prisma.employee.updateMany({ where: { id: { in: desactivar.slice(i, i + LOTE).map((e) => e.id) } }, data: { isActive: false } });
    console.log(`\n${activar.length} activados · ${desactivar.length} desactivados · ${limpiarBaja.length} fechaBaja limpiadas.`);
  } finally {
    await prisma.$disconnect();
  }
}

main();
