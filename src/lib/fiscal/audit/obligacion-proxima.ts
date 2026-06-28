// ─────────────────────────────────────────────────────────────────────────────
// Obligación próxima a vencer = complemento FORWARD-LOOKING de
// declaraciones.faltantes. Aquel mira hacia atrás (acuses históricos que rompen
// el arrastre); éste mira hacia adelante: para cada obligación MENSUAL activa,
// toma el periodo "en juego" (el mes cerrado más reciente cuyo plazo aún no pasa,
// p.ej. cualquier día de julio → junio, que vence el 17 de julio) y, si no hay
// una TaxDeclaration en FILED/PAID para ese obligación+periodo, avisa cuando el
// vencimiento ya está cerca (≤7 días) o ya pasó.
//
// Nota / gap conocido: la fecha legal del día 17 ignora las prórrogas por dígito
// de RFC (RCFF Art. 5 / regla del "sexto dígito"). Usamos el 17 fijo por ahora.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
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
  // Mes anterior al de hoy (1-based), ajustando el cruce de año.
  let anio = hoy.getFullYear();
  let mes = hoy.getMonth(); // getMonth() es 0-based ⇒ mes natural anterior en 1-based.
  if (mes === 0) {
    mes = 12;
    anio -= 1;
  }
  // Vencimiento = día `dia` del mes natural siguiente al periodo (= mes de hoy).
  const venc = vencimientoDe(anio, mes, dia);
  return {
    periodo: `${anio}-${String(mes).padStart(2, "0")}`,
    venc,
    mesIdx: mes - 1,
  };
}

/** Fecha de vencimiento del periodo `anio-mes` (1-based): día `dia` del mes natural siguiente. */
function vencimientoDe(anio: number, mes: number, dia: number): Date {
  // mes es 1-based; el mes siguiente en índice 0-based del Date es justamente `mes`.
  return new Date(anio, mes, dia);
}

function finDelDia(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
}

function inicioDelDia(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
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
  const hoyInicio = inicioDelDia(hoy);

  for (const ob of data.obligaciones) {
    const dia = ob.diaVencimiento || DIA_VENCIMIENTO;
    const { periodo, venc, mesIdx } = periodoEnJuego(hoy, dia);

    if (data.presentadas.has(`${ob.tipo}:${periodo}`)) continue;

    const vencFin = finDelDia(venc);
    const vencInicio = inicioDelDia(venc).getTime();
    const msPorDia = 24 * 60 * 60 * 1000;
    const diasParaVenc = Math.round((vencInicio - hoyInicio.getTime()) / msPorDia);

    const vencido = hoy.getTime() > vencFin;
    const enVentana = !vencido && diasParaVenc <= DIAS_AVISO;
    if (!vencido && !enVentana) continue;

    const etq = etiquetaTipo(ob.tipo);
    const mesNombre = MESES[mesIdx];

    if (vencido) {
      out.push({
        checkClave: "obligacion.vencimiento.proximo",
        severidad: "error",
        mensaje: `Tu Declaración de ${etq} de ${mesNombre} venció el ${dia} y aún no la presentas. Cada día genera actualización y recargos.`,
        referencias: [`${ob.tipo}:${periodo}`],
        fundamento: fundamentoDe(ob.tipo),
        sugerencia: `Presenta de inmediato la declaración de ${etq} de ${mesNombre} en el portal del SAT para detener actualización y recargos (CFF Art. 17-A y 21).`,
      });
    } else {
      out.push({
        checkClave: "obligacion.vencimiento.proximo",
        severidad: "warn",
        mensaje: `Tu Declaración de ${etq} de ${mesNombre} vence el ${dia} — aún no la presentas.`,
        referencias: [`${ob.tipo}:${periodo}`],
        fundamento: fundamentoDe(ob.tipo),
        sugerencia: `Calcula y presenta la declaración de ${etq} de ${mesNombre} antes del ${dia} para evitar actualización y recargos.`,
      });
    }
  }

  return out;
}
