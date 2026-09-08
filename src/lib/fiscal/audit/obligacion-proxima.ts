// ─────────────────────────────────────────────────────────────────────────────
// Obligación próxima a vencer = complemento FORWARD-LOOKING de
// declaraciones.faltantes. Aquel mira hacia atrás (acuses históricos que rompen
// el arrastre); éste mira hacia adelante: para cada obligación MENSUAL activa,
// toma el periodo "en juego" (el mes cerrado más reciente cuyo plazo aún no pasa,
// p.ej. cualquier día de julio → junio, que vence el 17 de julio) y, si no hay
// una TaxDeclaration en FILED/PAID para ese obligación+periodo, avisa cuando el
// vencimiento ya está cerca (≤7 días) o ya pasó.
//
// RFC-digit extensions are applied only after eligibility is known; the base
// deadline comes from the shared CFF-aware deadline service.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { calcularVencimiento, fechaCalendarioIso } from "@/lib/obligaciones";
import {
  diasEntreFechasCalendario,
  fechaFiscalEnMexico,
  periodoMensualPorDefecto,
} from "@/lib/fiscal/periodo-operativo";
import type { Hallazgo } from "./types";

/** Día legal de vencimiento para obligaciones mensuales (IVA/ISR/DIOT). */
const DIA_VENCIMIENTO = 17;
/** Ventana de aviso anticipado: hasta N días antes del vencimiento. */
const DIAS_AVISO = 7;

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/** Obligación mensual normalizada que el auditor evalúa (desacoplada de Prisma). */
export interface ObligacionMensual {
  tipo: string;
  /** Día del mes de vencimiento (17 para mensuales). */
  diaVencimiento: number;
}

export interface ObligacionProximaData {
  /** Obligaciones mensuales activas de la empresa. */
  obligaciones: ObligacionMensual[];
  /** Claves "tipo:periodo" ya presentadas (FILED/PAID). */
  presentadas: Set<string>;
}

/** Carga obligaciones mensuales activas + declaraciones ya presentadas. */
export async function cargarObligacionProxima(
  companyId: string,
  _hoy: Date = new Date(),
): Promise<ObligacionProximaData> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: {
      isActive: true,
      obligations: {
        where: { activa: true, periodicidad: "MENSUAL" },
        select: { tipo: true, diaVencimiento: true },
      },
    },
  });
  if (!company || !company.isActive) {
    return { obligaciones: [], presentadas: new Set() };
  }

  const decls = await prisma.taxDeclaration.findMany({
    where: { companyId, status: { in: ["FILED", "PAID"] } },
    select: { tipo: true, periodo: true },
  });

  return {
    obligaciones: company.obligations.map((o) => ({
      tipo: o.tipo,
      diaVencimiento: o.diaVencimiento,
    })),
    presentadas: new Set(decls.map((d) => `${d.tipo}:${d.periodo}`)),
  };
}

/**
 * Periodo "en juego" = el mes cerrado más reciente (el mes natural anterior al
 * de `hoy`). Su vencimiento legal es el día `dia` del mes ACTUAL.
 *
 * En cualquier día de julio el periodo en juego es junio (vence el 17 de julio):
 * antes del 17 → warn dentro de la ventana; después del 17 y sin presentar →
 * error (vencido). Al cambiar de mes (agosto) el periodo en juego pasa a julio,
 * y junio —ya histórico— lo cubre declaraciones.faltantes.
 */
function periodoEnJuego(hoy: Date, dia: number): { periodo: string; venc: Date; mesIdx: number } {
  const period = periodoMensualPorDefecto(hoy);
  const venc = calcularVencimiento(
    {
      tipo: "FEDERAL_MENSUAL",
      descripcion: "Declaración mensual",
      periodicidad: "MENSUAL",
      diaVencimiento: dia,
    },
    period.key,
  );
  return {
    periodo: period.key,
    venc,
    mesIdx: period.month - 1,
  };
}

function fundamentoDe(tipo: string) {
  if (tipo.startsWith("IVA")) return { ley: "LIVA", articulo: "5-D" };
  if (tipo.startsWith("ISR")) return { ley: "LISR", articulo: "14" };
  // DIOT y demás mensuales se rigen por el plazo general del CFF.
  return { ley: "CFF", articulo: "31" };
}

function etiquetaTipo(tipo: string): string {
  if (tipo.startsWith("IVA")) return "IVA";
  if (tipo.startsWith("ISR")) return "ISR";
  if (tipo === "DIOT") return "DIOT";
  return tipo;
}

/**
 * Por cada obligación mensual activa cuyo periodo en juego no esté presentado y
 * cuyo vencimiento ya esté cerca (≤7 días) o pasado, emite un Hallazgo.
 *   • dentro de la ventana, antes del vencimiento → warn.
 *   • vencimiento ya pasado → error.
 */
export function auditarObligacionProxima(data: ObligacionProximaData, hoy: Date = new Date()): Hallazgo[] {
  const out: Hallazgo[] = [];
  const hoyKey = fechaFiscalEnMexico(hoy).key;

  for (const ob of data.obligaciones) {
    const dia = ob.diaVencimiento || DIA_VENCIMIENTO;
    const { periodo, venc, mesIdx } = periodoEnJuego(hoy, dia);

    if (data.presentadas.has(`${ob.tipo}:${periodo}`)) continue;

    const diasParaVenc = diasEntreFechasCalendario(hoyKey, fechaCalendarioIso(venc));
    const vencido = diasParaVenc < 0;
    const enVentana = !vencido && diasParaVenc <= DIAS_AVISO;
    if (!vencido && !enVentana) continue;

    const etq = etiquetaTipo(ob.tipo);
    const mesNombre = MESES[mesIdx];

    if (vencido) {
      out.push({
        checkClave: "obligacion.vencimiento.proximo",
        severidad: "error",
        mensaje: `Tu Declaración de ${etq} de ${mesNombre} venció el ${venc.getDate()} y aún no la presentas. Cada día genera actualización y recargos.`,
        referencias: [`${ob.tipo}:${periodo}`],
        fundamento: fundamentoDe(ob.tipo),
        sugerencia: `Presenta de inmediato la declaración de ${etq} de ${mesNombre} en el portal del SAT para detener actualización y recargos (CFF Art. 17-A y 21).`,
      });
    } else {
      out.push({
        checkClave: "obligacion.vencimiento.proximo",
        severidad: "warn",
        mensaje: `Tu Declaración de ${etq} de ${mesNombre} vence el ${venc.getDate()} — aún no la presentas.`,
        referencias: [`${ob.tipo}:${periodo}`],
        fundamento: fundamentoDe(ob.tipo),
        sugerencia: `Calcula y presenta la declaración de ${etq} de ${mesNombre} antes del ${venc.getDate()} para evitar actualización y recargos.`,
      });
    }
  }

  return out;
}
