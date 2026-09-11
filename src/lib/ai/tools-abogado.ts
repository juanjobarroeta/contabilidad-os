// ─────────────────────────────────────────────────────────────────────────────
// Herramientas del perfil ABOGADO: las de conocimiento del copiloto contable
// (misma implementación en tool-executor.ts, con `perfil: "abogado"` el
// executor no filtra por materias) con la descripción del corpus completo y
// `get_articulo` abierto a cualquier clave del catálogo. Nada de datos de
// empresa ni de acciones «proponer_*»: aquí no hay empresa.
// ─────────────────────────────────────────────────────────────────────────────

import type Anthropic from "@anthropic-ai/sdk";
import { tools } from "./tools";
import { CLAVES_LEYES } from "@/lib/fiscal-kb/ingest-leyes";

const NOMBRES_ABOGADO = ["search_fiscal_knowledge", "get_articulo", "search_jurisprudencia", "get_tesis", "get_valor_fiscal"] as const;

const DESCRIPCION_BUSQUEDA =
  "Busca en TODO el orden jurídico mexicano cargado — Constitución, códigos (CCF, CNPCF, CFPC, CPF, CNPP, CCOM, CFF…), leyes federales y generales (LFT, LSS, LISR, LIVA, LAMP, LGSM, LFPC, LFPDPPP…), reglamentos, RMF y guías del SAT, y las leyes estatales cargadas (Puebla: LHPUE/CFPUE; CDMX: CFCDMX) — y devuelve fragmentos con su cita (artículo/regla, ordenamiento, fecha de vigencia). Úsala SIEMPRE antes de afirmar qué dice una norma; sigue las remisiones con get_articulo. Si no devuelve resultados, dilo y NO inventes un fundamento. Para hechos pasados pasa fecha_vigencia de esa fecha. Para criterios de los tribunales usa search_jurisprudencia, no ésta.";

type Esquema = Anthropic.Tool["input_schema"] & { properties?: Record<string, Record<string, unknown>> };

export const toolsAbogado: Anthropic.Tool[] = tools
  .filter((t) => (NOMBRES_ABOGADO as readonly string[]).includes(t.name))
  .map((t) => {
    if (t.name === "search_fiscal_knowledge") return { ...t, description: DESCRIPCION_BUSQUEDA };
    if (t.name === "get_articulo") {
      const esquema = t.input_schema as Esquema;
      const props = esquema.properties ?? {};
      return {
        ...t,
        input_schema: {
          ...esquema,
          properties: {
            ...props,
            ley: {
              ...(props.ley ?? {}),
              enum: [...CLAVES_LEYES, "RMF"],
              description: "Clave del ordenamiento tal como la devuelve search_fiscal_knowledge en `ley` (CCF, CNPCF, CPF, LAMP, LFT, LISR, CFF, LGSM…). RMF = Resolución Miscelánea Fiscal vigente.",
            },
          },
        } as Anthropic.Tool["input_schema"],
      };
    }
    return t;
  });
