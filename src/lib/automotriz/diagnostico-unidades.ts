import type { PrismaClient } from "@prisma/client";
import {
  conceptosConVeredicto,
  UMBRAL_UNIDAD_SIN_COMPLEMENTO,
  type MotivoNoUnidad,
} from "./vin";

// ─────────────────────────────────────────────────────────────────────────────
// ¿Por qué una compra de vehículo no se volvió unidad?
//
// El reporte de cobertura dice CUÁNTO no se explica; esto dice POR CUÁL candado.
// Existe porque la pregunta «¿el VIN viene dos veces en la descripción?» no se
// puede contestar leyendo el código: hay que contar sobre las descripciones
// reales. Mide con `conceptosConVeredicto`, la misma pasada que deriva en
// producción, así que no puede describir un derivador que no es el que corre.
//
// No corrige nada y no escribe nada. Sólo cuenta.
// ─────────────────────────────────────────────────────────────────────────────

/** Cuántos conceptos fallan cada candado (un concepto puede fallar varios). */
export interface ConteoFalla {
  motivo: MotivoNoUnidad;
  conceptos: number;
  monto: number;
  /** Conceptos cuya ÚNICA falla es ésta: los que se arreglarían tocando sólo este candado. */
  soloEsta: number;
  montoSoloEsta: number;
}

/** El conteo real de VINs por concepto — la pregunta que originó todo esto. */
export interface ConteoVins {
  vins: number;
  conceptos: number;
  monto: number;
}

export interface MuestraConcepto {
  /** Descripción con los VINs enmascarados y recortada: es dato de un tercero. */
  descripcion: string;
  claveProdServ: string | null;
  cantidad: number;
  importe: number;
  vinsEncontrados: number;
  fallas: MotivoNoUnidad[];
}

export interface DiagnosticoUnidades {
  /** Facturas EGRESO con algún concepto 2510xx que no derivaron ninguna unidad. */
  facturas: number;
  /** Conceptos 2510xx dentro de esas facturas. */
  conceptos: number;
  monto: number;
  /** Conceptos que SÍ pasan todos los candados — si esto es > 0, la falla no está en el gate. */
  pasanTodos: number;
  montoPasanTodos: number;
  porFalla: ConteoFalla[];
  distribucionVins: ConteoVins[];
  muestras: MuestraConcepto[];
  umbral: number;
  /** Facturas con concepto 2510xx que no traían rawXml: no se pueden diagnosticar. */
  sinXml: number;
}

const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/g;

/**
 * Enmascara VINs y recorta. Las descripciones vienen de facturas de terceros;
 * el diagnóstico necesita la FORMA del texto, no la identidad de la unidad.
 */
export function enmascarar(texto: string | null, max = 160): string {
  if (!texto) return "";
  const limpio = texto.replace(VIN_RE, (v) => `${v.slice(0, 4)}…${v.slice(-2)}`);
  return limpio.length > max ? `${limpio.slice(0, max)}…` : limpio;
}

interface FacturaCruda {
  id: string;
  rawXml: string | null;
}

/**
 * Puro: recibe los XML ya cargados y cuenta. Separado del acceso a datos para
 * poder fijarlo en tests con CFDI reales sin tocar la base.
 */
export function armarDiagnostico(
  facturas: FacturaCruda[],
  opciones: { maxMuestras?: number } = {}
): DiagnosticoUnidades {
  const maxMuestras = opciones.maxMuestras ?? 20;

  const porFalla = new Map<MotivoNoUnidad, { conceptos: number; monto: number; soloEsta: number; montoSoloEsta: number }>();
  const porVins = new Map<number, { conceptos: number; monto: number }>();
  const muestras: MuestraConcepto[] = [];

  let facturasConPendiente = 0;
  let conceptos = 0;
  let monto = 0;
  let pasanTodos = 0;
  let montoPasanTodos = 0;
  let sinXml = 0;

  for (const f of facturas) {
    if (!f.rawXml) {
      sinXml++;
      continue;
    }

    // Sólo los conceptos con clave de vehículo: el resto de la factura (fletes,
    // trámites) no pretende ser una unidad y contarlo diluiría el diagnóstico.
    const candidatos = conceptosConVeredicto(f.rawXml).filter((c) =>
      (c.claveProdServ ?? "").startsWith("2510")
    );
    if (candidatos.length === 0) continue;
    facturasConPendiente++;

    for (const c of candidatos) {
      conceptos++;
      monto += c.importe;

      const n = c.vinsTexto.length;
      const v = porVins.get(n) ?? { conceptos: 0, monto: 0 };
      v.conceptos++;
      v.monto += c.importe;
      porVins.set(n, v);

      if (c.veredicto.esUnidad) {
        pasanTodos++;
        montoPasanTodos += c.importe;
        continue;
      }

      for (const motivo of c.veredicto.fallas) {
        const e = porFalla.get(motivo) ?? { conceptos: 0, monto: 0, soloEsta: 0, montoSoloEsta: 0 };
        e.conceptos++;
        e.monto += c.importe;
        if (c.veredicto.fallas.length === 1) {
          e.soloEsta++;
          e.montoSoloEsta += c.importe;
        }
        porFalla.set(motivo, e);
      }

      if (muestras.length < maxMuestras) {
        muestras.push({
          descripcion: enmascarar(c.descripcion),
          claveProdServ: c.claveProdServ,
          cantidad: c.cantidad,
          importe: c.importe,
          vinsEncontrados: n,
          fallas: c.veredicto.fallas,
        });
      }
    }
  }

  const r2 = (n: number) => Math.round(n * 100) / 100;

  return {
    facturas: facturasConPendiente,
    conceptos,
    monto: r2(monto),
    pasanTodos,
    montoPasanTodos: r2(montoPasanTodos),
    porFalla: [...porFalla.entries()]
      .map(([motivo, e]) => ({
        motivo,
        conceptos: e.conceptos,
        monto: r2(e.monto),
        soloEsta: e.soloEsta,
        montoSoloEsta: r2(e.montoSoloEsta),
      }))
      .sort((a, b) => b.conceptos - a.conceptos),
    distribucionVins: [...porVins.entries()]
      .map(([vins, e]) => ({ vins, conceptos: e.conceptos, monto: r2(e.monto) }))
      .sort((a, b) => a.vins - b.vins),
    muestras,
    umbral: UMBRAL_UNIDAD_SIN_COMPLEMENTO,
    sinXml,
  };
}

/**
 * Carga las facturas EGRESO del periodo que traen algún concepto 2510xx y NO
 * derivaron unidad, y las diagnostica.
 */
export async function diagnosticarUnidades(
  prisma: PrismaClient,
  companyId: string,
  desde: Date,
  hasta: Date,
  opciones: { maxFacturas?: number; maxMuestras?: number } = {}
): Promise<DiagnosticoUnidades> {
  const maxFacturas = opciones.maxFacturas ?? 2000;

  const facturas = await prisma.$queryRaw<FacturaCruda[]>`
    SELECT i.id, i."rawXml"
    FROM "Invoice" i
    WHERE i."companyId" = ${companyId}
      AND i."tipo" = 'EGRESO'
      AND i."status" <> 'CANCELLED'
      AND i."fecha" >= ${desde} AND i."fecha" < ${hasta}
      AND EXISTS (
        SELECT 1 FROM "InvoiceItem" ii
        WHERE ii."invoiceId" = i.id AND ii."claveProdServ" LIKE '2510%'
      )
      -- Sin unidad derivada de esta compra: es justo el residuo que se busca.
      AND NOT EXISTS (
        SELECT 1 FROM "Vehiculo" v WHERE v."compraInvoiceId" = i.id
      )
    ORDER BY i."fecha" DESC
    LIMIT ${maxFacturas}
  `;

  return armarDiagnostico(facturas, { maxMuestras: opciones.maxMuestras });
}
