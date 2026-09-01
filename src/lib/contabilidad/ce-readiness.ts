// ─────────────────────────────────────────────────────────────────────────────
// ¿Lista tu Contabilidad Electrónica? — chequeo de READINESS / CONFIANZA
//
// Para una empresa + periodo, dice si los XML de Contabilidad Electrónica
// (catálogo / balanza / pólizas, generados en el panel CE) son confiables y,
// si no, EXACTAMENTE qué falta. La idea: que "construir la CE desde cero" sea
// evidente — el usuario ve la lista de pendientes con su CTA.
//
// Diseño:
//   1. La PUNTUACIÓN es pura (evaluarChecks): recibe hechos ya resueltos
//      (¿hay CFDIs?, ¿hay banco?, N sin clasificar, ¿cuadra?, ¿posteado?…) y
//      devuelve el estado global + la lista de checks. Sin Prisma → testeable.
//   2. evaluarReadinessCE hace las consultas a la base, reutilizando balanza()
//      y las mismas tablas que ya alimentan el motor de posteo y la pantalla de
//      Bancos. No reimplementa la matemática contable.
//
// Fuente-agnóstico en banco: sólo mira si EXISTEN filas BankTransaction del
// periodo y cuántas siguen sin conciliar/categorizar; NUNCA si hay una API
// conectada. Banco subido a mano o vía API aterrizan ambos en BankTransaction.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";
import { balanza, balanzaPreview } from "./posting";

// Tolerancia de cuadre (cargos vs abonos). Coincide con el balance check de
// postMonth(): diferencias < 1 centavo se consideran cuadradas.
export const TOLERANCIA_CUADRE = 0.01;

// Antigüedad máxima (en días) del último sync de CFDIs antes de advertir que
// los datos podrían estar incompletos.
export const SYNC_WARN_DIAS = 7;

export type CheckEstado = "ok" | "warn" | "error";

export type ReadinessCheck = {
  clave: string;
  estado: CheckEstado;
  titulo: string;
  detalle: string;
  // CTA opcional: a dónde mandar al usuario para resolverlo.
  cta?: { label: string; href: string };
};

export type ReadinessStatus = "lista" | "con_huecos" | "incompleta";

export type ReadinessResult = {
  status: ReadinessStatus;
  resumen: string;
  checks: ReadinessCheck[];
};

// Hechos del periodo, ya resueltos contra la base. Esto es lo único que la
// puntuación pura necesita.
export type ReadinessInputs = {
  // CFDIs sincronizados del periodo (ingresos/gastos/nómina STAMPED).
  cfdiCount: number;
  // Último sync de CFDIs (Company.lastAutoSyncAt). null si nunca se sincronizó.
  lastSyncAt: Date | null;
  // Fecha de referencia para medir la antigüedad del sync (normalmente "ahora").
  now: Date;

  // Banco — fuente-agnóstico: cuántas filas BankTransaction hay en el periodo
  // y cuántas siguen sin conciliar (UNMATCHED).
  bankTxCount: number;
  bankUnmatchedCount: number;

  // Cuadre del libro: suma de cargos y abonos sobre la balanza del periodo.
  totalCargos: number;
  totalAbonos: number;

  // Estado del periodo contable.
  posted: boolean;

  // El régimen requiere balance (Activo/CxC/CxP) → exige datos bancarios.
  // Las personas físicas con régimen simplificado (RESICO/PFAE puro) no llevan
  // balance, así que la falta de banco es nota suave, no error.
  requiereBalance: boolean;

  // Aportación de capital inicial detectada (asiento/clasificación CAPITAL).
  // undefined = no se pudo determinar de forma trivial → se omite el check.
  tieneCapitalInicial?: boolean;
  // Marca de empresa nueva (primer ejercicio): sólo entonces tiene sentido la
  // nota de capital inicial.
  esEmpresaNueva?: boolean;
};

// Régimenes de persona MORAL y los de persona física que SÍ llevan balance
// (Anexo 24 con cuentas de activo/pasivo). Para el resto, el balance —y por
// tanto el banco— es opcional.
const REGIMENES_CON_BALANCE = new Set<string>([
  "601", // General de Ley Personas Morales
  "603", // Personas Morales con Fines no Lucrativos
  "620", // Sociedades Cooperativas de Producción
  "622", // Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras
  "623", // Opcional para Grupos de Sociedades
  "624", // Coordinados
  "628", // Hidrocarburos
]);

export function regimenRequiereBalance(regimenFiscal: string): boolean {
  return REGIMENES_CON_BALANCE.has(regimenFiscal.trim());
}

function diasEntre(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}

// ─────────────────────────────────────────────────────────────────────────────
// PUNTUACIÓN PURA — sin DB. Dada la lista de hechos, arma los checks y el estado
// global. Reglas del estado global:
//   incompleta  → hay al menos un check en "error" (la CE NO es confiable).
//   con_huecos  → no hay errores pero sí algún "warn" (confiable con reservas).
//   lista       → todos los checks en "ok".
// ─────────────────────────────────────────────────────────────────────────────
export function evaluarChecks(input: ReadinessInputs): ReadinessResult {
  const checks: ReadinessCheck[] = [];

  // 1. CFDIs del periodo + frescura del sync.
  if (input.cfdiCount === 0) {
    checks.push({
      clave: "cfdis",
      estado: "error",
      titulo: "Sin CFDIs del periodo",
      detalle:
        "No hay facturas (ingresos, gastos ni nómina) sincronizadas para este mes. " +
        "Sincroniza con el SAT para que la contabilidad refleje tus operaciones.",
      cta: { label: "Sincronizar CFDIs", href: "/facturas" },
    });
  } else {
    const diasSync =
      input.lastSyncAt != null ? diasEntre(input.now, input.lastSyncAt) : null;
    if (diasSync != null && diasSync > SYNC_WARN_DIAS) {
      checks.push({
        clave: "cfdis",
        estado: "warn",
        titulo: "Sincronización de CFDIs desactualizada",
        detalle:
          `Hay ${input.cfdiCount} ${input.cfdiCount === 1 ? "CFDI" : "CFDIs"} en el periodo, pero la última sincronización fue hace ` +
          `${diasSync} días. Vuelve a sincronizar para no omitir facturas recientes.`,
        cta: { label: "Sincronizar CFDIs", href: "/facturas" },
      });
    } else {
      checks.push({
        clave: "cfdis",
        estado: "ok",
        titulo: "CFDIs del periodo sincronizados",
        detalle: `Hay ${input.cfdiCount} ${input.cfdiCount === 1 ? "CFDI sincronizado" : "CFDIs sincronizados"} para este mes.`,
      });
    }
  }

  // 2. Datos bancarios del periodo (fuente-agnóstico).
  if (input.requiereBalance) {
    if (input.bankTxCount === 0) {
      checks.push({
        clave: "banco",
        estado: "error",
        titulo: "Sin movimientos bancarios del periodo",
        detalle:
          "Sin banco el balance no cierra (Activo, Cuentas por cobrar y por pagar). " +
          "Conecta tu banco o sube tu estado de cuenta para este mes.",
        cta: { label: "Ir a Bancos", href: "/bancos?tab=cuentas" },
      });
    } else {
      checks.push({
        clave: "banco",
        estado: "ok",
        titulo: "Datos bancarios del periodo presentes",
        detalle: `Hay ${input.bankTxCount} ${input.bankTxCount === 1 ? "movimiento bancario registrado" : "movimientos bancarios registrados"} en este mes.`,
      });
    }
  } else if (input.bankTxCount === 0) {
    // Régimen sin balance: la falta de banco no rompe la CE, sólo se señala.
    checks.push({
      clave: "banco",
      estado: "warn",
      titulo: "Sin movimientos bancarios del periodo",
      detalle:
        "Tu régimen no exige balance, así que la CE puede generarse sin banco. " +
        "Aun así, registrar tus movimientos mejora la precisión de la contabilidad.",
      cta: { label: "Ir a Bancos", href: "/bancos?tab=cuentas" },
    });
  } else {
    checks.push({
      clave: "banco",
      estado: "ok",
      titulo: "Datos bancarios del periodo presentes",
      detalle: `Hay ${input.bankTxCount} ${input.bankTxCount === 1 ? "movimiento bancario registrado" : "movimientos bancarios registrados"} en este mes.`,
    });
  }

  // 3. Movimientos sin clasificar (sólo aplica si hay banco).
  if (input.bankTxCount > 0) {
    if (input.bankUnmatchedCount > 0) {
      checks.push({
        clave: "sin_clasificar",
        estado: "warn",
        titulo: `${input.bankUnmatchedCount} ${input.bankUnmatchedCount === 1 ? "movimiento sin clasificar" : "movimientos sin clasificar"}`,
        detalle:
          `${input.bankUnmatchedCount === 1 ? "Queda un movimiento bancario" : `Quedan ${input.bankUnmatchedCount} movimientos bancarios`} sin conciliar ni ` +
          "categorizar. Mientras no se resuelvan, no entran a la contabilidad y el mes no cierra.",
        cta: { label: "Clasificar en Bancos", href: "/bancos?tab=movimientos" },
      });
    } else {
      checks.push({
        clave: "sin_clasificar",
        estado: "ok",
        titulo: "Todos los movimientos clasificados",
        detalle: "No quedan movimientos bancarios sin conciliar ni categorizar.",
      });
    }
  }

  // 4. Balanza cuadra (cargos == abonos dentro de tolerancia).
  const diff = Math.abs(input.totalCargos - input.totalAbonos);
  if (diff > TOLERANCIA_CUADRE) {
    checks.push({
      clave: "cuadre",
      estado: "error",
      titulo: "La balanza no cuadra",
      detalle:
        `Los cargos (${input.totalCargos.toFixed(2)}) y los abonos ` +
        `(${input.totalAbonos.toFixed(2)}) no coinciden; diferencia de ` +
        `${diff.toFixed(2)}. Revisa los movimientos del periodo antes de generar la CE.`,
      cta: { label: "Ver balanza", href: "/contabilidad/balanza" },
    });
  } else {
    checks.push({
      clave: "cuadre",
      estado: "ok",
      titulo: "La balanza cuadra",
      detalle: "Los cargos y los abonos del periodo coinciden.",
    });
  }

  // 5. Mes posteado (definitivo) o preliminar.
  if (input.posted) {
    checks.push({
      clave: "posteo",
      estado: "ok",
      titulo: "Mes cerrado",
      detalle: "El periodo está cerrado; los XML reflejan los asientos definitivos.",
    });
  } else {
    checks.push({
      clave: "posteo",
      estado: "warn",
      titulo: "Mes preliminar",
      detalle:
        "El mes aún no se ha contabilizado: la descarga de los XML del SAT (balanza, pólizas y " +
        "auxiliares) está bloqueada hasta contabilizar y cerrar el periodo en “Cierre del mes”.",
      cta: { label: "Cerrar mes", href: "/contabilidad/cierre" },
    });
  }

  // 6. (Opcional) Capital inicial — sólo para empresas nuevas y cuando es
  // trivial determinarlo. Nota suave; nunca bloquea.
  if (input.esEmpresaNueva && input.tieneCapitalInicial === false) {
    checks.push({
      clave: "capital_inicial",
      estado: "warn",
      titulo: "Aportación de capital inicial no registrada",
      detalle:
        "No se detecta la aportación de capital inicial de los socios. En una empresa nueva " +
        "debe estar registrada para que el balance arranque del saldo correcto.",
      cta: { label: "Registrar saldos iniciales", href: "/contabilidad/apertura" },
    });
  }

  // Estado global.
  const hayError = checks.some((c) => c.estado === "error");
  const hayWarn = checks.some((c) => c.estado === "warn");
  const status: ReadinessStatus = hayError
    ? "incompleta"
    : hayWarn
      ? "con_huecos"
      : "lista";

  const resumen =
    status === "lista"
      ? "Lista para el SAT — generada de tus movimientos y cuadra."
      : status === "con_huecos"
        ? "Casi lista — resuelve los pendientes marcados para que la CE sea definitiva."
        : "Incompleta — faltan datos para que la Contabilidad Electrónica sea confiable.";

  return { status, resumen, checks };
}

// ─────────────────────────────────────────────────────────────────────────────
// EVALUACIÓN CON DB — resuelve los hechos del periodo y delega en evaluarChecks.
// Reutiliza balanza()/balanzaPreview() para el cuadre (no recalcula contabilidad)
// y las mismas tablas que el motor de posteo y la pantalla de Bancos.
// ─────────────────────────────────────────────────────────────────────────────
export async function evaluarReadinessCE(
  companyId: string,
  year: number,
  month: number,
  now: Date = new Date()
): Promise<ReadinessResult> {
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));

  const [company, period, cfdiCount, bankTxCount, bankUnmatchedCount] = await Promise.all([
    prisma.company.findUnique({
      where: { id: companyId },
      select: { regimenFiscal: true, lastAutoSyncAt: true, createdAt: true },
    }),
    prisma.accountingPeriod.findUnique({
      where: { companyId_year_month: { companyId, year, month } },
      select: { status: true },
    }),
    prisma.invoice.count({
      where: {
        companyId,
        status: "STAMPED",
        tipo: { in: ["INGRESO", "EGRESO", "NOMINA"] },
        fecha: { gte: start, lt: end },
      },
    }),
    prisma.bankTransaction.count({
      where: { companyId, fecha: { gte: start, lt: end } },
    }),
    prisma.bankTransaction.count({
      where: { companyId, fecha: { gte: start, lt: end }, status: "UNMATCHED" },
    }),
  ]);

  if (!company) throw new Error("Empresa no encontrada");

  const posted = period?.status === "POSTED" || period?.status === "CLOSED";

  // Cuadre: balanza real si está posteado, preliminar si no. Sumamos cargos y
  // abonos sobre TODAS las filas (no recalculamos la matemática contable).
  const rows = posted
    ? await balanza(companyId, year, month)
    : await balanzaPreview(companyId, year, month);
  let totalCargos = 0;
  let totalAbonos = 0;
  for (const r of rows) {
    totalCargos += r.cargos;
    totalAbonos += r.abonos;
  }

  const requiereBalance = regimenRequiereBalance(company.regimenFiscal);

  // Empresa nueva: creada dentro del año del periodo (heurística trivial). El
  // capital inicial sólo se señala cuando es barato detectarlo; por defecto no
  // afirmamos su ausencia (undefined) para no inventar el check.
  const esEmpresaNueva = company.createdAt.getUTCFullYear() === year;

  return evaluarChecks({
    cfdiCount,
    lastSyncAt: company.lastAutoSyncAt,
    now,
    bankTxCount,
    bankUnmatchedCount,
    totalCargos,
    totalAbonos,
    posted,
    requiereBalance,
    esEmpresaNueva,
    // tieneCapitalInicial se deja sin resolver: detectarlo con certeza requeriría
    // inspeccionar asientos APERTURA/clasificación CAPITAL, lo que no es trivial
    // ni barato aquí. Al ser undefined, el check de capital inicial se omite.
  });
}
