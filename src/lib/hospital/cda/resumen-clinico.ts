// ─────────────────────────────────────────────────────────────────────────────
// CDA R2 «Resumen Clínico» (NOM-024-SSA3-2012 6.1.3.1 · GIIS-A001-01-05).
//
// Dos pasos: `cargarDatos` (datos.ts) saca del expediente lo que el documento
// necesita y valida las reglas (EGRESO sólo con alta, REFERENCIA con
// destinatario); `armarCda` es puro y arma el XML con los arcos de OID del
// hospital —registrado en HospConfig.oidRaiz, o temporal 2.25.<uuid> que deja
// el documento marcado como no intercambiable—. `construirResumenClinico`
// encadena los dos para la ruta.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import { el, serializarXml } from "../xml";
import { nuevoUuid, raicesDe, sha256 } from "./comun";
import { cargarDatos, type CargarDatosArgs, type DatosResumen, type TipoResumen } from "./datos";
import { nodosEncabezado, type Contexto } from "./encabezado";
import { CODIGO_DOCUMENTO } from "./oids";
import { nodoCuerpo } from "./secciones";

export type { CargarDatosArgs, DatosResumen, Destinatario, TipoResumen } from "./datos";
export { TIPOS_RESUMEN, cargarDatos } from "./datos";

export interface MetaResumen {
  /** UUID del documento: extension del `id` con OID registrado; base del OID 2.25 sin él. */
  id: string;
  /** root del `id` del documento. */
  oidRoot: string;
  /** true sólo con OID registrado (GIIS-A003) y CLUES: identificadores que otro SIRES puede resolver. */
  intercambiable: boolean;
  tipo: TipoResumen;
  /** LOINC del tipo de documento. */
  codigo: string;
  titulo: string;
  /** SHA-256 (hex) del XML tal como se entregó. */
  hash: string;
  /** Lo que el documento no pudo llenar como pide la guía, en español para el piso. */
  advertencias: string[];
}

export interface OpcionesArmado {
  /** Instante de generación (effectiveTime, author/time). Default: ahora. */
  ahora?: Date;
  /** UUID del documento. Default: uno nuevo. */
  idDocumento?: string;
}

/** Arma el XML a partir de datos ya cargados. Puro: mismos datos y opciones → mismo XML. */
export function armarCda(datos: DatosResumen, opciones: OpcionesArmado = {}): { xml: string; meta: MetaResumen } {
  const ahora = opciones.ahora ?? new Date();
  const idDocumento = opciones.idDocumento ?? nuevoUuid();
  const ctx: Contexto = { ahora, idDocumento, raices: raicesDe(datos.hospital.oidRaiz, datos.companyId, idDocumento), advertencias: [] };

  const documento = el("ClinicalDocument", { xmlns: "urn:hl7-org:v3", "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance" }, [
    ...nodosEncabezado(datos, ctx),
    nodoCuerpo(datos, ctx),
  ]);
  const xml = serializarXml(documento, { sangria: "  ", declaracion: true });
  const doc = CODIGO_DOCUMENTO[datos.tipo];
  return {
    xml,
    meta: {
      id: idDocumento,
      oidRoot: ctx.raices.documento,
      intercambiable: ctx.raices.registrado && !!datos.hospital.clues,
      tipo: datos.tipo,
      codigo: doc.code,
      titulo: doc.titulo,
      hash: sha256(xml),
      advertencias: [...new Set(ctx.advertencias)],
    },
  };
}

/** Carga el expediente y arma el CDA. Lanza HospitalError (404/409/400) con el motivo. */
export async function construirResumenClinico(
  db: PrismaClient | Prisma.TransactionClient,
  args: CargarDatosArgs & OpcionesArmado
): Promise<{ xml: string; meta: MetaResumen; datos: DatosResumen }> {
  const datos = await cargarDatos(db, args);
  const { xml, meta } = armarCda(datos, { ahora: args.ahora, idDocumento: args.idDocumento });
  return { xml, meta, datos };
}
