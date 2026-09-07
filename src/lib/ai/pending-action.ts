import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { registrarBitacora } from "@/lib/audit";
import { reconcileTransaction } from "@/lib/conciliacion";
import { aprobarSugerencia } from "@/lib/bancos/sugerencias-concepto";
import { aplicarReglaRetroactiva, upsertReglaCategorizacion } from "@/lib/bancos/reglas-categorizacion";
import type { FamiliaConcepto, SignoMovimiento } from "@/lib/bancos/categorizar-concepto";

// ─────────────────────────────────────────────────────────────────────────────
// Gate de acciones del asistente DENTRO de la app (Fase B — "el contador dentro
// de la app").
//
// CONTRATO DE SEGURIDAD (no negociable):
//   1. El modelo NUNCA ejecuta una escritura desde una llamada de herramienta.
//      Una herramienta "proponer_*" sólo STAGEA aquí una propuesta (resumen +
//      payload) sobre la conversación. La ejecución ocurre SÓLO cuando el humano
//      toca "Confirmar" (POST /api/ai/confirm). El modelo no puede auto-confirmar.
//   2. Sólo se permiten acciones REVERSIBLES:
//        - conciliar         (aplicar un match banco↔CFDI)
//        - categorizacion    (aprobar la categoría de un concepto → ledger)
//        - resolver_hallazgo / posponer_hallazgo
//        - marcar_pendiente  (hecho / pospuesto)
//   3. Acciones IRREVERSIBLES (timbrar, dispersar/pagar, presentar al SAT) están
//      PROHIBIDAS como herramientas — no se pueden stagear (ver isReversibleType).
//   4. Stage y confirm re-validan autz e idempotencia. La confirmación es de un
//      solo uso, acotada a la conversación, con TTL.
//
// La confirmación es por TAP (no hay código de 6 dígitos como en WhatsApp): el
// canal in-app ya está autenticado por sesión, y cada confirm re-checa membresía
// y rechaza VIEWER. El tap ES la confirmación.
// ─────────────────────────────────────────────────────────────────────────────

export const PENDING_ACTION_TTL_MS = 15 * 60 * 1000; // 15 min

/** Tipos de acción reversibles que el asistente puede proponer. */
export type PendingActionType =
  | "conciliar"
  | "categorizacion"
  | "categorizacion_lote"
  | "resolver_hallazgo"
  | "posponer_hallazgo"
  | "marcar_pendiente"
  | "confirmar_paso"
  | "omitir_paso"
  | "fijar_coeficiente"
  | "fijar_perdida"
  | "fijar_saldo_favor_iva"
  | "firmar_conciliacion"
  | "marcar_diot_presentada"
  | "fijar_agrupador"
  | "confirmar_apertura";

/** Acciones irreversibles — JAMÁS stageables. Se documentan para los tests. */
export const IRREVERSIBLE_TYPES = ["timbrar", "dispersar", "pagar", "presentar"] as const;

interface BasePending {
  /** Token de un solo uso, ligado a esta conversación. */
  token: string;
  expiresAt: number;
  companyId: string;
  /** Resumen legible (lo que EXACTAMENTE pasará al confirmar). */
  summary: string;
}

export type ChatPendingAction =
  | (BasePending & { type: "conciliar"; payload: { txId: string; invoiceId: string } })
  | (BasePending & { type: "categorizacion"; payload: { txId: string; familia: FamiliaConcepto } })
  | (BasePending & {
      type: "categorizacion_lote";
      payload: { patron: string; familia: FamiliaConcepto; signo?: SignoMovimiento; crearRegla?: boolean };
    })
  | (BasePending & { type: "resolver_hallazgo"; payload: { hallazgoId: string } })
  | (BasePending & {
      type: "posponer_hallazgo";
      payload: { hallazgoId: string; token: "7d" | "30d" | "fin_de_mes" };
    })
  | (BasePending & {
      type: "marcar_pendiente";
      payload: { itemId: string; accion: "hecho" | "posponer" };
    })
  // Cierre guiado: confirmar/omitir un paso desde la conversación. Reversible
  // (el paso se reabre) y re-valida el hash de la evidencia al ejecutar: si
  // los datos cambiaron entre la propuesta y el tap, se rechaza.
  | (BasePending & {
      type: "confirmar_paso";
      payload: { year: number; month: number; clave: string; hashEsperado: string };
    })
  | (BasePending & {
      type: "omitir_paso";
      payload: { year: number; month: number; clave: string; hashEsperado: string; motivo: string };
    })
  // Punto de partida: capturar el coeficiente de utilidad del ejercicio y
  // estampar la confirmación de la apertura. Reversibles (se vuelven a fijar);
  // la bitácora guarda el valor anterior para poder deshacer a mano.
  | (BasePending & { type: "fijar_coeficiente"; payload: { valor: number; anio: number; anterior: number | null } })
  | (BasePending & {
      type: "fijar_perdida";
      payload: { valor: number; anio: number | null; anterior: number | null; origen: string };
    })
  | (BasePending & {
      type: "fijar_saldo_favor_iva";
      payload: { valor: number; anterior: number | null; origen: string };
    })
  | (BasePending & {
      type: "firmar_conciliacion";
      payload: { bankAccountId: string; year: number; month: number; etiqueta: string };
    })
  | (BasePending & {
      type: "marcar_diot_presentada";
      payload: { year: number; month: number; acuseUrl: string | null };
    })
  // El código agrupador del Anexo 24 de UNA cuenta del catálogo. `anterior`
  // queda en la bitácora para poder deshacerlo a mano.
  | (BasePending & {
      type: "fijar_agrupador";
      payload: { chartAccountId: string; cuenta: string; codAgrup: string; anterior: string | null };
    })
  | (BasePending & { type: "confirmar_apertura"; payload: Record<string, never> });

/** True si el tipo es una acción reversible permitida (lista blanca estricta). */
export function isReversibleType(type: string): type is PendingActionType {
  return (
    type === "conciliar" ||
    type === "categorizacion" ||
    type === "categorizacion_lote" ||
    type === "resolver_hallazgo" ||
    type === "posponer_hallazgo" ||
    type === "marcar_pendiente" ||
    type === "confirmar_paso" ||
    type === "omitir_paso" ||
    type === "fijar_coeficiente" ||
    type === "fijar_perdida" ||
    type === "fijar_saldo_favor_iva" ||
    type === "firmar_conciliacion" ||
    type === "marcar_diot_presentada" ||
    type === "fijar_agrupador" ||
    type === "confirmar_apertura"
  );
}

/**
 * Decisión PURA: dada la acción staged (o null), el token presentado y el
 * instante actual, ¿se puede confirmar? Testeable sin DB. NO ejecuta nada.
 *
 *   - none      → no hay acción pendiente
 *   - expired   → expiró por TTL (un solo uso ya implícito: tras ejecutar se borra)
 *   - mismatch  → el token no coincide (confirmación de otra propuesta)
 *   - ok        → procede ejecutar
 */
export function decideConfirm(
  pa: ChatPendingAction | null,
  presentedToken: string | undefined,
  now: number,
): { status: "none" | "expired" | "mismatch" | "ok" } {
  if (!pa) return { status: "none" };
  if (pa.expiresAt <= now) return { status: "expired" };
  if (presentedToken && presentedToken !== pa.token) return { status: "mismatch" };
  return { status: "ok" };
}

function genToken(): string {
  // Token opaco — no es un secreto descifrable por el usuario; el tap autenticado
  // es la autorización. Sólo evita confirmar una propuesta vieja por accidente.
  return `pa_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

// ── Persistencia (stage / read / clear) ──────────────────────────────────────

async function persist(conversationId: string, action: ChatPendingAction): Promise<ChatPendingAction> {
  await prisma.chatConversation.update({
    where: { id: conversationId },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { pendingAction: action as any },
  });
  return action;
}

/** Lee la acción pendiente (si existe y no expiró). */
export async function getChatPendingAction(conversationId: string): Promise<ChatPendingAction | null> {
  const conv = await prisma.chatConversation.findUnique({
    where: { id: conversationId },
    select: { pendingAction: true },
  });
  const pa = conv?.pendingAction as ChatPendingAction | null;
  if (!pa || pa.expiresAt <= Date.now()) return null;
  return pa;
}

/** Borra la acción pendiente (DbNull para realmente vaciar la columna Json). */
export async function clearChatPendingAction(conversationId: string): Promise<void> {
  await prisma.chatConversation.update({
    where: { id: conversationId },
    data: { pendingAction: Prisma.DbNull },
  });
}

// ── Stage (lo único que hacen las herramientas "proponer_*") ─────────────────

type StagePayload =
  | { type: "conciliar"; payload: { txId: string; invoiceId: string } }
  | { type: "categorizacion"; payload: { txId: string; familia: FamiliaConcepto } }
  | {
      type: "categorizacion_lote";
      payload: { patron: string; familia: FamiliaConcepto; signo?: SignoMovimiento; crearRegla?: boolean };
    }
  | { type: "resolver_hallazgo"; payload: { hallazgoId: string } }
  | { type: "posponer_hallazgo"; payload: { hallazgoId: string; token: "7d" | "30d" | "fin_de_mes" } }
  | { type: "marcar_pendiente"; payload: { itemId: string; accion: "hecho" | "posponer" } }
  | { type: "confirmar_paso"; payload: { year: number; month: number; clave: string; hashEsperado: string } }
  | {
      type: "omitir_paso";
      payload: { year: number; month: number; clave: string; hashEsperado: string; motivo: string };
    }
  | { type: "fijar_coeficiente"; payload: { valor: number; anio: number; anterior: number | null } }
  | { type: "fijar_perdida"; payload: { valor: number; anio: number | null; anterior: number | null; origen: string } }
  | { type: "fijar_saldo_favor_iva"; payload: { valor: number; anterior: number | null; origen: string } }
  | { type: "firmar_conciliacion"; payload: { bankAccountId: string; year: number; month: number; etiqueta: string } }
  | { type: "marcar_diot_presentada"; payload: { year: number; month: number; acuseUrl: string | null } }
  | {
      type: "fijar_agrupador";
      payload: { chartAccountId: string; cuenta: string; codAgrup: string; anterior: string | null };
    }
  | { type: "confirmar_apertura"; payload: Record<string, never> };

/**
 * STAGEA una acción reversible sobre la conversación. NO ejecuta. Devuelve la
 * propuesta con su token. Rechaza tipos irreversibles por contrato.
 */
export async function stageChatPendingAction(
  conversationId: string,
  companyId: string,
  summary: string,
  staged: StagePayload,
): Promise<ChatPendingAction> {
  if (!isReversibleType(staged.type)) {
    throw new Error(`Tipo de acción no permitido para el asistente: ${staged.type}`);
  }
  const action = {
    ...staged,
    token: genToken(),
    expiresAt: Date.now() + PENDING_ACTION_TTL_MS,
    companyId,
    summary,
  } as ChatPendingAction;
  return persist(conversationId, action);
}

// ── Execute (sólo desde el confirm endpoint, tras el tap humano) ─────────────

export type ExecuteResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * Ejecuta la acción ya confirmada. Cada rama REUSA la operación existente y es
 * IDEMPOTENTE + re-validada (rechaza si el estado cambió o ya se hizo). El
 * companyId aquí es el de la acción staged, ya re-verificado contra la membresía
 * en el endpoint de confirm. `confirmingUserId` es quien tocó "Confirmar": se usa
 * para las acciones cuyo alcance es POR USUARIO (los pendientes/bandeja), no por
 * empresa — así no se puede marcar el pendiente de otro usuario de la misma empresa.
 */
export async function executeChatPendingAction(
  pa: ChatPendingAction,
  confirmingUserId: string,
): Promise<ExecuteResult> {
  const r = await ejecutar(pa, confirmingUserId);
  // Cualquier acción confirmada puede mover la evidencia del cierre (conciliar
  // un movimiento, fijar el coeficiente…): la memo del motor se olvida para que
  // la siguiente lectura ya vea el cambio.
  if (r.ok) {
    const { invalidarCierre } = await import("../cierre/evaluar");
    invalidarCierre(pa.companyId);
  }
  return r;
}

async function ejecutar(
  pa: ChatPendingAction,
  confirmingUserId: string,
): Promise<ExecuteResult> {
  switch (pa.type) {
    case "conciliar": {
      // Reusa reconcileTransaction (mismo apply que stagePendingConciliar/preview).
      // Re-valida que el movimiento siga sin conciliar. El lado FACTURA también
      // se re-valida, dentro de reconcileTransaction (checkInvoiceMatchGuard):
      // si desde la propuesta la factura PUE ya se concilió con otro movimiento,
      // o el acumulado PPD excedería el total, regresa { ok:false, error } y la
      // confirmación falla con el mismo mensaje amable que los demás casos stale.
      const tx = await prisma.bankTransaction.findFirst({
        where: { id: pa.payload.txId, companyId: pa.companyId },
        select: {
          status: true,
          invoiceId: true,
          conciliacionDetalles: { select: { id: true }, take: 1 },
        },
      });
      if (!tx) return { ok: false, error: "El movimiento ya no existe." };
      if (tx.invoiceId || tx.conciliacionDetalles.length > 0) {
        return { ok: false, error: "El movimiento ya está conciliado; nada que hacer." };
      }
      const r = await reconcileTransaction(pa.payload.txId, pa.payload.invoiceId, pa.companyId);
      if (!r.ok) return { ok: false, error: r.error };
      return {
        ok: true,
        message: `Movimiento conciliado con la factura de ${r.cliente}${r.uuid ? ` (${r.uuid})` : ""}.`,
      };
    }

    case "categorizacion": {
      // Reusa aprobarSugerencia (idempotente: no duplica asientos; ledger).
      const tx = await prisma.bankTransaction.findFirst({
        where: { id: pa.payload.txId, companyId: pa.companyId },
        select: { id: true },
      });
      if (!tx) return { ok: false, error: "El movimiento ya no existe." };
      const r = await aprobarSugerencia(pa.payload.txId, pa.payload.familia);
      if (!r.ok) return { ok: false, error: r.error };
      return {
        ok: true,
        message: r.created
          ? "Movimiento categorizado y registrado en el libro mayor."
          : "El movimiento ya estaba categorizado; no se duplicó el asiento.",
      };
    }

    case "categorizacion_lote": {
      // Reusa el escaneo retroactivo (que a su vez reusa aprobarSugerencia,
      // idempotente) para categorizar TODOS los movimientos sin conciliar que
      // empatan con el patrón, y opcionalmente recuerda la regla. companyId ya
      // fue re-verificado contra la membresía en el endpoint de confirm.
      const { patron, familia, signo, crearRegla } = pa.payload;
      if (crearRegla !== false) {
        await upsertReglaCategorizacion({
          companyId: pa.companyId,
          pattern: patron,
          familia,
          signo: signo ?? null,
          createdBy: confirmingUserId,
        });
      }
      const res = await aplicarReglaRetroactiva(pa.companyId, patron, familia, signo ?? null);
      if (res.aprobados === 0) {
        return { ok: false, error: "No quedaron movimientos sin conciliar que empataran con ese patrón." };
      }
      return {
        ok: true,
        message:
          `${res.aprobados} movimiento(s) categorizados` +
          `${res.errores > 0 ? ` (${res.errores} no se pudieron)` : ""}` +
          `${crearRegla !== false ? " y la regla quedó guardada para futuros estados de cuenta." : "."}`,
      };
    }

    case "fijar_coeficiente": {
      // Mismo update que el botón «usar sugerido» de la pantalla de apertura
      // (/api/impuestos/coeficiente): fija el override del ejercicio. El valor
      // anterior queda en la bitácora para poder volver atrás a mano.
      const { valor, anio, anterior } = pa.payload;
      if (!Number.isFinite(valor) || valor < 0 || valor > 5) {
        return { ok: false, error: "El coeficiente está fuera de rango." };
      }
      const redondeado = Math.round(valor * 10000) / 10000;
      await prisma.company.update({
        where: { id: pa.companyId },
        data: { coeficienteUtilidad: redondeado, coeficienteAnio: anio },
      });
      registrarBitacora({
        companyId: pa.companyId,
        userId: confirmingUserId,
        accion: "apertura.coeficiente.fijar",
        entidad: "Company",
        entidadId: pa.companyId,
        detalle: { anio, antes: anterior, despues: redondeado, via: "copiloto" },
      });
      return {
        ok: true,
        message: `Coeficiente de utilidad del ejercicio ${anio} fijado en ${redondeado}. El ISR provisional ya se puede calcular con él.`,
      };
    }

    case "fijar_perdida": {
      // Mismo update que PATCH /api/companies/[id]/apertura (perdidaPendiente):
      // el remanente de pérdidas PM del Art. 14 que amortiza el provisional.
      // Un CERO es una captura válida y deliberada: dice «revisé la anual y no
      // hay pérdidas por amortizar», que no es lo mismo que no tener dato.
      const { valor, anio, anterior, origen } = pa.payload;
      if (!Number.isFinite(valor) || valor < 0) {
        return { ok: false, error: "El remanente de pérdidas debe ser un monto positivo (o cero)." };
      }
      const redondeado = Math.round(valor * 100) / 100;
      await prisma.company.update({
        where: { id: pa.companyId },
        data: { perdidaFiscalPendiente: redondeado, perdidaFiscalAnio: anio ?? null },
      });
      registrarBitacora({
        companyId: pa.companyId,
        userId: confirmingUserId,
        accion: "apertura.perdida.fijar",
        entidad: "Company",
        entidadId: pa.companyId,
        detalle: { anio, antes: anterior, despues: redondeado, origen, via: "copiloto" },
      });
      return {
        ok: true,
        message:
          redondeado === 0
            ? "Pérdidas por amortizar capturadas en $0 (revisado, no supuesto). El punto de partida deja de pedirlo."
            : `Pérdidas por amortizar del punto de partida fijadas en ${redondeado.toLocaleString("es-MX", { style: "currency", currency: "MXN" })}${anio ? ` (ejercicio ${anio})` : ""}.`,
      };
    }

    case "fijar_saldo_favor_iva": {
      // Mismo update que PATCH /api/companies/[id]/apertura
      // (ivaSaldoFavorInicial): escribe la fila IVA_MENSUAL del mes anterior al
      // primero computado — la MISMA que lee el arrastre del Art. 6 LIVA.
      const { valor, anterior, origen } = pa.payload;
      if (!Number.isFinite(valor) || valor < 0) {
        return { ok: false, error: "El saldo a favor inicial debe ser un monto positivo (o cero)." };
      }
      const redondeado = Math.round(valor * 100) / 100;
      const { guardarSaldoFavorInicial } = await import("@/lib/fiscal/apertura");
      const r = await guardarSaldoFavorInicial(pa.companyId, redondeado);
      registrarBitacora({
        companyId: pa.companyId,
        userId: confirmingUserId,
        accion: "apertura.saldo_favor_iva.fijar",
        entidad: "Company",
        entidadId: pa.companyId,
        detalle: { periodo: r.periodo, antes: anterior ?? r.anterior, despues: redondeado, origen, via: "copiloto" },
      });
      return {
        ok: true,
        message:
          redondeado === 0
            ? `Saldo a favor de IVA inicial capturado en $0 (revisado, no supuesto) en ${r.periodo}.`
            : `Saldo a favor de IVA inicial fijado en ${redondeado.toLocaleString("es-MX", { style: "currency", currency: "MXN" })} en ${r.periodo}.`,
      };
    }

    case "firmar_conciliacion": {
      // La MISMA firma que el botón «Dar por conciliada» de
      // /contabilidad/conciliacion. Reversible: ahí mismo se quita.
      const { bankAccountId, year, month, etiqueta } = pa.payload;
      const cuenta = await prisma.bankAccount.findFirst({
        where: { id: bankAccountId, companyId: pa.companyId },
        select: { id: true },
      });
      if (!cuenta) return { ok: false, error: "La cuenta bancaria ya no existe." };
      const { firmarConciliacion } = await import("@/lib/bancos/conciliacion-repo");
      await firmarConciliacion({
        companyId: pa.companyId,
        bankAccountId,
        year,
        month,
        userId: confirmingUserId,
        conciliado: true,
      });
      registrarBitacora({
        companyId: pa.companyId,
        userId: confirmingUserId,
        accion: "conciliacion.firmar",
        entidad: "ConciliacionBancaria",
        entidadId: bankAccountId,
        detalle: { year, month, cuenta: etiqueta, via: "copiloto" },
      });
      return {
        ok: true,
        message: `Conciliación de ${etiqueta} firmada para ${String(month).padStart(2, "0")}/${year}. Se puede quitar la firma en Contabilidad → Conciliación.`,
      };
    }

    case "marcar_diot_presentada": {
      // El MISMO update que el botón «Marcar presentada» de la tarjeta de la
      // DIOT (action file-diot). Reversible: ahí mismo se revierte.
      const { year, month, acuseUrl } = pa.payload;
      const periodo = `${year}-${String(month).padStart(2, "0")}`;
      const existente = await prisma.taxDeclaration.findFirst({
        where: { companyId: pa.companyId, tipo: "DIOT", periodo },
        select: { id: true, status: true },
      });
      if (existente && (existente.status === "FILED" || existente.status === "PAID")) {
        return { ok: false, error: `La DIOT de ${periodo} ya está marcada como presentada.` };
      }
      const datos = { status: "FILED" as const, fechaPresentacion: new Date(), ...(acuseUrl ? { acuseUrl } : {}) };
      if (existente) {
        await prisma.taxDeclaration.update({ where: { id: existente.id }, data: datos });
      } else {
        await prisma.taxDeclaration.create({
          data: { companyId: pa.companyId, tipo: "DIOT", periodo, ...datos },
        });
      }
      registrarBitacora({
        companyId: pa.companyId,
        userId: confirmingUserId,
        accion: "diot.presentar",
        entidad: "TaxDeclaration",
        entidadId: existente?.id ?? periodo,
        detalle: { periodo, acuseUrl: acuseUrl ?? null, via: "copiloto" },
      });
      return {
        ok: true,
        message: `DIOT de ${periodo} marcada como presentada. Si te equivocaste, se revierte en Impuestos → Presentar.`,
      };
    }

    case "fijar_agrupador": {
      // Sin el agrupador correcto el XML de contabilidad electrónica emite el
      // número propio de la cuenta y el SAT lo rechaza. Se re-valida contra el
      // Anexo 24 aquí: entre proponer y confirmar pudo cambiar el catálogo.
      const { esAgrupadorOficial } = await import("@/lib/contabilidad/agrupador");
      if (!esAgrupadorOficial(pa.payload.codAgrup)) {
        return { ok: false, error: `«${pa.payload.codAgrup}» no existe en el Anexo 24.` };
      }
      const cuenta = await prisma.chartAccount.findFirst({
        where: { id: pa.payload.chartAccountId, companyId: pa.companyId },
        select: { id: true, codAgrup: true, nombre: true },
      });
      if (!cuenta) return { ok: false, error: "Esa cuenta ya no existe en el catálogo." };
      await prisma.chartAccount.update({
        where: { id: cuenta.id },
        data: { codAgrup: pa.payload.codAgrup },
      });
      registrarBitacora({
        companyId: pa.companyId,
        userId: confirmingUserId,
        accion: "contabilidad.cuenta.agrupador",
        entidad: "ChartAccount",
        entidadId: cuenta.id,
        detalle: { cuenta: pa.payload.cuenta, codAgrup: pa.payload.codAgrup, anterior: pa.payload.anterior, via: "copiloto" },
      });
      return {
        ok: true,
        message:
          `Cuenta ${pa.payload.cuenta} agrupada como ${pa.payload.codAgrup}. ` +
          "Se cambia en Contabilidad → Catálogo de cuentas.",
      };
    }

    case "confirmar_apertura": {
      // Estampa la confirmación del punto de partida (quién y cuándo), igual
      // que POST /api/companies/[id]/apertura/confirmar.
      const user = await prisma.user.findUnique({ where: { id: confirmingUserId }, select: { email: true } });
      await prisma.company.update({
        where: { id: pa.companyId },
        data: { aperturaConfirmadaAt: new Date(), aperturaConfirmadaPor: user?.email ?? confirmingUserId },
      });
      registrarBitacora({
        companyId: pa.companyId,
        userId: confirmingUserId,
        actorEmail: user?.email ?? null,
        accion: "apertura.confirmar",
        entidad: "Company",
        entidadId: pa.companyId,
        detalle: { via: "copiloto" },
      });
      return { ok: true, message: "Punto de partida fiscal confirmado." };
    }

    case "confirmar_paso":
    case "omitir_paso": {
      // Misma función que el botón de la pantalla: una sola vía para cerrar un
      // paso. Re-evalúa la evidencia y rechaza si cambió desde la propuesta.
      const { confirmarPaso, omitirPaso } = await import("../cierre/evaluar");
      const { esClavePaso } = await import("../cierre/claves");
      const { year, month, clave, hashEsperado } = pa.payload;
      if (!esClavePaso(clave)) return { ok: false, error: "Paso de cierre desconocido." };
      const args = {
        companyId: pa.companyId,
        year,
        month,
        clave,
        userId: confirmingUserId,
        hashEsperado,
        nota: pa.type === "omitir_paso" ? pa.payload.motivo : null,
      };
      const r = pa.type === "confirmar_paso" ? await confirmarPaso(args) : await omitirPaso(args);
      if (!r.ok) return { ok: false, error: r.error };
      const paso = r.cierre.pasos.find((x) => x.clave === clave);
      return {
        ok: true,
        message:
          pa.type === "confirmar_paso"
            ? `Paso «${paso?.titulo ?? clave}» confirmado. Van ${r.cierre.resumen.confirmados} de ${r.cierre.resumen.aplican}.`
            : `Paso «${paso?.titulo ?? clave}» omitido con motivo. Queda en la bitácora.`,
      };
    }

    case "resolver_hallazgo": {
      // Reusa la misma mutación que /api/hallazgos/[id] (estado RESUELTO).
      const h = await prisma.fiscalHallazgo.findFirst({
        where: { id: pa.payload.hallazgoId, companyId: pa.companyId },
        select: { estado: true },
      });
      if (!h) return { ok: false, error: "El hallazgo ya no existe." };
      if (h.estado === "RESUELTO") return { ok: false, error: "El hallazgo ya estaba resuelto." };
      await prisma.fiscalHallazgo.update({
        where: { id: pa.payload.hallazgoId },
        data: { estado: "RESUELTO", posponerHasta: null },
      });
      return { ok: true, message: "Hallazgo marcado como resuelto." };
    }

    case "posponer_hallazgo": {
      const h = await prisma.fiscalHallazgo.findFirst({
        where: { id: pa.payload.hallazgoId, companyId: pa.companyId },
        select: { id: true },
      });
      if (!h) return { ok: false, error: "El hallazgo ya no existe." };
      const hasta = calcPosponerHasta(pa.payload.token);
      await prisma.fiscalHallazgo.update({
        where: { id: pa.payload.hallazgoId },
        data: { estado: "ABIERTO", posponerHasta: hasta },
      });
      return {
        ok: true,
        message: `Hallazgo pospuesto hasta ${hasta.toLocaleDateString("es-MX", { day: "2-digit", month: "long", year: "numeric" })}.`,
      };
    }

    case "marcar_pendiente": {
      // Reusa la misma mutación que /api/notificaciones/[id]. El inbox es POR
      // USUARIO: acotamos al recipientUserId del que confirma (NO sólo companyId),
      // igual que el endpoint directo — así nadie marca el pendiente de otro
      // usuario de la misma empresa.
      const item = await prisma.notificationItem.findFirst({
        where: { id: pa.payload.itemId, recipientUserId: confirmingUserId },
        select: { estado: true },
      });
      if (!item) return { ok: false, error: "El pendiente ya no existe." };
      if (pa.payload.accion === "hecho") {
        if (item.estado === "HECHO") return { ok: false, error: "El pendiente ya estaba hecho." };
        await prisma.notificationItem.update({
          where: { id: pa.payload.itemId },
          data: { estado: "HECHO", hechoAt: new Date(), posponerHasta: null },
        });
        return { ok: true, message: "Pendiente marcado como hecho." };
      }
      // posponer 7 días (atajo equivalente al de la UI de pendientes)
      const hasta = new Date(Date.now() + 7 * 86400000);
      await prisma.notificationItem.update({
        where: { id: pa.payload.itemId },
        data: { estado: "POSPUESTO", posponerHasta: hasta },
      });
      return {
        ok: true,
        message: `Pendiente pospuesto hasta ${hasta.toLocaleDateString("es-MX", { day: "2-digit", month: "long" })}.`,
      };
    }
  }
}

/** Fecha de snooze para un hallazgo — espeja /api/hallazgos/[id]. */
export function calcPosponerHasta(token: "7d" | "30d" | "fin_de_mes", now = new Date()): Date {
  if (token === "fin_de_mes") {
    return new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  }
  const dias = token === "7d" ? 7 : 30;
  const d = new Date(now);
  d.setDate(d.getDate() + dias);
  return d;
}
