/**
 * Categorías de gasto de purificadora — UNA sola fuente de verdad.
 *
 * Se derivan del enum de Prisma (`PurifGastoCategoria`) en vez de repetir la
 * lista en cada endpoint. Cuando el enum crece (p. ej. ESTACIONAMIENTO), todos
 * los validadores lo aceptan automáticamente.
 *
 * Motivo: al agregar ESTACIONAMIENTO se actualizaron unos endpoints y otros no,
 * y capturar un gasto de estacionamiento tiraba el request entero con 400 —
 * en el corte del día eso significaba perder toda la captura de Minerva.
 */
import { z } from "zod";
import { PurifGastoCategoria } from "@prisma/client";

/** Todas las categorías válidas, en el orden del enum. */
export const CATEGORIAS_GASTO = Object.values(PurifGastoCategoria);

/** Validador de categoría para body de request. */
export const categoriaGastoSchema = z.nativeEnum(PurifGastoCategoria);

/** True si el string es una categoría válida (para filtros de query string). */
export function esCategoriaGasto(v: string | null | undefined): v is PurifGastoCategoria {
  return !!v && (CATEGORIAS_GASTO as string[]).includes(v);
}

/** Nombre legible de cada categoría (mismo texto que muestra el satélite). */
export const CATEGORIA_GASTO_LABEL: Record<PurifGastoCategoria, string> = {
  AGUA_CRUDA: "Agua cruda",
  ELECTRICIDAD: "Electricidad",
  FILTROS_INSUMOS: "Filtros e insumos",
  MANTENIMIENTO: "Mantenimiento",
  SUELDOS: "Sueldos",
  RENTA: "Renta",
  COMBUSTIBLE: "Combustible",
  ESTACIONAMIENTO: "Estacionamiento",
  OTRO: "Otro",
};

/** Descripción a guardar cuando el capturista no escribió uno. */
export function descripcionGasto(
  descripcion: string | null | undefined,
  categoria: PurifGastoCategoria
): string {
  return descripcion?.trim() || CATEGORIA_GASTO_LABEL[categoria];
}
