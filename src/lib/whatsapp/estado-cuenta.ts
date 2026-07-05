import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { persistTransactions } from "@/lib/bancos/import";
import { registrarBitacora } from "@/lib/audit";
import type { ParsedTransaction, RowDescartada } from "@/lib/bank-parser";

// ─────────────────────────────────────────────────────────────────────────────
// Estado de cuenta por WhatsApp — lógica de decisión del flujo de intake.
//
// El contador manda una foto/PDF del estado de cuenta (o el CSV del banco) y
// los movimientos aterrizan como BankTransaction vía el pipeline de
// importación existente (persistTransactions: dedup + auto-categorización).
//
// SEGURIDAD (roadmap §4):
//   - El archivo crudo NUNCA se persiste: se procesa en memoria y se descarta.
//     Lo único que puede quedar en la BD son filas parseadas (movimientos) —
//     ya sea importadas, o cacheadas temporalmente en el pendingAction de la
//     conversación mientras el usuario elige la cuenta destino.
//   - CANDADO DE BALANCE: la extracción por visión NUNCA se ingiere a ciegas.
//     Sólo se importa si saldoInicial + Σ movimientos ≈ saldoFinal (tolerancia
//     $1.00). Si los saldos no aparecen o no cuadran, NO se importa nada y se
//     pide una imagen más clara o el CSV del banco.
//
// Este módulo separa la DECISIÓN (funciones puras, testeables sin BD ni LLM)
// de la EJECUCIÓN (importar / escenificar pendiente). La llamada a visión vive
// en src/lib/bancos/vision-statement.ts y se inyecta desde media.ts, así los
// tests trabajan con extracciones falsas.
// ─────────────────────────────────────────────────────────────────────────────

/** Tolerancia del candado de balance, en MXN. */
export const TOLERANCIA_BALANCE = 1.0;

/** Tope de tamaño para adjuntos de WhatsApp (espeja el upload web de 15 MB). */
export const MAX_MEDIA_BYTES = 15 * 1024 * 1024;

/** El pendiente de selección de cuenta expira igual que las confirmaciones. */
const TTL_MS = 15 * 60 * 1000;

const MXN = (n: number) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
const round2 = (n: number) => Math.round(n * 100) / 100;

// ── Candado de balance (función pura) ────────────────────────────────────────

export type ResultadoBalance =
  | { estado: "CUADRA"; esperado: number; diferencia: number }
  | { estado: "NO_CUADRA"; esperado: number; diferencia: number }
  | { estado: "SIN_SALDOS" };

/**
 * Verifica saldoInicial + Σ montos ≈ saldoFinal (tolerancia $1.00 por
 * redondeos). Si falta cualquiera de los dos saldos NO se puede verificar y el
 * candado responde SIN_SALDOS — que para WhatsApp equivale a NO importar,
 * porque este canal no tiene pantalla de revisión.
 */
export function verificarBalance(input: {
  saldoInicial: number | null;
  saldoFinal: number | null;
  montos: number[];
  tolerancia?: number;
}): ResultadoBalance {
  const { saldoInicial, saldoFinal, montos } = input;
  const tolerancia = input.tolerancia ?? TOLERANCIA_BALANCE;
  if (saldoInicial == null || saldoFinal == null) return { estado: "SIN_SALDOS" };

  const suma = round2(montos.reduce((s, m) => s + m, 0));
  const esperado = round2(saldoInicial + suma);
  const diferencia = round2(esperado - saldoFinal);
  return Math.abs(diferencia) <= tolerancia
    ? { estado: "CUADRA", esperado, diferencia }
    : { estado: "NO_CUADRA", esperado, diferencia };
}

// ── Resolución de cuenta destino (función pura) ──────────────────────────────

export interface CuentaCandidata {
  id: string;
  banco: string;
  nombre: string;
  numeroCuenta: string;
  clabe: string | null;
}

export type ResolucionCuenta =
  | { tipo: "UNICA"; cuenta: CuentaCandidata }
  | { tipo: "MATCH_ULTIMOS4"; cuenta: CuentaCandidata; ultimos4: string }
  | { tipo: "VARIAS"; cuentas: CuentaCandidata[] }
  | { tipo: "NINGUNA" };

/** Últimos 4 dígitos de un número de cuenta (ignora espacios/guiones/asteriscos). */
export function ultimos4Digitos(numero: string | null | undefined): string | null {
  const digitos = (numero ?? "").replace(/\D/g, "");
  return digitos.length >= 4 ? digitos.slice(-4) : null;
}

/**
 * Decide la cuenta destino:
 *   - 0 cuentas → NINGUNA (hay que crearla en /bancos).
 *   - 1 cuenta → UNICA (se usa directo).
 *   - N cuentas y la extracción trae un número cuya terminación coincide con
 *     EXACTAMENTE una cuenta (numeroCuenta o CLABE) → MATCH_ULTIMOS4.
 *   - En cualquier otro caso → VARIAS (preguntar con lista numerada).
 */
export function resolverCuentaDestino(
  cuentas: CuentaCandidata[],
  numeroCuentaExtraido: string | null
): ResolucionCuenta {
  if (cuentas.length === 0) return { tipo: "NINGUNA" };
  if (cuentas.length === 1) return { tipo: "UNICA", cuenta: cuentas[0] };

  const ultimos4 = ultimos4Digitos(numeroCuentaExtraido);
  if (ultimos4) {
    const matches = cuentas.filter(
      (c) =>
        ultimos4Digitos(c.numeroCuenta) === ultimos4 ||
        ultimos4Digitos(c.clabe) === ultimos4
    );
    if (matches.length === 1) return { tipo: "MATCH_ULTIMOS4", cuenta: matches[0], ultimos4 };
  }
  return { tipo: "VARIAS", cuentas };
}

// ── Decisión de ingesta para la extracción por visión (función pura) ─────────

/** Subconjunto de StatementExtraction que necesita la decisión (evita acoplar
 *  los tests al módulo de visión). */
export interface ExtraccionParaDecision {
  banco: string | null;
  numeroCuenta: string | null;
  periodo: string | null;
  transactions: ParsedTransaction[];
  saldoInicial: number | null;
  saldoFinal: number | null;
}

export type DecisionIngesta =
  | { accion: "SIN_MOVIMIENTOS"; mensaje: string }
  | { accion: "BALANCE_NO_VERIFICABLE"; mensaje: string }
  | { accion: "BALANCE_NO_CUADRA"; mensaje: string }
  | { accion: "SIN_CUENTAS"; mensaje: string }
  | { accion: "IMPORTAR"; cuenta: CuentaCandidata; notaCuenta: string | null }
  | { accion: "ELEGIR_CUENTA"; cuentas: CuentaCandidata[]; mensaje: string };

/**
 * Orquesta las reglas del intake por visión: primero el CANDADO DE BALANCE
 * (nunca ingerir a ciegas), después la resolución de cuenta. Pura: no toca BD
 * ni LLM, por eso es la superficie principal de tests.
 */
export function decidirIngesta(
  extraccion: ExtraccionParaDecision,
  cuentas: CuentaCandidata[]
): DecisionIngesta {
  if (extraccion.transactions.length === 0) {
    return {
      accion: "SIN_MOVIMIENTOS",
      mensaje:
        "No detecté movimientos en ese estado de cuenta. Envía una imagen más clara o el archivo CSV/Excel del banco.",
    };
  }

  const balance = verificarBalance({
    saldoInicial: extraccion.saldoInicial,
    saldoFinal: extraccion.saldoFinal,
    montos: extraccion.transactions.map((t) => t.monto),
  });

  if (balance.estado === "SIN_SALDOS") {
    return {
      accion: "BALANCE_NO_VERIFICABLE",
      mensaje:
        "No pude leer el saldo inicial y el saldo final del periodo, así que no puedo verificar que la lectura sea correcta y no importé nada. " +
        "Envía una imagen que incluya los saldos del periodo, o el archivo CSV/Excel del banco.",
    };
  }

  if (balance.estado === "NO_CUADRA") {
    return {
      accion: "BALANCE_NO_CUADRA",
      mensaje: mensajeBalanceNoCuadra({
        saldoInicial: extraccion.saldoInicial!,
        saldoFinal: extraccion.saldoFinal!,
        esperado: balance.esperado,
        diferencia: balance.diferencia,
        movimientos: extraccion.transactions.length,
      }),
    };
  }

  const resolucion = resolverCuentaDestino(cuentas, extraccion.numeroCuenta);
  switch (resolucion.tipo) {
    case "NINGUNA":
      return { accion: "SIN_CUENTAS", mensaje: mensajeSinCuentas() };
    case "UNICA":
      return { accion: "IMPORTAR", cuenta: resolucion.cuenta, notaCuenta: null };
    case "MATCH_ULTIMOS4":
      return {
        accion: "IMPORTAR",
        cuenta: resolucion.cuenta,
        notaCuenta: `La asigné a la cuenta ${etiquetaCuenta(resolucion.cuenta)} porque la terminación ${resolucion.ultimos4} coincide.`,
      };
    case "VARIAS":
      return {
        accion: "ELEGIR_CUENTA",
        cuentas: resolucion.cuentas,
        mensaje: mensajeSeleccionCuenta(resolucion.cuentas, {
          banco: extraccion.banco,
          movimientos: extraccion.transactions.length,
        }),
      };
  }
}

// ── Mensajes (español formal, texto plano, sin emojis ni markdown) ───────────

export function etiquetaCuenta(c: CuentaCandidata): string {
  const term = ultimos4Digitos(c.numeroCuenta) ?? ultimos4Digitos(c.clabe);
  return `${c.banco} ${c.nombre}${term ? ` (terminación ${term})` : ""}`;
}

export function mensajeSinCuentas(): string {
  return (
    "Recibí tu estado de cuenta, pero esta empresa no tiene cuentas bancarias registradas. " +
    "Crea la cuenta en la sección Bancos de la aplicación (/bancos) y vuelve a enviármelo."
  );
}

export function mensajeBalanceNoCuadra(d: {
  saldoInicial: number;
  saldoFinal: number;
  esperado: number;
  diferencia: number;
  movimientos: number;
}): string {
  return (
    `Leí ${d.movimientos} movimientos, pero el saldo no cuadra: saldo inicial ${MXN(d.saldoInicial)} ` +
    `más los movimientos da ${MXN(d.esperado)}, y el estado de cuenta reporta ${MXN(d.saldoFinal)} ` +
    `(diferencia de ${MXN(Math.abs(d.diferencia))}). No importé nada para no registrar información incorrecta. ` +
    "Es probable que falten o sobren movimientos en la lectura. Envía una foto más clara o el archivo CSV/Excel del banco."
  );
}

export function mensajeSeleccionCuenta(
  cuentas: CuentaCandidata[],
  ctx: { banco: string | null; movimientos: number }
): string {
  const origen = ctx.banco ? ` de ${ctx.banco}` : "";
  const lineas = cuentas.map((c, i) => `${i + 1}) ${etiquetaCuenta(c)}`);
  return (
    `Leí tu estado de cuenta${origen}: ${ctx.movimientos} movimientos y el saldo cuadra. ` +
    "¿A qué cuenta pertenece? Responde con el número:\n" +
    lineas.join("\n") +
    "\nO responde \"cancelar\" para descartarlo."
  );
}

export function mensajeResumenImportacion(d: {
  banco: string | null;
  periodo: string | null;
  importados: number;
  yaExistian: number;
  descartadas: RowDescartada[];
  saldoVerificado: boolean;
  notaCuenta?: string | null;
}): string {
  const origen = d.banco ? ` de ${d.banco}` : "";
  const periodo = d.periodo ? ` (${d.periodo})` : "";
  let msg =
    `Recibí tu estado de cuenta${origen}${periodo}: ${d.importados} movimientos importados, ` +
    `${d.yaExistian} ya existían, ${d.descartadas.length} filas descartadas.`;
  if (d.descartadas.length > 0) {
    const motivos = d.descartadas.slice(0, 3).map((r) => `fila ${r.fila}: ${r.motivo}`);
    msg += ` Descartadas: ${motivos.join("; ")}${d.descartadas.length > 3 ? "; entre otras" : ""}.`;
  }
  msg += d.saldoVerificado ? " El saldo cuadra." : "";
  if (d.notaCuenta) msg += ` ${d.notaCuenta}`;
  msg += " Revísalos en Bancos o pídeme conciliarlos.";
  return msg;
}

// ── Pendiente de selección de cuenta (estado en la conversación) ─────────────

/** Movimiento serializable para el Json de pendingAction (fecha en ISO). */
export interface MovimientoSerializado {
  fecha: string; // ISO
  descripcion: string;
  monto: number;
  referencia: string | null;
  saldo: number | null;
}

/**
 * Pendiente de importación a la espera de que el usuario elija la cuenta con
 * un número. Cachea las FILAS PARSEADAS (no el archivo crudo — seguridad) más
 * los metadatos para la bitácora y el resumen. Un solo uso, TTL de 15 min,
 * mismo mecanismo que las confirmaciones de escritura (pending-action.ts).
 */
export interface PendingImportEstado {
  type: "importar_estado";
  expiresAt: number;
  companyId: string;
  /** Razón social de la empresa DESTINO — se muestra al confirmar para que un
   *  usuario de despacho no importe a la empresa equivocada por descuido. */
  companyName: string;
  origen: "vision" | "archivo";
  banco: string | null;
  periodo: string | null;
  saldoVerificado: boolean;
  movimientos: MovimientoSerializado[];
  descartadas: RowDescartada[];
  cuentas: { id: string; etiqueta: string; terminacion: string | null }[];
  /** Cuenta por omisión (única o coincidente): "sí" la confirma sin pedir número. */
  defaultCuentaId?: string | null;
  /** El banco del archivo NO coincide con el de la cuenta destino → advertir. */
  bancoMismatch?: boolean;
}

/**
 * ¿El banco detectado en el archivo difiere del de la cuenta destino? Compara sin
 * acentos ni mayúsculas por contención (BBVA Bancomer ~ BBVA). Si no se detectó
 * banco en el archivo, NO se puede afirmar que difiera → false. PURA.
 */
export function bancosDifieren(detectado: string | null, cuentaBanco: string | null): boolean {
  if (!detectado || !cuentaBanco) return false;
  const n = (s: string) =>
    s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  const a = n(detectado);
  const b = n(cuentaBanco);
  if (!a || !b) return false;
  return !(a.includes(b) || b.includes(a));
}

export function serializarMovimientos(txs: ParsedTransaction[]): MovimientoSerializado[] {
  return txs.map((t) => ({
    fecha: t.fecha.toISOString(),
    descripcion: t.descripcion,
    monto: t.monto,
    referencia: t.referencia ?? null,
    saldo: t.saldo ?? null,
  }));
}

export function deserializarMovimientos(movs: MovimientoSerializado[]): ParsedTransaction[] {
  return movs.map((m) => ({
    fecha: new Date(m.fecha),
    descripcion: m.descripcion,
    monto: m.monto,
    referencia: m.referencia ?? undefined,
    saldo: m.saldo ?? undefined,
  }));
}

/** Escenifica el pendiente en la conversación (sobrescribe cualquier otro). */
export async function stagePendingImportEstado(
  conversationId: string,
  data: Omit<PendingImportEstado, "type" | "expiresAt">
): Promise<void> {
  const pending: PendingImportEstado = { type: "importar_estado", expiresAt: Date.now() + TTL_MS, ...data };
  await prisma.whatsappConversation.update({
    where: { id: conversationId },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { pendingAction: pending as any },
  });
}

async function clearPending(conversationId: string): Promise<void> {
  await prisma.whatsappConversation.update({
    where: { id: conversationId },
    // DbNull, no undefined: Prisma ignora undefined y el Json quedaría vivo.
    data: { pendingAction: Prisma.DbNull },
  });
}

// ── Interpretación de la respuesta (pura) ────────────────────────────────────

export type RespuestaSeleccion =
  | { tipo: "CANCELAR" }
  | { tipo: "CONFIRMAR" } // "sí" — confirma la cuenta por omisión
  | { tipo: "SELECCION"; indice: number } // 0-based, ya validado contra el rango
  | { tipo: "FUERA_DE_RANGO" }
  | { tipo: "OTRO" };

export function interpretarRespuestaSeleccion(body: string, numCuentas: number): RespuestaSeleccion {
  const texto = body.trim().toLowerCase();
  if (/^(cancelar|cancela|no)\b/.test(texto)) return { tipo: "CANCELAR" };
  if (/^(s[íi]|confirm[ao]|confirmar|ok|okay|dale|va|correcto|adelante|de acuerdo)(?![a-zñáéíóúü])/.test(texto))
    return { tipo: "CONFIRMAR" };
  const m = texto.match(/^(\d{1,2})$/);
  if (!m) return { tipo: "OTRO" };
  const idx = parseInt(m[1], 10) - 1;
  if (idx < 0 || idx >= numCuentas) return { tipo: "FUERA_DE_RANGO" };
  return { tipo: "SELECCION", indice: idx };
}

/**
 * Mensaje de CONFIRMACIÓN antes de importar (guardarraíl): nombra la empresa y la
 * cuenta destino y, si el banco del archivo no coincide con el de la cuenta,
 * ADVIERTE. Evita que un estado de cuenta caiga en la empresa/cuenta equivocada.
 */
export function mensajeConfirmarImportacion(d: {
  companyName: string;
  cuentaEtiqueta: string;
  bancoDetectado: string | null;
  movimientos: number;
  bancoMismatch: boolean;
}): string {
  const de = d.bancoDetectado ? ` de ${d.bancoDetectado}` : "";
  let msg =
    `Voy a importar ${d.movimientos} movimiento${d.movimientos === 1 ? "" : "s"}${de} ` +
    `a la cuenta *${d.cuentaEtiqueta}* de *${d.companyName}*.`;
  if (d.bancoMismatch) {
    msg +=
      `\n\n⚠️ Ojo: el archivo parece ser${de}, pero esa cuenta es de otro banco. ` +
      `Verifica que estés subiéndolo a la empresa y cuenta correctas.`;
  }
  msg += `\n\nResponde *sí* para confirmar, o *cambiar de empresa* si va a otra. También puedes escribir *cancelar*.`;
  return msg;
}

// ── Ejecución: importar a la cuenta elegida ──────────────────────────────────

/** Importa movimientos por el pipeline existente y registra la bitácora
 *  (bancos.import-whatsapp — sólo metadatos, nunca números de cuenta más allá
 *  de la terminación). */
export async function importarMovimientosWhatsapp(opts: {
  companyId: string;
  bankAccountId: string;
  transactions: ParsedTransaction[];
  origen: "vision" | "archivo";
  banco: string | null;
  periodo: string | null;
  cuentaTerminacion: string | null;
  descartadas: RowDescartada[];
}): Promise<{ imported: number; skipped: number }> {
  const { imported, skipped } = await persistTransactions({
    bankAccountId: opts.bankAccountId,
    companyId: opts.companyId,
    transactions: opts.transactions,
    source: "WHATSAPP",
    banco: opts.banco,
    periodo: opts.periodo,
  });
  registrarBitacora({
    companyId: opts.companyId,
    accion: "bancos.import-whatsapp",
    entidad: "BankAccount",
    entidadId: opts.bankAccountId,
    detalle: {
      origen: opts.origen,
      banco: opts.banco,
      periodo: opts.periodo,
      cuentaTerminacion: opts.cuentaTerminacion,
      importados: imported,
      posiblesDuplicados: skipped,
      descartadas: opts.descartadas.length,
    },
  });
  return { imported, skipped };
}

/**
 * Reanuda un pendiente "importar_estado" con la respuesta del usuario.
 * Un solo uso: la selección válida (o "cancelar") limpia el pendiente e
 * importa con las filas cacheadas; cualquier otro texto recuerda la pregunta
 * sin ejecutar nada. Lo invoca tryConfirmPendingAction (pending-action.ts).
 */
export async function resolverPendingImportEstado(
  conversationId: string,
  pending: PendingImportEstado,
  body: string
): Promise<string> {
  const respuesta = interpretarRespuestaSeleccion(body, pending.cuentas.length);

  if (respuesta.tipo === "CANCELAR") {
    await clearPending(conversationId);
    return "Cancelado. No se importó ningún movimiento.";
  }

  // "sí" confirma la cuenta por omisión (única o coincidente). Si no hay cuenta
  // por omisión (varias sin match), pedimos el número.
  let indiceElegido: number | null = null;
  if (respuesta.tipo === "CONFIRMAR") {
    const idx = pending.defaultCuentaId
      ? pending.cuentas.findIndex((c) => c.id === pending.defaultCuentaId)
      : -1;
    if (idx < 0) {
      const lineas = pending.cuentas.map((c, i) => `${i + 1}) ${c.etiqueta}`);
      return (
        "¿A cuál cuenta la importo? Responde con el número:\n" +
        lineas.join("\n") +
        '\nO responde "cancelar" para descartarlo.'
      );
    }
    indiceElegido = idx;
  } else if (respuesta.tipo === "SELECCION") {
    indiceElegido = respuesta.indice;
  }

  if (indiceElegido == null) {
    // FUERA_DE_RANGO / OTRO: recordar la pregunta sin importar.
    const lineas = pending.cuentas.map((c, i) => `${i + 1}) ${c.etiqueta}`);
    const encabezado =
      respuesta.tipo === "FUERA_DE_RANGO"
        ? "Ese número no corresponde a ninguna cuenta."
        : pending.cuentas.length === 1
          ? `Tienes un estado de cuenta pendiente de importar a *${pending.companyName}*. Responde *sí* para confirmar`
          : "Tienes un estado de cuenta pendiente de asignar. Responde con el número de la cuenta";
    if (pending.cuentas.length === 1) {
      return `${encabezado}, o *cancelar* para descartarlo.`;
    }
    return `${encabezado}:\n` + lineas.join("\n") + '\nO responde "cancelar" para descartarlo.';
  }

  // Selección válida → un solo uso: limpiar ANTES de importar para que un
  // reintento de Twilio o un doble mensaje no importe dos veces.
  await clearPending(conversationId);
  const cuenta = pending.cuentas[indiceElegido];

  try {
    const { imported, skipped } = await importarMovimientosWhatsapp({
      companyId: pending.companyId,
      bankAccountId: cuenta.id,
      transactions: deserializarMovimientos(pending.movimientos),
      origen: pending.origen,
      banco: pending.banco,
      periodo: pending.periodo,
      cuentaTerminacion: cuenta.terminacion,
      descartadas: pending.descartadas,
    });
    return (
      mensajeResumenImportacion({
        banco: pending.banco,
        periodo: pending.periodo,
        importados: imported,
        yaExistian: skipped,
        descartadas: pending.descartadas,
        saldoVerificado: pending.saldoVerificado,
        notaCuenta: `Los registré en la cuenta ${cuenta.etiqueta}.`,
      }) + (imported > 0 ? '\n\n¿Te equivocaste de empresa o cuenta? Dime "deshacer importación".' : "")
    );
  } catch (e) {
    console.error("[whatsapp] import estado (pendiente) error", e);
    return "Tuve un problema importando los movimientos. Vuelve a enviarme el estado de cuenta o súbelo desde la aplicación.";
  }
}
