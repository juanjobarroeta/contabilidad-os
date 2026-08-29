// ─────────────────────────────────────────────────────────────────────────────
// AGRUPACIÓN DEL COPILOTO v2 (docs/REDISENO-PILOTO.md, feedback del owner):
// 97 cartas-enunciado estresan; 4-5 GRUPOS-VERBO ayudan. Se agrupa por CAUSA
// RAÍZ operativa — el destino donde se resuelve (ctaParaHallazgo): si dos
// hallazgos se arreglan en el mismo lugar con la misma acción, son UNA carta
// con un contador. error > warn, y los `info` se colapsan a una línea: no
// compiten con lo urgente.
//
// Pura y testeada: el rail sólo pinta.
// ─────────────────────────────────────────────────────────────────────────────

import { ctaParaHallazgo } from "../hallazgos-cta";

export interface HallazgoRail {
  id: string;
  checkClave: string;
  categoria: string;
  severidad: string; // "error" | "warn" | "info"
  mensaje: string;
  sugerencia: string;
}

export interface GrupoRail {
  /** Destino que resuelve (también la llave de agrupación). */
  href: string;
  /** El verbo del botón — la sugerencia ES la acción. */
  verbo: string;
  severidad: "error" | "warn";
  count: number;
  ids: string[];
  /** Titular: el mensaje cuando es uno; síntesis contable cuando son varios. */
  titulo: string;
  /** El primer mensaje como muestra cuando el grupo agrupa varios. */
  muestra: string | null;
  categoria: string;
}

const SINTESIS: Record<string, [string, string]> = {
  // categoria → [singular, plural] con tono de siguiente-paso
  obligacion: ["declaración por presentar", "declaraciones por presentar"],
  declaraciones: ["declaración por presentar", "declaraciones por presentar"],
  cfdi: ["CFDI por revisar", "CFDIs por revisar"],
  iva: ["tema de IVA por revisar", "temas de IVA por revisar"],
  banco: ["pendiente de banco", "pendientes de banco"],
  contabilidad: ["pendiente de contabilidad", "pendientes de contabilidad"],
  cumplimiento: ["tema de cumplimiento", "temas de cumplimiento"],
  efos: ["proveedor en lista 69-B", "proveedores en lista 69-B"],
};

function sintetizar(categoria: string, count: number): string {
  const par = SINTESIS[categoria];
  if (par) return `${count} ${count === 1 ? par[0] : par[1]}`;
  return `${count} hallazgo${count === 1 ? "" : "s"} de ${categoria}`;
}

export interface RailAgrupado {
  grupos: GrupoRail[];
  /** Grupos que no cupieron en el corte (cuenta de hallazgos, no de grupos). */
  restantes: number;
  /** Los `info`, colapsados: avisos, no urgencias. */
  informativos: number;
}

export function agruparParaRail(
  hallazgos: HallazgoRail[],
  opts?: { maxGrupos?: number },
): RailAgrupado {
  const max = opts?.maxGrupos ?? 4;
  const accionables = hallazgos.filter((h) => h.severidad === "error" || h.severidad === "warn");
  const informativos = hallazgos.length - accionables.length;

  const porDestino = new Map<string, { cta: { label: string; href: string }; miembros: HallazgoRail[] }>();
  for (const h of accionables) {
    const cta = ctaParaHallazgo(h.checkClave, h) ?? { label: "Ver hallazgos", href: "/hallazgos" };
    const g = porDestino.get(cta.href) ?? { cta, miembros: [] };
    g.miembros.push(h);
    porDestino.set(cta.href, g);
  }

  const RANGO = { error: 0, warn: 1 } as const;
  const grupos: GrupoRail[] = [...porDestino.values()]
    .map(({ cta, miembros }) => {
      const severidad: "error" | "warn" = miembros.some((m) => m.severidad === "error") ? "error" : "warn";
      const categoria = miembros[0].categoria;
      return {
        href: cta.href,
        verbo: cta.label,
        severidad,
        count: miembros.length,
        ids: miembros.map((m) => m.id),
        titulo: miembros.length === 1 ? miembros[0].mensaje : sintetizar(categoria, miembros.length),
        muestra: miembros.length > 1 ? miembros[0].mensaje : null,
        categoria,
      };
    })
    .sort((a, b) => RANGO[a.severidad] - RANGO[b.severidad] || b.count - a.count);

  const visibles = grupos.slice(0, max);
  const restantes = grupos.slice(max).reduce((t, g) => t + g.count, 0);
  return { grupos: visibles, restantes, informativos };
}
