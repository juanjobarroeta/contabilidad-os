import {
  ORDEN_SALUD,
  PESO_ESTADO,
  TITULO_SALUD,
  type ClaveSalud,
  type DireccionDelta,
  type EstadoSalud,
} from "./claves";

// ─────────────────────────────────────────────────────────────────────────────
// LA SALUD DE UNA EMPRESA, EVALUADA. PURO — sin Prisma y sin reloj propio.
//
// Las señales ya existían, repartidas en siete pantallas: cobertura del SAT,
// vigencia de la e.firma, opinión de cumplimiento, declaraciones contra
// obligaciones, contabilidad electrónica, bancos sin conciliar, IVA de PUE sin
// prueba de pago, hallazgos abiertos. Nadie las juntaba, así que «¿qué cambió
// en esta empresa desde ayer?» no tenía respuesta sin abrirlas todas.
//
// Aquí se juntan en DIMENSIONES con un estado cada una, y se comparan contra el
// snapshot de ayer. El resultado tiene dos lectores:
//
//   · la persona, que quiere saber qué atender primero;
//   · el filtro que decide a qué empresas vale la pena dedicarles una pasada
//     de razonamiento. Sin ese filtro, razonar toda la cartera todos los días
//     cuesta lo que no vale, porque la mayoría de las empresas no cambió.
//
// `hoy` SIEMPRE entra por parámetro: media evaluación depende del calendario
// («hace cuánto que no sincroniza», «cuándo vence la e.firma») y una función
// que lee el reloj por su cuenta no se puede probar.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Los hechos crudos de una empresa. Datos planos a propósito: el evaluador no
 * conoce Prisma, así que se puede probar con objetos escritos a mano.
 */
export interface HechosSalud {
  companyId: string;

  // ── Descarga del SAT ──────────────────────────────────────────────────────
  autoSyncEnabled: boolean;
  lastAutoSyncAt: Date | null;
  satBackfillCompletedAt: Date | null;
  /** Solicitudes de descarga masiva que terminaron mal, recientes. */
  solicitudesFallidas: number;

  // ── Credenciales ──────────────────────────────────────────────────────────
  tieneFiel: boolean;
  fielVigencia: Date | null;
  csdVigencia: Date | null;

  // ── Opinión de cumplimiento (32-D) ────────────────────────────────────────
  opinionResultado: string | null;
  opinionFetchedAt: Date | null;
  opinionMotivos: number;

  // ── Declaraciones ─────────────────────────────────────────────────────────
  declaracionesFaltantes: number;
  /** Las que además arrastran al periodo en curso. */
  declaracionesCriticas: number;

  // ── Contabilidad electrónica ──────────────────────────────────────────────
  ceSatSyncEn: Date | null;
  /** Tri-estado: null = nunca corrió, false = corrió y falló. */
  ceSatSyncOk: boolean | null;

  // ── Bancos ────────────────────────────────────────────────────────────────
  /** ¿La empresa concilia banco? Sin movimientos importados, no se juzga. */
  concilia: boolean;
  movimientosSinConciliar: number;
  /** Sin conciliar y ya viejos: lo que de verdad estorba al cierre. */
  movimientosSinConciliarViejos: number;

  // ── Hallazgos del auditor ─────────────────────────────────────────────────
  hallazgosError: number;
  hallazgosWarn: number;

  // ── Solicitudes al cliente ────────────────────────────────────────────────
  solicitudesAbiertas: number;
  /** La más vieja sin atender, en días. null cuando no hay ninguna abierta. */
  diasSolicitudMasVieja: number | null;
}

export interface DimensionSalud {
  clave: ClaveSalud;
  titulo: string;
  estado: EstadoSalud;
  /** Una frase que explique el estado sin tener que abrir nada más. */
  detalle: string;
  /** Los números crudos, para que quien razone no vuelva a consultarlos. */
  metricas: Record<string, number | string | null>;
}

const DIA_MS = 24 * 60 * 60 * 1000;

/** Días completos entre dos fechas (positivo si `b` es posterior). PURA. */
export function diasEntre(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / DIA_MS);
}

// Umbrales. Viven juntos y con nombre para que se puedan discutir de un vistazo.
export const DIAS_SYNC_ATENCION = 7;
export const DIAS_SYNC_BLOQUEA = 21;
export const DIAS_VIGENCIA_AVISO = 30;
export const DIAS_OPINION_VIEJA = 45;
export const DIAS_CE_VIEJA = 45;
export const DIAS_SOLICITUD_VIEJA = 21;

function datosSat(h: HechosSalud, hoy: Date): DimensionSalud {
  const dias = h.lastAutoSyncAt ? diasEntre(h.lastAutoSyncAt, hoy) : null;
  const metricas = {
    diasSinSincronizar: dias,
    solicitudesFallidas: h.solicitudesFallidas,
    backfillCompleto: h.satBackfillCompletedAt ? "sí" : "no",
  };

  if (!h.autoSyncEnabled) {
    return {
      clave: "datos_sat",
      titulo: TITULO_SALUD.datos_sat,
      estado: "sin_datos",
      detalle: "La sincronización automática está apagada: los CFDIs no se están bajando solos.",
      metricas,
    };
  }
  if (dias == null) {
    return {
      clave: "datos_sat",
      titulo: TITULO_SALUD.datos_sat,
      estado: "sin_datos",
      detalle: "Nunca ha sincronizado con el SAT.",
      metricas,
    };
  }
  if (dias >= DIAS_SYNC_BLOQUEA) {
    return {
      clave: "datos_sat",
      titulo: TITULO_SALUD.datos_sat,
      estado: "bloquea",
      detalle: `Hace ${dias} días que no baja nada del SAT. Con ese hueco no se puede cerrar el mes.`,
      metricas,
    };
  }
  if (dias >= DIAS_SYNC_ATENCION || h.solicitudesFallidas > 0) {
    const porFallas =
      h.solicitudesFallidas > 0
        ? `${h.solicitudesFallidas} solicitudes de descarga terminaron mal`
        : `hace ${dias} días que no sincroniza`;
    return {
      clave: "datos_sat",
      titulo: TITULO_SALUD.datos_sat,
      estado: "atencion",
      detalle: `La descarga del SAT va atrasada: ${porFallas}.`,
      metricas,
    };
  }
  if (!h.satBackfillCompletedAt) {
    return {
      clave: "datos_sat",
      titulo: TITULO_SALUD.datos_sat,
      estado: "atencion",
      detalle: "La carga inicial de histórico todavía no termina.",
      metricas,
    };
  }
  return {
    clave: "datos_sat",
    titulo: TITULO_SALUD.datos_sat,
    estado: "ok",
    detalle: `Sincronizó hace ${dias} ${dias === 1 ? "día" : "días"}.`,
    metricas,
  };
}

function credenciales(h: HechosSalud, hoy: Date): DimensionSalud {
  const diasFiel = h.fielVigencia ? diasEntre(hoy, h.fielVigencia) : null;
  const diasCsd = h.csdVigencia ? diasEntre(hoy, h.csdVigencia) : null;
  const metricas = { diasParaVencerFiel: diasFiel, diasParaVencerCsd: diasCsd };

  if (!h.tieneFiel) {
    return {
      clave: "credenciales",
      titulo: TITULO_SALUD.credenciales,
      estado: "sin_datos",
      detalle: "No hay e.firma cargada: sin ella no se le puede pedir nada al SAT en nombre de la empresa.",
      metricas,
    };
  }
  if (diasFiel != null && diasFiel < 0) {
    return {
      clave: "credenciales",
      titulo: TITULO_SALUD.credenciales,
      estado: "bloquea",
      detalle: `La e.firma venció hace ${Math.abs(diasFiel)} días. Todo lo que depende del SAT está detenido.`,
      metricas,
    };
  }
  if (diasCsd != null && diasCsd < 0) {
    return {
      clave: "credenciales",
      titulo: TITULO_SALUD.credenciales,
      estado: "bloquea",
      detalle: `El CSD venció hace ${Math.abs(diasCsd)} días: no se puede timbrar.`,
      metricas,
    };
  }
  if (diasFiel != null && diasFiel <= DIAS_VIGENCIA_AVISO) {
    return {
      clave: "credenciales",
      titulo: TITULO_SALUD.credenciales,
      estado: "atencion",
      detalle: `La e.firma vence en ${diasFiel} días. Renovarla antes evita parar la descarga.`,
      metricas,
    };
  }
  if (diasCsd != null && diasCsd <= DIAS_VIGENCIA_AVISO) {
    return {
      clave: "credenciales",
      titulo: TITULO_SALUD.credenciales,
      estado: "atencion",
      detalle: `El CSD vence en ${diasCsd} días.`,
      metricas,
    };
  }
  return {
    clave: "credenciales",
    titulo: TITULO_SALUD.credenciales,
    estado: "ok",
    detalle: "e.firma y CSD vigentes.",
    metricas,
  };
}

function cumplimiento(h: HechosSalud, hoy: Date): DimensionSalud {
  const dias = h.opinionFetchedAt ? diasEntre(h.opinionFetchedAt, hoy) : null;
  const metricas = {
    resultado: h.opinionResultado,
    diasDesdeConsulta: dias,
    motivos: h.opinionMotivos,
  };

  if (!h.opinionResultado || dias == null) {
    return {
      clave: "cumplimiento",
      titulo: TITULO_SALUD.cumplimiento,
      estado: "sin_datos",
      detalle: "No hay opinión de cumplimiento consultada.",
      metricas,
    };
  }
  if (/negativ/i.test(h.opinionResultado)) {
    const porQue = h.opinionMotivos > 0 ? ` El SAT señala ${h.opinionMotivos} obligaciones.` : "";
    return {
      clave: "cumplimiento",
      titulo: TITULO_SALUD.cumplimiento,
      estado: "bloquea",
      detalle: `La opinión de cumplimiento salió NEGATIVA.${porQue}`,
      metricas,
    };
  }
  if (dias >= DIAS_OPINION_VIEJA) {
    return {
      clave: "cumplimiento",
      titulo: TITULO_SALUD.cumplimiento,
      estado: "atencion",
      detalle: `La última opinión es de hace ${dias} días: ya no dice nada del estado de hoy.`,
      metricas,
    };
  }
  return {
    clave: "cumplimiento",
    titulo: TITULO_SALUD.cumplimiento,
    estado: "ok",
    detalle: `Opinión ${h.opinionResultado.toLowerCase()}, consultada hace ${dias} días.`,
    metricas,
  };
}

function declaraciones(h: HechosSalud): DimensionSalud {
  const metricas = { faltantes: h.declaracionesFaltantes, criticas: h.declaracionesCriticas };
  if (h.declaracionesCriticas > 0) {
    return {
      clave: "declaraciones",
      titulo: TITULO_SALUD.declaraciones,
      estado: "bloquea",
      detalle: `Faltan ${h.declaracionesCriticas} acuses que arrastran al periodo en curso: sin ellos las cifras del mes salen mal.`,
      metricas,
    };
  }
  if (h.declaracionesFaltantes > 0) {
    return {
      clave: "declaraciones",
      titulo: TITULO_SALUD.declaraciones,
      estado: "atencion",
      detalle: `Faltan ${h.declaracionesFaltantes} acuses de declaraciones ya vencidas.`,
      metricas,
    };
  }
  return {
    clave: "declaraciones",
    titulo: TITULO_SALUD.declaraciones,
    estado: "ok",
    detalle: "Todas las declaraciones vencidas tienen su acuse.",
    metricas,
  };
}

function contabilidadElectronica(h: HechosSalud, hoy: Date): DimensionSalud {
  const dias = h.ceSatSyncEn ? diasEntre(h.ceSatSyncEn, hoy) : null;
  const metricas = { diasDesdeRevision: dias, ultimaCorridaOk: h.ceSatSyncOk == null ? null : h.ceSatSyncOk ? "sí" : "no" };

  if (h.ceSatSyncEn == null || dias == null) {
    return {
      clave: "contabilidad_electronica",
      titulo: TITULO_SALUD.contabilidad_electronica,
      estado: "sin_datos",
      detalle: "Nunca se ha revisado qué contabilidad electrónica tiene presentada el SAT.",
      metricas,
    };
  }
  if (h.ceSatSyncOk === false) {
    return {
      clave: "contabilidad_electronica",
      titulo: TITULO_SALUD.contabilidad_electronica,
      estado: "atencion",
      detalle: "La última revisión contra el buzón del SAT falló: no sabemos qué está presentado.",
      metricas,
    };
  }
  if (dias >= DIAS_CE_VIEJA) {
    return {
      clave: "contabilidad_electronica",
      titulo: TITULO_SALUD.contabilidad_electronica,
      estado: "atencion",
      detalle: `La última revisión es de hace ${dias} días.`,
      metricas,
    };
  }
  return {
    clave: "contabilidad_electronica",
    titulo: TITULO_SALUD.contabilidad_electronica,
    estado: "ok",
    detalle: `Revisada hace ${dias} ${dias === 1 ? "día" : "días"}.`,
    metricas,
  };
}

function bancos(h: HechosSalud): DimensionSalud {
  const metricas = {
    sinConciliar: h.movimientosSinConciliar,
    sinConciliarViejos: h.movimientosSinConciliarViejos,
  };
  if (!h.concilia) {
    return {
      clave: "bancos",
      titulo: TITULO_SALUD.bancos,
      estado: "sin_datos",
      detalle: "No hay movimientos bancarios cargados, así que no hay nada que conciliar.",
      metricas,
    };
  }
  if (h.movimientosSinConciliarViejos > 0) {
    return {
      clave: "bancos",
      titulo: TITULO_SALUD.bancos,
      estado: "atencion",
      detalle: `${h.movimientosSinConciliarViejos} movimientos llevan más de dos meses sin conciliar.`,
      metricas,
    };
  }
  return {
    clave: "bancos",
    titulo: TITULO_SALUD.bancos,
    estado: "ok",
    detalle:
      h.movimientosSinConciliar > 0
        ? `${h.movimientosSinConciliar} movimientos por conciliar, todos recientes.`
        : "Todo conciliado.",
    metricas,
  };
}

function ivaFlujo(h: HechosSalud): DimensionSalud {
  // La ley acredita el IVA de un gasto cuando se PAGA (Art. 5-I LIVA) y la
  // prueba de pago de un PUE es la conciliación bancaria. Una empresa que no
  // concilia conserva la suposición de siempre —PUE pagado al emitirse— y eso
  // no es un detalle de implementación: es IVA acreditado sin prueba.
  const metricas = { modo: h.concilia ? "FLUJO" : "SUPUESTO_PAGADO" };
  if (!h.concilia) {
    return {
      clave: "iva_flujo",
      titulo: TITULO_SALUD.iva_flujo,
      estado: "atencion",
      detalle:
        "Sin banco conciliado, el IVA de los gastos PUE se acredita SUPONIENDO que se pagaron al emitirse. Es la cifra que iría en la declaración sin prueba de pago.",
      metricas,
    };
  }
  return {
    clave: "iva_flujo",
    titulo: TITULO_SALUD.iva_flujo,
    estado: "ok",
    detalle: "El IVA de los gastos PUE se acredita contra la conciliación, no por suposición.",
    metricas,
  };
}

function hallazgos(h: HechosSalud): DimensionSalud {
  const metricas = { errores: h.hallazgosError, avisos: h.hallazgosWarn };
  if (h.hallazgosError > 0) {
    return {
      clave: "hallazgos",
      titulo: TITULO_SALUD.hallazgos,
      estado: "atencion",
      detalle: `El auditor tiene ${h.hallazgosError} hallazgos graves abiertos.`,
      metricas,
    };
  }
  return {
    clave: "hallazgos",
    titulo: TITULO_SALUD.hallazgos,
    estado: "ok",
    detalle:
      h.hallazgosWarn > 0 ? `${h.hallazgosWarn} avisos abiertos, ninguno grave.` : "Sin hallazgos abiertos.",
    metricas,
  };
}

function solicitudes(h: HechosSalud): DimensionSalud {
  const metricas = { abiertas: h.solicitudesAbiertas, diasDeLaMasVieja: h.diasSolicitudMasVieja };
  if (h.solicitudesAbiertas === 0) {
    return {
      clave: "solicitudes",
      titulo: TITULO_SALUD.solicitudes,
      estado: "ok",
      detalle: "No hay nada esperando del cliente.",
      metricas,
    };
  }
  // Una solicitud vieja no es un recordatorio olvidado: es trabajo detenido. El
  // estado de cuenta de terminal que nadie mandó en agosto es exactamente esto,
  // y es lo que dejó un mes entero sin poderse auditar.
  if (h.diasSolicitudMasVieja != null && h.diasSolicitudMasVieja >= DIAS_SOLICITUD_VIEJA) {
    return {
      clave: "solicitudes",
      titulo: TITULO_SALUD.solicitudes,
      estado: "atencion",
      detalle: `${h.solicitudesAbiertas} ${h.solicitudesAbiertas === 1 ? "cosa pedida al cliente sigue" : "cosas pedidas al cliente siguen"} sin llegar; la más vieja lleva ${h.diasSolicitudMasVieja} días.`,
      metricas,
    };
  }
  return {
    clave: "solicitudes",
    titulo: TITULO_SALUD.solicitudes,
    estado: "ok",
    detalle: `${h.solicitudesAbiertas} ${h.solicitudesAbiertas === 1 ? "pedido reciente" : "pedidos recientes"} al cliente, todavía en plazo razonable.`,
    metricas,
  };
}

/**
 * Evalúa todas las dimensiones. PURA.
 *
 * Devuelve SIEMPRE las ocho, en el orden de atención de `ORDEN_SALUD`: una
 * dimensión que desaparece del arreglo cuando está bien haría imposible
 * distinguir «mejoró» de «ya no se mide».
 */
export function evaluarSalud(h: HechosSalud, hoy: Date): DimensionSalud[] {
  const porClave: Record<ClaveSalud, DimensionSalud> = {
    datos_sat: datosSat(h, hoy),
    credenciales: credenciales(h, hoy),
    cumplimiento: cumplimiento(h, hoy),
    declaraciones: declaraciones(h),
    contabilidad_electronica: contabilidadElectronica(h, hoy),
    bancos: bancos(h),
    iva_flujo: ivaFlujo(h),
    hallazgos: hallazgos(h),
    solicitudes: solicitudes(h),
  };
  return ORDEN_SALUD.map((c) => porClave[c]);
}

/** El estado global: el PEOR de las dimensiones. PURA. */
export function peorEstado(dimensiones: DimensionSalud[]): EstadoSalud {
  let peor: EstadoSalud = "ok";
  for (const d of dimensiones) if (PESO_ESTADO[d.estado] < PESO_ESTADO[peor]) peor = d.estado;
  return peor;
}

export interface DeltaSalud {
  clave: ClaveSalud;
  titulo: string;
  /** `${clave}.${direccion}` — la llave que dedupe el aviso. */
  deltaKey: string;
  direccion: DireccionDelta;
  de: EstadoSalud | null;
  a: EstadoSalud;
  detalle: string;
}

/**
 * Qué cambió contra el snapshot anterior. PURA.
 *
 * Las reglas son las del pase diario del cierre, y la más importante es la que
 * NO emite: un problema que sigue igual que ayer no vuelve a avisar. Sin eso,
 * el aviso diario se convierte en ruido y se aprende a ignorarlo — que es
 * exactamente lo que pasó con los conteos del rail.
 */
export function diffSalud(prev: DimensionSalud[] | null, next: DimensionSalud[]): DeltaSalud[] {
  const antes = new Map((prev ?? []).map((d) => [d.clave, d]));
  const out: DeltaSalud[] = [];

  for (const d of next) {
    const a = antes.get(d.clave) ?? null;

    if (d.estado === "ok") {
      // Sólo se celebra lo que estaba mal y dejó de estarlo.
      if (a && a.estado !== "ok") {
        out.push({
          clave: d.clave,
          titulo: d.titulo,
          deltaKey: `${d.clave}.mejoro`,
          direccion: "mejoro",
          de: a.estado,
          a: d.estado,
          detalle: d.detalle,
        });
      }
      continue;
    }

    if (!a) {
      // Primera vez que se mide (empresa nueva, o dimensión recién agregada).
      out.push({
        clave: d.clave,
        titulo: d.titulo,
        deltaKey: `${d.clave}.nuevo`,
        direccion: "nuevo",
        de: null,
        a: d.estado,
        detalle: d.detalle,
      });
      continue;
    }

    if (PESO_ESTADO[d.estado] < PESO_ESTADO[a.estado]) {
      out.push({
        clave: d.clave,
        titulo: d.titulo,
        deltaKey: `${d.clave}.empeoro`,
        direccion: "empeoro",
        de: a.estado,
        a: d.estado,
        detalle: d.detalle,
      });
    }
  }

  return out;
}

/** Los deltas que importan primero: lo que bloquea, luego lo nuevo. PURA. */
export function rankDeltas(deltas: DeltaSalud[]): DeltaSalud[] {
  const prioridad = (d: DeltaSalud) =>
    d.direccion === "mejoro" ? 9 : d.a === "bloquea" ? 0 : d.direccion === "empeoro" ? 1 : 2;
  return [...deltas]
    .filter((d) => d.direccion !== "mejoro")
    .sort((x, y) => prioridad(x) - prioridad(y) || ORDEN_SALUD.indexOf(x.clave) - ORDEN_SALUD.indexOf(y.clave));
}

/**
 * ¿Esta empresa merece que alguien la razone hoy? PURA.
 *
 * Éste es el filtro que hace viable la pasada diaria: se gasta razonamiento en
 * las empresas que cambiaron a peor o que están bloqueadas, no en las que
 * siguen igual de bien que ayer.
 */
export function requiereAtencion(dimensiones: DimensionSalud[], deltas: DeltaSalud[]): boolean {
  if (dimensiones.some((d) => d.estado === "bloquea")) return true;
  return deltas.some((d) => d.direccion === "empeoro" || d.direccion === "nuevo");
}
