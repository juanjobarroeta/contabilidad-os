// ─────────────────────────────────────────────────────────────────────────────
// PUNTO DE PARTIDA DE UNA EMPRESA: qué tenemos, qué falta y a quién pedírselo.
//
// Una empresa nueva llega con su RFC y poco más. Para que la contabilidad sea
// real —no sólo el estado de resultados que dan los CFDI— hacen falta seis
// cosas, y hasta hoy nadie las pedía: el que sabía subía el catálogo en
// Empresa, y el que no, cerraba meses sobre el catálogo starter sin saberlo.
//
// Esto es un evaluador PURO: recibe hechos (cuántas cuentas propias, si hay
// e.firma, la última balanza que bajamos del SAT…) y devuelve la lista con su
// estado y, cuando falta algo, la petición concreta —qué archivo, de dónde—.
// Tres estados: «listo», «parcial» (hay con qué, falta un paso nuestro o del
// usuario) y «falta» (hay que pedirlo). La regla de fondo: si la empresa
// tiene e.firma vigente, la Contabilidad Electrónica y los CFDI los bajamos
// NOSOTROS del SAT; sólo cuando no la tiene —o no presenta CE— se le pide el
// archivo, en cualquiera de los formatos que sabemos leer (XML del Anexo 24,
// CSV o Excel de CONTPAQi / Aspel COI / una hoja del contador).
// ─────────────────────────────────────────────────────────────────────────────

import type { FielEstado } from "../fiel";

export interface HechosPuntoDePartida {
  hoy: Date;
  fiel: FielEstado;
  fielVigencia: Date | null;
  /** Obligaciones registradas (vienen de la CSF). */
  obligaciones: number;
  /** Cuentas del catálogo PROPIO (con código agrupador). */
  cuentasPropias: number;
  ultimaCargaCatalogo: Date | null;
  /** Última balanza mensual bajada del SAT (nuestra descarga de CE). */
  ultimaBalanzaSat: { anio: number; mes: number } | null;
  /** Hay asiento de apertura (saldos iniciales). */
  aperturaHecha: boolean;
  cuentasBancarias: number;
  /** Periodo («2026-08») del último estado de cuenta importado. */
  ultimoEstadoDeCuenta: string | null;
  cfdis: number;
  ultimaSincronizacionSat: Date | null;
}

export type EstadoPaso = "listo" | "parcial" | "falta";

export interface PasoPuntoDePartida {
  clave: "csf" | "fiel" | "catalogo" | "saldos" | "bancos" | "cfdi";
  titulo: string;
  estado: EstadoPaso;
  /** Lo que hay (o no), en una línea. */
  detalle: string;
  /** Qué se le pide a la empresa, cuando falta o está parcial. */
  peticion?: string;
  /** A dónde ir para resolverlo (ancla en /empresa o ruta). */
  href: string;
  /** Algo que la app puede hacer sola con lo que ya tiene, de un clic. */
  accion?: { tipo: "apertura-desde-ce"; anio: number; mes: number; etiqueta: string };
}

export interface PuntoDePartida {
  pasos: PasoPuntoDePartida[];
  listos: number;
  total: number;
  /** El primer paso que no está listo, para encabezar el aviso. */
  siguiente: PasoPuntoDePartida | null;
}

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const fecha = (d: Date) => d.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric", timeZone: "America/Mexico_City" });
const mesTexto = (m: { anio: number; mes: number }) => `${MESES[m.mes - 1] ?? m.mes} ${m.anio}`;
const periodoTexto = (p: string) => {
  const [a, m] = p.split("-").map(Number);
  return Number.isInteger(a) && m >= 1 && m <= 12 ? `${MESES[m - 1]} ${a}` : p;
};

const FORMATOS = "XML del SAT (Anexo 24) o CSV/Excel de tu sistema (CONTPAQi, Aspel COI, o una hoja con código, nombre, naturaleza y agrupador)";

export function evaluarPuntoDePartida(h: HechosPuntoDePartida): PuntoDePartida {
  const fielVigente = h.fiel === "ok" || h.fiel === "por_vencer";
  const pasos: PasoPuntoDePartida[] = [];

  // 1. CSF → obligaciones y régimen.
  pasos.push(
    h.obligaciones > 0
      ? { clave: "csf", titulo: "Constancia de Situación Fiscal", estado: "listo", detalle: `${h.obligaciones} obligación(es) registradas`, href: "#csf" }
      : { clave: "csf", titulo: "Constancia de Situación Fiscal", estado: "falta", detalle: "Sin obligaciones registradas", peticion: "Sube la CSF más reciente (PDF del SAT): de ahí salen régimen, obligaciones y código postal.", href: "#csf" },
  );

  // 2. e.firma → con ella bajamos CFDI y Contabilidad Electrónica.
  if (h.fiel === "ok") {
    pasos.push({ clave: "fiel", titulo: "e.firma", estado: "listo", detalle: h.fielVigencia ? `Vigente hasta ${fecha(h.fielVigencia)}` : "Vigente", href: "#fiel" });
  } else if (h.fiel === "por_vencer") {
    pasos.push({ clave: "fiel", titulo: "e.firma", estado: "parcial", detalle: h.fielVigencia ? `Vence ${fecha(h.fielVigencia)}` : "Por vencer", peticion: "Renueva la e.firma en el SAT y sube el .cer y .key nuevos antes de que venza.", href: "#fiel" });
  } else {
    pasos.push({
      clave: "fiel", titulo: "e.firma", estado: "falta",
      detalle: h.fiel === "vencida" ? "Vencida" : "Sin e.firma",
      peticion: "Sube el .cer, el .key y la contraseña: con ella bajamos del SAT tus CFDI y tu Contabilidad Electrónica sin pedirte archivos.",
      href: "#fiel",
    });
  }

  // 3. Catálogo de cuentas propio.
  if (h.cuentasPropias > 0) {
    pasos.push({ clave: "catalogo", titulo: "Catálogo de cuentas", estado: "listo", detalle: `${h.cuentasPropias} cuentas propias${h.ultimaCargaCatalogo ? ` · cargado ${fecha(h.ultimaCargaCatalogo)}` : ""}`, href: "#contabilidad-electronica" });
  } else if (fielVigente) {
    pasos.push({
      clave: "catalogo", titulo: "Catálogo de cuentas", estado: "parcial",
      detalle: "Todavía sobre el catálogo genérico",
      peticion: `Lo bajamos del SAT con tu e.firma en la siguiente descarga de Contabilidad Electrónica. Si no presentas CE, súbelo tú: ${FORMATOS}.`,
      href: "#contabilidad-electronica",
    });
  } else {
    pasos.push({
      clave: "catalogo", titulo: "Catálogo de cuentas", estado: "falta",
      detalle: "Todavía sobre el catálogo genérico",
      peticion: `Sube tu catálogo de cuentas: ${FORMATOS}.`,
      href: "#contabilidad-electronica",
    });
  }

  // 4. Saldos iniciales (apertura).
  if (h.aperturaHecha) {
    pasos.push({ clave: "saldos", titulo: "Saldos iniciales", estado: "listo", detalle: "Asiento de apertura registrado", href: "#contabilidad-electronica" });
  } else if (h.ultimaBalanzaSat) {
    pasos.push({
      clave: "saldos", titulo: "Saldos iniciales", estado: "parcial",
      detalle: `Tenemos tu balanza del SAT de ${mesTexto(h.ultimaBalanzaSat)}`,
      peticion: "Falta generar la apertura con esa balanza; no hay que subir nada.",
      href: "#contabilidad-electronica",
      accion: { tipo: "apertura-desde-ce", anio: h.ultimaBalanzaSat.anio, mes: h.ultimaBalanzaSat.mes, etiqueta: `Generar apertura con la balanza de ${mesTexto(h.ultimaBalanzaSat)}` },
    });
  } else {
    pasos.push({
      clave: "saldos", titulo: "Saldos iniciales", estado: fielVigente ? "parcial" : "falta",
      detalle: "Sin balanza de arranque: el balance no será real",
      peticion: fielVigente
        ? "La balanza la bajamos del SAT con tu e.firma si presentas CE; si no, sube la última balanza de comprobación (XML, CSV o Excel)."
        : "Sube la última balanza de comprobación (XML del SAT, o CSV/Excel de tu sistema) para arrancar con saldos reales.",
      href: "#contabilidad-electronica",
    });
  }

  // 5. Bancos.
  if (h.cuentasBancarias > 0 && h.ultimoEstadoDeCuenta) {
    pasos.push({ clave: "bancos", titulo: "Bancos", estado: "listo", detalle: `${h.cuentasBancarias} cuenta(s) · último estado ${periodoTexto(h.ultimoEstadoDeCuenta)}`, href: "/bancos" });
  } else if (h.cuentasBancarias > 0) {
    pasos.push({ clave: "bancos", titulo: "Bancos", estado: "parcial", detalle: `${h.cuentasBancarias} cuenta(s) sin estados de cuenta`, peticion: "Sube el estado de cuenta de cada banco (PDF o CSV del portal), empezando por el último mes.", href: "/bancos" });
  } else {
    pasos.push({ clave: "bancos", titulo: "Bancos", estado: "falta", detalle: "Sin cuentas bancarias", peticion: "Registra cada cuenta bancaria (banco, CLABE) y sube su último estado de cuenta.", href: "/bancos" });
  }

  // 6. CFDI.
  if (h.cfdis > 0) {
    pasos.push({ clave: "cfdi", titulo: "CFDI", estado: "listo", detalle: `${h.cfdis.toLocaleString("es-MX")} comprobantes${h.ultimaSincronizacionSat ? ` · sincronizado ${fecha(h.ultimaSincronizacionSat)}` : ""}`, href: "/facturas" });
  } else if (fielVigente) {
    pasos.push({ clave: "cfdi", titulo: "CFDI", estado: "parcial", detalle: "Sin comprobantes todavía", peticion: "Se sincronizan del SAT con tu e.firma en la siguiente corrida; puedes lanzarla desde Facturas.", href: "/facturas" });
  } else {
    pasos.push({ clave: "cfdi", titulo: "CFDI", estado: "falta", detalle: "Sin comprobantes", peticion: "Sube tu e.firma para sincronizarlos del SAT, o carga los XML a mano en Facturas.", href: "/facturas" });
  }

  const listos = pasos.filter((p) => p.estado === "listo").length;
  return { pasos, listos, total: pasos.length, siguiente: pasos.find((p) => p.estado !== "listo") ?? null };
}
