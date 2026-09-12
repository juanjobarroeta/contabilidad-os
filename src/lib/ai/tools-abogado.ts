// ─────────────────────────────────────────────────────────────────────────────
// Herramientas del perfil ABOGADO: las de conocimiento del copiloto contable
// (misma implementación en tool-executor.ts, con `perfil: "abogado"` el
// executor no filtra por materias) con la descripción del corpus completo y
// `get_articulo` abierto a cualquier clave del catálogo. Nada de datos de
// empresa ni de acciones «proponer_*»: aquí no hay empresa.
// ─────────────────────────────────────────────────────────────────────────────

import type Anthropic from "@anthropic-ai/sdk";
import { tools } from "./tools";

const NOMBRES_ABOGADO = ["search_fiscal_knowledge", "get_articulo", "search_jurisprudencia", "get_tesis", "get_valor_fiscal"] as const;

const DESCRIPCION_BUSQUEDA =
  "Busca en TODO el orden jurídico mexicano cargado — Constitución, códigos (CCF, CNPCF, CFPC, CPF, CNPP, CCOM, CFF…), leyes federales y generales (LFT, LSS, LISR, LIVA, LAMP, LGSM, LFPC, LFPDPPP…), reglamentos, RMF y guías del SAT, las leyes estatales cargadas (Puebla: LHPUE/CFPUE; CDMX: CFCDMX), la normatividad de CONSTRUCCIÓN y desarrollo urbano de las 32 entidades y sus principales municipios (leyes de desarrollo urbano y asentamientos, reglamentos de construcciones, fraccionamientos, protección civil; el Reglamento de Construcciones de la CDMX y sus Normas Técnicas Complementarias 2023) y las NOM que un constructor cumple (instalaciones eléctricas NOM-001-SEDE, eficiencia energética ENER, seguridad en obra STPS, agua CONAGUA, SEDATU) — y devuelve fragmentos con su cita (artículo/regla, ordenamiento, fecha de vigencia). Úsala SIEMPRE antes de afirmar qué dice una norma; sigue las remisiones con get_articulo. Si no devuelve resultados, dilo y NO inventes un fundamento. Para hechos pasados pasa fecha_vigencia de esa fecha. Para criterios de los tribunales usa search_jurisprudencia, no ésta.";

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
            // Sin enum: el catálogo tiene más de mil claves (federales,
            // reglamentos, estatales, municipales, NOM) y un enum así pesa
            // decenas de miles de tokens en cada turno. La clave llega en `ley`
            // de cada resultado de búsqueda; una clave que no exista devuelve
            // un error claro.
            ley: {
              type: "string",
              description: "Clave del ordenamiento tal como la devuelve search_fiscal_knowledge en `ley` (CCF, CNPCF, CPF, LAMP, LFT, LISR, CFF, LGSM, R-LOPSRM, PUE-M-PUEBLA-R-CONSTRUCCIONES…, NOM-001-SEDE-2012). RMF = Resolución Miscelánea Fiscal vigente.",
            },
          },
        } as Anthropic.Tool["input_schema"],
      };
    }
    return t;
  });
