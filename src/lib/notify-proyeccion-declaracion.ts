import { prisma } from "./prisma";
import { sendPushToUser } from "./push";
import { empresasAccesiblesIds } from "./authz";
import { computeTaxPosition } from "./impuestos";
import {
  diasParaVencimientoMensual,
  debeEnviarProyeccion,
  componerMensajeProyeccion,
  mesNombreCapitalizado,
} from "./fiscal/proyeccion-declaracion";

// ─────────────────────────────────────────────────────────────────────────────
// Proyección PROACTIVA de la declaración mensual: en las marcas T-7 y T-3 antes
// del día 17, empuja las cifras estimadas (IVA/ISR) del periodo que se está por
// declarar, con deep-link a los papeles de trabajo para revisar y aprobar.
//
// La presentación ante el SAT sigue siendo MANUAL — esto sólo proyecta + avisa.
//
// Agregación: un solo push por usuario, referenciando la empresa MÁS URGENTE
// (la de menor `dias`); si tiene más empresas en marca, el cuerpo lo indica.
// Evita spamear a despachos/operadores con una empresa por aviso.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Complementos de pago (REP) que faltan y cuestan IVA acreditable: CFDIs de
 * EGRESO PPD del periodo (o anteriores, aún del ejercicio) que a la fecha de
 * corte no tienen NINGÚN pago relacionado registrado. Conteo barato (sin armar
 * el papel de trabajo completo): cada uno representa IVA que NO se podrá
 * acreditar hasta que llegue su REP.
 */
async function complementosFaltantes(
  companyId: string,
  year: number,
  month: number,
): Promise<number> {
  const to = new Date(year, month, 1); // fin del periodo (exclusivo)
  const egresosPpd = await prisma.invoice.findMany({
    where: {
      companyId,
      tipo: "EGRESO",
      status: "STAMPED",
      metodoPago: "PPD",
      ivaNoAcreditable: false,
      fecha: { lt: to },
    },
    select: { uuid: true },
  });
  const uuids = egresosPpd.map((i) => i.uuid).filter((u): u is string => !!u);
  if (uuids.length === 0) return 0;

  const conRep = new Set(
    (
      await prisma.pagoDoctoRelacionado.findMany({
        where: {
          parentUuid: { in: uuids },
          fechaPago: { lt: to },
          pagoInvoice: { companyId, tipo: "PAGO", status: "STAMPED" },
        },
        select: { parentUuid: true },
      })
    ).map((r) => r.parentUuid),
  );

  return uuids.filter((u) => !conRep.has(u)).length;
}

interface EmpresaEnMarca {
  companyId: string;
  razonSocial: string;
  marca: 7 | 3;
  dias: number;
  year: number;
  month: number;
  mesNombre: string;
  cuerpo: string;
}

/**
 * Calcula la proyección de cada empresa accesible que esté EXACTAMENTE en una
 * marca T-7/T-3 y, si hay al menos una, envía UN push agregado al usuario
 * referenciando la más urgente. Deep-link a los papeles de trabajo del periodo.
 *
 * No-op si el usuario no tiene empresas, ninguna está en marca, o push no está
 * configurado / la categoría está desactivada.
 */
export async function notifyProyeccionDeclaracion(
  userId: string,
  hoy: Date = new Date(),
): Promise<{ notified: number; empresasEnMarca: number }> {
  const ids = await empresasAccesiblesIds(userId);
  if (ids.length === 0) return { notified: 0, empresasEnMarca: 0 };

  const companies = await prisma.company.findMany({
    where: { id: { in: ids }, isActive: true },
    select: { id: true, razonSocial: true, regimenFiscal: true },
  });

  const enMarca: EmpresaEnMarca[] = [];
  for (const c of companies) {
    const venc = diasParaVencimientoMensual(c.regimenFiscal, hoy);
    if (!venc) continue;
    const marca = debeEnviarProyeccion(venc.dias);
    if (!marca) continue;

    try {
      const pos = await computeTaxPosition(c.id, venc.year, venc.month);
      const faltan = await complementosFaltantes(c.id, venc.year, venc.month);
      const cuerpo = componerMensajeProyeccion(
        venc.mesNombre,
        {
          ivaPagar: pos.iva.pagar,
          ivaSaldoAFavor: pos.iva.saldoAFavor,
          isrPagar: pos.isr.isrPagar,
        },
        faltan,
      );
      enMarca.push({
        companyId: c.id,
        razonSocial: c.razonSocial,
        marca,
        dias: venc.dias,
        year: venc.year,
        month: venc.month,
        mesNombre: venc.mesNombre,
        cuerpo,
      });
    } catch (e) {
      console.error(`[notify-proyeccion] empresa ${c.id} falló:`, e);
    }
  }

  if (enMarca.length === 0) return { notified: 0, empresasEnMarca: 0 };

  // Más urgente = menor `dias`; desempate estable por razón social.
  enMarca.sort((a, b) => a.dias - b.dias || a.razonSocial.localeCompare(b.razonSocial));
  const top = enMarca[0];
  const otras = enMarca.length - 1;

  const titulo =
    enMarca.length === 1
      ? `Proyección de ${mesNombreCapitalizado(top.mesNombre)} — ${top.razonSocial}`
      : `Proyección de ${mesNombreCapitalizado(top.mesNombre)} — ${top.razonSocial} y ${otras} más`;

  const cuerpo =
    enMarca.length === 1
      ? top.cuerpo
      : `${top.cuerpo} (+${otras} empresa${otras === 1 ? "" : "s"} con declaración próxima)`;

  // Deep-link a los papeles de trabajo del periodo de la empresa más urgente.
  const url = `/impuestos/papeles?tab=iva&month=${top.month}&year=${top.year}`;

  const r = await sendPushToUser(
    userId,
    {
      title: titulo,
      body: cuerpo,
      url,
      // Colapsa avisos repetidos del mismo periodo/marca en uno solo.
      tag: `proyeccion-${top.year}-${String(top.month).padStart(2, "0")}-t${top.marca}`,
    },
    "declaraciones",
  );

  return { notified: r.sent, empresasEnMarca: enMarca.length };
}
