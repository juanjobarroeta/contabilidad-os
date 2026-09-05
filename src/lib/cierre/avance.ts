// ─────────────────────────────────────────────────────────────────────────────
// EL PASE DIARIO — parte PURA. Dado el snapshot de ayer y el de hoy, qué cambió
// y merece un aviso, en qué orden y con qué texto.
//
// Regla de ruido: sólo se avisa lo que EMPEORÓ o es NUEVO (una señal que pasó
// de ok a warn/error, o apareció en warn/error), y los vencimientos. Lo que
// mejoró no se avisa: se marca como accionado en el ledger (CierreAviso). Tope
// de avisos por corrida, ranqueados por vencimiento > dinero > gravedad.
// Las plantillas viven en plantillas.ts; aquí no hay texto.
// ─────────────────────────────────────────────────────────────────────────────

import { ORDEN_PASOS, type ClavePasoCierre, type PasoEvaluado, type SenalPaso } from "./workflow";

export type DireccionDelta = "nuevo" | "empeoro" | "mejoro" | "vencio" | "por_vencer";

export interface Delta {
  paso: ClavePasoCierre;
  tituloPaso: string;
  /** Clave de la señal sin prefijo ("sin_clasificar", "complementos-por-emitir") o "fecha_limite". */
  senal: string;
  /** Identidad estable del delta: `${paso}.${senal}.${direccion}`. */
  deltaKey: string;
  direccion: DireccionDelta;
  estadoAhora: SenalPaso["estado"];
  resumen: string;
  cta: { label: string; href: string };
  diasRestantes?: number;
  fechaLimite?: string;
}

const PESO_ESTADO: Record<SenalPaso["estado"], number> = { error: 0, warn: 1, ok: 2, na: 3 };
const POR_VENCER_DIAS = 3;

function sinPrefijo(clave: string): string {
  return clave.replace(/^(ce|fx|x):/, "");
}

/**
 * Deltas entre el snapshot anterior (null = primera corrida) y el actual.
 * Sólo pasos que aplican. PURA.
 */
export function diffCierre(prev: PasoEvaluado[] | null, next: PasoEvaluado[]): Delta[] {
  const out: Delta[] = [];
  const prevPorClave = new Map((prev ?? []).map((p) => [p.clave, p]));

  for (const paso of next) {
    if (paso.estadoCalculado === "no_aplica") continue;
    const antes = prevPorClave.get(paso.clave);
    const senalesAntes = new Map((antes?.senales ?? []).map((s) => [s.clave, s]));

    for (const s of paso.senales) {
      if (s.estado === "na") continue;
      const a = senalesAntes.get(s.clave);
      const senal = sinPrefijo(s.clave);
      const base = {
        paso: paso.clave,
        tituloPaso: paso.titulo,
        senal,
        estadoAhora: s.estado,
        resumen: s.resumen,
        cta: s.cta ?? paso.cta,
      };
      if (s.estado === "ok") {
        if (a && a.estado !== "ok") out.push({ ...base, direccion: "mejoro", deltaKey: `${paso.clave}.${senal}.mejoro` });
        continue;
      }
      if (!a) {
        out.push({ ...base, direccion: "nuevo", deltaKey: `${paso.clave}.${senal}.nuevo` });
      } else if (PESO_ESTADO[s.estado] < PESO_ESTADO[a.estado]) {
        out.push({ ...base, direccion: "empeoro", deltaKey: `${paso.clave}.${senal}.empeoro` });
      }
    }

    // Vencimiento de la declaración: se avisa al cruzar el umbral, no cada día.
    if (paso.clave === "declaracion" && paso.diasRestantes != null && paso.estadoCalculado !== "listo") {
      const d = paso.diasRestantes;
      const dAntes = antes?.diasRestantes;
      const base = {
        paso: paso.clave,
        tituloPaso: paso.titulo,
        senal: "fecha_limite",
        estadoAhora: (d < 0 ? "error" : "warn") as SenalPaso["estado"],
        resumen: paso.detalle ?? "Declaración pendiente",
        cta: paso.cta,
        diasRestantes: d,
        fechaLimite: paso.fechaLimite,
      };
      if (d < 0 && (dAntes == null || dAntes >= 0)) {
        out.push({ ...base, direccion: "vencio", deltaKey: "declaracion.fecha_limite.vencio" });
      } else if (d >= 0 && d <= POR_VENCER_DIAS && (dAntes == null || dAntes > POR_VENCER_DIAS)) {
        out.push({ ...base, direccion: "por_vencer", deltaKey: "declaracion.fecha_limite.por_vencer" });
      }
    }
  }
  return out;
}

/** Prioridad numérica (menor = más urgente). PURA. */
export function prioridadDelta(d: Delta): number {
  if (d.direccion === "vencio") return 0;
  if (d.direccion === "por_vencer") return 1;
  if (d.estadoAhora === "error") return 2;
  // Dinero en juego antes que orden del flujo.
  if (/\$\s?[\d,]+/.test(d.resumen)) return 3;
  return 4;
}

/**
 * Los deltas que se AVISAN: sin mejoras, ranqueados y con tope. Los que quedan
 * fuera del tope no se pierden: mañana, si siguen, vuelven a salir como
 * «nuevo» frente a un snapshot que ya los traía… no — el snapshot de hoy los
 * incluye, así que se dan por vistos. Por eso el tope es una decisión de
 * producto (≤ 5 al día) y no un buffer.
 */
export function rankDeltas(deltas: Delta[], opts: { max?: number } = {}): Delta[] {
  const max = opts.max ?? 5;
  return deltas
    .filter((d) => d.direccion !== "mejoro")
    .sort((a, b) => {
      const p = prioridadDelta(a) - prioridadDelta(b);
      if (p !== 0) return p;
      return ORDEN_PASOS.indexOf(a.paso) - ORDEN_PASOS.indexOf(b.paso);
    })
    .slice(0, max);
}

/** ¿Este delta merece push (interrumpir)? Sólo vencimientos y bloqueos. */
export function meritaPush(d: Delta): boolean {
  return d.direccion === "vencio" || d.direccion === "por_vencer" || d.estadoAhora === "error";
}
