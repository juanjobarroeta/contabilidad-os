// ─────────────────────────────────────────────────────────────────────────────
// Ejecución de herramientas del perfil ABOGADO. Las mismas funciones de
// conocimiento que usa tool-executor.ts, pero SIN empresa (la ley es común, el
// gasto se registra al usuario) y SIN filtro de materias: el abogado busca en
// todo el corpus. No hay herramientas de datos ni acciones «proponer_*».
// ─────────────────────────────────────────────────────────────────────────────

import { getArticulo, getTesis, searchFiscalKnowledge, searchJurisprudencia } from "@/lib/fiscal-kb/search";
import { consultarValorFiscal, type ConsultaValorFiscal } from "@/lib/fiscal/valores";
import type { CostCtx } from "@/lib/costos/record";
import { ejecutarHerramientaDocumento, type DocumentoCargado } from "@/lib/juridico/documentos";

type Entrada = Record<string, unknown>;

/** search_fiscal_knowledge sin `fuentes` explícitas es normativa: la jurisprudencia tiene su herramienta. */
const FUENTES_NORMATIVA = ["LEY", "REGLAMENTO", "RMF", "CRITERIO", "DOF", "GUIA"];

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const fecha = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? new Date(v) : undefined);

export async function ejecutarHerramientaAbogado(nombre: string, input: Entrada, ctx: { userId: string; documentos?: DocumentoCargado[] }): Promise<string> {
  const cost: CostCtx = { companyId: null, userId: ctx.userId, subtipo: "ai.juridico" };
  try {
    switch (nombre) {
      case "leer_documento":
      case "buscar_en_documento":
        // Documentos adjuntos a la conversación (src/lib/juridico/documentos.ts): puro, sin costo.
        return ejecutarHerramientaDocumento(nombre, input, ctx.documentos ?? []);
      case "search_fiscal_knowledge":
        return JSON.stringify(
          await searchFiscalKnowledge(String(input.query ?? ""), {
            fechaVigencia: fecha(input.fecha_vigencia),
            fuentes: Array.isArray(input.fuentes) && input.fuentes.length > 0 ? input.fuentes.map(String) : FUENTES_NORMATIVA,
            limit: num(input.limit),
            cost,
          })
        );
      case "get_articulo": {
        const art = await getArticulo(String(input.ley ?? ""), String(input.articulo ?? ""), fecha(input.fecha_vigencia));
        return JSON.stringify(
          art ?? {
            error: `No hay ${String(input.ley)} artículo/regla ${String(input.articulo)} vigente en la base.`,
            instruccion: "Dilo al usuario; NO reconstruyas el artículo de memoria. Prueba search_fiscal_knowledge con la pregunta.",
          }
        );
      }
      case "search_jurisprudencia":
        return JSON.stringify(
          await searchJurisprudencia(String(input.query ?? ""), {
            fechaVigencia: fecha(input.fecha_vigencia),
            tipoCriterio: input.tipo === "JURISPRUDENCIA" || input.tipo === "AISLADA" ? input.tipo : undefined,
            epocas: Array.isArray(input.epocas) ? input.epocas.map(String) : undefined,
            limit: num(input.limit),
            cost,
          })
        );
      case "get_tesis": {
        const t = await getTesis(String(input.registro ?? ""));
        return JSON.stringify(
          t ?? {
            error: `No hay una tesis con registro ${String(input.registro)} en la base.`,
            instruccion: "Dilo al usuario; NO reconstruyas la tesis de memoria. Prueba search_jurisprudencia con el tema.",
          }
        );
      }
      case "get_valor_fiscal":
        return JSON.stringify(
          consultarValorFiscal({
            tipo: String(input.tipo ?? "") as ConsultaValorFiscal["tipo"],
            articulo: str(input.articulo),
            fraccion: str(input.fraccion),
            inciso: str(input.inciso),
            entidad: str(input.entidad),
            periodo: input.periodo === "anual" ? "anual" : input.periodo === "mensual" ? "mensual" : undefined,
            base: num(input.base),
            meses: num(input.meses),
            fecha: str(input.fecha),
          } as ConsultaValorFiscal)
        );
      default:
        return JSON.stringify({ error: `Herramienta desconocida para el perfil abogado: ${nombre}` });
    }
  } catch (err) {
    console.error(`[juridico ${nombre}]`, err);
    return JSON.stringify({ error: "La base jurídica no está disponible en este momento.", instruccion: "Dilo al usuario; NO inventes fundamentos." });
  }
}
