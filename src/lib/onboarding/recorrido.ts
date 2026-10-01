// ─────────────────────────────────────────────────────────────────────────────
// EL RECORRIDO — la pantalla 08 del alta, dentro de la app real.
//
// Un paso por sección del menú (Hoy → Configuración), el buscador (⌘K) y el
// copiloto: arrastrarlo sobre un dato (paso práctico) y su chat (Resumen,
// historial, Personalizar). Cada paso apunta a un elemento que YA existe en
// la app; si no está (p.ej. Cartera sin despacho), el paso se salta.
// ─────────────────────────────────────────────────────────────────────────────

import type { Linea } from "./lineas";

export interface PasoRecorrido {
  id: string;
  /** Selector del elemento a resaltar (el primero visible). */
  selector: string;
  titulo: string;
  linea: Linea;
  /** Paso práctico: avanza cuando el copiloto explica algo dentro del objetivo. */
  practico?: "arrastre";
  /** Si no se encuentra el objetivo: saltar (default) o mostrar centrado. */
  siFalta?: "saltar" | "centrar";
}

const menu = (href: string) => `aside a[href="${href}"]`;

export const PASOS_RECORRIDO: readonly PasoRecorrido[] = [
  {
    id: "hoy",
    selector: menu("/dashboard"),
    titulo: "Hoy",
    linea: {
      grano: "<b>Hoy</b>: el cierre del mes en cinco pasos, lo vencido y lo que toca presentar.",
      bal: "En <b>Hoy</b> ves lo que toca este mes: qué presentar, cuánto y para cuándo. Ya lo calculo con lo que bajé del SAT.",
      calma: "<b>Hoy</b> es lo más importante: cuánto le toca pagar al SAT este mes y hasta cuándo. Yo hago la cuenta; tú sólo revisas.",
    },
  },
  {
    id: "facturas",
    selector: menu("/facturas"),
    titulo: "Facturas",
    linea: {
      grano: "<b>Facturas</b>: emitidas y recibidas del SAT, timbrado, cancelaciones y complementos de pago.",
      bal: "En <b>Facturas</b> está todo lo que emites y recibes, ya descargado del SAT. Desde aquí también facturas y cancelas.",
      calma: "En <b>Facturas</b> están todas tus facturas, las que tú haces y las que te dan. Aquí también puedes hacer una nueva.",
    },
  },
  {
    id: "directorio",
    selector: menu("/clientes"),
    titulo: "Directorio",
    linea: "En <b>Directorio</b> están tus clientes y proveedores, armados solos a partir de tus facturas, con lo que te deben y lo que debes.",
  },
  {
    id: "bancos",
    selector: menu("/bancos"),
    titulo: "Bancos",
    linea: {
      grano: "<b>Bancos</b>: estados de cuenta y conciliación automática movimiento ↔ CFDI.",
      bal: "En <b>Bancos</b> subes tus estados de cuenta y cruzo cada movimiento con su factura.",
      calma: "En <b>Bancos</b> me das tus estados de cuenta y yo junto cada pago con su factura, para que nada se quede suelto.",
    },
  },
  {
    id: "nomina",
    selector: menu("/nomina"),
    titulo: "Nómina",
    linea: "En <b>Nómina</b> calculas y timbras recibos, y llevas IMSS e ISN de tus empleados.",
  },
  {
    id: "impuestos",
    selector: menu("/impuestos"),
    titulo: "Impuestos",
    linea: {
      grano: "<b>Impuestos</b>: papel de trabajo IVA/ISR, coeficiente de utilidad, DIOT y simulador.",
      bal: "En <b>Impuestos</b> está el desglose: de dónde sale cada peso de IVA e ISR. Tú revisas; yo nunca presento sin ti.",
      calma: "En <b>Impuestos</b> te explico de dónde sale cada peso que pagas. Nunca presento nada sin que tú me digas que sí.",
    },
  },
  {
    id: "contabilidad",
    selector: menu("/contabilidad"),
    titulo: "Contabilidad",
    linea: {
      grano: "<b>Contabilidad</b>: pólizas, catálogo, balanza y contabilidad electrónica (Anexo 24).",
      bal: "En <b>Contabilidad</b> están tus pólizas, tu balanza y la contabilidad electrónica, generadas a partir de tus facturas.",
      calma: "En <b>Contabilidad</b> están tus libros. Los armo yo a partir de tus facturas; tú no tienes que capturar nada.",
    },
  },
  {
    id: "cumplimiento",
    selector: menu("/cumplimiento"),
    titulo: "Cumplimiento",
    linea: "En <b>Cumplimiento</b> vigilo por ti las listas del SAT (69-B), tu opinión de cumplimiento y lo que vence.",
  },
  {
    id: "cartera",
    selector: menu("/despacho"),
    titulo: "Cartera",
    linea: "En <b>Cartera</b> ves todas las empresas que llevas, ordenadas por lo que urge.",
  },
  {
    id: "cierre",
    selector: menu("/cierre"),
    titulo: "Cierre",
    linea: "En <b>Cierre</b> te guío por el cierre del mes, paso por paso, con lo que falta en cada uno.",
  },
  {
    id: "empresa",
    selector: menu("/empresa"),
    titulo: "Mi Empresa",
    linea: "En <b>Mi Empresa</b> están tus datos fiscales, tu e.firma y tu CSD, y los documentos de la empresa.",
  },
  {
    id: "configuracion",
    selector: menu("/configuracion"),
    titulo: "Configuración",
    linea: "En <b>Configuración</b> invitas a tu equipo, das de alta más empresas, manejas tu plan y tus avisos.",
  },
  {
    id: "buscar",
    selector: '[data-tour="buscar"]',
    titulo: "Buscar",
    linea: "Para ir rápido a cualquier lado, pulsa <b>⌘K</b> (Ctrl+K): buscas facturas, clientes o pantallas desde cualquier lugar.",
  },
  {
    id: "arrastre",
    selector: "main [data-copiloto]",
    titulo: "Pruébalo tú",
    linea: "Ahora tú: <b>arrástrame</b> desde la esquina sobre esta tarjeta y te explico qué significa. (Con teclado: enfócala y pulsa ⌘/.)",
    practico: "arrastre",
  },
  {
    id: "chat",
    selector: ".cos-pet",
    titulo: "Tu copiloto",
    linea: "Haz clic en mí cuando quieras: en el chat me preguntas lo que sea, en <b>Resumen</b> ves lo que necesito de ti, y en <b>Personalizar</b> me cambias el aspecto. Aquí me quedo.",
    siFalta: "centrar",
  },
];
